// IPTV: M3U listeleri sunucuda indirilir, ayrıştırılır ve diskte tutulur. Tarayıcı ham listeyi
// hiç görmez; kanal başına kısa JSON alır (Gemini sürümündeki yavaşlığın sebebi buydu).
// EPG (XMLTV) de sunucuda akış halinde okunur, sadece "şimdi -2 sa … +12 sa" aralığı tutulur.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { Readable, PassThrough } = require('stream')
const { once } = require('events')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const REFRESH_MS = 12 * 3600e3
const EPG_REFRESH_MS = 6 * 3600e3

let dir = null
let state = { lists: [] }
const mem = new Map() // id -> { channels, groups, at }
const epgMem = new Map() // id -> { byId: Map(tvgId -> [{s,e,t}]), at }

const stateFile = () => path.join(dir, 'iptv.json')
const chFile = (id) => path.join(dir, `iptv_${id}.json`)
const epgFile = (id) => path.join(dir, `epg_${id}.json`)
const save = () => fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))

function init(dataDir) {
  dir = dataDir
  fs.mkdirSync(dir, { recursive: true })
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }
  } catch {}
}

// Xtream Codes bilgisi verildiyse M3U adresine çevir (HLS çıkışı: tarayıcı doğrudan oynatır).
function xtreamUrl({ host, user, pass }) {
  const base = host.replace(/\/+$/, '')
  return `${base}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus&output=m3u8`
}

const attr = (s, k) => {
  const m = new RegExp(`${k}="([^"]*)"`, 'i').exec(s)
  return m ? m[1].trim() : ''
}

