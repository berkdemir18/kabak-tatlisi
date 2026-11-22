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

// ---------------------------------------------------------------- kategoriler
// Grup adından (o boşsa/genelse kanal adından) konu çıkar: "SPOR KANALLARI" + "YABANCI SPOR" → Spor,
// "TR | BEIN" → Spor. Eşleşme sırası önemli (YABANCI SPOR önce Spor'a düşer), gösterim sırası ayrı.
const LIVE_THEMES = [
  ['radyo', '📻', 'Radyo', /radyo|radio|\bfm\b/i],
  ['cocuk', '🧸', 'Çocuk', /çocuk|cocuk|kids|child|cartoon|çizgi|cizgi|disney|nick|baby|minika|cartoon/i],
  ['spor', '⚽', 'Spor', /spor|sport|bein|futbol|football|soccer|\bnba\b|\bf1\b|eurosport|arena/i],
  ['haber', '📰', 'Haber', /haber|news|cnn|al ?jazeera|ntv\b|tgrt|halk tv|sözcü|sozcu/i],
  ['belgesel', '🌍', 'Belgesel', /belgesel|document|nat ?geo|discovery|history|animal|viasat|da ?vinci|bbc earth/i],
  ['muzik', '🎵', 'Müzik', /müzik|muzik|music|\bmtv\b|kral|power ?t[uü]rk|number ?1|dream ?t[uü]rk/i],
  ['dini', '🕌', 'Dini', /dini|religi|islam|kuran|quran|diyanet|semerkand|mekke|lalegül|dua/i],
  ['sinema', '🎬', 'Sinema & Dizi', /sinema|cinema|film|movie|dizi|series|\bvod\b|blu ?tv|tabii|netflix|digiturk|d-?smart|tivibu|sinemax|yesilcam|yeşilçam/i],
  ['yerel', '📍', 'Yerel', /yerel|local|bölgesel|bolgesel/i],
  ['yabanci', '🌐', 'Yabancı & Bölgesel', /avrupa|europe|yabanc|foreign|international|azerbaycan|azerbaijan|kıbrıs|kibris|cyprus|kürt|kurd|arap|arab|german|deutsch|alman|\buk\b|\busa?\b|\bde\b|\bfr\b|\bnl\b|\bru\b|balkan|türkmen|turkmen|iran|irak|ira[qk]|\bit\b|\bes\b/i],
  ['ulusal', '📺', 'Ulusal', /ulusal|national|genel|general|eğlence|eglence|entertainment|t[uü]rk|\btr\b|trt|\batv\b|show ?tv|star ?tv|kanal ?d|\bnow\b|tv ?8|teve2|beyaz ?tv|kanal ?7/i],
]
const LIVE_ORDER = ['ulusal', 'spor', 'haber', 'sinema', 'belgesel', 'cocuk', 'muzik', 'dini', 'yerel', 'yabanci', 'radyo', 'diger']
const VOD_THEMES = [
  ['yeni', '🆕', 'Yeni Eklenenler', /yeni|\bnew\b|vizyon|son eklenen|latest|recent/i],
  ['platform', '📺', 'Platformlar', /netflix|disney|amazon|prime|\bhbo\b|\bmax\b|exxen|blu ?tv|tabii|\bgain\b|apple ?tv|mubi|puhu/i],
  ['cocuk', '🧸', 'Çocuk & Animasyon', /çocuk|cocuk|kids|animasyon|animation|anime|çizgi|cizgi|cartoon|disney|pixar|aile|family/i],
  ['korku', '👻', 'Korku & Gerilim', /korku|horror|gerilim|thriller|slasher/i],
  ['bilimkurgu', '🚀', 'Bilim Kurgu & Fantastik', /bilim ?kurgu|sci-?fi|fantasti|fantasy|science/i],
  ['aksiyon', '💥', 'Aksiyon & Macera', /aksiyon|action|macera|adventure|savaş|savas|\bwar\b|western/i],
  ['komedi', '😂', 'Komedi', /komedi|comedy/i],
  ['suc', '🔪', 'Suç & Gizem', /suç|\bsuc\b|crime|polisiye|mafya|gizem|mystery/i],
  ['dram', '🎭', 'Dram & Romantik', /dram|drama|romant|romance|\başk\b/i],
  ['belgesel', '🌍', 'Belgesel', /belgesel|document|biyografi|biography|tarih|history/i],
  ['yerli', '🇹🇷', 'Yerli', /yerli|t[uü]rk|\btr\b|yeşilçam|yesilcam/i],
  ['uhd', '✨', '4K / UHD', /\b4k\b|uhd|2160/i],
  ['yabanci', '🌐', 'Yabancı', /yabanc|foreign|english|ingilizce|altyaz|\ben\b|\bus\b|\buk\b/i],
]
const VOD_ORDER = ['yeni', 'platform', 'yerli', 'aksiyon', 'komedi', 'dram', 'korku', 'bilimkurgu', 'suc', 'cocuk', 'belgesel', 'uhd', 'yabanci', 'diger']
const info = (list) => ({ ...Object.fromEntries(list.map(([k, icon, title]) => [k, { icon, title }])), diger: { icon: '☰', title: 'Diğer' } })
const LIVE_INFO = info(LIVE_THEMES)
const VOD_INFO = info(VOD_THEMES)
// Hem metnin kendisine hem Türkçe küçük harfine bakılır: JS büyük İ'yi i saymıyor ("SİNEMA" kaçıyordu),
// tr küçültmesi de I'yı ı yapıyor ("KIDS" kaçıyordu).
const themeOf = (text, list) => { const lo = text.toLocaleLowerCase('tr'); return list.find((t) => t[3].test(text) || t[3].test(lo))?.[0] || null }

