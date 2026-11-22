'use strict'
// BerkStream N Tesla — TiviMate düzeni: gruplar | liste | önizleme. Tek dosya, çatısız.

const $ = (s, r = document) => r.querySelector(s)
// replaceChildren(null) ekrana "null" yazar: boş dalları ayıkla.
{
  const rc = Element.prototype.replaceChildren
  Element.prototype.replaceChildren = function (...k) { return rc.apply(this, k.flat().filter((x) => x != null && x !== false)) }
  const ap = Element.prototype.append
  Element.prototype.append = function (...k) { return ap.apply(this, k.filter((x) => x != null && x !== false)) }
}
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v)
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k === 'html') e.innerHTML = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)))
  return e
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const cleanTitle = (t) => String(t || '').replace(/^[^\p{L}\p{N}']+/u, '').trim()
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
const hhmm = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
// TMDB görselini gösterildiği boyda iste: 48 px'lik satır afişine w342 indirmek arabanın işlemcisini boğuyor.
const img = (u, size) => (u ? String(u).replace(/\/t\/p\/(w\d+|original)\//, `/t/p/${size}/`) : u)
const LS = {
  get(k, d) { try { const v = localStorage.getItem('bs_' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('bs_' + k, JSON.stringify(v)) } catch {} },
}

async function api(path, opts) {
  const r = await fetch(path, opts)
  if (r.status === 401) { location.replace('/'); throw new Error('giriş') }
  return r.json()
}
const post = (path, data) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
const memo = new Map()
const cached = (key, fn, ttl = 10 * 60e3) => {
  const c = memo.get(key)
  if (c && Date.now() - c.at < ttl) return c.p
  const p = fn().catch((e) => { memo.delete(key); throw e })
  memo.set(key, { p, at: Date.now() })
  return p
}

// ---------------------------------------------------------------- kaynak sırası (BerkStreamRank)
const TR_FLAG = '🇹🇷'
const dubWords = ['dublaj', 'dubbed', 'türkçe ses', 'turkce ses', 'tr dub', 'trdub', 'tr ses', '[dub]', ' dub ']
const subWords = ['altyazılı', 'altyazili', 'türkçe altyazı', 'turkce altyazi', 'tr altyazı', 'tr sub']
const turkishWords = ['türkçe', 'turkce', 'turkish', ' tr ', '[tr]', TR_FLAG]
const sText = (s) => ' ' + [s.name, s.title, s.quality].filter(Boolean).join(' ').toLocaleLowerCase('tr') + ' '
const qTier = (t) => (/2160|4k|uhd/.test(t) ? 5 : t.includes('1440') ? 4 : t.includes('1080') ? 3 : t.includes('720') ? 2 : /576|480/.test(t) ? 1 : /360|240/.test(t) ? 0 : 2)
const after = (t, k) => { const i = t.indexOf(k); return i < 0 ? '' : t.slice(i + k.length) }
const audioPart = (t) => after(t, 'ses:').split('altyazı')[0].split('altyazi')[0].split('•')[0]
const subPart = (t) => after(t, 'altyazı:') || after(t, 'altyazi:')
function lang(s) {
  const t = sText(s)
  if (audioPart(t).includes(TR_FLAG) || dubWords.some((w) => t.includes(w))) return 'DUB'
  if (subPart(t).includes(TR_FLAG) || subWords.some((w) => t.includes(w))) return 'SUB'
  if (!t.includes('ses:') && turkishWords.some((w) => t.includes(w))) return 'SUB'
  return 'NONE'
}
function score(s) {
  const t = sText(s), l = lang(s)
  let sc = qTier(t) * 10
  if (l !== 'NONE') sc += 1000
  if (l === 'DUB') sc += 6 + (audioPart(t).trim().startsWith(TR_FLAG) ? 1 : 0)
  if (l === 'SUB') sc += 3
  return sc
}
const sortStreams = (list) => list.map((s, i) => ({ s, i, sc: score(s) })).sort((a, b) => b.sc - a.sc || a.i - b.i).map((x) => x.s)
const qLabel = (s) => ['360p', '480p', '720p', '1080p', '1440p', '4K'][qTier(sText(s))]

// ---------------------------------------------------------------- durum
const S = {
  tab: LS.get('tab', 'n'),
  store: { list: [], progress: {}, settings: {}, favs: [], recentCh: [] },
  home: null,
  iptv: [],
  group: LS.get('group', {}),
  items: [],
  sel: -1,
  listKey: '',
  playingKey: null,
}
const progKey = (kind, id, s, e) => (kind === 'tv' && s != null ? `tv:${id}:${s}:${e}` : `${kind}:${id}`)

// ---------------------------------------------------------------- saat
function tick() {
  const t = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  $('#clock').textContent = t
  $('#pClock').textContent = t
}
setInterval(tick, 10e3)

// ---------------------------------------------------------------- sekmeler
function tabs() {
  const live = S.iptv.some((l) => l.counts?.live)
  const mov = S.iptv.some((l) => l.counts?.movie)
  const ser = S.iptv.some((l) => l.counts?.series)
  const list = [
    ['n', '🎬', 'Film & Dizi'],
    ['live', '📡', 'Canlı TV'],
    mov && ['movie', '🎞️', 'IPTV Film'],
    ser && ['series', '📼', 'IPTV Dizi'],
    ['search', '🔍', 'Ara'],
    ['mylist', '❤', 'Listem'],
  ].filter(Boolean)
  void live
  if (!list.some((t) => t[0] === S.tab)) S.tab = 'n'
  const nav = $('#tabs')
  nav.replaceChildren(...list.map(([k, i, t]) => h('button', { class: 'tab' + (S.tab === k ? ' on' : ''), onclick: () => setTab(k) }, h('span', {}, i), t)))
}
function setTab(k) {
  S.tab = k
  LS.set('tab', k)
  tabs()
  // Eski sekmenin listesi/önizlemesi hemen temizlenir (yeni sekme yüklenirken Canlı TV seçili ama
  // ortada film listesi duruyordu).
  selGen++
  S.items = []
  S.listKind = 'none'
  rendered.clear()
  stopMini()
  $('#listHead').replaceChildren()
  $('#vspace').style.height = '0px'
  $('#vspace').replaceChildren(h('div', { class: 'spin' }))
  $('#preview').replaceChildren()
  renderGroups()
}

// ---------------------------------------------------------------- gruplar
let curGroups = []
function groupBtn(g, active) {
  return h('button', { class: 'g' + (active ? ' on' : ''), 'data-key': g.key, onclick: () => selectGroup(g) },
    g.logo ? h('img', { class: 'gl', src: g.logo, alt: '' }) : h('span', { class: 'gi' }, g.icon || '•'),
    h('span', { class: 'gn' }, g.title),
    g.count != null ? h('span', { class: 'gc' }, g.count) : null)
}
function curListId() {
  const want = LS.get('iptvList', null)
  const ok = S.iptv.filter((l) => l.counts?.[S.tab === 'live' ? 'live' : S.tab])
  return (ok.find((l) => l.id === want) || ok[0])?.id || null
}

// Her çizim bir kuşak numarası alır: yavaş gelen eski cevap (önceki sekme/grup) yenisinin
// üstüne yazamaz. "Menüye bastım geçmedi" hatasının sebebi buydu.
let groupsGen = 0
async function renderGroups() {
  const gen = ++groupsGen
  try {
    await renderGroupsInner(gen)
  } catch (e) {
    if (gen !== groupsGen) return
    $('#groups').replaceChildren(h('div', { class: 'empty' }, 'Yüklenemedi.'), h('button', { class: 'gAdd', onclick: renderGroups }, '↻  Tekrar dene'))
  }
}
async function renderGroupsInner(gen) {
  const col = $('#groups')
  const tab = S.tab
  let groups = []
  const waiting = tab === 'n' ? !S.home : ['live', 'movie', 'series'].includes(tab) && curListId() && !chGroups.has(curListId())
  if (waiting) col.replaceChildren(h('div', { class: 'spin' }))
  if (tab === 'n') {
    if (!S.home) S.home = await cached('home', () => api('/api/home'))
    if (gen !== groupsGen) return
    const cont = Object.values(S.store.progress).filter((p) => p.meta && p.dur && p.pos / p.dur < 0.95)
    groups.push({ head: 'BerkStream N' })
    if (cont.length) groups.push({ key: 'cont', title: 'İzlemeye devam et', icon: '▶', count: cont.length })
    for (const sh of S.home.shelves) {
      const m = /^([^\p{L}\p{N}']+)/u.exec(sh.title)
      groups.push({ key: 'shelf:' + sh.id, title: titleCase(cleanTitle(sh.title)), icon: (m?.[1] || '•').trim() || '•', ranked: sh.ranked })
    }
    groups.push({ head: 'Platformlar' })
    for (const p of S.home.platforms) groups.push({ key: 'plat:' + p.key, title: p.title, logo: p.logo })
  } else if (tab === 'live' || tab === 'movie' || tab === 'series') {
    const id = curListId()
    if (S.iptv.length > 1) {
      groups.push({ head: 'Liste' })
      for (const l of S.iptv.filter((l) => l.counts?.[tab])) groups.push({ key: 'list:' + l.id, title: l.name, icon: l.id === id ? '◉' : '○', count: l.counts[tab], isList: true })
    }
    if (!id) {
      col.replaceChildren(h('div', { class: 'empty' }, 'Henüz IPTV listesi yok.'), h('button', { class: 'gAdd', onclick: openIptv }, '+ M3U / Xtream ekle'))
      curGroups = []
      selGen++
      showList('none', 'IPTV', [])
      $('#preview').replaceChildren(h('div', { class: 'pvEmpty' }, h('div', {}, h('b', {}, '📡'), 'M3U linkini ya da Xtream bilgilerini ekle,', h('br'), 'kanallar TiviMate gibi burada dizilsin.')))
      return
    }
    const data = await loadGroups(id)
    if (gen !== groupsGen) return
    groups.push({ head: tab === 'live' ? 'Kanallar' : 'Kategoriler' })
    if (tab === 'live') {
      groups.push({ key: 'favs', title: 'Favoriler', icon: '★', count: S.store.favs.filter((k) => k.startsWith(id + ':')).length })
      groups.push({ key: 'recent', title: 'Son izlenenler', icon: '🕘' })
    }
    groups.push({ key: 'all', title: 'Tümü', icon: '☰', count: (data.groups[tab] || []).reduce((a, g) => a + g.count, 0) })
    for (const g of data.groups[tab] || []) groups.push({ key: 'grp:' + g.name, title: g.name, icon: '›', count: g.count })
  } else if (tab === 'search') {
    groups.push({ head: 'Ara' }, { key: 'search', title: 'Film & Dizi ara', icon: '🔍' })
    if (S.iptv.length) groups.push({ key: 'searchTv', title: 'Kanal ara', icon: '📡' })
  } else if (tab === 'mylist') {
    groups.push({ head: 'Benim' }, { key: 'mylist', title: 'Listem', icon: '❤', count: S.store.list.length }, { key: 'cont', title: 'İzlemeye devam et', icon: '▶' })
  }
  curGroups = groups
  let active = S.group[tab]
  if (!active || !groups.some((g) => g.key && g.key === active && !g.isList)) active = (groups.find((g) => g.ranked) || groups.find((g) => g.key && !g.isList))?.key
  if (active === 'favs' && !groups.find((g) => g.key === 'favs')?.count && !S.group[tab]) active = 'all'
  col.replaceChildren(...groups.map((g) => (g.head ? h('div', { class: 'gHead' }, g.head) : groupBtn(g, g.key === active || (g.isList && g.key === 'list:' + curListId())))))
  // Yönet düğmesi en üstte: 150 grubun altına gömülünce kimse bulamıyordu.
  if (tab === 'live' || tab === 'movie' || tab === 'series') col.prepend(h('button', { class: 'gAdd top', onclick: openIptv }, '⚙  Listeleri yönet / ekle'))
  col.scrollTop = 0
  if (active) selectGroup(groups.find((g) => g.key === active), true)
}
const titleCase = (s) => s.toLocaleLowerCase('tr').replace(/(^|[\s•(])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('tr')).replace(/\bTv\b/g, 'TV').replace(/\bHbo\b/, 'HBO').replace(/İlk 10/i, 'İlk 10')

let selGen = 0
async function selectGroup(g, initial) {
  const gen = ++selGen
  try {
    await selectGroupInner(g, initial, gen)
  } catch (e) {
    if (gen !== selGen || !g || g.isList) return
    $('#listHead').replaceChildren(h('h2', {}, g.title))
    $('#vspace').style.height = '0px'
    $('#vspace').replaceChildren(h('div', { class: 'empty' }, 'Yüklenemedi.', h('br'), h('button', { class: 'btn', style: { marginTop: '16px' }, onclick: () => selectGroup(g) }, '↻  Tekrar dene')))
  }
}
async function selectGroupInner(g, initial, gen) {
  if (!g) return
  if (g.isList) {
    LS.set('iptvList', g.key.slice(5))
    return renderGroups()
  }
  S.group[S.tab] = g.key
  LS.set('group', S.group)
  for (const b of $('#groups').querySelectorAll('.g')) if (!b.dataset.key?.startsWith('list:')) b.classList.toggle('on', b.dataset.key === g.key)
  const k = g.key
  if (!['search', 'searchTv'].includes(k)) {
    $('#listHead').replaceChildren(h('h2', {}, g.title))
    $('#vspace').style.height = '0px'
    $('#vspace').replaceChildren(h('div', { class: 'spin' }))
  }
  if (k === 'cont') {
    const items = Object.entries(S.store.progress).filter(([, p]) => p.meta && p.dur && p.pos / p.dur < 0.95).sort((a, b) => b[1].updatedAt - a[1].updatedAt).map(([key, p]) => ({ ...p.meta, _prog: p, _key: key }))
    return showList('meta', g.title, items, { initial, gen })
  }
  if (k === 'mylist') return showList('meta', 'Listem', S.store.list, { initial, gen })
  if (k.startsWith('shelf:')) return showShelf(k.slice(6), g.title, g.ranked, initial, gen)
  if (k.startsWith('plat:')) {
    const p = await cached('plat:' + k, () => api('/api/platform?key=' + k.slice(5)))
    const items = []
    // dört raf aynı anda (eskiden ikişer ikişer sırayla bekleniyordu)
    const shelf = (sh) => cached('shelf:' + sh.id + ':1', () => api(`/api/shelf?id=${sh.id}&page=1`)).catch(() => [])
    const [all, rest] = await Promise.all([Promise.all(p.shelves.slice(0, 2).map(shelf)), Promise.all(p.shelves.slice(3, 5).map(shelf))])
    all.forEach((arr) => items.push(...arr.slice(0, 10)))
    rest.forEach((arr) => items.push(...arr))
    const seen = new Set()
    return showList('meta', p.title, items.filter((x) => { const kk = x.kind + x.id; if (seen.has(kk)) return false; seen.add(kk); return true }), { initial, gen, rankUntil: 0 })
  }
  if (k === 'search') return showSearch(initial)
  if (k === 'searchTv') return showTvSearch()
  // IPTV
  const id = curListId()
  const kind = KIND[S.tab]
  const emptyText = k === 'favs' ? 'Kanala dokun, sağdan ☆ Favori.' : k === 'recent' ? 'Henüz kanal izlemedin.' : 'Burası boş.'
  if (k === 'favs' || k === 'recent') {
    const want = (k === 'favs' ? S.store.favs : S.store.recentCh).filter((f) => f.startsWith(id + ':')).map((f) => +f.split(':')[1])
    const r = want.length ? await api(`/api/iptv/rows?id=${id}&idx=${want.join(',')}`) : { rows: [] }
    keepRows(id, r?.rows || [])
    return showList('ch', g.title, want.filter((i) => chRow(id, i)), { initial, gen, listId: id, emptyText })
  }
  const page = { id, kind, group: k.startsWith('grp:') ? k.slice(4) : '' }
  const r = await fetchPage(page, 0)
  const items = new Array(r.total)
  r.rows.forEach((row, n) => (items[n] = row[0]))
  showList('ch', g.title, items, { initial, gen, listId: id, page, emptyText })
}

// ---------------------------------------------------------------- IPTV veri
// Gruplar bir kez, kanallar sayfa sayfa (200'lük): 115 bin satırlık Xtream listesi eskiden tek
// JSON'da iniyordu, sunucu çöküyor, arabanın tarayıcısı kilitleniyordu.
const KIND = { live: 'l', movie: 'm', series: 's' }
const PAGE = 200
const chGroups = new Map() // id -> { groups, at }
const chRows = new Map() // id -> Map(i -> [ad, logo, grup, tvg-id, tür, numara])
async function loadGroups(id) {
  if (chGroups.has(id)) return chGroups.get(id)
  const r = await api('/api/iptv/groups?id=' + id)
  if (!r) throw new Error('liste yok')
  chGroups.set(id, r)
  return r
}
function keepRows(id, rows) {
  let m = chRows.get(id)
  if (!m) chRows.set(id, (m = new Map()))
  for (const r of rows) if (r) m.set(r[0], [r[1], r[2], r[3], r[4], r[6], r[5]])
}
const chRow = (id, i) => chRows.get(id)?.get(i)
function forgetList(id) {
  chGroups.delete(id)
  chRows.delete(id)
}
async function fetchPage(page, from) {
  const r = await api(`/api/iptv/rows?id=${page.id}&kind=${page.kind}&group=${encodeURIComponent(page.group)}&from=${from}&n=${PAGE}`)
  if (!r) throw new Error('liste yok')
  keepRows(page.id, r.rows)
  return r
}
// Ekranda boş satır görünce o satırın sayfası istenir.
const pagesLoading = new Set()
function needPage(pos) {
  const page = vOpts.page
  if (!page) return
  const from = Math.floor(pos / PAGE) * PAGE
  const key = S.listKey + '|' + from
  if (pagesLoading.has(key)) return
  pagesLoading.add(key)
  const items = S.items
  fetchPage(page, from)
    .then((r) => {
      if (S.items !== items) return
      r.rows.forEach((row, n) => (items[from + n] = row[0]))
      vRender(true)
      // hatırlanan seçili kanal bu sayfadaysa önizlemesi şimdi açılır
      if (S.sel >= from && S.sel < from + r.rows.length && !$('#preview .pvBody')) select(S.sel, false)
    })
    .catch(() => {})
    .finally(() => pagesLoading.delete(key))
}
async function ensurePos(pos) {
  if (S.items[pos] != null || !vOpts.page) return S.items[pos]
  const from = Math.floor(pos / PAGE) * PAGE
  const items = S.items
  const r = await fetchPage(vOpts.page, from)
  r.rows.forEach((row, n) => (items[from + n] = row[0]))
  return items[pos]
}
const epgCache = new Map()
let epgPending = new Set()
let epgTimer = null
function wantEpg(listId, tvgId) {
  if (!tvgId) return null
  const key = listId + '|' + tvgId
  const c = epgCache.get(key)
  if (c && Date.now() - c.at < 5 * 60e3) return c.v
  if (!c?.loading) {
    epgPending.add(tvgId)
    epgCache.set(key, { v: c?.v || null, at: c?.at || 0, loading: true })
    clearTimeout(epgTimer)
    epgTimer = setTimeout(() => flushEpg(listId), 120)
  }
  return c?.v || null
}
async function flushEpg(listId) {
  const ids = [...epgPending]
  epgPending = new Set()
  for (let i = 0; i < ids.length; i += 150) {
    const part = ids.slice(i, i + 150)
    const r = await api(`/api/iptv/epg?id=${listId}&t=${encodeURIComponent(part.join(','))}`).catch(() => ({}))
    for (const t of part) epgCache.set(listId + '|' + t, { v: r[t] || [], at: Date.now() })
  }
  vRender(true)
  if (S.listKind === 'ch' && S.sel >= 0) renderPreviewCh(S.items[S.sel], true)
}
const nowProg = (arr) => { const n = Date.now(); return arr?.find((p) => p.s <= n && p.e > n) || null }

// ---------------------------------------------------------------- sanal liste
S.listKind = 'none'
let vOpts = {}
function showList(kind, title, items, opts = {}) {
  if (opts.gen != null && opts.gen !== selGen) return
  S.listKind = kind
  S.items = items
  vOpts = opts
  const key = S.tab + '|' + (S.group[S.tab] || '')
  const keep = key === S.listKey
  S.listKey = key
  const head = $('#listHead')
  if (!opts.keepHead) head.replaceChildren(h('h2', {}, title), h('span', { class: 'cnt' }, items.length ? items.length : ''))
  else head.querySelector('.cnt') && (head.querySelector('.cnt').textContent = items.length || '')
  const vl = $('#vlist')
  if (!keep || !opts.initial) vl.scrollTop = 0
  const remembered = LS.get('sel:' + key, -1)
  S.sel = Math.min(remembered, items.length - 1)
  if (S.sel < 0 && items.length) S.sel = 0
  if (!items.length) {
    $('#vspace').style.height = '0px'
    $('#vspace').replaceChildren(h('div', { class: 'empty' }, opts.emptyText || 'Burası boş.'))
    if (!opts.keepPreview) $('#preview').replaceChildren(h('div', { class: 'pvEmpty' }, h('div', {}, h('b', {}, 'B'), opts.emptyText || '')))
    return
  }
  $('#vspace').style.height = items.length * rowH() + 'px'
  $('#vspace').replaceChildren()
  rendered.clear()
  if (S.sel > 0 && !keep) vl.scrollTop = Math.max(0, S.sel * rowH() - vl.clientHeight / 3)
  vRender(true)
  select(S.sel, false)
}
// Satır yüksekliği bir kez okunur: her kaydırma karesinde getComputedStyle pahalı.
let ROW = 0
const rowH = () => ROW || (ROW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 84)
window.addEventListener('resize', () => { ROW = 0; if (S.items.length) { $('#vspace').style.height = S.items.length * rowH() + 'px'; vRender(true) } })
const rendered = new Map()
function vRender(force) {
  const vl = $('#vlist'), sp = $('#vspace'), rh = rowH()
  if (!S.items.length) return
  const from = Math.max(0, Math.floor(vl.scrollTop / rh) - 6)
  const to = Math.min(S.items.length, Math.ceil((vl.scrollTop + vl.clientHeight) / rh) + 6)
  for (const [i, el] of rendered) if (i < from || i >= to || force) { el.remove(); rendered.delete(i) }
  for (let i = from; i < to; i++) {
    if (rendered.has(i)) continue
    const el = rowEl(i)
    el.style.top = i * rh + 'px'
    sp.append(el)
    rendered.set(i, el)
  }
  // sonsuz kaydırma (raflar)
  if (vOpts.more && to >= S.items.length - 4) vOpts.more()
}
let vRaf = 0
$('#vlist').addEventListener('scroll', () => { if (!vRaf) vRaf = requestAnimationFrame(() => { vRaf = 0; vRender(false) }) }, { passive: true })

function rowEl(i) {
  const it = S.items[i]
  const on = i === S.sel
  if (S.listKind === 'meta') {
    const p = it._prog || S.store.progress[`${it.kind}:${it.id}`]
    const rank = vOpts.ranked && i < 10
    return h('button', { class: 'row' + (on ? ' on' : ''), onclick: () => tapRow(i) },
      h('span', { class: 'rn' + (rank ? ' big' : '') }, i + 1),
      h('div', { class: 'rp', style: { backgroundImage: `url(${img(it.poster, 'w154')})` } }),
      h('div', { class: 'rb' },
        h('div', { class: 'rt' }, it.name),
        h('div', { class: 'rs' }, [it.year, it.rating && '★ ' + it.rating, it.kind === 'tv' ? 'Dizi' : 'Film', it._prog?.season ? `S${it._prog.season} B${it._prog.episode}` : null].filter(Boolean).join('  ·  ')),
        p && p.dur ? h('div', { class: 'rpg' }, h('i', { style: { width: Math.min(100, (p.pos / p.dur) * 100) + '%' } })) : null))
  }
  // kanal (sayfası henüz gelmediyse boş satır)
  const c = it == null ? null : chRow(vOpts.listId, it)
  if (!c) {
    needPage(i)
    return h('div', { class: 'row ghost' }, h('span', { class: 'rn' }, i + 1), h('div', { class: 'rl' }), h('div', { class: 'rb' }, h('div', { class: 'rt' }, '…')))
  }
  const epg = S.tab === 'live' ? wantEpg(vOpts.listId, c[3]) : null
  const np = nowProg(epg)
  const fav = S.store.favs.includes(vOpts.listId + ':' + it)
  const playing = S.playingKey === vOpts.listId + ':' + it
  return h('button', { class: 'row' + (on ? ' on' : '') + (playing ? ' playing' : ''), onclick: () => tapRow(i) },
    h('span', { class: 'rn' }, c[5]),
    h('div', { class: 'rl', style: c[1] ? { backgroundImage: `url("${c[1].replace(/"/g, '%22')}")` } : {} }, c[1] ? '' : c[0].slice(0, 3).toUpperCase()),
    h('div', { class: 'rb' },
      h('div', { class: 'rt' }, fav ? h('span', { class: 'rfav' }, '★ ') : null, c[0]),
      h('div', { class: 'rs' }, np ? `${hhmm(np.s)}  ${np.t}` : S.tab === 'live' ? c[2] : c[2]),
      np ? h('div', { class: 'rpg live' }, h('i', { style: { width: ((Date.now() - np.s) / (np.e - np.s)) * 100 + '%' } })) : null))
}

function tapRow(i) {
  if (S.listKind === 'ch' && S.items[i] == null) return
  // TiviMate: ilk dokunuş seçer/önizler, seçiliye tekrar dokunuş tam ekran oynatır.
  if (i === S.sel) {
    if (S.listKind === 'ch') return playChannel(S.items[i], vOpts.listId)
    if (S.listKind === 'meta') return quickPlay(S.items[i])
  }
  select(i, true)
}
function select(i, user) {
  const old = rendered.get(S.sel)
  S.sel = i
  LS.set('sel:' + S.listKey, i)
  if (old) old.classList.remove('on')
  rendered.get(i)?.classList.add('on')
  if (i < 0) return
  if (S.listKind === 'meta') renderPreviewMeta(S.items[i])
  else if (S.listKind === 'ch' && S.items[i] != null) renderPreviewCh(S.items[i], false, user)
}

async function showShelf(id, title, ranked, initial, gen) {
  let page = 1, loading = false, done = false
  const items = await cached(`shelf:${id}:1`, () => api(`/api/shelf?id=${id}&page=1`)).catch(() => [])
  showList('meta', title, items, {
    initial, ranked, gen,
    more: async () => {
      if (loading || done || ranked) return
      loading = true
      const next = await cached(`shelf:${id}:${page + 1}`, () => api(`/api/shelf?id=${id}&page=${page + 1}`)).catch(() => [])
      loading = false
      // bu arada başka gruba geçildiyse sonraki sayfa o listeye eklenmesin
      if (gen !== selGen) return
      if (!next.length) { done = true; return }
      page++
      const seen = new Set(S.items.map((x) => x.kind + x.id))
      S.items.push(...next.filter((x) => !seen.has(x.kind + x.id)))
      $('#vspace').style.height = S.items.length * rowH() + 'px'
      $('#listHead .cnt').textContent = S.items.length
      vRender(false)
    },
  })
}

function showSearch() {
  const inp = h('input', { class: 'search', placeholder: 'Film, dizi, oyuncu…', value: LS.get('q', ''), enterkeyhint: 'search' })
  $('#listHead').replaceChildren(inp)
  let t = null
  const run = async () => {
    const q = inp.value.trim()
    LS.set('q', q)
    if (q.length < 2) return showList('meta', '', [], { keepHead: true, emptyText: 'En az 2 harf yaz.' })
    const r = await cached('q:' + q, () => api('/api/search?q=' + encodeURIComponent(q))).catch(() => [])
    if (inp.isConnected && inp.value.trim() === q) showList('meta', '', r, { keepHead: true, emptyText: 'Bulunamadı.' })
  }
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350) })
  run()
  setTimeout(() => inp.focus(), 50)
}
async function showTvSearch() {
  const inp = h('input', { class: 'search', placeholder: 'Kanal adı…', enterkeyhint: 'search' })
  $('#listHead').replaceChildren(inp)
  const id = (S.iptv.find((l) => l.id === LS.get('iptvList', null) && l.counts?.live) || S.iptv.find((l) => l.counts?.live))?.id
  let t = null
  const run = async () => {
    const q = inp.value.trim()
    if (!id) return showList('ch', '', [], { keepHead: true, emptyText: 'Canlı kanal listesi yok.' })
    if (q.length < 2) return showList('ch', '', [], { keepHead: true, emptyText: 'Kanal adı yaz.', listId: id })
    const r = await api(`/api/iptv/rows?id=${id}&kind=l&q=${encodeURIComponent(q)}`).catch(() => null)
    if (!inp.isConnected || inp.value.trim() !== q) return
    keepRows(id, r?.rows || [])
    showList('ch', '', (r?.rows || []).map((x) => x[0]), { keepHead: true, listId: id, emptyText: 'Bulunamadı.' })
  }
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 300) })
  run()
  setTimeout(() => inp.focus(), 50)
}

// ---------------------------------------------------------------- önizleme: film / dizi
let pvToken = 0
let prefetchT = null
async function renderPreviewMeta(m) {
  const tok = ++pvToken
  stopMini()
  const pv = $('#preview')
  const hero = h('div', { class: 'pvHero', style: { backgroundImage: m.backdrop ? `url(${img(m.backdrop, 'w780')})` : 'none' } })
  const body = h('div', { class: 'pvBody' }, h('h1', { class: 'pvName' }, m.name), h('div', { class: 'pvMeta' }, m.year, m.rating && h('span', { class: 'star' }, '★ ' + m.rating), m.kind === 'tv' ? 'Dizi' : 'Film'), h('p', { class: 'pvOv' }, m.overview || ''))
  pv.replaceChildren(hero, body)
  pv.scrollTop = 0
  const d = await cached(`d:${m.kind}:${m.id}`, () => api(`/api/detail?kind=${m.kind}&id=${m.id}`)).catch(() => null)
  if (tok !== pvToken || !d) return
  // Kaynak taraması arkada başlar ama sadece filmde 2,5 sn durursan: eskiden listede gezinirken
  // her dokunuş 81 eklentiyi çalıştırıp sunucuyu (ve menüleri) kilitliyordu.
  clearTimeout(prefetchT)
  if (m.kind === 'movie') prefetchT = setTimeout(() => { if (tok === pvToken && player.hidden) api(`/api/streams?kind=movie&id=${m.id}&prefetch=1`).catch(() => {}) }, 2500)
  if (d.backdrop) hero.style.backgroundImage = `url(${img(d.backdrop, 'w780')})`
  const inList = S.store.list.some((x) => x.kind === m.kind && x.id === m.id)
  const meta = { id: d.id, kind: d.kind, name: d.name, poster: d.poster || m.poster, backdrop: d.backdrop, overview: d.overview, year: d.year, rating: d.rating }
  const prog = m.kind === 'movie' ? S.store.progress[`movie:${m.id}`] : lastEpisode(m.id)
  const playLabel = prog && prog.pos > 60 ? (m.kind === 'tv' ? `Devam et  ·  S${prog.season} B${prog.episode}` : `Devam et  ·  ${fmtTime(prog.pos)}`) : m.kind === 'tv' ? 'Oynat  ·  S1 B1' : 'Oynat'
  const listBtn = h('button', { class: 'btn', onclick: async () => { S.store.list = await post('/api/list', meta); listBtn.textContent = S.store.list.some((x) => x.kind === m.kind && x.id === m.id) ? '✓  Listemde' : '＋  Listem' } }, inList ? '✓  Listemde' : '＋  Listem')
  body.replaceChildren(
    d.logo ? h('img', { class: 'pvLogo', src: d.logo, alt: d.name }) : h('h1', { class: 'pvName' }, d.name),
    h('div', { class: 'pvMeta' }, ...[d.year, d.rating && h('span', { class: 'star' }, '★ ' + d.rating), d.cert && h('span', { class: 'cert' }, d.cert), d.runtime && (d.runtime >= 60 ? `${Math.floor(d.runtime / 60)} sa ${d.runtime % 60} dk` : `${d.runtime} dk`), d.genres.slice(0, 3).join(', '), d.seasons.length ? `${d.seasons.length} sezon` : null].filter(Boolean).map((x) => (x.nodeType ? x : h('span', {}, x)))),
    h('p', { class: 'pvOv' }, d.overview || 'Açıklama yok.'),
    d.cast.length ? h('div', { class: 'pvCast' }, 'Oyuncular: ' + d.cast.slice(0, 5).join(', ')) : null,
    h('div', { class: 'btns' }, h('button', { class: 'btn red', onclick: () => (m.kind === 'tv' ? playEpisode(d, meta, prog?.season || 1, prog?.episode || 1) : playMovie(d, meta)) }, '▶  ' + playLabel), listBtn),
  )
  if (m.kind === 'tv' && d.seasons.length) {
    const seasonsEl = h('div', { class: 'seasons' })
    const epsEl = h('div', { class: 'eps' })
    const showSeason = async (n) => {
      LS.set('season:' + d.id, n)
      seasonsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', +c.dataset.n === n))
      epsEl.replaceChildren(h('div', { class: 'spin' }))
      const eps = await cached(`s:${d.id}:${n}`, () => api(`/api/season?id=${d.id}&n=${n}`)).catch(() => [])
      if (tok !== pvToken) return
      epsEl.replaceChildren(...eps.map((e) => {
        const p = S.store.progress[`tv:${d.id}:${n}:${e.number}`]
        return h('button', { class: 'ep' + (e.aired ? '' : ' na'), onclick: () => e.aired && playEpisode(d, meta, n, e.number) },
          h('div', { class: 'es', style: { backgroundImage: e.still ? `url(${e.still})` : 'none' } }, p && p.dur ? h('div', { class: 'rpg' }, h('i', { style: { width: (p.pos / p.dur) * 100 + '%' } })) : null),
          h('div', { class: 'eb' }, h('div', { class: 'et' }, `${e.number}. ${e.name || 'Bölüm'}`), h('div', { class: 'eo' }, e.aired ? e.overview || '' : `Yayın: ${e.airDate || 'yakında'}`)))
      }))
    }
    d.seasons.forEach((s) => seasonsEl.append(h('button', { class: 'chip', 'data-n': s.number, onclick: () => showSeason(s.number) }, s.name || `${s.number}. Sezon`)))
    body.append(h('div', { class: 'sec' }, 'Bölümler'), seasonsEl, epsEl)
    showSeason(LS.get('season:' + d.id, prog?.season || d.seasons[0].number))
  }
}
function lastEpisode(id) {
  let best = null
  for (const [k, p] of Object.entries(S.store.progress)) if (k.startsWith(`tv:${id}:`) && (!best || p.updatedAt > best.updatedAt)) best = p
  return best
}
async function quickPlay(m) {
  const d = await cached(`d:${m.kind}:${m.id}`, () => api(`/api/detail?kind=${m.kind}&id=${m.id}`))
  const meta = { id: d.id, kind: d.kind, name: d.name, poster: d.poster || m.poster, backdrop: d.backdrop, overview: d.overview, year: d.year, rating: d.rating }
  if (m.kind === 'movie') return playMovie(d, meta)
  const p = lastEpisode(m.id)
  playEpisode(d, meta, p?.season || 1, p?.episode || 1)
}

// ---------------------------------------------------------------- önizleme: kanal (canlı mini oynatıcı)
let mini = null
function stopMini() {
  if (mini) { mini.destroy(); mini = null }
}
async function renderPreviewCh(i, epgOnly, user) {
  const id = vOpts.listId
  const c = chRow(id, i)
  if (!c) return
  const pv = $('#preview')
  const epg = S.tab === 'live' ? wantEpg(id, c[3]) : null
  const key = id + ':' + i
  if (!epgOnly) {
    const hero = h('div', { class: 'pvHero video' })
    pv.replaceChildren(hero, h('div', { class: 'pvBody' }))
    pv.scrollTop = 0
    stopMini()
    // canlı kanalda önizleme hemen başlar (TiviMate gibi); film/dizide sadece kullanıcı seçince
    if (S.tab === 'live' || user) {
      const box = h('div', { class: 'mini' })
      hero.append(box, h('div', { class: 'miniInfo' }, S.tab === 'live' ? h('span', { class: 'liveDot' }) : null, S.tab === 'live' ? 'CANLI önizleme · tam ekran için tekrar dokun' : 'Önizleme'))
      mini = new Engine(box, { muted: false, live: S.tab === 'live' })
      mini.key = key
      loadChannelInto(mini, id, i).catch(() => {})
    }
  }
  const body = pv.querySelector('.pvBody')
  const fav = S.store.favs.includes(key)
  const favBtn = h('button', { class: 'btn', onclick: async () => { S.store.favs = await post('/api/fav', { key }); favBtn.textContent = S.store.favs.includes(key) ? '★  Favoride' : '☆  Favori'; vRender(true) } }, fav ? '★  Favoride' : '☆  Favori')
  const np = nowProg(epg)
  body.replaceChildren(
    h('div', { class: 'pvMeta' }, h('b', { style: { fontSize: '26px', color: '#fff' } }, `${c[5]}  ${c[0]}`), h('span', {}, c[2])),
    np ? h('div', {}, h('div', { class: 'pvName', style: { fontSize: '28px' } }, np.t), h('div', { class: 'pvMeta' }, `${hhmm(np.s)} – ${hhmm(np.e)}`, `${Math.max(0, Math.round((np.e - Date.now()) / 60e3))} dk kaldı`), np.d ? h('p', { class: 'pvOv' }, np.d) : null) : null,
    h('div', { class: 'btns' }, h('button', { class: 'btn red', onclick: () => playChannel(i, id) }, '⛶  Tam ekran'), S.tab === 'live' ? favBtn : null),
    epg?.length ? h('div', { class: 'sec' }, 'Yayın akışı') : null,
    epg?.length ? h('div', { class: 'epg' }, ...epg.map((p) => h('div', { class: 'epgRow' + (p === np ? ' now' : '') }, h('div', { class: 'tm' }, `${hhmm(p.s)} – ${hhmm(p.e)}`), h('div', {}, h('div', { class: 'ti' }, p.t), p.d ? h('div', { class: 'de' }, p.d) : null)))) : null,
  )
}
async function loadChannelInto(eng, id, i) {
  const r = await api(`/api/iptv/play?id=${id}&i=${i}`)
  if (!r) throw new Error('kanal yok')
  // önce doğrudan (https + başlık gerekmiyorsa sunucuyu yormaz), olmazsa sunucu üzerinden
  const tries = []
  if (r.direct) tries.push({ url: r.direct, ts: r.ts, mp4: r.mp4 })
  tries.push({ url: r.url, ts: r.ts, mp4: r.mp4 })
  for (const t of tries) {
    try {
      await eng.load(t.url, { ts: t.ts, mp4: t.mp4, live: eng.opts.live })
      return
    } catch (e) {
      if (eng.dead) return
    }
  }
  eng.fail('Kanal açılmadı')
}

// ---------------------------------------------------------------- oynatma motoru (hls.js / mpegts.js / yerel)
class Engine {
  constructor(container, opts = {}) {
    this.opts = opts
    this.box = container
    this.video = h('video', { playsinline: true, autoplay: true, preload: 'auto' })
    this.video.muted = !!opts.muted
    container.append(this.video)
    this.hls = null
    this.ts = null
    this.dead = false
  }
  detach() {
    if (this.hls) { this.hls.destroy(); this.hls = null }
    if (this.ts) { try { this.ts.destroy() } catch {} this.ts = null }
    this.video.querySelectorAll('track').forEach((t) => t.remove())
    this.video.removeAttribute('src')
    try { this.video.load() } catch {}
  }
  load(url, { ts, mp4, live, start = 0 } = {}) {
    this.detach()
    const v = this.video
    return new Promise((resolve, reject) => {
      let settled = false
      const ok = () => { if (!settled) { settled = true; cleanup(); resolve() } }
      const bad = (e) => { if (!settled) { settled = true; cleanup(); reject(e || new Error('oynatılamadı')) } }
      const timer = setTimeout(() => bad(new Error('zaman aşımı')), live ? 15000 : 25000)
      const onPlay = () => ok()
      const onErr = () => bad(new Error('video hatası'))
      const cleanup = () => { clearTimeout(timer); v.removeEventListener('playing', onPlay); v.removeEventListener('error', onErr) }
      v.addEventListener('playing', onPlay)
      v.addEventListener('error', onErr)
      const play = () => v.play().catch(() => { if (!v.muted) { v.muted = true; v.play().catch(() => {}); this.onAutoMute?.() } })
      if (ts && window.mpegts?.isSupported()) {
        const p = mpegts.createPlayer({ type: 'mpegts', isLive: !!live, url }, { enableWorker: true, liveBufferLatencyChasing: true, lazyLoad: false, stashInitialSize: 128 * 1024 })
        p.attachMediaElement(v)
        p.on(mpegts.Events.ERROR, () => bad(new Error('ts hatası')))
        p.load()
        play()
        this.ts = p
      } else if (!mp4 && window.Hls?.isSupported()) {
        const hls = new Hls({ startPosition: start || -1, maxBufferLength: live ? 20 : 45, backBufferLength: 30, enableWorker: true, lowLatencyMode: false, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4 })
        this.hls = hls
        hls.on(Hls.Events.MANIFEST_PARSED, () => play())
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return
          if (!settled) return bad(new Error(data.details))
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
          else this.onFatal?.(data.details)
        })
        hls.loadSource(url)
        hls.attachMedia(v)
      } else {
        v.src = url
        if (start) v.addEventListener('loadedmetadata', () => (v.currentTime = start), { once: true })
        play()
      }
    })
  }
  fail(msg) { this.onFail?.(msg) }
  moveTo(container) { container.append(this.video); this.box = container }
  destroy() { this.dead = true; this.detach(); this.video.remove() }
}

