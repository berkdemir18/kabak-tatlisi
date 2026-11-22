// BerkStream N Tesla — web sunucusu. N'in beyni (hub raflari, Nuvio kaynak taramasi, yayin
// aktarma, Turkce altyazi) + IPTV. Tek sifre, cihaz 400 gun hatirlanir.
const http = require('http')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { Readable } = require('stream')
const hub = require('./hub.cjs')
const plugins = require('./plugins.cjs')
const iptv = require('./iptv.cjs')
const { decodeText, toVtt } = require('./dl-core.cjs')

const ROOT = path.join(__dirname, '..')
const DATA = process.env.BS_DATA || path.join(ROOT, 'data')
const PUB = path.join(ROOT, 'public')
fs.mkdirSync(DATA, { recursive: true })

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return {}
  }
}
const cfg = { ...readJson(path.join(ROOT, '..', 'BerkStream-N-PC', 'config.local.json')), ...readJson(path.join(DATA, 'config.json')) }
const TMDB = process.env.TMDB_API_KEY || cfg.tmdbApiKey || ''
const PASSWORD = process.env.BS_PASSWORD || cfg.password || ''
const USERNAME = process.env.BS_USER || cfg.username || ''
if (!PASSWORD || !USERNAME) console.warn('[uyari] BS_USER / BS_PASSWORD ayarli degil: giris kapali')
const PORT = +(process.env.PORT || cfg.port || 8790)
let SECRET = process.env.BS_SECRET || cfg.secret
if (!SECRET) {
  SECRET = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ ...readJson(path.join(DATA, 'config.json')), secret: SECRET }, null, 2))
}

hub.init({ tmdbApiKey: TMDB, dir: path.join(DATA, 'hub') })
plugins.init({ tmdbApiKey: TMDB, dir: path.join(DATA, 'plugins') })
iptv.init(path.join(DATA, 'iptv'))
setTimeout(() => plugins.ensure().catch(() => {}), 500)
// Raflar açılışta arkada ısıtılır: deploy sonrası (Render diski boş) ilk menü tıklaması 10+ sn sürüyordu.
async function warmShelves() {
  const home = hub.home()
  const ids = home.shelves.map((x) => x.id)
  for (const p of home.platforms) ids.push(...(hub.platformPage(p.key)?.shelves || []).slice(0, 5).map((x) => x.id))
  for (const id of ids) {
    await hub.shelfItems(id, 1).catch(() => {})
    await new Promise((r) => setTimeout(r, 250))
  }
}
setTimeout(() => warmShelves().catch(() => {}), 4000)
setInterval(() => warmShelves().catch(() => {}), 6 * 3600e3)
setInterval(() => plugins.ensure().catch(() => {}), 3600e3)

// ---------------------------------------------------------------- kayit (Listem, kaldigin yer)

const storeFile = path.join(DATA, 'store.json')
let store = { list: [], progress: {}, settings: { subLang: 'tr', subSize: 100 }, favs: [], recentCh: [] }
store = { ...store, ...readJson(storeFile) }
// Disk gerçekten silinmiş mi (Render uyuyup kalkınca): tarayıcı yedeği sadece o zaman geri yüklenir.
// "Sunucu boş" ölçütü yetmiyordu: tek IPTV listeni silince de boş görünüyordu, yedek onu geri getiriyordu.
let fresh = !fs.existsSync(storeFile) && !iptv.lists().length
let saveT = null
const saveStore = () => {
  fresh = false
  clearTimeout(saveT)
  saveT = setTimeout(() => hub.safeWrite(storeFile, JSON.stringify(store)), 300)
}

// ---------------------------------------------------------------- giris

const AUTH = crypto.createHmac('sha256', SECRET).update('bs2:' + USERNAME + ':' + PASSWORD).digest('base64url')
const COOKIE_AGE = 400 * 24 * 3600
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => [c.split('=')[0], decodeURIComponent(c.split('=').slice(1).join('='))]))
const authed = (req) => {
  const c = cookies(req).bst || ''
  return c.length === AUTH.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(AUTH))
}
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted
const authCookie = (req) => `bst=${AUTH}; Max-Age=${COOKIE_AGE}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`
const fails = new Map()
// Kapı (Render) ile ev sunucusu (PC) arasındaki ortak anahtar: ikisinde de aynı kullanıcı adı + şifre.
const SSO_KEY = crypto.createHash('sha256').update('sso1:' + USERNAME + ':' + PASSWORD).digest()
const sso = (msg) => crypto.createHmac('sha256', SSO_KEY).update(msg).digest('base64url')
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }
let HOME = null
module.exports = { sso }

