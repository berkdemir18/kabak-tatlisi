// İndirme motorunun platformdan bağımsız saf mantığı (Electron'a, dosya sistemine, ağa dokunmaz):
// HLS playlist ayrıştırma, yerel playlist yazma, parça/anahtar/altyazı doğrulama, sahte başlık
// ayıklama, SRT→VTT çevirme. Tablet sürümü de aynen kullanabilir. Testler: test/dl-core.test.cjs

// ---------------------------------------------------------------- playlist ayrıştırma

function parseAttrs(s) {
  const out = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let m
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2]
  return out
}

const absUrl = (u, base) => {
  try {
    return new URL(u, base).toString()
  } catch {
    return u
  }
}

const isPlaylistText = (text) => typeof text === 'string' && text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')

// Master: { type:'master', variants:[{uri,bandwidth,height,width,codecs,audio,subtitles,frameRate}], media:[{type,groupId,name,lang,uri,default}] }
// Media:  { type:'media', segments:[{uri,duration,key,map,byterange,discontinuity}], targetDuration, mediaSequence, version, endList, independent }
function parseM3U8(text, base) {
  if (!isPlaylistText(text)) throw new Error('Playlist değil')
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim())
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = []
    const media = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18))
        let j = i + 1
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++
        if (j >= lines.length) break
        const [w, h] = (a.RESOLUTION || '').split('x').map((x) => parseInt(x) || 0)
        variants.push({
          uri: absUrl(lines[j], base),
          bandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
          width: w || 0,
          height: h || 0,
          codecs: a.CODECS || '',
          audio: a.AUDIO || null,
          subtitles: a.SUBTITLES || null,
          frameRate: a['FRAME-RATE'] || null,
        })
        i = j
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13))
        media.push({
          type: a.TYPE,
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          lang: a.LANGUAGE || '',
          uri: a.URI ? absUrl(a.URI, base) : null,
          default: a.DEFAULT === 'YES',
          channels: a.CHANNELS || null,
        })
      }
    }
    return { type: 'master', variants, media }
  }
  const pl = { type: 'media', segments: [], targetDuration: 0, mediaSequence: 0, version: 3, endList: false, independent: false }
  let key = null
  let map = null
  let dur = null
  let range = null
  let disc = false
  const lastEnd = new Map()
  const parseRange = (v, uri) => {
    const [len, off] = v.split('@')
    const length = parseInt(len)
    const offset = off != null ? parseInt(off) : lastEnd.get(uri) || 0
    return { length, offset }
  }
  for (const l of lines) {
    if (!l) continue
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) pl.targetDuration = parseInt(l.slice(22)) || 0
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.mediaSequence = parseInt(l.slice(22)) || 0
    else if (l.startsWith('#EXT-X-VERSION:')) pl.version = parseInt(l.slice(15)) || 3
    else if (l === '#EXT-X-ENDLIST') pl.endList = true
    else if (l === '#EXT-X-INDEPENDENT-SEGMENTS') pl.independent = true
    else if (l === '#EXT-X-DISCONTINUITY') disc = true
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) pl.playlistType = l.slice(21)
    else if (l.startsWith('#EXT-X-BYTERANGE:')) range = l.slice(17)
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11))
      key = !a.METHOD || a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? absUrl(a.URI, base) : null, iv: a.IV || null, keyFormat: a.KEYFORMAT || null, keyFormatVersions: a.KEYFORMATVERSIONS || null }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11))
      const uri = absUrl(a.URI, base)
      map = { uri, byterange: a.BYTERANGE ? parseRange(a.BYTERANGE, uri) : null }
    } else if (!l.startsWith('#')) {
      const uri = absUrl(l, base)
      const seg = { uri, duration: dur ?? pl.targetDuration, key, map, byterange: null, discontinuity: disc }
      if (range) {
        seg.byterange = parseRange(range, uri)
        lastEnd.set(uri, seg.byterange.offset + seg.byterange.length)
      }
      pl.segments.push(seg)
      dur = null
      range = null
      disc = false
    }
  }
  if (pl.playlistType === 'VOD') pl.endList = true
  return pl
}

// Desteklenmeyen şifreleme (DRM) var mı?
const hasDrm = (pl) => pl.segments.some((s) => s.key && ((s.key.keyFormat && s.key.keyFormat !== 'identity') || !/^(AES-128|SAMPLE-AES)$/.test(s.key.method)))

// İstenen yüksekliğe en yakın (üstü yoksa en iyi) varyant; height yoksa bant genişliğine göre.
function pickVariant(variants, maxHeight = 0) {
  if (!variants.length) return null
  const sorted = [...variants].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)
  if (!maxHeight) return sorted[0]
  return sorted.find((v) => v.height && v.height <= maxHeight) || sorted[sorted.length - 1]
}