// ---------------------------------------------------------------- tam ekran oynatıcı
const P = { eng: null, ctx: null, idleT: null, saveT: null, streams: [], idx: 0, es: null, subs: [], subIdx: -1 }
const player = $('#player')
function showToast(t, ms = 2200) {
  const el = $('#toast')
  el.textContent = t
  el.hidden = false
  clearTimeout(showToast.t)
  showToast.t = setTimeout(() => (el.hidden = true), ms)
}
function wake() {
  player.classList.remove('idle')
  clearTimeout(P.idleT)
  P.idleT = setTimeout(() => { if (!P.eng?.video.paused && $('#sheet').hidden) player.classList.add('idle') }, 4000)
}
player.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, .bar, .sheet')) return wake()
  if (player.classList.contains('idle')) wake()
  else { player.classList.add('idle'); clearTimeout(P.idleT) }
})
$('#pClose').onclick = closePlayer
document.addEventListener('keydown', (e) => {
  if (player.hidden) return
  if (e.key === 'Escape' || e.key === 'Backspace') closePlayer()
  if (e.key === ' ') togglePlay()
  if (e.key === 'ArrowRight') seekBy(10)
  if (e.key === 'ArrowLeft') seekBy(-10)
  if (e.key === 'ArrowUp' && P.ctx?.live) zap(-1)
  if (e.key === 'ArrowDown' && P.ctx?.live) zap(1)
  wake()
})