// ---------------------------------------------------------------- yardimcilar

function send(req, res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const h = { 'content-type': type, 'cache-control': 'no-store', ...extra }
  if (buf.length > 1400 && /gzip/.test(req.headers['accept-encoding'] || '') && /json|text|javascript|css|html/.test(type)) {
    buf = zlib.gzipSync(buf, { level: 5 })
    h['content-encoding'] = 'gzip'
  }
  h['content-length'] = buf.length
  res.writeHead(code, h)
  res.end(buf)
}
const json = (req, res, v) => send(req, res, 200, v ?? null)
async function body(req) {
  const parts = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > 30e6) throw new Error('çok büyük')
    parts.push(c)
  }
  const t = Buffer.concat(parts).toString('utf8')
  return t ? JSON.parse(t) : {}
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.ico': 'image/x-icon', '.webp': 'image/webp' }
// Statik dosyalar bellekte, sıkıştırılmış halleriyle; ETag ile değişmediyse 304 (araba her açılışta
// app.js'i baştan indirmesin, sunucu her istekte yeniden sıkıştırmasın).
const staticCache = new Map()
function serveStatic(req, res, file) {
  const f = path.normalize(path.join(PUB, file))
  if (!f.startsWith(PUB)) return send(req, res, 403, 'yok', 'text/plain')
  let c = staticCache.get(f)
  try {
    const st = fs.statSync(f)
    if (!c || c.mtime !== st.mtimeMs) {
      const buf = fs.readFileSync(f)
      const type = MIME[path.extname(f)] || 'application/octet-stream'
      const gz = /json|text|javascript|css|html|svg/.test(type) && buf.length > 1400 ? zlib.gzipSync(buf, { level: 9 }) : null
      c = { mtime: st.mtimeMs, buf, gz, type, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16) + '"' }
      staticCache.set(f, c)
    }
  } catch {
    return send(req, res, 404, 'yok', 'text/plain')
  }
  const long = /hls|mpegts|logo-b|icon/.test(file)
  const h = { 'content-type': c.type, 'cache-control': long ? 'public, max-age=604800' : 'no-cache', etag: c.etag, vary: 'accept-encoding' }
  if (req.headers['if-none-match'] === c.etag) return res.writeHead(304, h).end()
  const useGz = c.gz && /gzip/.test(req.headers['accept-encoding'] || '')
  const body = useGz ? c.gz : c.buf
  if (useGz) h['content-encoding'] = 'gzip'
  h['content-length'] = body.length
  res.writeHead(200, h)
  res.end(body)
}

// ---------------------------------------------------------------- yayin aktarma (proxy.cjs'in web hali)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s) => Buffer.from(s || '', 'base64url').toString('utf8')
const streamUrl = (url, headers) => `/s?u=${b64(url)}${headers && Object.keys(headers).length ? `&h=${b64(JSON.stringify(headers))}` : ''}`
const subUrl = (url, headers) => `/sub?u=${b64(url)}${headers && Object.keys(headers).length ? `&h=${b64(JSON.stringify(headers))}` : ''}`

function upstreamHeaders(extra, req) {
  const h = { 'user-agent': UA, accept: '*/*' }
  for (const [k, v] of Object.entries(extra || {})) h[k.toLowerCase()] = v
  if (req?.headers.range) h.range = req.headers.range
  return h
}
const isListHead = (b) => Buffer.from(b.subarray(0, 64)).toString('utf8').replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')
function rewritePlaylist(text, base, headers) {
  const abs = (u) => {
    try {
      return new URL(u, base).toString()
    } catch {
      return u
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${streamUrl(abs(u), headers)}"`)
      return streamUrl(abs(t), headers)
    })
    .join('\n')
}

