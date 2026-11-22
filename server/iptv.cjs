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
  if (/\/movie\//i.test(url)) return 'm'
  if (/\/series\//i.test(url)) return 's'
  if (/\.(mp4|mkv|avi)(\?|$)/i.test(url) && !/live/i.test(group)) return 'm'
  return 'l'
}

// Kanal satırı nesne değil dizi: 115 bin satırlık Xtream listesinde (6 bin kanal + 30 bin film +
// 78 bin bölüm) nesneler Render'ın 512 MB'ını taşırıp sunucuyu çökertiyordu.
// [0 ad, 1 logo, 2 grup, 3 tvg-id, 4 tür l|m|s, 5 numara, 6 adres, 7 user-agent, 8 referer]

// Satır satır ayrıştırıcı: liste hiçbir zaman tek parça metin olarak bellekte durmaz.
function makeParser() {
  const rows = []
  const intern = new Map() // aynı grup adı 30 bin kez ayrı metin olarak tutulmasın
  const str = (v) => { let x = intern.get(v); if (x === undefined) { intern.set(v, v); x = v } return x }
  let cur = null
  let epgUrl = ''
  let first = true
  const line = (raw) => {
    const t = raw.replace(/^﻿/, '').trim()
    if (!t) return
    if (first) {
      first = false
      if (!/#EXTM3U|#EXTINF/.test(t)) throw new Error('Bu bir M3U listesi değil')
      if (t.startsWith('#EXTM3U')) { epgUrl = attr(t, 'url-tvg') || attr(t, 'x-tvg-url'); return }
    }
    if (t.startsWith('#EXTINF')) {
      const comma = t.lastIndexOf('",') >= 0 ? t.indexOf(',', t.lastIndexOf('"')) : t.indexOf(',')
      const meta = t.slice(0, comma < 0 ? t.length : comma)
      cur = [(comma >= 0 ? t.slice(comma + 1) : '').trim() || attr(meta, 'tvg-name') || 'Kanal', attr(meta, 'tvg-logo'), str(attr(meta, 'group-title') || 'Diğer'), attr(meta, 'tvg-id'), 'l', parseInt(attr(meta, 'tvg-chno')) || 0, '', '', '']
    } else if (t.startsWith('#EXTGRP:') && cur) {
      cur[2] = str(t.slice(8).trim() || cur[2])
    } else if (t.startsWith('#EXTVLCOPT:') && cur) {
      const v = t.slice(11)
      if (/^http-user-agent=/i.test(v)) cur[7] = v.split('=').slice(1).join('=')
      if (/^http-referr?er=/i.test(v)) cur[8] = v.split('=').slice(1).join('=')
    } else if (!t.startsWith('#')) {
      if (!cur) cur = [t.split('/').pop() || 'Kanal', '', str('Diğer'), '', 'l', 0, '', '', '']
      // "url|User-Agent=..&Referer=.." (Kodi biçimi)
      let url = t
      const pipe = t.indexOf('|')
      if (pipe > 0) {
        url = t.slice(0, pipe)
        for (const kv of t.slice(pipe + 1).split('&')) {
          const [k, ...v] = kv.split('=')
          if (/user-agent/i.test(k)) cur[7] = decodeURIComponent(v.join('='))
          if (/referr?er/i.test(k)) cur[8] = decodeURIComponent(v.join('='))
        }
      }
      cur[6] = url
      cur[4] = kindOf(url, cur[2])
      if (!cur[5]) cur[5] = rows.length + 1
      rows.push(cur)
      cur = null
    }
  }
  const done = () => {
    const groups = { live: new Map(), movie: new Map(), series: new Map() }
    const K = { l: 'live', m: 'movie', s: 'series' }
    for (const r of rows) { const g = groups[K[r[4]]]; g.set(r[2], (g.get(r[2]) || 0) + 1) }
    const groupList = {}
    for (const [k, m] of Object.entries(groups)) if (m.size) groupList[k] = [...m].map(([name, count]) => ({ name, count }))
    return { epgUrl, rows, groups: groupList }
  }
  return { line, done }
}

// Gövdeyi (gzip olsun olmasın) satır satır okur.
async function* lines(body) {
  const it = Readable.fromWeb(body)[Symbol.asyncIterator]()
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
  // Bayt düzeyinde bölünür: her satır kendi küçük metni olur. Metin parçasından slice alınca V8
  // bütün 64 KB'lık parçayı satırlarla birlikte bellekte tutuyordu.
  let rest = null
  for await (const chunk of stream) {
    const b = rest ? Buffer.concat([rest, chunk]) : chunk
    let i, from = 0
    while ((i = b.indexOf(10, from)) >= 0) { yield b.toString('utf8', from, i); from = i + 1 }
    rest = from < b.length ? Buffer.from(b.subarray(from)) : null
  }
  if (rest) yield rest.toString('utf8')
}

async function parseList(list) {
  const p = makeParser()
  if (list.text != null) {
    for (const l of list.text.split(/\r?\n/)) p.line(l)
  } else {
    const r = await fetch(list.url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(180000), redirect: 'follow' })
    if (!r.ok || !r.body) throw new Error(`Liste indirilemedi (HTTP ${r.status})`)
    for await (const l of lines(r.body)) p.line(l)
  }
  const out = p.done()
  if (!out.rows.length) throw new Error('Listede kanal yok')
  return out
}

// Diskte NDJSON: ilk satır özet, sonra her satır bir kanal (okurken de yazarken de tek dev metin yok).
async function writeRows(id, data) {
  const f = chFile(id)
  const ws = fs.createWriteStream(f + '.tmp')
  ws.write(JSON.stringify({ at: data.at, groups: data.groups }) + '\n')
  for (let i = 0; i < data.rows.length; i += 2000) {
    if (!ws.write(data.rows.slice(i, i + 2000).map((r) => JSON.stringify(r)).join('\n') + '\n')) await once(ws, 'drain')
  }
  ws.end()
  await once(ws, 'finish')
  fs.renameSync(f + '.tmp', f)
}
async function readRows(id) {
  const rs = fs.createReadStream(chFile(id), { encoding: 'utf8' })
  let head = null
  const rows = []
  let buf = ''
  for await (const chunk of rs) {
    buf += chunk
    let i, from = 0
    while ((i = buf.indexOf('\n', from)) >= 0) {
      const l = buf.slice(from, i)
      from = i + 1
      if (!head) head = JSON.parse(l)
      else if (l) rows.push(JSON.parse(l))
    }
    buf = buf.slice(from)
  }
  if (!head || !Array.isArray(rows[0])) throw new Error('eski ya da bozuk kayıt')
  return { ...head, rows }
}

const loading = new Map()
function load(list) {
  if (loading.has(list.id)) return loading.get(list.id)
  const p = (async () => {
    const parsed = await parseList(list)
    const data = { rows: parsed.rows, groups: parsed.groups, at: Date.now() }
    mem.set(list.id, data)
    await writeRows(list.id, data).catch(() => {})
    list.count = data.rows.length
    list.counts = Object.fromEntries(Object.entries(data.groups).map(([k, g]) => [k, g.reduce((a, x) => a + x.count, 0)]))
    list.updatedAt = data.at
    if (!list.epgUrl && parsed.epgUrl) list.epgUrl = parsed.epgUrl
    list.error = null
    save()
    if (list.epgUrl) loadEpg(list).catch(() => {})
    return data
  })().finally(() => loading.delete(list.id))
  loading.set(list.id, p)
  return p
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
      data = await readRows(id)
      mem.set(id, data)
    } catch {}
  }
  if (!data) data = await load(list)
  else if (list.url && Date.now() - data.at > REFRESH_MS) load(list).catch((e) => ((list.error = String(e.message || e)), save()))
  return data
}