function openPlayer(ctx) {
  P.ctx = ctx
  player.hidden = false
  $('#sheet').hidden = true
  $('#pTitle').textContent = ctx.title
  $('#pSub').textContent = ctx.sub || ''
  $('#seekWrap').hidden = !!ctx.live
  tick()
  renderCtrls()
  wake()
  try { document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {}) } catch {}
}
function closePlayer() {
  saveProgress()
  if (P.es) { P.es.close(); P.es = null }
  clearInterval(P.saveT)
  // canlı kanal önizlemeye geri döner (TiviMate gibi kesintisiz)
  if (P.ctx?.live && P.eng && S.listKind === 'ch' && P.ctx.backToMini) {
    const box = $('#preview .mini')
    if (box && mini === null) { P.eng.moveTo(box); mini = P.eng; mini.key = P.ctx.key; P.eng = null }
  }
  if (P.eng) { P.eng.destroy(); P.eng = null }
  P.ctx = null
  player.hidden = true
  $('#pCenter').replaceChildren()
  try { document.fullscreenElement && document.exitFullscreen() } catch {}
  if (S.listKind === 'meta' && S.sel >= 0) { vRender(true); renderPreviewMeta(S.items[S.sel]) }
}
function center(l1, l2, spin = true) {
  $('#pCenter').replaceChildren(l1 ? h('div', { class: 'loadBox' }, spin ? h('div', { class: 'spin' }) : null, h('div', { class: 'l1' }, l1), l2 ? h('div', { class: 'l2' }, l2) : null) : '')
}
function togglePlay() {
  const v = P.eng?.video
  if (!v) return
  if (v.paused) v.play().catch(() => {})
  else v.pause()
}
function seekBy(s) {
  const v = P.eng?.video
  if (!v || P.ctx?.live) return
  v.currentTime = Math.max(0, Math.min((v.duration || 1e9) - 1, v.currentTime + s))
  showToast(`${s > 0 ? '+' : ''}${s} sn`, 800)
}