// Ses grubundaki ayrı ses parçaları (URI'si olanlar). Dublaj = Türkçe.
function audioOptions(master, variant) {
  const group = variant?.audio
  const list = master.media.filter((m) => m.type === 'AUDIO' && m.uri && (!group || m.groupId === group))
  const seen = new Set()
  return list.filter((m) => {
    const k = `${m.name}|${m.lang}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
const isTurkishTrack = (t) => /^(tr|tur|tür)/i.test(t.lang || '') || /türk|turk|dublaj/i.test(t.name || '')

function subtitleOptions(master, variant) {
  const group = variant?.subtitles
  return master.media.filter((m) => m.type === 'SUBTITLES' && m.uri && (!group || m.groupId === group))
}

// ---------------------------------------------------------------- yerel playlist yazma

const q = (s) => `"${String(s).replace(/"/g, "'")}"`

function keyTag(key, localUri) {
  if (!key) return '#EXT-X-KEY:METHOD=NONE'
  let t = `#EXT-X-KEY:METHOD=${key.method},URI=${q(localUri)}`
  if (key.iv) t += `,IV=${key.iv}`
  if (key.keyFormat) t += `,KEYFORMAT=${q(key.keyFormat)}`
  if (key.keyFormatVersions) t += `,KEYFORMATVERSIONS=${q(key.keyFormatVersions)}`
  return t
}

// names: { seg: (i) => 'video/00001.ts' göreli ad, key: (uri) => '../keys/k0.key', map: (map) => 'init.mp4' }
function buildLocalMedia(pl, names) {
  const out = ['#EXTM3U', `#EXT-X-VERSION:${Math.max(3, pl.version || 3)}`, `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(pl.targetDuration || Math.max(...pl.segments.map((s) => s.duration), 1)))}`, `#EXT-X-MEDIA-SEQUENCE:${pl.mediaSequence || 0}`, '#EXT-X-PLAYLIST-TYPE:VOD']
  if (pl.independent) out.push('#EXT-X-INDEPENDENT-SEGMENTS')
  let lastKey
  let lastMap
  pl.segments.forEach((s, i) => {
    const kId = s.key ? `${s.key.method}|${s.key.uri}|${s.key.iv}` : 'none'
    if (kId !== lastKey) {
      if (s.key || lastKey !== undefined) out.push(keyTag(s.key, s.key ? names.key(s.key.uri) : ''))
      lastKey = kId
    }
    const mId = s.map ? `${s.map.uri}|${s.map.byterange?.offset}` : ''
    if (s.map && mId !== lastMap) out.push(`#EXT-X-MAP:URI=${q(names.map(s.map))}`)
    lastMap = mId
    if (s.discontinuity) out.push('#EXT-X-DISCONTINUITY')
    out.push(`#EXTINF:${+s.duration.toFixed(6)},`)
    out.push(names.seg(i))
  })
  out.push('#EXT-X-ENDLIST', '')
  return out.join('\n')
}

// Yerel ana playlist: tek video varyantı + (varsa) seçilen ses + altyazılar.
function buildLocalMaster({ video, audio, subs = [] }) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:4']
  if (audio) out.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME=${q(audio.name || 'Ses')},${audio.lang ? `LANGUAGE=${q(audio.lang)},` : ''}DEFAULT=YES,AUTOSELECT=YES,URI=${q(audio.uri)}`)
  for (const s of subs) out.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME=${q(s.name || s.lang || 'Altyazı')},${s.lang ? `LANGUAGE=${q(s.lang)},` : ''}DEFAULT=NO,AUTOSELECT=NO,URI=${q(s.uri)}`)
  let inf = `#EXT-X-STREAM-INF:BANDWIDTH=${video.bandwidth || 1}`
  if (video.width && video.height) inf += `,RESOLUTION=${video.width}x${video.height}`
  if (video.codecs) inf += `,CODECS=${q(video.codecs)}`
  if (audio) inf += ',AUDIO="aud"'
  if (subs.length) inf += ',SUBTITLES="sub"'
  out.push(inf, video.uri, '')
  return out.join('\n')
}

// ---------------------------------------------------------------- doğrulama

