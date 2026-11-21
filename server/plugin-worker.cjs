// Tek bir Nuvio kaynak eklentisini (getStreams) ayrı bir iş parçacığında çalıştırır.
// Nuvio TV'deki QuickJS ortamının karşılığı: fetch, cheerio, crypto-js, atob/btoa, TMDB_API_KEY.
// Eklentiye fs / child_process / process verilmez; iş bitince iş parçacığı tamamen kapatılır.
const { parentPort, workerData } = require('worker_threads')
const cheerio = require('cheerio')
const CryptoJS = require('crypto-js')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAX_BYTES = 4 * 1024 * 1024
const nativeFetch = globalThis.fetch

// Havuz modu: iş parçacığı bir kez açılır (cheerio bir kez yüklenir), eklentiler sırayla koşar.
const { tmdbKey } = workerData

function pluginFetch(input, init = {}) {
  const headers = new Headers(init.headers || (input && input.headers) || {})
  if (!headers.has('user-agent')) headers.set('user-agent', UA)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  if (init.signal) init.signal.addEventListener?.('abort', () => ctrl.abort())
  return nativeFetch(input, { ...init, headers, signal: ctrl.signal })
    .then(async (res) => {
      // Gövdeyi bir kez okuyup sınırlı bir Response'a çevir (dev dosya inmesin).
      const reader = res.body?.getReader()
      const chunks = []
      let size = 0
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > MAX_BYTES) {
            reader.cancel().catch(() => {})
            break
          }
          chunks.push(value)
        }
      }
      const body = Buffer.concat(chunks)
      const out = new Response(res.status === 204 || res.status === 304 || (res.status >= 100 && res.status < 200) ? null : body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
      Object.defineProperty(out, 'url', { value: res.url })
      Object.defineProperty(out, 'redirected', { value: res.redirected })
      return out
    })
    .catch((e) => {
      const u = typeof input === 'string' ? input : input?.url
      log('fetch')(`${u} -> ${e?.cause?.code || e?.cause?.message || e?.message}`)
      throw e
    })
    .finally(() => clearTimeout(timer))
}

const sandboxRequire = (name) => {
  if (name === 'cheerio' || name === 'cheerio-without-node-native' || name === 'react-native-cheerio') return cheerio
  if (name === 'crypto-js') return CryptoJS
  throw new Error(`Module '${name}' is not available`)
}

let logs = []
const log = (level) => (...a) => {
  if (logs.length < 40) logs.push(`[${level}] ` + a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' ').slice(0, 300))
}
const safe = (x) => {
  try {
    return JSON.stringify(x)
  } catch {
    return String(x)
  }
}

globalThis.fetch = pluginFetch
globalThis.CryptoJS = CryptoJS
globalThis.cheerio = cheerio
globalThis.TMDB_API_KEY = tmdbKey
globalThis.SCRAPER_SETTINGS = {}
globalThis.window = globalThis
globalThis.self = globalThis
globalThis.global = globalThis
const quietConsole = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} }
globalThis.console = quietConsole

// Node'a özgü kapılar eklentiye parametre olarak undefined verilir (aşağıda new Function).
// Global process silinmez: düz Node'da fetch (undici) içeride process.env'e ve timer.unref'e muhtaç.

// Bazı eklentiler setTimeout/clearTimeout'u kendi sahtesiyle ezer; düz Node'da fetch (undici)
// gerçek Timeout nesnesine (unref) muhtaç olduğu için hepsi "fetch failed" olurdu. Kilitlenir.
for (const k of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'fetch', 'Headers', 'Request', 'Response', 'AbortController', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder']) {
  const v = globalThis[k]
  if (v === undefined) continue
  try {
    Object.defineProperty(globalThis, k, { get: () => v, set: () => {}, configurable: false, enumerable: true })
  } catch {}
}

// Eklentinin globalThis'i: process/require görünmez, geri kalanı gerçek global.
const sandboxGlobal = new Proxy(globalThis, {
  get: (t, k) => (k === 'process' || k === 'require' ? undefined : Reflect.get(t, k)),
  has: (t, k) => (k === 'process' || k === 'require' ? false : Reflect.has(t, k)),
})

async function run({ code, scraperId, args }) {
  globalThis.SCRAPER_ID = scraperId
  try { delete globalThis.getStreams } catch {}
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', 'process', '__dirname', '__filename', 'console', 'globalThis', code)
  fn(module, module.exports, sandboxRequire, undefined, undefined, undefined, quietConsole, sandboxGlobal)
  const getStreams = module.exports.getStreams || globalThis.getStreams
  if (typeof getStreams !== 'function') throw new Error('getStreams bulunamadı')
  const result = await getStreams(args.tmdbId, args.mediaType, args.season, args.episode)
  return JSON.parse(JSON.stringify(Array.isArray(result) ? result : []))
}

parentPort.on('message', (job) => {
  logs = []
  run(job)
    .then((streams) => parentPort.postMessage({ id: job.id, ok: true, streams, logs }))
    .catch((e) => parentPort.postMessage({ id: job.id, ok: false, error: String((e && e.message) || e), logs }))
})
parentPort.postMessage({ ready: true })