function renderCtrls() {
  const c = P.ctx
  const v = P.eng?.video
  const btns = []
  if (c.live) {
    btns.push(h('span', { class: 'liveBadge' }, h('span', { class: 'liveDot', style: { background: '#fff' } }), 'CANLI'))
    btns.push(h('button', { class: 'pBtn', onclick: () => zap(-1), 'aria-label': 'Önceki kanal' }, '▲'))
    btns.push(h('button', { class: 'pBtn big', onclick: togglePlay }, v && v.paused ? '▶' : '❚❚'))
    btns.push(h('button', { class: 'pBtn', onclick: () => zap(1), 'aria-label': 'Sonraki kanal' }, '▼'))
    btns.push(h('span', { class: 'sp' }))
    btns.push(h('button', { class: 'pBtn txt', onclick: () => chSheet() }, '☰  Kanallar'))
  } else {
    btns.push(h('button', { class: 'pBtn', onclick: () => seekBy(-10) }, '↺'))
    btns.push(h('button', { class: 'pBtn big', onclick: togglePlay }, v && v.paused ? '▶' : '❚❚'))
    btns.push(h('button', { class: 'pBtn', onclick: () => seekBy(30) }, '↻'))
    btns.push(h('span', { class: 'sp' }))
    if (c.vod) {
      btns.push(h('button', { class: 'pBtn txt', onclick: srcSheet }, '⇄  Kaynak', P.streams.length ? h('small', {}, ` ${P.idx + 1}/${P.streams.length}`) : null))
      btns.push(h('button', { class: 'pBtn txt', onclick: subSheet }, '💬  Altyazı'))
      if (c.next) btns.push(h('button', { class: 'pBtn txt', onclick: () => c.next() }, '⏭  Sonraki bölüm'))
    }
  }
  btns.push(h('button', { class: 'pBtn', onclick: () => { const v2 = P.eng?.video; if (v2) { v2.muted = !v2.muted; renderCtrls() } } }, v && v.muted ? '🔇' : '🔊'))
  $('#pCtrls').replaceChildren(...btns)
}
function bindVideo(v) {
  const upd = () => {
    if (!P.ctx || P.ctx.live) return
    const d = v.duration || 0
    const pct = d ? (v.currentTime / d) * 100 : 0
    $('#barFill').style.width = pct + '%'
    $('#barKnob').style.left = pct + '%'
    $('#tCur').textContent = fmtTime(v.currentTime)
    $('#tDur').textContent = fmtTime(d)
    try { const b = v.buffered; if (b.length) $('#barBuf').style.width = (b.end(b.length - 1) / d) * 100 + '%' } catch {}
  }
  v.addEventListener('timeupdate', upd)
  v.addEventListener('play', renderCtrls)
  v.addEventListener('pause', () => { renderCtrls(); wake() })
  v.addEventListener('waiting', () => P.ctx && center('Yükleniyor…', null))
  v.addEventListener('playing', () => center(null))
  v.addEventListener('ended', () => P.ctx?.next && P.ctx.next())
}
// ilerleme çubuğu
;(() => {
  const bar = $('#bar')
  let drag = false
  const at = (e) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) }
  bar.addEventListener('pointerdown', (e) => { drag = true; bar.setPointerCapture(e.pointerId); move(e) })
  const move = (e) => { if (!drag) return; const v = P.eng?.video; if (!v?.duration) return; const p = at(e); $('#barFill').style.width = p * 100 + '%'; $('#barKnob').style.left = p * 100 + '%'; $('#tCur').textContent = fmtTime(p * v.duration) }
  bar.addEventListener('pointermove', move)
  bar.addEventListener('pointerup', (e) => { if (!drag) return; drag = false; const v = P.eng?.video; if (v?.duration) v.currentTime = at(e) * v.duration })
})()