const HTML_RE = /^\s*(<!doctype|<html|<head|<body|<\?xml|<title|<script|\{\s*"(error|message|status)")/i

// HTML/JSON hata sayfası mı (404 sayfası, "erişim engellendi", Cloudflare)?
function looksLikeErrorPage(buf, contentType = '') {
  if (/text\/html|application\/json/i.test(contentType || '')) return true
  const head = buf.subarray(0, 512).toString('latin1')
  return HTML_RE.test(head)
}

function tsSyncOffset(buf, limit = 65536) {
  const max = Math.min(buf.length - 377, limit)
  for (let i = 0; i <= max; i++) if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i
  return buf.length >= 188 && buf.length < 377 && buf[0] === 0x47 ? 0 : -1
}

const IMG_SIGS = [Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('GIF8'), Buffer.from('BM'), Buffer.from('RIFF')]
const startsWithImage = (buf) => IMG_SIGS.some((s) => buf.length >= s.length && buf.subarray(0, s.length).equals(s))
const MP4_BOXES = new Set(['ftyp', 'styp', 'moof', 'sidx', 'emsg', 'prft', 'free', 'moov', 'mdat'])

// Parça doğrulama. kind: 'seg' | 'key' | 'vtt' | 'init'. Dönen: { ok, reason?, data } — data sahte
// resim başlığı ayıklanmış hali.
function checkSegment(buf, { contentType = '', kind = 'seg', encrypted = false, expectedLength = 0 } = {}) {
  if (!buf || !buf.length) return { ok: false, reason: 'boş' }
  if (expectedLength && buf.length !== expectedLength) return { ok: false, reason: `eksik (${buf.length}/${expectedLength})` }
  if (kind === 'key') {
    if (buf.length !== 16) return { ok: false, reason: `anahtar boyu ${buf.length}` }
    return { ok: true, data: buf }
  }
  if (kind === 'vtt') {
    const t = buf.toString('utf8')
    if (/WEBVTT/.test(t.slice(0, 200))) return { ok: true, data: buf }
    return { ok: false, reason: 'vtt değil' }
  }
  if (looksLikeErrorPage(buf, /image\//.test(contentType) ? '' : contentType)) return { ok: false, reason: 'hata sayfası' }
  if (buf.length < 100) return { ok: false, reason: 'çok küçük' }
  if (encrypted) return { ok: true, data: buf }
  const box = buf.subarray(4, 8).toString('latin1')
  if (MP4_BOXES.has(box)) return { ok: true, data: buf }
  if (kind === 'init') return { ok: true, data: buf }
  const off = tsSyncOffset(buf)
  if (off === 0) return { ok: true, data: buf }
  if (off > 0) return { ok: true, data: buf.subarray(off), stripped: off }
  if (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0)) return { ok: true, data: buf }
  if (startsWithImage(buf)) return { ok: false, reason: 'gerçek resim' }
  // Tanınmayan ikili veri: metin değilse kabul (bilinmeyen kapsayıcılar).
  return { ok: true, data: buf, unknown: true }
}

// MP4 dosyasının başı gerçekten video mu?
function checkMp4Head(buf, contentType = '') {
  if (looksLikeErrorPage(buf, contentType)) return { ok: false, reason: 'hata sayfası' }
  if (/^video|octet|binary|mp4|matroska/i.test(contentType || '') || MP4_BOXES.has(buf.subarray(4, 8).toString('latin1')) || buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { ok: true }
  return { ok: false, reason: `tür: ${contentType || 'bilinmiyor'}` }
}

// Content-Range: "bytes 100-199/1000" → { start, end, total }
function parseContentRange(v) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(v || '')
  if (!m) return null
  return { start: +m[1], end: +m[2], total: m[3] === '*' ? 0 : +m[3] }
}

// 429/503'te artan bekleme; Retry-After varsa ona uyar.
function retryDelay(attempt, status, retryAfter) {
  const ra = parseInt(retryAfter)
  if (ra > 0) return Math.min(ra * 1000, 60000)
  const base = status === 429 || status === 503 ? 2000 : 700
  return Math.min(base * 2 ** attempt, 30000)
}

// ---------------------------------------------------------------- altyazı

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1254').decode(buf)
  }
}

function toVtt(text) {
  if (text.trimStart().startsWith('WEBVTT')) return text
  const body = text
    .replace(/\r+/g, '')
    .replace(/^\d+\s*\n(?=\d{1,2}:\d{2})/gm, '')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
    .replace(/\{\\[^}]*\}/g, '')
  return 'WEBVTT\n\n' + body
}

// ---------------------------------------------------------------- yardımcılar

// Windows'ta geçerli klasör adı.
const safeName = (s) =>
  String(s || 'BerkStream')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80) || 'BerkStream'

const pad = (n, w = 5) => String(n).padStart(w, '0')

// Parça uzantısı: kaynak .jpg/.png gibi sahte uzantı verse de yerelde doğru ad.
function segExt(uri, isFmp4) {
  if (isFmp4) return '.m4s'
  const m = /\.(ts|aac|mp4|m4s|m4a|vtt|webvtt)(\?|$)/i.exec(uri)
  return m ? '.' + m[1].toLowerCase().replace('webvtt', 'vtt') : '.ts'
}

module.exports = {
  parseAttrs,
  parseM3U8,
  isPlaylistText,
  hasDrm,
  pickVariant,
  audioOptions,
  subtitleOptions,
  isTurkishTrack,
  buildLocalMedia,
  buildLocalMaster,
  looksLikeErrorPage,
  tsSyncOffset,
  checkSegment,
  checkMp4Head,
  parseContentRange,
  retryDelay,
  decodeText,
  toVtt,
  safeName,
  pad,
  segExt,
}