// Her satıra konu yazılır (r[9]); dizi bölümleri diziye bağlanır (r[10]).
// "Dizi Adı S01 E05", "Dizi Adı - S1E5", "Dizi Adı 1. Sezon 5. Bölüm"
const EP_RE = /^(.*?)[\s._\-|]*(?:S(?:ezon)?\s*(\d{1,2})[\s._-]*(?:E|B|Bölüm|Bolum)\s*(\d{1,4})|(\d{1,2})\.\s*Sezon\s*(\d{1,4})\.\s*B[öo]l[üu]m)/i
function episodeOf(name) {
  const m = EP_RE.exec(name)
  if (!m || !m[1].trim()) return null
  return { show: m[1].replace(/[\s\-|:._]+$/, '').trim(), s: +(m[2] || m[4]), e: +(m[3] || m[5]) }
}
function classify(rows) {
  const byGroup = new Map()
  const intern = new Map()
  const str = (v) => { let x = intern.get(v); if (x === undefined) { intern.set(v, v); x = v } return x }
  for (const r of rows) {
    const list = r[4] === 'l' ? LIVE_THEMES : VOD_THEMES
    const gk = r[4] + '\u0000' + r[2]
    let gt = byGroup.get(gk)
    if (gt === undefined) byGroup.set(gk, (gt = themeOf(r[2], list)))
    r[9] = gt || themeOf(r[0], list) || 'diger'
    if (r[4] === 's') {
      const ep = episodeOf(r[0])
      r[10] = str(r[2] + '\u0000' + (ep ? ep.show.toLocaleLowerCase('tr') : r[0]))
    }
  }
}
function themeSummary(rows) {
  const out = {}
  const K = { l: 'live', m: 'movie', s: 'series' }
  const acc = {}
  for (const r of rows) {
    const k = K[r[4]]
    const t = ((acc[k] ||= new Map()).get(r[9])) || { count: 0, groups: new Map(), seen: new Set() }
    // dizide bölüm değil dizi sayılır
    if (r[4] === 's') { if (t.seen.has(r[10])) continue; t.seen.add(r[10]) }
    t.count++
    t.groups.set(r[2], (t.groups.get(r[2]) || 0) + 1)
    acc[k].set(r[9], t)
  }
  for (const [k, m] of Object.entries(acc)) {
    const order = k === 'live' ? LIVE_ORDER : VOD_ORDER
    const inf = k === 'live' ? LIVE_INFO : VOD_INFO
    out[k] = [...m]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([key, t]) => ({ key, ...inf[key], count: t.count, groups: [...t.groups].map(([name, count]) => ({ name, count })) }))
  }
  return out
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
  ws.write(JSON.stringify({ at: data.at, groups: data.groups, themes: data.themes }) + '\n')
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
  if (!head.themes || rows[0].length < 10) { classify(rows); head.themes = themeSummary(rows) }
  return { ...head, rows }
}