function kindOf(url, group) {
  if (/\/movie\//i.test(url)) return 'movie'
  if (/\/series\//i.test(url)) return 'series'
  if (/\.(mp4|mkv|avi)(\?|$)/i.test(url) && !/live/i.test(group)) return 'movie'
  return 'live'
}

function parse(text) {
  const lines = text.split(/\r?\n/)
  const head = lines[0] || ''
  const epgUrl = attr(head, 'url-tvg') || attr(head, 'x-tvg-url')
  const channels = []
  let cur = null
  for (let raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf('",') >= 0 ? line.indexOf(',', line.lastIndexOf('"')) : line.indexOf(',')
      const meta = line.slice(0, comma < 0 ? line.length : comma)
      cur = {
        name: (comma >= 0 ? line.slice(comma + 1) : '').trim() || attr(meta, 'tvg-name') || 'Kanal',
        logo: attr(meta, 'tvg-logo'),
        group: attr(meta, 'group-title') || 'Diğer',
        tvgId: attr(meta, 'tvg-id'),
        num: parseInt(attr(meta, 'tvg-chno')) || 0,
      }
    } else if (line.startsWith('#EXTGRP:') && cur) {
      cur.group = line.slice(8).trim() || cur.group
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {
      const v = line.slice(11)
      if (/^http-user-agent=/i.test(v)) cur.ua = v.split('=').slice(1).join('=')
      if (/^http-referr?er=/i.test(v)) cur.ref = v.split('=').slice(1).join('=')
    } else if (!line.startsWith('#')) {
      if (!cur) cur = { name: line.split('/').pop() || 'Kanal', logo: '', group: 'Diğer', tvgId: '', num: 0 }
      // "url|User-Agent=..&Referer=.." (Kodi biçimi)
      let url = line
      const pipe = line.indexOf('|')
      if (pipe > 0) {
        url = line.slice(0, pipe)
        for (const kv of line.slice(pipe + 1).split('&')) {
          const [k, ...v] = kv.split('=')
          if (/user-agent/i.test(k)) cur.ua = decodeURIComponent(v.join('='))
          if (/referr?er/i.test(k)) cur.ref = decodeURIComponent(v.join('='))
        }
      }
      cur.url = url
      cur.kind = kindOf(url, cur.group)
      channels.push(cur)
      cur = null
    }
  }
  channels.forEach((c, i) => {
    c.i = i
    if (!c.num) c.num = i + 1
  })
  const groups = {}
  for (const c of channels) {
    const g = (groups[c.kind] ||= new Map())
    g.set(c.group, (g.get(c.group) || 0) + 1)
  }
  const groupList = Object.fromEntries(Object.entries(groups).map(([k, m]) => [k, [...m].map(([name, count]) => ({ name, count }))]))
  return { epgUrl, channels, groups: groupList }
}

async function fetchText(url, timeout = 60000) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' })
  if (!r.ok) throw new Error(`Liste indirilemedi (HTTP ${r.status})`)
  let buf = Buffer.from(await r.arrayBuffer())
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
  return buf.toString('utf8').replace(/^﻿/, '')
}

async function load(list) {
  const text = list.text ?? (await fetchText(list.url))
  if (!text.trimStart().startsWith('#EXTM3U') && !/#EXTINF/.test(text)) throw new Error('Bu bir M3U listesi değil')
  const p = parse(text)
  const data = { channels: p.channels, groups: p.groups, at: Date.now() }
  mem.set(list.id, data)
  fs.writeFileSync(chFile(list.id), JSON.stringify(data))
  list.count = p.channels.length
  list.counts = Object.fromEntries(Object.entries(p.groups).map(([k, g]) => [k, g.reduce((a, x) => a + x.count, 0)]))
  list.updatedAt = data.at
  if (!list.epgUrl && p.epgUrl) list.epgUrl = p.epgUrl
  list.error = null
  save()
  if (list.epgUrl) loadEpg(list).catch(() => {})
  return data
}

async function add({ id: keepId, name, url, text, epgUrl, xtream }) {
  // Yedekten geri yüklenen liste eski kimliğini korur: favoriler/son izlenenler kanala bağlı kalsın.
  const id = /^[a-f0-9]{10}$/.test(keepId || '') && !state.lists.some((l) => l.id === keepId) ? keepId : crypto.randomBytes(5).toString('hex')
  const list = { id, name: name?.trim() || 'IPTV', url: xtream ? xtreamUrl(xtream) : url?.trim() || null, epgUrl: epgUrl?.trim() || null, addedAt: Date.now() }
  if (xtream && !list.epgUrl) list.epgUrl = `${xtream.host.replace(/\/+$/, '')}/xmltv.php?username=${encodeURIComponent(xtream.user)}&password=${encodeURIComponent(xtream.pass)}`
  if (!list.url && !text) throw new Error('Adres ya da liste metni gerekli')
  if (text) list.text = text
  await load(list)
  state.lists.push(list)
  save()
  return publicList(list)
}

function remove(id) {
  state.lists = state.lists.filter((l) => l.id !== id)
  mem.delete(id)
  epgMem.delete(id)
  for (const f of [chFile(id), epgFile(id)]) fs.rmSync(f, { force: true })
  save()
}

const publicList = ({ text, url, ...l }) => ({ ...l, url: url ? url.replace(/(password=)[^&]+/i, '$1***') : null })
const lists = () => state.lists.map(publicList)

async function channels(id) {
  const list = state.lists.find((l) => l.id === id)
  if (!list) return null
  let data = mem.get(id)
  if (!data) {
    try {
      data = JSON.parse(await fs.promises.readFile(chFile(id), 'utf8'))
      mem.set(id, data)
    } catch {}
  }
  if (!data) data = await load(list)
  else if (list.url && Date.now() - data.at > REFRESH_MS) load(list).catch((e) => ((list.error = String(e.message || e)), save()))
  return data
}

async function refresh(id) {
  const list = state.lists.find((l) => l.id === id)
  if (!list) return null
  await load(list)
  return publicList(list)
}

function channel(id, i) {
  return mem.get(id)?.channels[i] || null
}

// ---------------------------------------------------------------- EPG

const xmlDate = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s || '')
  if (!m) return 0
  const tz = m[7] ? (m[7][0] === '-' ? -1 : 1) * (parseInt(m[7].slice(1, 3)) * 60 + parseInt(m[7].slice(3))) : 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - tz * 60e3
}
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