function newEngine() {
  if (P.eng) P.eng.destroy()
  const eng = new Engine($('#stage'))
  eng.video.style.setProperty('--sub', S.store.settings.subSize || 100)
  player.style.setProperty('--sub', S.store.settings.subSize || 100)
  eng.onAutoMute = () => { showToast('Ses için 🔊 düğmesine dokun'); renderCtrls() }
  bindVideo(eng.video)
  P.eng = eng
  return eng
}

// ---- canlı kanal
async function playChannel(i, listId) {
  const c = chRow(listId, i)
  if (!c) return
  const key = listId + ':' + i
  S.playingKey = key
  post('/api/recent', { key }).then((r) => (S.store.recentCh = r)).catch(() => {})
  const live = c[4] === 'l'
  openPlayer({ title: `${c[5]}  ${c[0]}`, sub: c[2], live, key, listId, index: i, backToMini: live })
  const sameAsMini = mini && mini.key === key && !mini.dead
  if (sameAsMini) {
    // önizlemedeki video tam ekrana taşınır, yeniden yüklenmez
    if (P.eng) P.eng.destroy()
    P.eng = mini
    mini = null
    P.eng.moveTo($('#stage'))
    bindVideo(P.eng.video)
    P.eng.video.muted = false
    center(null)
  } else {
    stopMini()
    const eng = newEngine()
    eng.opts.live = live
    center('Kanal açılıyor…', c[0])
    eng.onFail = (m) => center(m, 'Başka kanal dene', false)
    await loadChannelInto(eng, listId, i).catch(() => {})
  }
  renderCtrls()
  if (!live) {
    P.ctx.vod = false
    $('#seekWrap').hidden = false
  }
  vRender(true)
  osd(c)
}
function osd(c) {
  const st = $('#stage')
  st.querySelector('.chOsd')?.remove()
  const np = nowProg(wantEpg(P.ctx.listId, c[3]))
  const el = h('div', { class: 'chOsd' }, h('div', { class: 'n' }, c[5]), c[1] ? h('div', { class: 'rl', style: { backgroundImage: `url("${c[1]}")` } }) : null, h('div', {}, h('div', { class: 'rt' }, c[0]), np ? h('div', { class: 'rs' }, `${hhmm(np.s)}–${hhmm(np.e)}  ${np.t}`) : null))
  st.append(el)
  setTimeout(() => el.remove(), 4000)
}
async function zap(dir) {
  if (!P.ctx?.live || S.listKind !== 'ch' || !S.items.length) return
  const pos = S.items.indexOf(P.ctx.index)
  const np = (pos + dir + S.items.length) % S.items.length
  const next = await ensurePos(np).catch(() => null)
  if (next == null) return
  select(np, false)
  stopMini()
  playChannel(next, P.ctx.listId)
}
function chSheet() {
  const sh = $('#sheet')
  sh.hidden = false
  const body = h('div', { class: 'sheetBody' })
  sh.replaceChildren(h('h3', {}, h('span', {}, 'Kanallar'), h('button', { class: 'pBtn', onclick: () => (sh.hidden = true) }, '✕')), body)
  const list = S.listKind === 'ch' ? S.items : []
  const at = Math.max(0, list.indexOf(P.ctx.index) - 150)
  for (const i of list.slice(at, at + 400)) {
    const c = i == null ? null : chRow(P.ctx.listId, i)
    if (!c) continue
    const np = nowProg(wantEpg(P.ctx.listId, c[3]))
    body.append(h('button', { class: 'opt' + (i === P.ctx.index ? ' on' : ''), onclick: () => { sh.hidden = true; select(S.items.indexOf(i), false); playChannel(i, P.ctx.listId) } },
      h('span', { class: 'rn' }, c[5]), c[1] ? h('div', { class: 'rl', style: { backgroundImage: `url("${c[1]}")`, width: '70px', height: '44px' } }) : null,
      h('div', { class: 'ob' }, h('div', { class: 'o1' }, c[0]), h('div', { class: 'o2' }, np ? np.t : c[2]))))
  }
  body.querySelector('.on')?.scrollIntoView({ block: 'center' })
}

