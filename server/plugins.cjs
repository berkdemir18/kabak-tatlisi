// Nuvio kaynak depoları: manifest + providers/*.js indirilir, diskte tutulur, her aramada
// açık olan eklentiler paralel çalışır. Varsayılan depolar BerkStream N'deki BerkFirstRun ile aynı.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Worker } = require('worker_threads')

const DEFAULT_REPOS = [
  'https://izlelan.com/manifest.json',
  'https://raw.githubusercontent.com/falsisdev/anthology/main/manifest.json',
  'https://raw.githubusercontent.com/onrcvndev/nuvio-plugin-tr/main/manifest.json',
]
const PLUGIN_TIMEOUT_MS = 20000
const PARALLEL = +(process.env.BS_PARALLEL || 16)
const UPDATE_EVERY_MS = 12 * 3600e3

let dir = null
let tmdbKey = ''
let state = { repos: [], disabled: {}, seeded: false }

const stateFile = () => path.join(dir, 'state.json')
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
const save = () => fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))

function init(opts) {
  dir = opts.dir
  tmdbKey = opts.tmdbApiKey || ''
  fs.mkdirSync(dir, { recursive: true })
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }
  } catch {}
}

async function getText(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'cache-control': 'no-cache' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

async function installRepo(url) {
  const manifest = JSON.parse(await getText(url))
  if (!Array.isArray(manifest.scrapers)) throw new Error('Bu bir Nuvio kaynak deposu değil (scrapers yok)')
  const base = url.slice(0, url.lastIndexOf('/') + 1)
  const repoDir = path.join(dir, hash(url))
  fs.mkdirSync(repoDir, { recursive: true })
  const scrapers = []
  const queue = manifest.scrapers.filter((s) => s.filename && s.enabled !== false)
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const s = queue.shift()
        try {
          const code = await getText(new URL(s.filename, base).toString())
          const file = path.join(repoDir, `${s.id}.js`)
          fs.writeFileSync(file, code)
          codeCache.delete(file)
          scrapers.push({
            id: s.id,
            name: s.name || s.id,
            description: s.description || '',
            version: s.version || '',
            types: (s.supportedTypes || ['movie', 'tv']).map((t) => (t === 'series' ? 'tv' : t)),
            logo: s.logo || '',
            file,
          })
        } catch {}
      }
    })
  )
  scrapers.sort((a, b) => manifest.scrapers.findIndex((x) => x.id === a.id) - manifest.scrapers.findIndex((x) => x.id === b.id))
  const repo = { url, name: manifest.name || url, version: manifest.version || '', updatedAt: Date.now(), scrapers }
  const i = state.repos.findIndex((r) => r.url === url)
  if (i >= 0) state.repos[i] = repo
  else state.repos.push(repo)
  save()
  return repo
}

// İlk açılışta varsayılan depolar; sonra 12 saatte bir arkada güncelleme.
async function ensure() {
  if (!state.seeded) {
    const results = await Promise.allSettled(DEFAULT_REPOS.map(installRepo))
    if (results.some((r) => r.status === 'fulfilled')) {
      state.seeded = true
      save()
    }
    return
  }
  for (const r of state.repos) {
    if (Date.now() - (r.updatedAt || 0) > UPDATE_EVERY_MS) installRepo(r.url).catch(() => {})
  }
}

function removeRepo(url) {
  const repo = state.repos.find((r) => r.url === url)
  state.repos = state.repos.filter((r) => r.url !== url)
  save()
  if (repo) fs.rmSync(path.join(dir, hash(url)), { recursive: true, force: true })
}

function setEnabled(id, enabled) {
  if (enabled) delete state.disabled[id]
  else state.disabled[id] = true
  save()
}

function list() {
  return state.repos.map((r) => ({
    url: r.url,
    name: r.name,
    version: r.version,
    updatedAt: r.updatedAt,
    scrapers: r.scrapers.map(({ file, ...s }) => ({ ...s, enabled: !state.disabled[s.id] })),
  }))
}

// Eklenti kodu bellekte tutulur: her taramada 16 dosya ana süreçte eşzamanlı okunmasın.
const codeCache = new Map()
async function runOne(scraper, args) {
  let code = codeCache.get(scraper.file)
  if (!code) {
    try {
      code = await fs.promises.readFile(scraper.file, 'utf8')
      codeCache.set(scraper.file, code)
    } catch {
      return { ok: false, error: 'dosya yok' }
    }
  }
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'plugin-worker.cjs'), {
      workerData: { code, scraperId: scraper.id, tmdbKey, settings: {}, args },
      resourceLimits: { maxOldGenerationSizeMb: +(process.env.BS_WORKER_MB || 256) },
    })
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      resolve(v)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'zaman aşımı' }), PLUGIN_TIMEOUT_MS)
    worker.once('message', finish)
    worker.once('error', (e) => finish({ ok: false, error: String(e?.message || e) }))
    worker.once('exit', () => finish({ ok: false, error: 'çıktı' }))
  })
}

function normalize(raw, scraper) {
  const url = typeof raw.url === 'string' ? raw.url : raw.url?.url
  if (!url || url.includes('[object') || url.startsWith('magnet:')) return null
  const str = (v) => (v == null || String(v).includes('[object') ? null : String(v))
  const headers = raw.headers && typeof raw.headers === 'object'
    ? Object.fromEntries(Object.entries(raw.headers).filter(([k, v]) => typeof v === 'string'))
    : null
  const subtitles = Array.isArray(raw.subtitles)
    ? raw.subtitles
        .map((s) => ({ url: s.url, lang: s.lang || s.language || s.label || '', label: s.label || s.lang || s.language || '' }))
        .filter((s) => typeof s.url === 'string' && s.url)
    : []
  return {
    provider: scraper.name,
    providerId: scraper.id,
    name: str(raw.name),
    title: str(raw.title) || str(raw.name) || scraper.name,
    url,
    quality: str(raw.quality),
    size: str(raw.size),
    headers: headers && Object.keys(headers).length ? headers : null,
    subtitles,
  }
}

// Açık eklentileri paralel çalıştırır; her eklenti bitince onStreams ile anında bildirir.
async function getStreams({ tmdbId, kind, season, episode }, onProgress, isCancelled) {
  const mediaType = kind === 'tv' ? 'tv' : 'movie'
  const scrapers = state.repos.flatMap((r) => r.scrapers).filter((s) => !state.disabled[s.id] && s.types.includes(mediaType))
  const unique = [...new Map(scrapers.map((s) => [s.id, s])).values()]
  const queue = [...unique]
  let finished = 0
  const total = unique.length
  onProgress({ total, finished, streams: [], scraper: null })
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (queue.length && !isCancelled()) {
        const s = queue.shift()
        const res = await runOne(s, { tmdbId: String(tmdbId), mediaType, season: season ?? null, episode: episode ?? null })
        finished++
        const streams = res.ok ? (res.streams || []).map((x) => normalize(x, s)).filter(Boolean) : []
        if (!isCancelled()) onProgress({ total, finished, streams, scraper: s.name, error: res.ok ? null : res.error })
      }
    })
  )
}

module.exports = { init, ensure, installRepo, removeRepo, setEnabled, list, getStreams }