async function handleStream(req, res, q) {
  const url = unb64(q.get('u'))
  if (!/^https?:\/\//.test(url)) return send(req, res, 400, 'adres', 'text/plain')
  const headers = q.get('h') ? JSON.parse(unb64(q.get('h'))) : null
  const ctrl = new AbortController()
  res.on('close', () => ctrl.abort())
  const up = await fetch(url, { headers: upstreamHeaders(headers, req), signal: ctrl.signal, redirect: 'follow' })
  const type = up.headers.get('content-type') || ''
  const len = parseInt(up.headers.get('content-length') || '0')
  const maybeList = /mpegurl/i.test(type) || /\.m3u8?(\?|$)/i.test(url) || (len > 0 && len < 3e6 && !/video|audio|mp2t/.test(type) && /\.(m3u8|txt)|playlist|master|index/i.test(url))
  const cors = { 'access-control-allow-origin': '*' }
  if (maybeList) {
    const buf = Buffer.from(await up.arrayBuffer())
    if (isListHead(buf)) return send(req, res, up.status === 206 ? 200 : up.status, rewritePlaylist(buf.toString('utf8'), up.url || url, headers), 'application/vnd.apple.mpegurl', cors)
    res.writeHead(up.status, { 'content-type': type || 'application/octet-stream', ...cors })
    return res.end(buf)
  }
  const pass = { ...cors }
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
    const v = up.headers.get(k)
    if (v) pass[k] = v
  }
  if (!up.body) return res.writeHead(up.status, pass).end()
  const reader = up.body.getReader()
  const first = req.headers.range ? null : await reader.read().catch(() => null)
  if (first?.value && isListHead(first.value)) {
    const parts = [Buffer.from(first.value)]
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      parts.push(Buffer.from(r.value))
    }
    return send(req, res, up.status === 206 ? 200 : up.status, rewritePlaylist(Buffer.concat(parts).toString('utf8'), up.url || url, headers), 'application/vnd.apple.mpegurl', cors)
  }
  if (/image\//.test(pass['content-type'] || '')) pass['content-type'] = 'video/mp2t'
  res.writeHead(up.status, pass)
  const rest = new ReadableStream({
    start(c) {
      if (first?.value) c.enqueue(first.value)
      if (first?.done) c.close()
    },
    async pull(c) {
      const r = await reader.read()
      if (r.done) c.close()
      else c.enqueue(r.value)
    },
    cancel: (e) => reader.cancel(e),
  })
  Readable.fromWeb(rest).on('error', () => res.destroy()).pipe(res)
}

async function handleSub(req, res, q) {
  const url = unb64(q.get('u'))
  const headers = q.get('h') ? JSON.parse(unb64(q.get('h'))) : null
  const up = await fetch(url, { headers: upstreamHeaders(headers), signal: AbortSignal.timeout(15000) })
  let buf = Buffer.from(await up.arrayBuffer())
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
  send(req, res, 200, toVtt(decodeText(buf)), 'text/vtt; charset=utf-8', { 'access-control-allow-origin': '*' })
}