// ---- film / dizi (N kaynakları)
function playMovie(d, meta) {
  startVod({ kind: 'movie', id: d.id, imdb: d.imdbId, title: d.name, sub: [d.year, d.genres?.[0]].filter(Boolean).join(' · '), meta, key: progKey('movie', d.id) })
}
async function playEpisode(d, meta, s, e) {
  const eps = await cached(`s:${d.id}:${s}`, () => api(`/api/season?id=${d.id}&n=${s}`)).catch(() => [])
  const ep = eps.find((x) => x.number === e)
  const nextEp = eps.find((x) => x.number === e + 1 && x.aired)
  const nextSeason = !nextEp && d.seasons.find((x) => x.number === s + 1)
  const next = nextEp ? () => playEpisode(d, meta, s, e + 1) : nextSeason ? () => playEpisode(d, meta, s + 1, 1) : null
  startVod({ kind: 'tv', id: d.id, imdb: d.imdbId, season: s, episode: e, title: d.name, sub: `S${s} B${e}${ep?.name ? '  ·  ' + ep.name : ''}`, meta, episodeName: ep?.name, key: progKey('tv', d.id, s, e), next })
}

function startVod(ctx) {
  if (P.es) { P.es.close(); P.es = null }
  stopMini()
  openPlayer({ ...ctx, vod: true })
  newEngine()
  P.streams = []
  P.idx = -1
  P.subs = []
  P.subIdx = -1
  P.failed = new Set()
  center('Kaynaklar aranıyor…', 'BerkStream N eklentileri taranıyor')
  const qs = `kind=${ctx.kind}&id=${ctx.id}${ctx.season ? `&s=${ctx.season}&e=${ctx.episode}` : ''}`
  const es = new EventSource('/api/streams?' + qs)
  P.es = es
  const t0 = Date.now()
  let total = 0, finished = 0, started = false
  const tryStart = (force) => {
    if (started || !P.streams.length) return
    const best = P.streams[0]
    const top = qTier(sText(best)) >= 3 && lang(best) !== 'NONE'
    if (force || top || Date.now() - t0 > 7000 || (total && finished / total > 0.6)) {
      started = true
      playIdx(0)
    }
  }
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.total != null) total = m.total
    if (m.finished != null) finished = m.finished
    if (m.streams?.length) {
      const cur = P.streams[P.idx]
      const seen = new Set(P.streams.map((s) => s.url))
      P.streams = sortStreams([...P.streams, ...m.streams.filter((s) => !seen.has(s.url))])
      if (cur) P.idx = P.streams.indexOf(cur)
      renderCtrls()
      if (!$('#sheet').hidden && $('#sheet').dataset.k === 'src') srcSheet()
    }
    if (!started) center('Kaynaklar aranıyor…', `${finished}/${total || '?'} eklenti · ${P.streams.length} kaynak bulundu`)
    tryStart(false)
    if (m.done) {
      es.close()
      P.es = null
      if (!P.streams.length) center('Kaynak bulunamadı', 'Bu yapım için eklentiler bir şey döndürmedi', false)
      else tryStart(true)
    }
  }
  es.onerror = () => { es.close(); P.es = null; tryStart(true); if (!P.streams.length) center('Bağlantı koptu', 'Tekrar dene', false) }
  setTimeout(() => tryStart(false), 7100)
  api(`/api/subs?imdb=${ctx.imdb || ''}&kind=${ctx.kind}&s=${ctx.season || ''}&e=${ctx.episode || ''}`).then((r) => { P.osubs = r || [] }).catch(() => (P.osubs = []))
  clearInterval(P.saveT)
  P.saveT = setInterval(saveProgress, 10000)
}