const loading = new Map()
function load(list) {
  if (loading.has(list.id)) return loading.get(list.id)
  const p = (async () => {
    const parsed = await parseList(list)
    classify(parsed.rows)
    const data = { rows: parsed.rows, groups: parsed.groups, themes: themeSummary(parsed.rows), at: Date.now() }
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

async function add({ id: keepId, name, url, text, epgUrl, xtream, edit }) {
  // Yedekten geri yüklenen liste eski kimliğini korur: favoriler/son izlenenler kanala bağlı kalsın.
  const id = /^[a-f0-9]{10}$/.test(keepId || '') && !state.lists.some((l) => l.id === keepId) ? keepId : crypto.randomBytes(5).toString('hex')
  const list = { id, name: name?.trim() || 'IPTV', url: xtream ? xtreamUrl(xtream) : url?.trim() || null, epgUrl: epgUrl?.trim() || null, addedAt: Date.now() }
  if (xtream && !list.epgUrl) list.epgUrl = `${xtream.host.replace(/\/+$/, '')}/xmltv.php?username=${encodeURIComponent(xtream.user)}&password=${encodeURIComponent(xtream.pass)}`
  if (!list.url && !text) throw new Error('Adres ya da liste metni gerekli')
  if (text) list.text = text
  if (edit && typeof edit === 'object') list.edit = edit
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
// ---------------------------------------------------------------- kullanıcı düzenlemeleri
// list.edit[live|movie|series] = { rename: {'th:spor': 'Futbol', 'g:SPOR KANALLARI': 'Yerli'},
//   hidden: ['th:radyo', 'g:KÜRTÇE KANALLAR'], move: {grupAdı: konu}, custom: [{key: 'c:ab12', title, icon}],
//   order: [konu…] }. Listenin içinde durur: yedekle taşınır, Render diski silinse de kaybolmaz.
const KN = { l: 'live', m: 'movie', s: 'series' }
const editOf = (list, kc) => list?.edit?.[KN[kc]] || {}
const effTheme = (r, e) => e.move?.[r[2]] || r[9]
const hiddenRow = (r, e, th) => !!e.hidden?.length && (e.hidden.includes('g:' + r[2]) || e.hidden.includes('th:' + th))

function index(data, kind, group, theme, list) {
  data.idx ||= new Map()
  const e = editOf(list, kind)
  const key = kind + '\u0000' + (group ?? '') + '\u0000' + (theme ?? '') + '\u0000' + (list?.editVer || 0)
  let a = data.idx.get(key)
  if (!a) {
    const out = []
    // dizide her diziden tek satır (ilk bölüm): 78 bin bölüm yerine dizi listesi
    const seen = kind === 's' ? new Set() : null
    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i]
      if (r[4] !== kind || (group != null && r[2] !== group)) continue
      const th = effTheme(r, e)
      if ((theme != null && th !== theme) || hiddenRow(r, e, th)) continue
      if (seen) { if (seen.has(r[10])) continue; seen.add(r[10]) }
      out.push(i)
    }
    a = Int32Array.from(out)
    if (data.idx.size > 60) data.idx.delete(data.idx.keys().next().value)
    data.idx.set(key, a)
  }
  return a
}
// Tarayıcıya giden kısa satır: [i, ad, logo, grup, tvg-id, numara, tür]. Dizide ad = dizi adı.
const showName = (r) => (r[4] === 's' ? episodeOf(r[0])?.show || r[0] : r[0])
const slim = (data, i, asShow) => { const r = data.rows[i]; return r ? [i, asShow ? showName(r) : r[0], r[1], r[2], r[3], r[5], r[4]] : null }

// Sayfa sayfa satır: tarayıcı sadece ekrandakini ister (eskiden bütün liste tek JSON'da iniyordu).
async function rows(id, { kind, group, theme, q, from = 0, n = 200, idx }) {
  const data = await channels(id)
  if (!data) return null
  const list = state.lists.find((l) => l.id === id)
  if (idx) return { total: idx.length, rows: idx.map((i) => slim(data, i)).filter(Boolean) }
  if (q) {
    const needle = q.toLocaleLowerCase('tr')
    const out = []
    const seenShow = new Set()
    for (let i = 0; i < data.rows.length && out.length < 300; i++) {
      const r = data.rows[i]
      if ((!kind || r[4] === kind) && r[0].toLocaleLowerCase('tr').includes(needle)) {
        const e = editOf(list, r[4])
        if (hiddenRow(r, e, effTheme(r, e))) continue
        if (r[4] === 's') { if (seenShow.has(r[10])) continue; seenShow.add(r[10]) }
        out.push(slim(data, i, r[4] === 's'))
      }
    }
    return { total: out.length, rows: out }
  }
  const a = index(data, kind, group || null, theme || null, list)
  const end = Math.min(a.length, from + Math.min(n, 500))
  const out = []
  for (let k = from; k < end; k++) out.push(slim(data, a[k], kind === 's'))
  return { total: a.length, from, rows: out }
}

// Düzenlemeler uygulanmış kategori özeti: görünenler (grup sütunu) + hepsi (düzenleyici, silinenler dahil).
function editedSummary(data, list, kname) {
  const kc = { live: 'l', movie: 'm', series: 's' }[kname]
  const e = editOf(list, kc)
  const ck = kname + ':' + (list?.editVer || 0)
  data.sum ||= {}
  if (data.sum[ck]) return data.sum[ck]
  const acc = new Map()
  for (const r of data.rows) {
    if (r[4] !== kc) continue
    const th = effTheme(r, e)
    let t = acc.get(th)
    if (!t) acc.set(th, (t = { groups: new Map(), seen: kc === 's' ? new Set() : null }))
    if (t.seen) { if (t.seen.has(r[10])) continue; t.seen.add(r[10]) }
    t.groups.set(r[2], (t.groups.get(r[2]) || 0) + 1)
  }
  const custom = e.custom || []
  for (const c of custom) if (!acc.has(c.key)) acc.set(c.key, { groups: new Map() })
  const order = [...(e.order || []), ...(kname === 'live' ? LIVE_ORDER : VOD_ORDER), ...custom.map((c) => c.key)]
  const pos = (k) => { const i = order.indexOf(k); return i < 0 ? 999 : i }
  const inf = kname === 'live' ? LIVE_INFO : VOD_INFO
  const hid = e.hidden || []
  const all = [...acc].sort((a, b) => pos(a[0]) - pos(b[0])).map(([key, t]) => {
    const cu = custom.find((c) => c.key === key)
    const base = cu || inf[key] || { icon: '📁', title: key }
    const groups = [...t.groups].map(([name, count]) => ({ name, title: e.rename?.['g:' + name] || name, count, hidden: hid.includes('g:' + name) }))
    return { key, icon: base.icon || '📁', title: e.rename?.['th:' + key] || base.title, origTitle: base.title, custom: !!cu, hidden: hid.includes('th:' + key), count: groups.reduce((a, g) => a + g.count, 0), groups }
  })
  const visible = all
    .filter((t) => !t.hidden)
    .map((t) => { const groups = t.groups.filter((g) => !g.hidden); return { ...t, groups, count: groups.reduce((a, g) => a + g.count, 0) } })
    .filter((t) => t.groups.length)
  const out = { visible, all }
  for (const k of Object.keys(data.sum)) if (k.startsWith(kname + ':')) delete data.sum[k]
  data.sum[ck] = out
  return out
}
async function summaries(id) {
  const data = await channels(id)
  if (!data) return null
  const list = state.lists.find((l) => l.id === id)
  const themes = {}
  const editor = {}
  for (const k of Object.keys(data.groups)) {
    const x = editedSummary(data, list, k)
    themes[k] = x.visible
    editor[k] = x.all
  }
  return { groups: data.groups, themes, editor, at: data.at }
}
// Düzenleyiciden gelen değişiklik (bir tür için tamamı): şekli süzülür, kayıt sürümü artar.
function setEdit(id, kname, edit) {
  const list = state.lists.find((l) => l.id === id)
  if (!list || !['live', 'movie', 'series'].includes(kname)) return false
  const str = (v, n = 80) => String(v ?? '').slice(0, n)
  const obj = (o, max) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, max).map(([k, v]) => [str(k, 300), str(v)]).filter(([, v]) => v))
  const custom = (Array.isArray(edit?.custom) ? edit.custom : []).filter((c) => /^c:[a-z0-9]{1,12}$/.test(c?.key || '')).slice(0, 40).map((c) => ({ key: c.key, title: str(c.title, 40) || 'Yeni kategori', icon: str(c.icon, 8) || '📁' }))
  const clean = {
    rename: obj(edit?.rename, 500),
    hidden: (Array.isArray(edit?.hidden) ? edit.hidden : []).map((x) => str(x, 300)).slice(0, 1000),
    move: obj(edit?.move, 1000),
    custom,
    order: (Array.isArray(edit?.order) ? edit.order : []).map((x) => str(x, 40)).slice(0, 80),
  }
  list.edit = { ...(list.edit || {}), [kname]: clean }
  list.editVer = (list.editVer || 0) + 1
  save()
  return true
}

// Bir dizinin bütün bölümleri (sezon/bölüm sırasıyla).
async function episodes(id, i) {
  const data = await channels(id)
  const r0 = data?.rows[i]
  if (!r0) return null
  const out = []
  for (let k = 0; k < data.rows.length; k++) {
    const r = data.rows[k]
    if (r[10] !== r0[10]) continue
    const ep = episodeOf(r[0])
    out.push({ row: slim(data, k), s: ep?.s || 1, e: ep?.e || out.length + 1 })
  }
  out.sort((a, b) => a.s - b.s || a.e - b.e)
  return { show: showName(r0), logo: r0[1], group: r0[2], eps: out }
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
const exportDefs = () => state.lists.map((l) => ({ id: l.id, name: l.name, url: l.url, text: l.text, epgUrl: l.epgUrl, edit: l.edit }))

module.exports = { exportDefs, init, add, remove, lists, channels, rows, episodes, summaries, setEdit, refresh, channel, epg }
