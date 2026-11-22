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
  try {
    stats = JSON.parse(fs.readFileSync(statsFile(), 'utf8'))
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
// Eklenti karnesi: kaç kez koştu, kaçında kaynak buldu, kaçında takıldı. Tarama sırası buna göre:
// iş görenler önce (ilk kaynak erken gelir), hep boş dönen/takılanlar sona ve kısa süreyle.
let stats = {}
const statsFile = () => path.join(dir, 'stats.json')
let statsT = null
function note(id, ok, hits, ms) {
  const s = (stats[id] ||= { runs: 0, hits: 0, stuck: 0, ms: 0 })
  s.runs++
  if (hits) s.hits++
  if (!ok) s.stuck++
  s.ms = Math.round(s.ms ? s.ms * 0.7 + ms * 0.3 : ms)
  clearTimeout(statsT)
  statsT = setTimeout(() => fs.promises.writeFile(statsFile(), JSON.stringify(stats)).catch(() => {}), 5000)
}
const rate = (id) => { const s = stats[id]; return s ? (s.hits + 0.5) / (s.runs + 1) : 0.5 }
const chronic = (id) => { const s = stats[id]; return !!s && s.runs >= 3 && s.hits === 0 }
function ordered(list) {
  return [...list].sort((a, b) => chronic(a.id) - chronic(b.id) || rate(b.id) - rate(a.id) || (stats[a.id]?.ms || 9e3) - (stats[b.id]?.ms || 9e3))
}

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
  return pool.run({ code, scraperId: scraper.id, args }, chronic(scraper.id) ? 8000 : PLUGIN_TIMEOUT_MS)
}

// İş parçacığı havuzu: her eklentide yeni iş parçacığı + cheerio yüklemek zayıf işlemcide (Render)
// dakikalar sürüyordu. Havuzdakiler açık kalır; zaman aşımına uğrayan iş parçacığı öldürülüp yenisi açılır.
let jobSeq = 0
const pool = {
  workers: [],
  queue: [],
  spawn() {
    const w = new Worker(path.join(__dirname, 'plugin-worker.cjs'), { workerData: { tmdbKey }, resourceLimits: { maxOldGenerationSizeMb: +(process.env.BS_WORKER_MB || 256) } })
    const slot = { w, busy: null, ready: false }
    w.on('message', (m) => {
      if (m.ready) { slot.ready = true; return this.pump() }
      if (slot.busy && m.id === slot.busy.id) {
        const job = slot.busy
        slot.busy = null
        clearTimeout(job.timer)
        job.resolve(m)
        this.pump()
        // Boşta kalan iş parçacığı 30 sn sonra kapanır: tarama bitince 6 tanesi Render'ın 512 MB'ını
        // tutmaya devam ediyordu (IPTV ile birleşince sunucu çöküp diski siliyordu).
        if (!slot.busy) { clearTimeout(slot.idleT); slot.idleT = setTimeout(() => { if (!slot.busy) slot.w.terminate().catch(() => {}) }, 30000) }
      }
    })
    const dead = () => {
      this.workers = this.workers.filter((x) => x !== slot)
      if (slot.busy) { clearTimeout(slot.busy.timer); slot.busy.resolve({ ok: false, error: 'çıktı' }); slot.busy = null }
      this.pump()
    }
    w.on('error', dead)
    w.on('exit', dead)
    this.workers.push(slot)
    return slot
  },
  run(payload, timeout = PLUGIN_TIMEOUT_MS) {
    return new Promise((resolve) => {
      this.queue.push({ id: ++jobSeq, payload, resolve, timeout })
      this.pump()
    })
  },
  pump() {
    while (this.workers.length < PARALLEL && this.queue.length > this.workers.filter((x) => !x.busy).length) this.spawn()
    for (const slot of this.workers) {
      if (!this.queue.length) break
      if (slot.busy || !slot.ready) continue
      const job = this.queue.shift()
      clearTimeout(slot.idleT)
      slot.busy = job
      job.timer = setTimeout(() => {
        // Takılan eklenti: iş parçacığını öldür (kalan fetch'leri de gider), yenisi açılır.
        if (slot.busy === job) { slot.busy = null; job.resolve({ ok: false, error: 'zaman aşımı' }); slot.w.terminate().catch(() => {}) }
      }, job.timeout)
      slot.w.postMessage({ id: job.id, ...job.payload })
    }
  },
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
  const queue = ordered(unique)
  let finished = 0
  const total = unique.length
  onProgress({ total, finished, streams: [], scraper: null })
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (queue.length && !isCancelled()) {
        const s = queue.shift()
        const t0 = Date.now()
        const res = await runOne(s, { tmdbId: String(tmdbId), mediaType, season: season ?? null, episode: episode ?? null })
        finished++
        const streams = res.ok ? (res.streams || []).map((x) => normalize(x, s)).filter(Boolean) : []
        note(s.id, res.ok, streams.length, Date.now() - t0)
        if (!isCancelled()) onProgress({ total, finished, streams, scraper: s.name, error: res.ok ? null : res.error })
      }
    })
  )
}

const getStats = () => stats
module.exports = { init, ensure, installRepo, removeRepo, setEnabled, list, getStreams, getStats }
