// BerkStream Hub rafları — BerkStream N'deki BerkHubAddon.kt'nin birebir PC karşılığı.
// TMDB (tr-TR) + JustWatch Türkiye günlük sıralaması. Raflar diskte: 1 saat taze, 3 güne kadar
// bayatsa eskisi anında döner ve arkada yenilenir.
const fs = require('fs')
const path = require('path')

const API = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p'
const JW = 'https://apis.justwatch.com/graphql'
const PAGE = 20
const JW_TTL = 6 * 3600e3
const TMDB_TTL = 30 * 60e3
const FRESH_MS = 3600e3
const STALE_MS = 3 * 24 * 3600e3

let apiKey = ''
let cacheDir = null

function init({ tmdbApiKey, dir }) {
  apiKey = tmdbApiKey || ''
  cacheDir = dir
  fs.mkdirSync(cacheDir, { recursive: true })
}

let n = 0
const s = (title, kind, p) => ({ id: `bs${n++}`, title, kind, path: p, ranked: title.includes('İLK 10') })

const shelves = [
  s('🔥  GÜNÜN TRENDLERİ', 'mixed', 'trending/all/day'),
  s('🏆  BUGÜN İLK 10 FİLM', 'movie', 'discover/movie?sort_by=popularity.desc&with_watch_monetization_types=flatrate&vote_count.gte=50'),
  s('🏆  BUGÜN İLK 10 DİZİ', 'tv', 'discover/tv?sort_by=popularity.desc&with_watch_monetization_types=flatrate&vote_count.gte=50'),
  s('📅  GELECEK HAFTA YAYINDA', 'mixed', 'upcoming'),
  s('🎬  VİZYONDAKİ FİLMLER', 'movie', 'movie/now_playing?region=TR'),
  s('📈  HAFTANIN POPÜLER FİLMLERİ', 'movie', 'trending/movie/week'),
  s('📺  HAFTANIN POPÜLER DİZİLERİ', 'tv', 'trending/tv/week'),
  s('🆕  YENİ ÇIKAN FİLMLER', 'movie', 'discover/movie?sort_by=primary_release_date.desc&vote_count.gte=25'),
  s('⭐  EN YÜKSEK PUANLI FİLMLER', 'movie', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=400'),
  s('⭐  EN YÜKSEK PUANLI DİZİLER', 'tv', 'discover/tv?sort_by=vote_average.desc&vote_count.gte=250'),
  s('🇹🇷  TÜRK DİZİLERİ', 'tv', 'discover/tv?with_original_language=tr&sort_by=popularity.desc'),
  s('🇹🇷  TÜRK FİLMLERİ', 'movie', 'discover/movie?with_original_language=tr&sort_by=popularity.desc'),
  s('ᴺ  NETFLIX • FİLM', 'movie', 'discover/movie?with_watch_providers=8'),
  s('ᴺ  NETFLIX • DİZİ', 'tv', 'discover/tv?with_watch_providers=8'),
  s('▶  PRIME VIDEO • FİLM', 'movie', 'discover/movie?with_watch_providers=119'),
  s('▶  PRIME VIDEO • DİZİ', 'tv', 'discover/tv?with_watch_providers=119'),
  s('✨  DISNEY+ • FİLM', 'movie', 'discover/movie?with_watch_providers=337'),
  s('✨  DISNEY+ • DİZİ', 'tv', 'discover/tv?with_watch_providers=337'),
  s('🟣  HBO MAX • FİLM', 'movie', 'discover/movie?with_watch_providers=1899'),
  s('🟣  HBO MAX • DİZİ', 'tv', 'discover/tv?with_watch_providers=1899'),
  s('  APPLE TV+ • FİLM', 'movie', 'discover/movie?with_watch_providers=350&watch_region=US'),
  s('  APPLE TV+ • DİZİ', 'tv', 'discover/tv?with_watch_providers=350&watch_region=US'),
  s('🔴  TABİİ', 'tv', 'discover/tv?with_watch_providers=2235'),
  s('💥  AKSİYON', 'movie', 'discover/movie?with_genres=28&sort_by=popularity.desc'),
  s('😂  KOMEDİ', 'movie', 'discover/movie?with_genres=35&sort_by=popularity.desc'),
  s('👽  BİLİM KURGU', 'movie', 'discover/movie?with_genres=878&sort_by=popularity.desc'),
  s('😱  KORKU', 'movie', 'discover/movie?with_genres=27&sort_by=popularity.desc'),
  s('🎭  DRAM', 'movie', 'discover/movie?with_genres=18&sort_by=popularity.desc'),
  s('🕵️  GERİLİM', 'movie', 'discover/movie?with_genres=53&sort_by=popularity.desc'),
  s('💘  ROMANTİK', 'movie', 'discover/movie?with_genres=10749&sort_by=popularity.desc'),
  s('🎨  ANİMASYON • FİLM', 'movie', 'discover/movie?with_genres=16&sort_by=popularity.desc'),
  s('🧒  ANİMASYON • DİZİ', 'tv', 'discover/tv?with_genres=16&sort_by=popularity.desc'),
  s('🎌  ANİME', 'tv', 'discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc'),
  s('📖  BELGESEL', 'movie', 'discover/movie?with_genres=99&sort_by=popularity.desc'),
  s('🏛️  TARİH • FİLM', 'movie', 'discover/movie?with_genres=36&sort_by=popularity.desc'),
  s('🎖️  SAVAŞ • FİLM', 'movie', 'discover/movie?with_genres=10752&sort_by=popularity.desc'),
  s('🤠  WESTERN • FİLM', 'movie', 'discover/movie?with_genres=37&sort_by=popularity.desc'),
  s('🎖️  SAVAŞ • DİZİ', 'tv', 'discover/tv?with_genres=10768&sort_by=popularity.desc'),
  s('🤠  WESTERN • DİZİ', 'tv', 'discover/tv?with_genres=37&sort_by=popularity.desc'),
  s('📅  BU HAFTA YENİ BÖLÜM', 'tv', 'tv/on_the_air'),
  s('💎  GİZLİ CEVHERLER', 'movie', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=200&vote_count.lte=1200'),
  s('⏱️  KISA GECE • 95 DK ALTI', 'movie', 'discover/movie?with_runtime.lte=95&vote_count.gte=300&sort_by=vote_average.desc'),
  s("🕰️  90'LAR KLASİKLERİ", 'movie', 'discover/movie?primary_release_date.gte=1990-01-01&primary_release_date.lte=1999-12-31&sort_by=vote_average.desc&vote_count.gte=500'),
  s('🏆  OSCAR YOLUNDA', 'movie', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=1500&primary_release_date.gte=2015-01-01'),
]

// TMDB sağlayıcı logoları (TR; Apple TV+ US)
const platforms = [
  { key: 'netflix', title: 'Netflix', logo: '/rK1KljqmbvO9HQa1PBFLILWah72.png', pkg: 'nfx', provider: '8', country: 'TR' },
  { key: 'prime', title: 'Prime Video', logo: '/gMZdpavHmxFNnLpMHwVxfqeux2g.png', pkg: 'prv', provider: '119', country: 'TR' },
  { key: 'disney', title: 'Disney+', logo: '/5eZ872CghnHFLB1j8grszbrx0dx.png', pkg: 'dnp', provider: '337', country: 'TR' },
  { key: 'hbo', title: 'HBO Max', logo: '/skypuy7SXuugIQeYg0IglmzoKaS.png', pkg: 'mxx', provider: '1899', country: 'TR' },
  { key: 'apple', title: 'Apple TV+', logo: '/9icYBfYFcwgCbky5VdGUIKJ4C5i.png', pkg: 'atp', provider: '350', country: 'US' },
  { key: 'tabii', title: 'tabii', logo: '/8OIs6ZVYbS3auTiW6cWsXE5LTX.png', pkg: 'tab', provider: '2235', country: 'TR' },
]

const today = () => new Date().toISOString().slice(0, 10)

function platformShelves(p) {
  const region = p.country === 'TR' ? '' : `&watch_region=${p.country}`
  const prov = `with_watch_providers=${p.provider}${region}`
  const t = today()
  const sh = (key, title, kind, pth) => ({ id: `bsp_${p.key}_${key}`, title, kind, path: pth, ranked: false })
  return [
    sh('topm', '🏆  GÜNCEL TOP FİLM', 'movie', `chart:${p.pkg}:${p.country}`),
    sh('topt', '🏆  GÜNCEL TOP DİZİ', 'tv', `chart:${p.pkg}:${p.country}`),
    sh('soon', '📅  YAKINDA', 'mixed', `upcoming:${p.pkg}:${p.country}`),
    sh('newm', '🆕  YENİ FİLMLER', 'movie', `discover/movie?${prov}&sort_by=primary_release_date.desc&primary_release_date.lte=${t}`),
    sh('newt', '🆕  YENİ DİZİLER', 'tv', `discover/tv?${prov}&sort_by=first_air_date.desc&first_air_date.lte=${t}`),
    sh('bestm', '⭐  EN İYİ FİLMLER', 'movie', `discover/movie?${prov}&sort_by=vote_average.desc&vote_count.gte=300`),
    sh('bestt', '⭐  EN İYİ DİZİLER', 'tv', `discover/tv?${prov}&sort_by=vote_average.desc&vote_count.gte=150`),
    sh('allm', '🎬  TÜM FİLMLER', 'movie', `discover/movie?${prov}&sort_by=popularity.desc`),
    sh('allt', '📺  TÜM DİZİLER', 'tv', `discover/tv?${prov}&sort_by=popularity.desc`),
  ]
}

const allShelves = () => {
  const map = new Map()
  for (const x of shelves) map.set(x.id, x)
  for (const p of platforms) for (const x of platformShelves(p)) map.set(x.id, x)
  return map
}
let byId = null
const shelfById = (id) => (byId || (byId = allShelves())).get(id)

// ---------------------------------------------------------------- ağ

const tmdbCache = new Map()
// Ölçüm sayaçları (ağa giden istekler).
const stats = { requests: 0, tmdb: 0 }

async function getJson(url, init, timeout = 15000) {
  stats.requests++
  if (url.startsWith(API)) stats.tmdb++
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function tmdb(p, extra = '', lang = 'tr-TR') {
  if (!apiKey) return null
  const sep = p.includes('?') ? '&' : '?'
  const url = `${API}${p}${sep}api_key=${apiKey}&language=${lang}${extra}`
  const hit = tmdbCache.get(url)
  if (hit && Date.now() - hit.at < TMDB_TTL) return hit.data
  // Aynı adres zaten yoldaysa (vitrin + raf, iki grafik aynı yapımı isterse) tek istek.
  if (inflight.has(url)) return inflight.get(url)
  const req = getJson(url).then((data) => {
    inflight.delete(url)
    if (!data) return null
    if (tmdbCache.size > 600) [...tmdbCache.keys()].slice(0, 200).forEach((k) => tmdbCache.delete(k))
    tmdbCache.set(url, { at: Date.now(), data })
    return data
  })
  inflight.set(url, req)
  return req
}
const inflight = new Map()

const jw = (query, variables) =>
  getJson(JW, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })

function toMeta(o, forcedKind, releaseInfo) {
  const kind = forcedKind || o.media_type || (o.first_air_date !== undefined ? 'tv' : 'movie')
  if (kind !== 'movie' && kind !== 'tv') return null
  if (!o.id) return null
  const name = (kind === 'tv' ? o.name : o.title) || o.original_title || o.original_name
  if (!name || !o.poster_path) return null
  const date = (kind === 'tv' ? o.first_air_date : o.release_date) || ''
  return {
    id: o.id,
    kind,
    name,
    poster: `${IMG}/w342${o.poster_path}`,
    backdrop: o.backdrop_path ? `${IMG}/w1280${o.backdrop_path}` : null,
    overview: o.overview || '',
    year: releaseInfo || date.slice(0, 4),
    rating: o.vote_average > 0 ? o.vote_average.toFixed(1) : null,
  }
}

async function tmdbPage(p, kind, page) {
  const res = await tmdb(`/${p}`, `&page=${page}&include_adult=false`)
  const forced = kind === 'movie' || kind === 'tv' ? kind : null
  return (res?.results || []).map((o) => toMeta(o, forced)).filter(Boolean)
}

const details = async (kind, id) => {
  const d = await tmdb(`/${kind}/${id}`)
  return d && d.id ? d : null
}

// ---------------------------------------------------------------- JustWatch

const packages = { 8: 'nfx:TR', 119: 'prv:TR', 337: 'dnp:TR', 1899: 'mxx:TR', 2235: 'tab:TR', 350: 'atp:US' }
const trPackages = ['nfx', 'prv', 'dnp', 'mxx', 'tab']
const chartCache = new Map()
const upCache = new Map()

async function chartOf(country, pkgs, cacheName, isShow) {
  const key = `${country}|${cacheName}|${isShow}`
  let ids = chartCache.get(key)
  if (!ids || Date.now() - ids.at > JW_TTL) {
    const q = `query BerkPlatform($filter: TitleFilter) { popularTitles(country: ${country}, first: 40, filter: $filter, sortBy: TRENDING) { edges { node { content(country: ${country}, language: tr) { externalIds { tmdbId } } } } } }`
    const res = await jw(q, { filter: { objectTypes: [isShow ? 'SHOW' : 'MOVIE'], packages: pkgs } })
    const list = [...new Set((res?.data?.popularTitles?.edges || []).map((e) => parseInt(e?.node?.content?.externalIds?.tmdbId)).filter((x) => x > 0))]
    ids = { at: Date.now(), list }
    if (list.length) chartCache.set(key, ids)
  }
  const kind = isShow ? 'tv' : 'movie'
  const ds = await Promise.all(ids.list.slice(0, 20).map((id) => details(kind, id)))
  return ds.filter(Boolean)
}

const chart = (platform, isShow) => {
  const [pkg, country = 'TR'] = platform.split(':')
  return chartOf(country, [pkg], pkg, isShow)
}

async function upcoming(platform) {
  const [pkg, country = 'TR'] = platform.split(':')
  const key = `${country}|${pkg}`
  const hit = upCache.get(key)
  if (hit && Date.now() - hit.at < JW_TTL) return hit.list
  const q = `query BerkUpcoming($p: [String!]) { newTitles(country: ${country}, date: "${today()}", first: 100, pageType: UPCOMING, filter: {packages: $p}) { edges { node { objectType ... on Movie { content(country: ${country}, language: tr) { externalIds { tmdbId } upcomingReleases { releaseDate package { shortName } } } } ... on Season { content(country: ${country}, language: tr) { upcomingReleases { releaseDate package { shortName } } } show { content(country: ${country}, language: tr) { externalIds { tmdbId } } } } } } } }`
  const res = await jw(q, { p: [pkg] })
  const seen = new Set()
  const list = []
  for (const e of res?.data?.newTitles?.edges || []) {
    const node = e?.node
    if (!node) continue
    const isShow = String(node.objectType || '').startsWith('SHOW')
    const ids = isShow ? node.show?.content?.externalIds : node.content?.externalIds
    const id = parseInt(ids?.tmdbId)
    if (!(id > 0)) continue
    const dates = (node.content?.upcomingReleases || []).filter((r) => r?.package?.shortName === pkg && r.releaseDate).map((r) => r.releaseDate).sort()
    if (!dates.length) continue
    const k = `${isShow}:${id}`
    if (seen.has(k)) continue
    seen.add(k)
    list.push({ tmdbId: id, isShow, date: dates[0] })
  }
  if (list.length) upCache.set(key, { at: Date.now(), list })
  return list
}

async function upcomingOf(pkgs) {
  const lists = await Promise.all(pkgs.map(upcoming))
  const seen = new Set()
  const all = lists.flat().filter((u) => {
    const k = `${u.isShow}:${u.tmdbId}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (!all.length) return []
  const until = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)
  const t = until(0)
  const window = [7, 14, 30].find((d) => all.filter((u) => u.date >= t && u.date <= until(d)).length >= 6) || 30
  const picked = all.filter((u) => u.date >= t && u.date <= until(window)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 30)
  const fmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' })
  const out = await Promise.all(
    picked.map(async (u) => {
      const kind = u.isShow ? 'tv' : 'movie'
      const d = await details(kind, u.tmdbId)
      if (!d || (d.popularity || 0) < 1) return null
      return toMeta(d, kind, fmt.format(new Date(u.date)))
    })
  )
  return out.filter(Boolean)
}

const uniq = (arr) => {
  const seen = new Set()
  return arr.filter((m) => {
    const k = `${m.kind}:${m.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------------------------------------------------------------- Netflix Türkiye Top 10 (N 2.5.1 ile aynı)
// netflix.com/tudum/top10/turkey: geçen haftanın gerçek izlenme sırası (her salı). İngilizce ad →
// TMDB arama, birebir ad + en yüksek popülerlik; sezonlar tek yapıma iner.
const NETFLIX_TTL = 3 * 3600e3
const netflixCache = new Map()
const titleIdCache = new Map()
const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '')
const seasonSuffix = /:\s*(Season|Part|Volume|Vol\.|Book|Chapter|Limited Series|Collection)\b.*$/i
async function tmdbIdFor(kind, title) {
  const k = `${kind}|${title}`
  if (titleIdCache.has(k)) return titleIdCache.get(k)
  const res = await tmdb(`/search/${kind}?query=${encodeURIComponent(title)}`, '&include_adult=false', 'en-US')
  const results = (res?.results || []).slice(0, 8).filter((o) => o.poster_path)
  const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const want = norm(title)
  const exact = results.filter((o) => ['title', 'name', 'original_title', 'original_name'].some((f) => norm(o[f]) === want))
  const pick = (exact.length ? exact : results.slice(0, 1)).sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0]
  if (!pick?.id) return null
  titleIdCache.set(k, pick.id)
  return pick.id
}
async function netflixTop(isShow) {
  let hit = netflixCache.get(isShow)
  if (!hit || Date.now() - hit.at > NETFLIX_TTL) {
    try {
      const r = await fetch('https://www.netflix.com/tudum/top10/turkey' + (isShow ? '/tv' : ''), { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'accept-language': 'en-US,en;q=0.8' }, signal: AbortSignal.timeout(12000) })
      const html = r.ok ? await r.text() : ''
      const rows = [...html.matchAll(/<span class="rank">(\d+)<\/span>.*?<button>(.*?)<\/button>/gs)].map((m) => [+m[1], unescapeHtml(m[2]).replace(seasonSuffix, '').trim()]).filter((x) => x[1])
      const seen = new Set()
      const titles = rows.filter((x) => (seen.has(x[0]) ? false : seen.add(x[0]))).sort((a, b) => a[0] - b[0]).slice(0, 10).map((x) => x[1])
      const kind = isShow ? 'tv' : 'movie'
      const ids = [...new Set((await Promise.all(titles.map((t) => tmdbIdFor(kind, t).catch(() => null)))).filter(Boolean))]
      hit = { at: Date.now(), ids }
      if (ids.length) netflixCache.set(isShow, hit)
    } catch {
      hit = hit || { at: 0, ids: [] }
    }
  }
  const kind = isShow ? 'tv' : 'movie'
  return (await Promise.all(hit.ids.map((id) => details(kind, id)))).filter(Boolean)
}

async function catalog(shelf, page) {
  const p = shelf.path
  if (p === 'upcoming') return page > 1 ? [] : upcomingOf([...new Set(Object.values(packages))])
  if (p.startsWith('upcoming:')) return page > 1 ? [] : upcomingOf([p.slice(9)])
  if (p.startsWith('chart:')) {
    if (page > 1) return []
    const isShow = shelf.kind === 'tv'
    const real = p.slice(6).startsWith('nfx:') ? await netflixTop(isShow) : []
    return uniq([...real, ...(await chart(p.slice(6), isShow))].map((o) => toMeta(o, shelf.kind)).filter(Boolean))
  }
  if (shelf.ranked) {
    const row = await tmdbPage(p, shelf.kind, page)
    if (page !== 1) return row
    const isShow = shelf.kind === 'tv'
    const [nf, jw] = await Promise.all([netflixTop(isShow), chartOf('TR', trPackages, 'all', isShow)])
    return uniq([...nf, ...jw].map((o) => toMeta(o, shelf.kind)).filter(Boolean).concat(row))
  }
  if (p.includes('with_watch_providers')) {
    const region = p.includes('watch_region=') ? '' : '&watch_region=TR'
    const floor = p.includes('vote_count') ? '' : '&vote_count.gte=30'
    const row = await tmdbPage(p + region + floor, shelf.kind, page)
    if (page !== 1 || p.includes('sort_by=')) return row
    const provider = (p.match(/with_watch_providers=(\d+)/) || [])[1]
    const pkg = packages[provider]
    if (!pkg) return row
    const top = (await chart(pkg, shelf.kind === 'tv')).map((o) => toMeta(o, shelf.kind)).filter(Boolean)
    return uniq([...top, ...row])
  }
  return tmdbPage(p, shelf.kind, page)
}

const refreshing = new Set()

// Avast gibi antivirüsler yeni yazılan .tmp dosyasının adını değiştirmeyi bazen engelliyor:
// önce tmp + rename dene, olmazsa doğrudan yaz.
function safeWrite(file, text) {
  try {
    fs.writeFileSync(file + '.tmp', text)
    fs.renameSync(file + '.tmp', file)
    return
  } catch {}
  try {
    fs.writeFileSync(file, text)
  } catch {}
  try {
    fs.rmSync(file + '.tmp', { force: true })
  } catch {}
}

// Diske yazma ana süreci bekletmesin (tmp + rename, olmazsa doğrudan).
async function safeWriteAsync(file, text) {
  try {
    await fs.promises.writeFile(file + '.tmp', text)
    await fs.promises.rename(file + '.tmp', file)
    return
  } catch {}
  try {
    await fs.promises.writeFile(file, text)
  } catch {}
  fs.promises.rm(file + '.tmp', { force: true }).catch(() => {})
}

async function fetchAndStore(shelf, page, file) {
  const items = await catalog(shelf, page)
  if (!items.length) return null
  safeWriteAsync(file, JSON.stringify(items))
  return items
}

// Raflar: önce diskteki kopya (ana süreci kilitlemeden okunur); aynı raf aynı anda iki kez
// istenirse (vitrin + ilk raf) tek iş.
const shelfInflight = new Map()
function shelfItems(id, page = 1) {
  const shelf = shelfById(id)
  if (!shelf) return Promise.resolve([])
  const file = path.join(cacheDir, `${shelf.id}_${page}${shelf.ranked || shelf.path.startsWith('chart:') ? '_v2' : ''}.json`)
  if (shelfInflight.has(file)) return shelfInflight.get(file)
  const p = (async () => {
    let age = null
    try {
      age = Date.now() - (await fs.promises.stat(file)).mtimeMs
    } catch {}
    if (age !== null && age < STALE_MS) {
      try {
        const cached = JSON.parse(await fs.promises.readFile(file, 'utf8'))
        if (age >= FRESH_MS && !refreshing.has(file)) {
          refreshing.add(file)
          fetchAndStore(shelf, page, file).finally(() => refreshing.delete(file))
        }
        return cached
      } catch {}
    }
    const fresh = await fetchAndStore(shelf, page, file)
    if (fresh) return fresh
    // İnternet yoksa kopya 3 günden eski de olsa elde ne varsa göster.
    try {
      return JSON.parse(await fs.promises.readFile(file, 'utf8'))
    } catch {
      return []
    }
  })().finally(() => shelfInflight.delete(file))
  shelfInflight.set(file, p)
  return p
}

// Detay ve sezon bilgisi diskte de durur: internetsiz açılışta (indirilenler) detay sayfası çalışsın.
const metaFile = (name) => path.join(cacheDir, '..', 'meta', name)
async function withDiskCopy(name, fn) {
  const data = await fn()
  const f = metaFile(name)
  if (data && (!Array.isArray(data) || data.length)) {
    fs.promises
      .mkdir(path.dirname(f), { recursive: true })
      .then(() => safeWriteAsync(f, JSON.stringify(data)))
      .catch(() => {})
    return data
  }
  try {
    return JSON.parse(await fs.promises.readFile(f, 'utf8'))
  } catch {
    return data
  }
}

// ---------------------------------------------------------------- Türkçe çeviri (N'deki BerkTranslate)
// TMDB'de Türkçe özeti olmayan yapımlarda İngilizce açıklama geliyor: Google çeviriyle Türkçeye
// çevrilir, çeviriler diske yazılır (bir daha beklenmez).

const TR_CHARS = /[çğışöüÇĞİŞÖÜ]/g
const TR_WORDS = /(?:^|[^\p{L}])(ve|bir|bu|ile|için|olan|ama|onun|kendi|daha)(?=$|[^\p{L}])/giu
let trCache = null
let trSaveTimer = null
const trFile = () => path.join(cacheDir, '..', 'ceviri.json')
function trLoad() {
  if (trCache) return
  trCache = new Map()
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(trFile(), 'utf8')))) trCache.set(k, v)
  } catch {}
}
function needsTranslation(text) {
  const t = (text || '').trim()
  if (t.length < 25) return false
  if ((t.match(TR_CHARS) || []).length >= 2) return false
  if ((t.match(TR_WORDS) || []).length >= 2) return false
  return [...t].filter((c) => /[a-z]/i.test(c)).length > t.length / 2
}
async function toTurkish(text) {
  if (!needsTranslation(text)) return text
  trLoad()
  if (trCache.has(text)) return trCache.get(text)
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(text.slice(0, 1800))}`
  const root = await getJson(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, 5000)
  if (!Array.isArray(root) || root[2] === 'tr') return text
  const out = (root[0] || []).map((p) => p?.[0] || '').join('').trim()
  if (!out) return text
  trCache.set(text, out)
  if (trCache.size > 3000) [...trCache.keys()].slice(0, 500).forEach((k) => trCache.delete(k))
  clearTimeout(trSaveTimer)
  trSaveTimer = setTimeout(() => safeWrite(trFile(), JSON.stringify(Object.fromEntries(trCache))), 2000)
  return out
}

// ---------------------------------------------------------------- detay / arama

async function search(query) {
  if (!query?.trim()) return []
  const res = await tmdb(`/search/multi?query=${encodeURIComponent(query.trim())}`, '&include_adult=false')
  return (res?.results || [])
    .filter((o) => o.media_type === 'movie' || o.media_type === 'tv')
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .map((o) => toMeta(o))
    .filter(Boolean)
}

const detail = (kind, id) => withDiskCopy(`${kind}_${id}.json`, () => detailLive(kind, id))
async function detailLive(kind, id) {
  const d = await tmdb(`/${kind}/${id}`, '&append_to_response=external_ids,credits,videos,images,recommendations,similar,watch/providers,content_ratings,release_dates&include_video_language=tr,en&include_image_language=tr,en,null')
  if (!d) return null
  const providers = (d['watch/providers']?.results?.TR?.flatrate || []).slice(0, 6).map((p) => ({ name: p.provider_name, logo: `${IMG}/w154${p.logo_path}` }))
  const trailer = (d.videos?.results || []).filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')).sort((a, b) => (a.type === 'Trailer' ? -1 : 1) - (b.type === 'Trailer' ? -1 : 1) || (a.iso_639_1 === 'tr' ? -1 : 1))[0]
  let overview = d.overview
  if (!overview) {
    const en = await tmdb(`/${kind}/${id}`, '', 'en-US')
    overview = en?.overview || ''
  }
  overview = await toTurkish(overview)
  let cert = ''
  if (kind === 'movie') {
    const tr = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === 'TR')
    cert = tr?.release_dates?.find((x) => x.certification)?.certification || ''
  } else {
    cert = (d.content_ratings?.results || []).find((r) => r.iso_3166_1 === 'TR')?.rating || ''
  }
  return {
    id: d.id,
    kind,
    name: kind === 'tv' ? d.name : d.title,
    originalName: kind === 'tv' ? d.original_name : d.original_title,
    overview,
    tagline: d.tagline || '',
    poster: d.poster_path ? `${IMG}/w500${d.poster_path}` : null,
    backdrop: d.backdrop_path ? `${IMG}/w1280${d.backdrop_path}` : null,
    year: ((kind === 'tv' ? d.first_air_date : d.release_date) || '').slice(0, 4),
    rating: d.vote_average > 0 ? d.vote_average.toFixed(1) : null,
    runtime: kind === 'movie' ? d.runtime : d.episode_run_time?.[0] || null,
    genres: (d.genres || []).map((g) => g.name),
    cast: (d.credits?.cast || []).slice(0, 8).map((c) => c.name),
    people: (d.credits?.cast || []).filter((c) => c.profile_path).slice(0, 14).map((c) => ({ name: c.name, character: c.character || '', photo: `${IMG}/w185${c.profile_path}` })),
    similar: (() => {
      const pick = (d.recommendations?.results || []).length >= 6 ? d.recommendations.results : [...(d.recommendations?.results || []), ...(d.similar?.results || [])]
      return uniq(pick.map((o) => toMeta(o, kind)).filter(Boolean)).slice(0, 20)
    })(),
    imdbId: d.external_ids?.imdb_id || d.imdb_id || null,
    cert,
    providers,
    trailer: trailer ? trailer.key : null,
    // Başlık logosu: Türkçe, yoksa İngilizce, yoksa dilsiz (Web'deki kart görseliyle aynı kural).
    logo: (() => {
      const logos = d.images?.logos || []
      const l = logos.find((x) => x.iso_639_1 === 'tr') || logos.find((x) => x.iso_639_1 === 'en') || logos[0]
      return l ? `${IMG}/w500${l.file_path}` : null
    })(),
    seasons: kind === 'tv' ? (d.seasons || []).filter((x) => x.season_number > 0 && x.episode_count > 0).map((x) => ({ number: x.season_number, name: x.name, count: x.episode_count })) : [],
  }
}

const season = (id, number) => withDiskCopy(`tv_${id}_s${number}.json`, () => seasonLive(id, number))
async function seasonLive(id, number) {
  const d = await tmdb(`/tv/${id}/season/${number}`)
  const t = today()
  const eps = d?.episodes || []
  if (eps.some((e) => !e.overview)) {
    const en = await tmdb(`/tv/${id}/season/${number}`, '', 'en-US')
    const byNum = new Map((en?.episodes || []).map((e) => [e.episode_number, e]))
    await Promise.all(
      eps.map(async (e) => {
        if (e.overview) return
        const src = byNum.get(e.episode_number)
        if (src?.overview) e.overview = await toTurkish(src.overview)
        if (/^\d+\. Bölüm$/.test(e.name || '') && src?.name && !/^Episode \d+$/.test(src.name)) e.name = src.name
      })
    )
  }
  return eps.map((e) => ({
    number: e.episode_number,
    name: e.name,
    overview: e.overview,
    still: e.still_path ? `${IMG}/w300${e.still_path}` : null,
    runtime: e.runtime,
    airDate: e.air_date,
    aired: !!e.air_date && e.air_date <= t,
  }))
}

function home() {
  return {
    shelves: shelves.map(({ id, title, kind, ranked }) => ({ id, title, kind, ranked })),
    platforms: platforms.map((p) => ({ key: p.key, title: p.title, logo: `${IMG}/original${p.logo}` })),
  }
}

function platformPage(key) {
  const p = platforms.find((x) => x.key === key)
  if (!p) return null
  return { key: p.key, title: p.title, logo: `${IMG}/original${p.logo}`, shelves: platformShelves(p).map(({ id, title, kind }) => ({ id, title, kind, ranked: id.endsWith('_topm') || id.endsWith('_topt') })) }
}

module.exports = { stats, safeWrite, init, home, platformPage, shelfItems, search, detail, season, tmdb }