async function playIdx(i) {
  const ctx = P.ctx
  if (!ctx || i >= P.streams.length) return center('Hiçbir kaynak açılmadı', 'Kaynak listesinden elle dene', false)
  P.idx = i
  const s = P.streams[i]
  renderCtrls()
  center('Açılıyor…', `${s.provider} · ${qLabel(s)}${lang(s) === 'DUB' ? ' · Türkçe dublaj' : lang(s) === 'SUB' ? ' · Türkçe altyazı' : ''}`)
  const v = P.eng.video
  const resumeAt = P.resumeOverride ?? (() => { const p = S.store.progress[ctx.key]; return p && p.pos > 60 && p.dur && p.pos < p.dur - 120 ? p.pos : 0 })()
  P.resumeOverride = null
  const mp4 = /\.(mp4|mkv|webm)(\?|$)/i.test(s.url)
  try {
    await P.eng.load(s.play, { mp4, start: resumeAt })
    if (P.ctx !== ctx) return
    if (resumeAt && Math.abs(v.currentTime - resumeAt) > 5) v.currentTime = resumeAt
    if (resumeAt) showToast(`Kaldığın yerden: ${fmtTime(resumeAt)}`)
    center(null)
    setupSubs(s)
    P.eng.onFatal = () => { if (P.ctx === ctx) { showToast('Kaynak düştü, sıradakine geçiliyor'); P.resumeOverride = v.currentTime; playIdx(P.idx + 1) } }
  } catch {
    if (P.ctx !== ctx) return
    P.failed.add(s.url)
    if (i + 1 < P.streams.length) playIdx(i + 1)
    else if (P.es) { center('Kaynaklar aranıyor…', 'Açılan kaynak yok, tarama sürüyor'); const wait = setInterval(() => { if (P.ctx !== ctx) return clearInterval(wait); if (P.streams.length > i + 1) { clearInterval(wait); playIdx(i + 1) } else if (!P.es) { clearInterval(wait); center('Hiçbir kaynak açılmadı', null, false) } }, 1000) }
    else center('Hiçbir kaynak açılmadı', 'Kaynak listesinden elle dene', false)
  }
}

function setupSubs(s) {
  const v = P.eng.video
  v.querySelectorAll('track').forEach((t) => t.remove())
  const subs = [...(s.subtitles || []).map((x) => ({ ...x, label: x.label || x.lang })), ...(P.osubs || [])]
  P.subs = subs
  const isTr = (x) => /tr|tür|turk/i.test(x.lang + ' ' + x.label)
  // Dublajda altyazı kapalı, değilse Türkçe açık (N'deki gibi).
  let pick = -1
  if (lang(s) !== 'DUB' && S.store.settings.subLang !== 'off') pick = subs.findIndex(isTr)
  if (pick < 0 && lang(s) === 'NONE' && S.store.settings.subLang === 'en') pick = subs.findIndex((x) => /en|ing/i.test(x.lang + x.label))
  subs.forEach((x, i) => v.append(h('track', { kind: 'subtitles', src: x.url, srclang: isTr(x) ? 'tr' : 'en', label: x.label })))
  setSub(pick)
}
function setSub(i) {
  P.subIdx = i
  const tr = P.eng?.video.textTracks
  if (!tr) return
  for (let k = 0; k < tr.length; k++) tr[k].mode = k === i ? 'showing' : 'disabled'
}
function sheet(k, title, items) {
  const sh = $('#sheet')
  sh.hidden = false
  sh.dataset.k = k
  sh.replaceChildren(h('h3', {}, h('span', {}, title), h('button', { class: 'pBtn', onclick: () => (sh.hidden = true) }, '✕')), h('div', { class: 'sheetBody' }, ...items))
}
function srcSheet() {
  sheet('src', `Kaynaklar (${P.streams.length})${P.es ? ' · aranıyor' : ''}`, P.streams.map((s, i) => {
    const l = lang(s)
    return h('button', { class: 'opt' + (i === P.idx ? ' on' : ''), style: P.failed?.has(s.url) ? { opacity: 0.45 } : {}, onclick: () => { $('#sheet').hidden = true; P.resumeOverride = P.eng?.video.currentTime || 0; playIdx(i) } },
      h('span', { class: 'tag q' }, qLabel(s)),
      l !== 'NONE' ? h('span', { class: 'tag ' + (l === 'DUB' ? 'dub' : 'sub') }, l === 'DUB' ? 'DUBLAJ' : 'ALTYAZI') : null,
      h('div', { class: 'ob' }, h('div', { class: 'o1' }, s.provider), h('div', { class: 'o2' }, [s.title, s.size].filter(Boolean).join(' · '))))
  }))
}
function subSheet() {
  const size = S.store.settings.subSize || 100
  sheet('sub', 'Altyazı', [
    h('button', { class: 'opt' + (P.subIdx < 0 ? ' on' : ''), onclick: () => { setSub(-1); subSheet() } }, h('div', { class: 'ob' }, h('div', { class: 'o1' }, 'Kapalı'))),
    ...P.subs.map((x, i) => h('button', { class: 'opt' + (i === P.subIdx ? ' on' : ''), onclick: () => { setSub(i); subSheet() } }, h('div', { class: 'ob' }, h('div', { class: 'o1' }, x.label || x.lang)))),
    h('div', { class: 'sec', style: { margin: '24px 16px 10px' } }, `Boyut: %${size}`),
    h('div', { style: { display: 'flex', gap: '10px', padding: '0 16px' } },
      ...[80, 100, 120, 150].map((n) => h('button', { class: 'chip' + (n === size ? ' on' : ''), onclick: async () => { S.store.settings = await post('/api/settings', { subSize: n }); player.style.setProperty('--sub', n); subSheet() } }, '%' + n))),
  ])
}
function saveProgress() {
  const c = P.ctx
  const v = P.eng?.video
  if (!c?.vod || !v || !v.duration || !isFinite(v.duration) || v.currentTime < 5) return
  const value = { pos: v.currentTime, dur: v.duration, meta: c.meta, season: c.season, episode: c.episode, episodeName: c.episodeName }
  S.store.progress[c.key] = { ...value, updatedAt: Date.now() }
  post('/api/progress', { key: c.key, value }).catch(() => {})
}
window.addEventListener('pagehide', saveProgress)
document.addEventListener('visibilitychange', () => document.hidden && saveProgress())

