// Ev sunucusu: PC'de (Türkiye IP'si) sunucuyu açar, Cloudflare hızlı tüneli kurar ve tünel adresini
// kapıya (Render) kaydeder. Kapı girişli kullanıcıyı buraya geçirir; PC kapalıysa kapı kendisi çalışır.
// Her 4 dakikada yeniden kayıt = kapı uyumaz (Render'ın 50 sn'lik soğuk açılışı olmaz).
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const KAPI = process.env.BS_KAPI || 'https://kabak-tatlisi.onrender.com'
const CLOUDFLARED = process.env.CLOUDFLARED || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
const LOG = path.join(__dirname, 'data', 'ev.log')
fs.mkdirSync(path.dirname(LOG), { recursive: true })
const log = (...a) => {
  const line = `[${new Date().toLocaleString('tr-TR')}] ${a.join(' ')}\n`
  process.stdout.write(line)
  try {
    fs.appendFileSync(LOG, line)
    if (fs.statSync(LOG).size > 2e6) fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').slice(-5e5))
  } catch {}
}

process.env.PORT = process.env.PORT || '8790'
const { sso } = require('./server/index.cjs')

let tunnelUrl = null
let proc = null

async function register() {
  if (!tunnelUrl) return
  const ts = Date.now()
  try {
    const r = await fetch(`${KAPI}/api/home-register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: tunnelUrl, ts, sig: sso(`home|${tunnelUrl}|${ts}`) }), signal: AbortSignal.timeout(90000) })
    log('kapıya kayıt:', r.status, tunnelUrl)
  } catch (e) {
    log('kapıya kayıt olmadı:', e?.cause?.code || e?.message)
  }
}

async function waitReachable(url) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) })
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

function startTunnel() {
  tunnelUrl = null
  proc = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${process.env.PORT}`], { windowsHide: true })
  const onData = async (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d))
    if (m && !tunnelUrl) {
      tunnelUrl = m[0]
      log('tünel:', tunnelUrl)
      if (await waitReachable(tunnelUrl)) await register()
      else {
        log('tünel erişilemedi, yine de kaydediliyor')
        await register()
      }
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  proc.on('exit', (code) => {
    log('tünel kapandı, kod', code, '- 10 sn sonra yeniden')
    tunnelUrl = null
    setTimeout(startTunnel, 10000)
  })
}

// Tünel sessizce ölürse (uyku, internet kopması) yakala: kendi adresimize dışarıdan ulaşamıyorsak yeniden kur.
setInterval(async () => {
  if (!tunnelUrl) return
  try {
    const r = await fetch(`${tunnelUrl}/healthz`, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error(String(r.status))
    register()
  } catch (e) {
    log('tünel yanıt vermiyor (' + (e?.message || e) + '), yeniden kuruluyor')
    proc?.kill()
  }
}, 4 * 60e3)

process.on('exit', () => proc?.kill())
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit())
startTunnel()