const epgLoading = new Map()
function loadEpg(list) {
  if (epgLoading.has(list.id)) return epgLoading.get(list.id)
  const p = (async () => {
    const r = await fetch(list.epgUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(180000) })
    if (!r.ok || !r.body) throw new Error(`EPG HTTP ${r.status}`)
    const from = Date.now() - 2 * 3600e3
    const to = Date.now() + 12 * 3600e3
    const byId = {}
    // gzip mi düz mü, ilk baytlardan anlaşılır (sunucular türü çoğu zaman yanlış söyler)
    const it = Readable.fromWeb(r.body)[Symbol.asyncIterator]()
    const first = await it.next()
    const isGz = !!first.value && first.value[0] === 0x1f && first.value[1] === 0x8b
    const pass = new PassThrough()
    ;(async () => {
      if (!first.done) pass.write(first.value)
      for (;;) {
        const n = await it.next()
        if (n.done) break
        if (!pass.write(n.value)) await once(pass, 'drain')
      }
      pass.end()
    })().catch((e) => pass.destroy(e))
    const stream = isGz ? pass.pipe(zlib.createGunzip()) : pass
    stream.setEncoding('utf8')
    let buf = ''
    for await (const chunk of stream) {
      buf += chunk
      let end
      while ((end = buf.indexOf('</programme>')) >= 0) {
        const block = buf.slice(Math.max(0, buf.lastIndexOf('<programme', end)), end)
        buf = buf.slice(end + 12)
        const head = /<programme([^>]*)>/.exec(block)?.[1] || ''
        const s0 = xmlDate(attr(head, 'start'))
        const e0 = xmlDate(attr(head, 'stop'))
        if (e0 < from || s0 > to) continue
        const ch = attr(head, 'channel')
        const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1]
        if (!ch || !t) continue
        const d = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(block)?.[1]
        ;(byId[ch] ||= []).push({ s: s0, e: e0, t: unesc(t.trim()), d: d ? unesc(d.trim()).slice(0, 300) : '' })
      }
      if (buf.length > 4e6) buf = buf.slice(-1e6)
    }
    for (const k in byId) byId[k].sort((a, b) => a.s - b.s)
    const data = { byId, at: Date.now() }
    epgMem.set(list.id, data)
    fs.writeFileSync(epgFile(list.id), JSON.stringify(data))
    return data
  })().finally(() => epgLoading.delete(list.id))
  epgLoading.set(list.id, p)
  return p
}

async function epg(id, tvgIds) {
  const list = state.lists.find((l) => l.id === id)
  if (!list?.epgUrl) return {}
  let data = epgMem.get(id)
  if (!data) {
    try {
      data = JSON.parse(await fs.promises.readFile(epgFile(id), 'utf8'))
      epgMem.set(id, data)
    } catch {}
  }
  if (!data || Date.now() - data.at > EPG_REFRESH_MS) {
    const p = loadEpg(list).catch(() => null)
    if (!data) data = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 20000))])
  }
  if (!data) return {}
  const now = Date.now()
  const out = {}
  for (const t of tvgIds) {
    const arr = data.byId[t]
    if (!arr) continue
    out[t] = arr.filter((p) => p.e > now - 60e3).slice(0, 6)
  }
  return out
}

// Yedek için listelerin tanımı (şifreli adres dahil; yalnız girişli kullanıcıya).
const exportDefs = () => state.lists.map((l) => ({ id: l.id, name: l.name, url: l.url, text: l.text, epgUrl: l.epgUrl }))

module.exports = { exportDefs, init, add, remove, lists, channels, refresh, channel, epg }