// ---------------------------------------------------------------- IPTV listeleri penceresi
function openIptv() {
  const m = $('#modal')
  let mode = 'm3u'
  const name = h('input', { placeholder: 'Örn: Ev IPTV' })
  const url = h('input', { placeholder: 'https://…/liste.m3u', inputmode: 'url' })
  const host = h('input', { placeholder: 'http://sunucu.com:8080', inputmode: 'url' })
  const user = h('input', { placeholder: 'Kullanıcı adı', autocomplete: 'off' })
  const pass = h('input', { placeholder: 'Şifre', type: 'password', autocomplete: 'off' })
  const epg = h('input', { placeholder: 'EPG (XMLTV) adresi — boş bırakılabilir', inputmode: 'url' })
  const text = h('textarea', { placeholder: '#EXTM3U\n#EXTINF:-1 group-title="Ulusal",TRT 1\nhttps://…' })
  const err = h('div', { class: 'err' })
  const fields = h('div')
  const seg = h('div', { class: 'seg' })
  const lists = h('div', { class: 'lst' })
  const drawLists = () => lists.replaceChildren(...S.iptv.map((l) => h('div', { class: 'lstRow' },
    h('div', { class: 'lb' }, h('div', { class: 'l1' }, l.name), h('div', { class: 'l2' }, `${l.counts?.live || 0} kanal · ${l.counts?.movie || 0} film · ${l.counts?.series || 0} dizi${l.epgUrl ? ' · EPG' : ''}${l.error ? ' · ⚠ ' + l.error : ''}`)),
    h('button', { class: 'sm', onclick: async (e) => { e.target.textContent = '…'; const r = await api('/api/iptv/refresh?id=' + l.id).catch((x) => ({ ok: false, error: String(x) })); forgetList(l.id); if (!r.ok) err.textContent = r.error; await reloadIptv(); drawLists(); renderGroups() } }, 'Yenile'),
    h('button', { class: 'sm red', onclick: (e) => delList(l, e.currentTarget) }, 'Sil'))))
  // confirm() arabanın tarayıcısında hiç açılmıyor (hep "hayır" dönüyor): silme bu yüzden çalışmıyordu.
  // Onun yerine ikinci dokunuş: "Emin misin?" 4 sn bekler.
  const delList = async (l, btn) => {
    if (!btn.classList.contains('sure')) {
      btn.classList.add('sure')
      btn.textContent = 'Emin misin?'
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove('sure'); btn.textContent = 'Sil' } }, 4000)
      return
    }
    btn.closest('.lstRow')?.classList.add('gone')
    try {
      S.iptv = await api('/api/iptv?id=' + l.id, { method: 'DELETE' })
    } catch (x) {
      err.textContent = 'Silinemedi: ' + x
      return drawLists()
    }
    forgetList(l.id)
    if (LS.get('iptvList', null) === l.id) LS.set('iptvList', null)
    saveBackup()
    drawLists()
    tabs()
    renderGroups()
  }
  const drawSeg = () => {
    seg.replaceChildren(...[['m3u', 'M3U linki'], ['xtream', 'Xtream'], ['text', 'Metin yapıştır']].map(([k, t]) => h('button', { class: mode === k ? 'on' : '', onclick: () => { mode = k; drawSeg() } }, t)))
    fields.replaceChildren(
      h('label', {}, 'Liste adı'), name,
      ...(mode === 'm3u' ? [h('label', {}, 'M3U / M3U8 adresi'), url] : mode === 'xtream' ? [h('label', {}, 'Sunucu'), host, h('label', {}, 'Kullanıcı'), user, h('label', {}, 'Şifre'), pass] : [h('label', {}, 'M3U içeriği'), text]),
      mode !== 'xtream' ? h('label', {}, 'EPG adresi (isteğe bağlı)') : null, mode !== 'xtream' ? epg : null)
  }
  drawSeg()
  drawLists()
  // açılırken sunucudan tazele (yedekten geri yükleme o sırada sürüyor olabilir)
  reloadIptv().then(() => m.hidden || drawLists()).catch(() => {})
  const addBtn = h('button', { class: 'btn red', onclick: async () => {
    err.textContent = ''
    addBtn.disabled = true
    addBtn.textContent = 'Liste indiriliyor…'
    const payload = { name: name.value, epgUrl: epg.value }
    if (mode === 'm3u') payload.url = url.value
    if (mode === 'xtream') payload.xtream = { host: host.value.trim(), user: user.value.trim(), pass: pass.value }
    if (mode === 'text') payload.text = text.value
    const r = await post('/api/iptv', payload).catch((e) => ({ ok: false, error: String(e) }))
    addBtn.disabled = false
    addBtn.textContent = 'Ekle'
    if (!r.ok) return (err.textContent = r.error)
    await reloadIptv()
    LS.set('iptvList', r.list.id)
    saveBackup()
    drawLists()
    m.hidden = true
    setTab(r.list.counts?.live ? 'live' : r.list.counts?.movie ? 'movie' : 'series')
  } }, 'Ekle')
  m.replaceChildren(h('div', { class: 'box' },
    h('h3', {}, 'IPTV listeleri'), h('p', {}, 'Liste sunucuda indirilip ayrıştırılır, burada sadece kanallar gelir. 12 saatte bir kendini yeniler.'),
    lists, h('div', { class: 'sec' }, 'Yeni liste'), seg, fields, err,
    h('div', { class: 'boxBtns' }, h('button', { class: 'btn', onclick: () => (m.hidden = true) }, 'Kapat'), addBtn)))
  m.hidden = false
}
function saveBackup() {
  if (S.noBackup) return
  api('/api/backup').then((b) => { if (!b.fresh) LS.set('backup', b) }).catch(() => {})
}
async function reloadIptv() {
  S.iptv = await api('/api/iptv')
  tabs()
}
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') e.target.hidden = true })
$('#iptvBtn').onclick = openIptv
$('#brand').onclick = () => { setTab('n'); S.group.n = undefined; renderGroups() }

// ---------------------------------------------------------------- açılış
;(async () => {
  tick()
  $('#preview').replaceChildren(h('div', { class: 'spin' }))
  const [store, lists] = await Promise.all([api('/api/store'), api('/api/iptv').catch(() => [])])
  S.store = { favs: [], recentCh: [], ...store }
  S.iptv = lists
  // Sunucu boş açıldıysa (Render diski silinir) bu cihazdaki yedekten geri yükle.
  // Eskiden "sunucu boş mu" diye bakılıyordu: tek listeni silince sunucu boş görünüyor, yedek silineni
  // geri getiriyordu. Artık sunucu diskin gerçekten silindiğini (_fresh) kendisi söylüyor.
  const bk = LS.get('backup', null)
  const hasBk = bk && (bk.store?.list?.length || Object.keys(bk.store?.progress || {}).length || bk.iptv?.length)
  if (store._fresh && hasBk) {
    $('#preview').replaceChildren(h('div', { class: 'pvEmpty' }, h('div', {}, h('div', { class: 'spin' }), 'Yedekten geri yükleniyor…')))
    const ok = await post('/api/restore', bk).catch(() => null)
    const [s2, l2] = await Promise.all([api('/api/store'), api('/api/iptv').catch(() => [])])
    S.store = { favs: [], recentCh: [], ...s2 }
    S.iptv = l2
    // geri yükleme patladıysa iyi yedeğin üstüne boşu yazma
    if (!ok?.ok) S.noBackup = true
  }
  saveBackup()
  setInterval(saveBackup, 60e3)
  window.addEventListener('pagehide', saveBackup)
  tabs()
  renderGroups()
})()