async function openSubtitles({ imdbId, kind, season, episode }) {
  if (!imdbId) return []
  const id = kind === 'tv' ? `${imdbId}:${season}:${episode}` : imdbId
  try {
    const r = await fetch(`https://opensubtitles-v3.strem.io/subtitles/${kind === 'tv' ? 'series' : 'movie'}/${id}.json`, { signal: AbortSignal.timeout(12000) })
    const j = await r.json()
    const subs = (j.subtitles || []).filter((s) => s.lang === 'tur' || s.lang === 'eng')
    const tr = subs.filter((s) => s.lang === 'tur').slice(0, 4)
    const en = subs.filter((s) => s.lang === 'eng').slice(0, 2)
    return [...tr, ...en].map((s, i) => ({ url: subUrl(s.url), lang: s.lang === 'tur' ? 'tr' : 'en', label: `${s.lang === 'tur' ? 'Türkçe' : 'İngilizce'} • OpenSubtitles ${i + 1}` }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- kaynak taramasi (SSE)

const scans = new Map()
const SCAN_TTL = 10 * 60e3
function getScan(r) {
  const key = `${r.kind}:${r.tmdbId}:${r.season ?? ''}:${r.episode ?? ''}`
  const old = scans.get(key)
  if (old && !old.cancelled && (!old.done || Date.now() - old.at < SCAN_TTL)) return old
  const scan = { streams: [], total: 0, finished: 0, done: false, at: Date.now(), subs: new Set(), cancelled: false, pending: new Set() }
  const expect = expectedMinutes(r)
  scans.set(key, scan)
  const active = [...scans.values()].filter((x) => !x.done && !x.cancelled && x !== scan)
  for (const x of active.slice(0, Math.max(0, active.length - 1))) if (!x.subs.size) x.cancelled = true
  const push = (msg) => {
    for (const res of scan.subs) res.write(`data: ${JSON.stringify(msg)}\n\n`)
  }
  plugins
    .ensure()
    .catch(() => {})
    .then(() =>
      plugins.getStreams(
        r,
        (p) => {
          scan.total = p.total
          scan.finished = p.finished
          push({ total: p.total, finished: p.finished, streams: [], scraper: p.scraper })
          if (!p.streams?.length) return
          // Kaynak tarayıcıya gitmeden önce yoklanır: Render'ın IP'sini reddeden (428/403/404)
          // kaynaklar listenin başına geçip oynatıcıyı boşuna oyalıyordu.
          const job = Promise.all([expect, ...p.streams.map((s) => probe(s))]).then(([min, ...infos]) => {
            const list = p.streams.map((s, k) => {
              const inf = infos[k]
              if (!inf.ok) return null
              const x = { ...s, dur: inf.dur || null, audio: inf.audio || [], subsIn: inf.subs || [] }
              if (x.audio.some((a) => isTrText(a.name) || isTrText(a.lang))) x.trAudio = true
              if (x.subsIn.some((a) => isTrText(a.name) || isTrText(a.lang))) x.trSubIn = true
              if (wrongLength(x.dur, min)) x.wrong = true
              else if (x.dur && min) x.verified = true
              return x
            })
            const streams = list.filter(Boolean).map(webStream)
            scan.dropped = (scan.dropped || 0) + list.length - streams.length
            if (!streams.length || scan.cancelled) return
            scan.streams.push(...streams)
            push({ total: scan.total, finished: scan.finished, streams })
          })
          scan.pending.add(job)
          job.finally(() => scan.pending.delete(job))
        },
        () => scan.cancelled
      )
    )
    .finally(async () => {
      await Promise.allSettled([...scan.pending])
      scan.done = true
      scan.at = Date.now()
      if (scan.cancelled) scans.delete(key)
      push({ done: true })
      for (const res of scan.subs) res.end()
      scan.subs.clear()
    })
  return scan
}
// Kaynak yoklaması: açılıyor mu + HLS ise süresi, ses kanalları, gömülü altyazıları.
// Süre beklenenle tutmuyorsa yanlış içerik (Breaking Bad bölümü yerine 123 dk'lık film geliyordu,
// "TR Dublaj 1080p" yazdığı için de listenin başına geçiyordu).
const attrOf = (line, k) => new RegExp(`${k}="([^"]*)"`, 'i').exec(line)?.[1] || ''
const isTrText = (t) => /t[uü]rk|\btur\b|\btr\b/i.test(t || '')
async function probe(s) {
  const ctrl = new AbortController()
  let timedOut = false
  const t = setTimeout(() => { timedOut = true; ctrl.abort() }, 8000)
  const get = (u) => fetch(u, { headers: upstreamHeaders(s.headers), signal: ctrl.signal, redirect: 'follow' })
  const readText = async (r) => {
    const reader = r.body?.getReader()
    if (!reader) return ''
    const parts = []
    let n = 0
    for (;;) {
      const x = await reader.read()
      if (x.done) break
      parts.push(x.value)
      n += x.value.length
      if (n > 2e6) { reader.cancel().catch(() => {}); break }
    }
    return Buffer.concat(parts).toString('utf8')
  }
  try {
    const up = await get(s.url)
    if (up.status >= 400 && up.status !== 405) return { ok: false }
    const type = up.headers.get('content-type') || ''
    if (!/mpegurl|text|octet/i.test(type) && !/\.m3u8?(\?|$)/i.test(s.url)) return { ok: true }
    let text = await readText(up)
    if (!text.trimStart().startsWith('#EXTM3U')) return { ok: true }
    const info = { ok: true, audio: [], subs: [] }
    if (/#EXT-X-STREAM-INF/.test(text)) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('#EXT-X-MEDIA:')) continue
        const tr = { name: attrOf(line, 'NAME'), lang: attrOf(line, 'LANGUAGE') }
        if (/TYPE=AUDIO/i.test(line)) info.audio.push(tr)
        else if (/TYPE=SUBTITLES/i.test(line)) info.subs.push(tr)
      }
      const variant = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))
      if (!variant) return info
      const r2 = await get(new URL(variant.trim(), up.url || s.url).toString())
      if (r2.status >= 400) return { ok: false }
      text = await readText(r2)
    }
    let sum = 0
    for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) sum += +m[1]
    if (sum > 60 && /#EXT-X-ENDLIST/.test(text)) info.dur = Math.round(sum)
    return info
  } catch {
    return { ok: timedOut } // yavaş ama belki yaşıyor: elenmez, sona düşer
  } finally {
    clearTimeout(t)
    ctrl.abort()
  }
}
// Beklenen süre (dk): filmde TMDB süresi, dizide o bölümün süresi.
async function expectedMinutes(r) {
  try {
    if (r.kind === 'tv' && r.season != null) {
      const eps = await hub.season(r.tmdbId, r.season)
      const ep = (eps || []).find((x) => x.number === r.episode)
      if (ep?.runtime) return ep.runtime
    }
    return (await hub.detail(r.kind, r.tmdbId))?.runtime || null
  } catch {
    return null
  }
}
const wrongLength = (sec, min) => !!(sec && min) && Math.abs(sec / 60 - min) > Math.max(7, min * 0.2)
// Tarayici yayini her zaman bizim uzerimizden alir: Referer/Origin basliklari, CORS ve http→https.
const webStream = (s) => ({ ...s, play: streamUrl(s.url, s.headers), subtitles: (s.subtitles || []).map((x) => ({ ...x, url: subUrl(x.url, s.headers) })) })

function handleStreams(req, res, q) {
  const r = { kind: q.get('kind') === 'tv' ? 'tv' : 'movie', tmdbId: +q.get('id'), season: q.get('s') ? +q.get('s') : undefined, episode: q.get('e') ? +q.get('e') : undefined }
  const scan = getScan(r)
  if (q.get('prefetch')) return json(req, res, true)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write(`data: ${JSON.stringify({ total: scan.total, finished: scan.finished, streams: scan.streams })}\n\n`)
  if (scan.done) {
    res.write(`data: {"done":true}\n\n`)
    return res.end()
  }
  scan.subs.add(res)
  req.on('close', () => scan.subs.delete(res))
}

// ---------------------------------------------------------------- yonlendirme

async function api(req, res, u) {
  const q = u.searchParams
  const p = u.pathname
  const m = req.method
  if (p === '/api/home') return json(req, res, hub.home())
  if (p === '/api/shelf') return json(req, res, await hub.shelfItems(q.get('id'), +q.get('page') || 1))
  if (p === '/api/platform') return json(req, res, hub.platformPage(q.get('key')))
  if (p === '/api/detail') return json(req, res, await hub.detail(q.get('kind'), +q.get('id')))
  if (p === '/api/season') return json(req, res, await hub.season(+q.get('id'), +q.get('n')))
  if (p === '/api/search') return json(req, res, await hub.search(q.get('q') || ''))
  if (p === '/api/streams') return handleStreams(req, res, q)
  if (p === '/api/subs') return json(req, res, await openSubtitles({ imdbId: q.get('imdb'), kind: q.get('kind'), season: q.get('s'), episode: q.get('e') }))
  if (p === '/api/store') return json(req, res, { ...store, _fresh: fresh })
  if (p === '/api/list' && m === 'POST') {
    const item = await body(req)
    const k = `${item.kind}:${item.id}`
    const i = store.list.findIndex((x) => `${x.kind}:${x.id}` === k)
    if (i >= 0) store.list.splice(i, 1)
    else store.list.unshift({ ...item, addedAt: Date.now() })
    saveStore()
    return json(req, res, store.list)
  }
  if (p === '/api/progress' && m === 'POST') {
    const { key, value } = await body(req)
    if (value === null) delete store.progress[key]
    else store.progress[key] = { ...value, updatedAt: Date.now() }
    const keys = Object.keys(store.progress)
    if (keys.length > 300) keys.sort((a, b) => store.progress[a].updatedAt - store.progress[b].updatedAt).slice(0, 50).forEach((k) => delete store.progress[k])
    saveStore()
    return json(req, res, true)
  }
  if (p === '/api/settings' && m === 'POST') {
    store.settings = { ...store.settings, ...(await body(req)) }
    saveStore()
    return json(req, res, store.settings)
  }
  if (p === '/api/fav' && m === 'POST') {
    const { key } = await body(req)
    const i = store.favs.indexOf(key)
    if (i >= 0) store.favs.splice(i, 1)
    else store.favs.unshift(key)
    saveStore()
    return json(req, res, store.favs)
  }
  if (p === '/api/recent' && m === 'POST') {
    const { key } = await body(req)
    store.recentCh = [key, ...store.recentCh.filter((k) => k !== key)].slice(0, 30)
    saveStore()
    return json(req, res, store.recentCh)
  }
  // Yedek: sunucunun diski silinirse (Render) tarayıcıdaki kopyadan geri yüklenir.
  if (p === '/api/backup') return json(req, res, { fresh, store, iptv: iptv.exportDefs() })
  if (p === '/api/restore' && m === 'POST') {
    const b = await body(req)
    if (!fresh) return json(req, res, { ok: true, restoredStore: false, added: 0 })
    const empty = !store.list.length && !Object.keys(store.progress).length && !store.favs.length
    if (empty && b.store) {
      store = { ...store, ...b.store }
      saveStore()
    }
    // IPTV listeleri arkada iner (büyük liste dakika sürebilir): sayfa beklemeden açılır.
    const defs = !iptv.lists().length && Array.isArray(b.iptv) ? b.iptv : []
    ;(async () => { for (const d of defs) await iptv.add(d).catch(() => {}) })()
    fresh = false
    saveStore()
    return json(req, res, { ok: true, restoredStore: empty && !!b.store, pendingIptv: defs.length })
  }
  // IPTV
  if (p === '/api/iptv' && m === 'GET') return json(req, res, iptv.lists())
  if (p === '/api/iptv' && m === 'POST') {
    try {
      const { id, ...def } = await body(req)
      fresh = false
      return json(req, res, { ok: true, list: await iptv.add(def) })
    } catch (e) {
      return json(req, res, { ok: false, error: String(e?.message || e) })
    }
  }
  if (p === '/api/iptv' && m === 'DELETE') {
    fresh = false
    iptv.remove(q.get('id'))
    saveStore()
    return json(req, res, iptv.lists())
  }
  if (p === '/api/iptv/refresh') {
    try {
      return json(req, res, { ok: true, list: await iptv.refresh(q.get('id')) })
    } catch (e) {
      return json(req, res, { ok: false, error: String(e?.message || e) })
    }
  }
  // Sadece gruplar; kanallar sayfa sayfa /api/iptv/rows'tan (115 bin satırı tek JSON'da yollamak
  // hem sunucuyu çökertiyor hem arabanın tarayıcısını kilitliyordu).
  if (p === '/api/iptv/groups') return json(req, res, await iptv.summaries(q.get('id')))
  if (p === '/api/iptv/edit' && m === 'POST') {
    const b = await body(req)
    if (!iptv.setEdit(b.id, b.kind, b.edit)) return json(req, res, null)
    return json(req, res, await iptv.summaries(b.id))
  }
  if (p === '/api/iptv/rows') {
    const idx = q.get('idx') ? q.get('idx').split(',').map(Number).filter((n) => n >= 0).slice(0, 500) : null
    return json(req, res, await iptv.rows(q.get('id'), { kind: q.get('kind') || '', group: q.get('group'), theme: q.get('theme'), q: q.get('q'), from: +q.get('from') || 0, n: +q.get('n') || 200, idx }))
  }
  if (p === '/api/iptv/episodes') return json(req, res, await iptv.episodes(q.get('id'), +q.get('i')))
  if (p === '/api/iptv/play') {
    const id = q.get('id')
    await iptv.channels(id)
    const c = iptv.channel(id, +q.get('i'))
    if (!c) return json(req, res, null)
    const h = {}
    if (c.ua) h['user-agent'] = c.ua
    if (c.ref) h.referer = c.ref
    return json(req, res, { url: streamUrl(c.url, h), direct: /^https:/.test(c.url) && !c.ua && !c.ref ? c.url : null, ts: /\.ts(\?|$)/i.test(c.url) || (!/\.m3u8?(\?|$)/i.test(c.url) && !/\.(mp4|mkv)(\?|$)/i.test(c.url) && c.kind === 'live'), mp4: /\.(mp4|mkv)(\?|$)/i.test(c.url) })
  }
  if (p === '/api/iptv/epg') return json(req, res, await iptv.epg(q.get('id'), (q.get('t') || '').split(',').filter(Boolean).slice(0, 200)))
  if (p === '/api/plugins') return json(req, res, plugins.list())
  return send(req, res, 404, { error: 'yok' })
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  try {
    if (u.pathname === '/login' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress
      const f = fails.get(ip) || { n: 0, at: 0 }
      if (f.n >= 8 && Date.now() - f.at < 10 * 60e3) return json(req, res, { ok: false, error: 'Çok deneme, 10 dk bekle' })
      const { username, password } = await body(req)
      const eq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }
      if (PASSWORD && USERNAME && eq(username?.trim(), USERNAME) & eq(password, PASSWORD)) {
        fails.delete(ip)
        return send(req, res, 200, { ok: true }, undefined, { 'set-cookie': authCookie(req) })
      }
      fails.set(ip, { n: f.n + 1, at: Date.now() })
      return json(req, res, { ok: false, error: 'Kullanıcı adı ya da şifre yanlış' })
    }
    if (u.pathname === '/logout') return send(req, res, 302, '', 'text/plain', { 'set-cookie': 'bst=; Max-Age=0; Path=/', location: '/' })
    if (u.pathname === '/robots.txt') return send(req, res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain')
    if (u.pathname === '/healthz') return send(req, res, 200, 'ok', 'text/plain')
    // Ev sunucusu (PC, Türkiye IP'si) kendini kapıya (Render) kaydeder; kapı girişliyi oraya geçirir.
    if (u.pathname === '/api/home-register' && req.method === 'POST') {
      const { url, ts, sig } = await body(req)
      if (!/^https:\/\/[a-z0-9.-]+$/i.test(url || '') || Math.abs(Date.now() - ts) > 5 * 60e3 || !safeEq(sig, sso(`home|${url}|${ts}`))) return send(req, res, 403, { ok: false })
      HOME = { url, at: Date.now() }
      return json(req, res, { ok: true })
    }
    if (u.pathname === '/sso') {
      const exp = +u.searchParams.get('exp')
      if (exp > Date.now() && exp < Date.now() + 5 * 60e3 && safeEq(u.searchParams.get('t'), sso(`sso|${exp}`))) return send(req, res, 302, '', 'text/plain', { 'set-cookie': authCookie(req), location: '/' })
      return send(req, res, 302, '', 'text/plain', { location: '/' })
    }
    if (!authed(req)) {
      if (u.pathname.startsWith('/api/') || u.pathname === '/s' || u.pathname === '/sub') return send(req, res, 401, { error: 'giriş' })
      return serveStatic(req, res, 'login.html')
    }
    if (u.pathname === '/s') return await handleStream(req, res, u.searchParams)
    if (u.pathname === '/sub') return await handleSub(req, res, u.searchParams)
    if (u.pathname.startsWith('/api/')) return await api(req, res, u)
    if (u.pathname === '/' || u.pathname === '/index.html') {
      if (HOME && Date.now() - HOME.at < 10 * 60e3 && !u.searchParams.has('burada')) {
        const exp = Date.now() + 2 * 60e3
        return send(req, res, 302, '', 'text/plain', { location: `${HOME.url}/sso?exp=${exp}&t=${sso(`sso|${exp}`)}` })
      }
      // Her girişte çerez tazelenir: cihaz hiç çıkış yapmadıkça hep hatırlanır.
      res.setHeader('set-cookie', authCookie(req))
      return serveStatic(req, res, 'index.html')
    }
    return serveStatic(req, res, u.pathname)
  } catch (e) {
    if (!res.headersSent) send(req, res, 502, { error: String(e?.message || e) })
    else res.destroy()
  }
})
server.listen(PORT, '0.0.0.0', () => console.log(`BerkStream N Tesla: http://localhost:${PORT}`))

// Render Free 15 dk istek gelmezse servisi uyutur: uyanmak 30-60 sn sürüyor ve disk (raf önbelleği,
// IPTV listeleri) siliniyor. Kendi dış adresine 10 dk'da bir dokunup uyanık kalır.
if (process.env.RENDER_EXTERNAL_URL) setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/healthz', { signal: AbortSignal.timeout(15000) }).catch(() => {}), 10 * 60e3)