// Tür + grup dizini (bir kez kurulur): grup açılınca 115 bin satır baştan taranmasın.
function index(data, kind, group) {
  data.idx ||= new Map()
  const key = kind + '\u0000' + (group ?? '')
  let a = data.idx.get(key)
  if (!a) {
    const out = []
    for (let i = 0; i < data.rows.length; i++) { const r = data.rows[i]; if (r[4] === kind && (group == null || r[2] === group)) out.push(i) }
    a = Int32Array.from(out)
    if (data.idx.size > 60) data.idx.delete(data.idx.keys().next().value)
    data.idx.set(key, a)
  }
  return a
}
// Tarayıcıya giden kısa satır: [i, ad, logo, grup, tvg-id, numara, tür]
const slim = (data, i) => { const r = data.rows[i]; return r ? [i, r[0], r[1], r[2], r[3], r[5], r[4]] : null }

// Sayfa sayfa satır: tarayıcı sadece ekrandakini ister (eskiden bütün liste tek JSON'da iniyordu).
async function rows(id, { kind, group, q, from = 0, n = 200, idx }) {
  const data = await channels(id)
  if (!data) return null
  if (idx) return { total: idx.length, rows: idx.map((i) => slim(data, i)).filter(Boolean) }
  if (q) {
    const needle = q.toLocaleLowerCase('tr')
    const out = []
    for (let i = 0; i < data.rows.length && out.length < 300; i++) {
      const r = data.rows[i]
      if ((!kind || r[4] === kind) && r[0].toLocaleLowerCase('tr').includes(needle)) out.push(slim(data, i))
    }
    return { total: out.length, rows: out }
  }
  const a = index(data, kind, group || null)
  const end = Math.min(a.length, from + Math.min(n, 500))
  const out = []
  for (let k = from; k < end; k++) out.push(slim(data, a[k]))
  return { total: a.length, from, rows: out }
}

async function refresh(id) {
  const list = state.lists.find((l) => l.id === id)
  if (!list) return null
  await load(list)
  return publicList(list)
}

function channel(id, i) {
  const r = mem.get(id)?.rows[i]
  return r ? { name: r[0], url: r[6], ua: r[7], ref: r[8], kind: r[4] === 'l' ? 'live' : r[4] === 'm' ? 'movie' : 'series' } : null
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
        ;(byId[ch] ||= []).push({ s: s0, e: e0, t: unesc(t.trim()), d: d ? unesc(d.trim()).slice(0, 200) : '' })
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

module.exports = { exportDefs, init, add, remove, lists, channels, rows, refresh, channel, epg }
