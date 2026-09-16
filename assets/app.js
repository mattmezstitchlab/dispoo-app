/* Dispoo V1 — application monopage (vanilla JS, sans dépendance). */
'use strict'

/* ------------------------------------------------------------------ base */

const $ = (sel, el = document) => el.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CODE_RE = /^[A-Z0-9]{6}$/
const LABEL = { yes: 'Disponible', maybe: 'Peut-être', no: 'Indisponible' }
let renderSeq = 0 // garde anti-course : les réponses lentes n'écrasent pas la vue courante

/* ------------------------------------------------------------------ stockage local */

const ls = {
  get (k) { try { return localStorage.getItem(k) } catch { return null } },
  set (k, v) { try { localStorage.setItem(k, v) } catch {} },
  del (k) { try { localStorage.removeItem(k) } catch {} }
}
const getOwnerToken = (code) => ls.get(`dispoo:owner:${code}`)
const setOwnerToken = (code, t) => ls.set(`dispoo:owner:${code}`, t)
const dropOwnerToken = (code) => ls.del(`dispoo:owner:${code}`)
const getVoter = (code) => {
  try { return JSON.parse(ls.get(`dispoo:voter:${code}`) || 'null') } catch { return null }
}
const setVoter = (code, v) => ls.set(`dispoo:voter:${code}`, JSON.stringify(v))
const myCodes = () => {
  try {
    const a = JSON.parse(ls.get('dispoo:mine') || '[]')
    return Array.isArray(a) ? a.filter((c) => CODE_RE.test(c)) : []
  } catch { return [] }
}
const addMyCode = (code) => {
  ls.set('dispoo:mine', JSON.stringify([code, ...myCodes().filter((c) => c !== code)].slice(0, 50)))
}
const dropMyCode = (code) => {
  ls.set('dispoo:mine', JSON.stringify(myCodes().filter((c) => c !== code)))
}

/* ------------------------------------------------------------------ API */

class ApiError extends Error {
  constructor (status, data) {
    super(data?.error || 'Erreur')
    this.status = status
    this.data = data
  }
}

async function api (path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers['x-owner-token'] = token
  for (let i = 0; i <= 1; i++) {
    try {
      const r = await fetch(path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      })
      if (r.status >= 500 && i < 1) { await sleep(350); continue } // 1 seul retry (cold start)
      let data = null
      try { data = await r.json() } catch { data = null }
      if (!r.ok) throw new ApiError(r.status, data)
      return data
    } catch (e) {
      if (e instanceof ApiError) throw e
      if (i < 1) { await sleep(350); continue }
      throw new ApiError(0, { error: 'Connexion impossible', hint: 'Vérifiez votre connexion, puis réessayez.' })
    }
  }
}

function showSetupBanner () {
  const box = $('#setup-banner')
  if (!box || box.dataset.done) return
  box.dataset.done = '1'
  box.hidden = false
  box.innerHTML = `
    <div class="setup" role="alert">
      <strong>Configuration requise.</strong>
      L’application répond, mais la base de données n’est pas branchée :
      création et votes sont désactivés tant que <code>POSTGRES_URL</code> est absent.
      <details>
        <summary>Brancher la base (3 minutes)</summary>
        <ol>
          <li>Dans Vercel : projet → <em>Storage</em> → <em>Create database</em> → Postgres (ou créez une base Neon).</li>
          <li>Vérifiez que la variable <code>POSTGRES_URL</code> existe dans <em>Settings → Environment Variables</em>.</li>
          <li>Redéployez. Le schéma se crée tout seul au premier appel.</li>
        </ol>
      </details>
    </div>`
}

/* ------------------------------------------------------------------ formats */

const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
function formatDay (isoDay) {
  const d = new Date(`${isoDay}T12:00:00`)
  return Number.isNaN(d) ? isoDay : cap(dayFmt.format(d))
}
function todayLocal () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function plural (n, one, many) {
  return `${n} ${n > 1 ? many : one}`
}
function appUrl () {
  const m = document.querySelector('meta[name="dispoo:app-url"]')?.getAttribute('content')
  return (m && m.startsWith('http')) ? m.replace(/\/$/, '') : location.origin
}
const inviteUrl = (code) => `${appUrl()}/e/${code}`

function toast (msg, kind = '') {
  const box = $('#toasts')
  if (!box) return
  const el = document.createElement('div')
  el.className = `toast ${kind}`.trim()
  el.textContent = msg
  box.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

async function copyText (text, inputFallback) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Lien copié.')
  } catch {
    if (inputFallback) {
      inputFallback.select()
      toast('Sélectionnez le lien et copiez-le.')
    } else {
      toast('Copie impossible sur cet appareil.', 'toast-error')
    }
  }
}

/* ------------------------------------------------------------------ routeur */

function readRoute () {
  const path = location.pathname.match(/^\/e\/([A-Za-z0-9]{4,10})\/?$/)
  const params = new URLSearchParams(location.search)
  if (path) return { name: 'invite', code: path[1].trim().toUpperCase(), fresh: params.get('cree') === '1' }
  const legacy = params.get('code')
  if (legacy != null) return { name: 'invite', code: legacy.trim().toUpperCase(), legacy: true, fresh: params.get('cree') === '1' }
  return { name: 'home' }
}

function navigate (url) {
  history.pushState({}, '', url)
  render()
}

function syncMeta (title, path) {
  document.title = title
  const abs = `${appUrl()}${path}`
  $('#canonical')?.setAttribute('href', abs)
  document.querySelector('meta[property="og:url"]')?.setAttribute('content', abs)
}

function render () {
  const seq = ++renderSeq
  const route = readRoute()
  if (route.name === 'invite' && route.legacy && CODE_RE.test(route.code)) {
    // `?code=` accepté, puis normalisé vers le joli lien (sans entrée d'historique).
    history.replaceState({}, '', `/e/${route.code}${route.fresh ? '?cree=1' : ''}`)
  }
  if (route.name === 'invite') {
    renderInviteShell(route, seq)
  } else {
    renderHome(seq)
  }
  window.scrollTo(0, 0)
  const h1 = $('#view h1')
  if (h1) {
    h1.setAttribute('tabindex', '-1')
    h1.focus({ preventScroll: true })
  }
  if (location.hash) {
    const target = $(location.hash)
    if (target) {
      target.scrollIntoView({ block: 'start' })
      const field = target.querySelector('input')
      if (field) field.focus({ preventScroll: true })
    }
  }
}

/* ------------------------------------------------------------------ fragments */

const skeletonCards = (n = 3) => Array.from({ length: n }, () => `
  <div class="card skeleton" aria-hidden="true"><h3>Chargement</h3><p>Chargement des événements…</p></div>
`).join('')

const emptyView = ({ title, text, action }) => `
  <div class="card empty">
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    ${action || ''}
  </div>`

const errorView = ({ title, text, retry }) => `
  <div class="card empty" role="alert">
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    <div class="btn-row" style="justify-content:center">
      ${retry ? '<button type="button" class="btn btn-secondary" data-action="retry">Réessayer</button>' : ''}
      <a class="btn btn-ghost" href="/" data-nav>Revenir à l’accueil</a>
    </div>
  </div>`

const shareLinkBox = (code, idPrefix) => `
  <div class="share-link">
    <label class="hint" for="${idPrefix}-link" style="position:absolute;left:-9999px">Lien de l’événement</label>
    <input id="${idPrefix}-link" type="text" readonly value="${esc(inviteUrl(code))}" onclick="this.select()">
    <button type="button" class="btn btn-ghost btn-small" data-action="copy" data-target="${idPrefix}-link">Copier le lien</button>
  </div>`

const shareButton = (code, title) => (
  (typeof navigator !== 'undefined' && navigator.share)
    ? `<button type="button" class="btn btn-ghost btn-small" data-action="share" data-code="${esc(code)}" data-title="${esc(title)}">Partager</button>`
    : ''
)

function bindShareButtons (root, code, title) {
  root.querySelectorAll('[data-action="copy"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target)
      copyText(input ? input.value : inviteUrl(code), input)
    })
  })
  root.querySelectorAll('[data-action="share"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.share({ title: btn.dataset.title || 'Dispoo', url: inviteUrl(btn.dataset.code) })
      } catch (e) {
        if (e?.name !== 'AbortError') toast('Partage impossible sur cet appareil.', 'toast-error')
      }
    })
  })
}

/* ------------------------------------------------------------------ accueil */

function slotRowHTML (i) {
  return `
  <div class="slot-row" data-slot="${i}">
    <div class="field slot-day">
      <label for="slot-day-${i}">Jour</label>
      <input id="slot-day-${i}" name="day" type="date" min="${todayLocal()}" required>
    </div>
    <div class="field">
      <label for="slot-start-${i}">Début</label>
      <input id="slot-start-${i}" name="start" type="time" required>
    </div>
    <div class="field">
      <label for="slot-end-${i}">Fin</label>
      <input id="slot-end-${i}" name="end" type="time" required>
    </div>
    <button type="button" class="link-btn slot-remove" data-action="slot-remove">Retirer ce créneau</button>
  </div>`
}

function renderHome (seq) {
  syncMeta('Dispoo — Trouvez le créneau où tout le monde est disponible', '/')
  const view = $('#view')
  view.innerHTML = `
    <div class="hero">
      <h1>Trouvez la date <span class="accent">parfaite.</span></h1>
      <p class="lead">Proposez des créneaux, partagez un lien, laissez vos invités voter. Dispoo révèle le moment où tout le monde est disponible.</p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="#creer">Créer un événement</a>
        <a class="btn btn-ghost" href="#voter">Voter avec un code</a>
      </div>
    </div>

    <section class="block" id="creer" aria-labelledby="creer-titre">
      <div class="card">
        <h2 id="creer-titre">Créer un événement</h2>
        <div class="form-error" id="create-errors" role="alert" hidden></div>
        <form id="create-form" novalidate>
          <div class="field">
            <label for="f-title">Titre</label>
            <input id="f-title" name="title" type="text" maxlength="80" autocomplete="off"
              placeholder="Dîner d’équipe, week-end surf…" required>
          </div>
          <div class="field">
            <label for="f-location">Lieu</label>
            <input id="f-location" name="location" type="text" maxlength="60" autocomplete="off"
              placeholder="Bordeaux, chez Léa…" required>
          </div>
          <fieldset style="border:none;padding:0;margin:0 0 8px">
            <legend style="font-weight:700;font-size:13px;margin-bottom:6px">Créneaux (2 minimum)</legend>
            <div id="slot-list"></div>
            <button type="button" class="btn btn-ghost btn-small" data-action="slot-add">Ajouter un créneau</button>
          </fieldset>
          <div class="btn-row">
            <button type="submit" class="btn btn-primary" id="create-submit" disabled>Ajoutez au moins 2 créneaux</button>
          </div>
        </form>
      </div>
    </section>

    <section class="block" id="voter" aria-labelledby="voter-titre">
      <div class="card">
        <h2 id="voter-titre">Voter avec un code</h2>
        <p class="muted">Le code de l’événement figure dans le lien reçu : 6 lettres et chiffres.</p>
        <form id="code-form" class="code-form">
          <label for="f-code" style="position:absolute;left:-9999px">Code de l’événement</label>
          <input id="f-code" name="code" type="text" maxlength="6" autocomplete="off"
            placeholder="ABC123" pattern="[A-Za-z0-9]{6}" required>
          <button type="submit" class="btn btn-secondary">Rejoindre</button>
        </form>
        <p class="field-error" id="code-error" hidden>Ce code doit comporter 6 lettres ou chiffres.</p>
      </div>
    </section>

    <section class="block" id="mine" aria-labelledby="mine-titre">
      <div class="section-head">
        <h2 id="mine-titre">Mes événements</h2>
      </div>
      <div id="mine-body">${skeletonCards(2)}</div>
    </section>`

  // --- formulaire de création
  const slotList = $('#slot-list')
  let slotSeq = 0
  const addSlot = () => {
    slotList.insertAdjacentHTML('beforeend', slotRowHTML(slotSeq++))
    refreshCreateButton()
  }
  addSlot()
  addSlot()

  const form = $('#create-form')
  const submitBtn = $('#create-submit')
  const errBox = $('#create-errors')

  function readSlots () {
    return [...slotList.querySelectorAll('[data-slot]')].map((row) => ({
      day: row.querySelector('[name="day"]').value,
      time_start: row.querySelector('[name="start"]').value,
      time_end: row.querySelector('[name="end"]').value
    }))
  }

  function refreshCreateButton () {
    const slots = readSlots().filter((s) => s.day && s.time_start && s.time_end && s.time_start < s.time_end)
    const title = $('#f-title').value.trim()
    const location = $('#f-location').value.trim()
    const tooFew = slots.length < 2
    submitBtn.disabled = tooFew || !title || !location
    submitBtn.textContent = tooFew ? 'Ajoutez au moins 2 créneaux' : 'Créer et partager'
  }

  form.addEventListener('input', refreshCreateButton)
  view.querySelector('[data-action="slot-add"]').addEventListener('click', () => {
    if (slotList.children.length >= 8) {
      toast('8 créneaux maximum : au-delà, personne ne compare plus.', 'toast-error')
      return
    }
    addSlot()
  })
  slotList.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="slot-remove"]')) return
    if (slotList.children.length <= 2) {
      toast('Un sondage compare au moins 2 créneaux.', 'toast-error')
      return
    }
    e.target.closest('[data-slot]').remove()
    refreshCreateButton()
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const title = $('#f-title').value.trim().replace(/\s+/g, ' ')
    const location = $('#f-location').value.trim().replace(/\s+/g, ' ')
    const slots = readSlots()
    const problems = []
    if (title.length < 3 || title.length > 80) problems.push('Le titre doit comporter entre 3 et 80 caractères.')
    if (location.length < 2 || location.length > 60) problems.push('Le lieu doit comporter entre 2 et 60 caractères.')
    slots.forEach((s, i) => {
      if (!s.day || !s.time_start || !s.time_end) problems.push(`Créneau ${i + 1} : jour, début et fin requis.`)
      else if (!(s.time_start < s.time_end)) problems.push(`Créneau ${i + 1} : la fin doit suivre le début.`)
    })
    const keys = slots.map((s) => `${s.day}|${s.time_start}|${s.time_end}`)
    if (new Set(keys).size !== keys.length) problems.push('Deux créneaux sont identiques.')
    if (slots.length < 2) problems.push('Ajoutez au moins 2 créneaux.')
    if (problems.length) {
      errBox.hidden = false
      errBox.innerHTML = `<strong>Vérifiez le formulaire :</strong><ul style="margin:6px 0 0;padding-left:18px">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
      $('#f-title').setAttribute('aria-invalid', title.length < 3 ? 'true' : 'false')
      $('#f-location').setAttribute('aria-invalid', location.length < 2 ? 'true' : 'false')
      errBox.scrollIntoView({ block: 'nearest' })
      return
    }
    errBox.hidden = true
    submitBtn.disabled = true
    submitBtn.textContent = 'Création…'
    try {
      const data = await api('/api/events', { method: 'POST', body: { title, location, options: slots } })
      setOwnerToken(data.event.code, data.owner_token)
      addMyCode(data.event.code)
      toast('Événement créé.')
      navigate(`/e/${data.event.code}?cree=1`)
    } catch (err) {
      if (err.status === 503) showSetupBanner()
      errBox.hidden = false
      errBox.innerHTML = `<strong>${esc(err.data?.error || 'Une erreur est survenue.')}</strong>${err.data?.hint ? `<br>${esc(err.data.hint)}` : ''}`
      refreshCreateButton()
    }
  })

  // --- rejoindre par code
  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const code = $('#f-code').value.trim().toUpperCase()
    if (!CODE_RE.test(code)) {
      $('#code-error').hidden = false
      $('#f-code').setAttribute('aria-invalid', 'true')
      return
    }
    navigate(`/e/${code}`)
  })

  loadMyEvents(seq)
}

async function loadMyEvents (seq) {
  const body = $('#mine-body')
  if (!body) return
  const codes = myCodes()
  if (!codes.length) {
    body.innerHTML = emptyView({
      title: 'Aucun événement pour le moment',
      text: 'Créez un événement, ajoutez deux créneaux, partagez le lien.',
      action: '<div class="btn-row" style="justify-content:center"><a class="btn btn-primary" href="#creer">Créer mon premier événement</a></div>'
    })
    return
  }
  const results = await Promise.allSettled(
    codes.map((code) => api(`/api/events?code=${code}`, { token: getOwnerToken(code) || undefined }))
  )
  if (seq !== renderSeq || !document.contains(body)) return
  const items = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(r.value)
    } else if (r.reason?.status === 404 || r.reason?.status === 410) {
      dropMyCode(codes[i])
      dropOwnerToken(codes[i])
    } else if (r.reason?.status === 503) {
      showSetupBanner()
    }
  })
  if (!items.length) {
    body.innerHTML = codes.length !== myCodes().length
      ? emptyView({ title: 'Aucun événement pour le moment', text: 'Vos anciens liens ont expiré.' })
      : errorView({ title: 'Impossible de charger vos événements', text: 'Réessayez dans un instant.', retry: true })
    body.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      body.innerHTML = skeletonCards(2)
      loadMyEvents(seq)
    })
    return
  }
  renderMineList(body, items, 'all')
}

function mineStatus (item) {
  const { event, final_option: finalOption } = item
  if (event.status === 'confirme' && finalOption && finalOption.day < todayLocal()) return 'past'
  if (event.status === 'confirme') return 'done'
  return 'live'
}

function renderMineList (body, items, tab) {
  const counts = {
    all: items.length,
    live: items.filter((i) => mineStatus(i) === 'live').length,
    done: items.filter((i) => mineStatus(i) === 'done').length,
    past: items.filter((i) => mineStatus(i) === 'past').length
  }
  const tabs = [['all', 'Tous'], ['live', 'En cours'], ['done', 'Confirmés'], ['past', 'Passés']]
  const filtered = tab === 'all' ? items : items.filter((i) => mineStatus(i) === tab)
  body.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Filtrer mes événements">
      ${tabs.map(([key, label]) => `
        <button type="button" role="tab" class="tab" data-tab="${key}" aria-selected="${key === tab}">
          ${label} <span class="count">(${counts[key]})</span>
        </button>`).join('')}
    </div>
    ${filtered.length ? `
    <ul class="event-grid">
      ${filtered.map((item) => {
        const st = mineStatus(item)
        const badge = st === 'live'
          ? '<span class="badge badge-live">En cours de vote</span>'
          : st === 'done'
            ? '<span class="badge badge-done">Confirmé</span>'
            : '<span class="badge">Passé</span>'
        const finalLine = (st !== 'live' && item.final_option)
          ? `<p class="event-meta">${esc(formatDay(item.final_option.day))} · ${esc(item.final_option.time_start)} → ${esc(item.final_option.time_end)}</p>`
          : ''
        return `
        <li>
          <a class="event-card" href="/e/${esc(item.event.code)}" data-nav>
            ${badge}
            <h3>${esc(item.event.title)}</h3>
            <p class="event-meta">${esc(item.event.location)} · ${plural(item.options.length, 'créneau', 'créneaux')} · ${plural(item.participants_count, 'invité', 'invités')}</p>
            ${finalLine}
          </a>
        </li>`
      }).join('')}
    </ul>` : emptyView({ title: 'Rien ici', text: 'Aucun événement dans cet onglet.' })}`
  body.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => renderMineList(body, items, btn.dataset.tab))
  })
}

/* ------------------------------------------------------------------ page invitée */

const inviteState = {
  code: null, data: null, detail: null, votesSel: {}, showForm: true,
  confirmSlot: null, confirmDelete: false, name: ''
}

function renderInviteShell (route, seq) {
  const view = $('#view')
  if (!CODE_RE.test(route.code)) {
    syncMeta('Rejoindre un événement — Dispoo', '/')
    view.innerHTML = `
      <div class="card">
        <h1>Rejoindre un événement</h1>
        <p class="muted">Ce lien est incomplet : le code de l’événement comporte 6 lettres ou chiffres.</p>
        <form id="prompt-form" class="code-form">
          <label for="prompt-code" style="position:absolute;left:-9999px">Code de l’événement</label>
          <input id="prompt-code" type="text" maxlength="6" autocomplete="off" value="${esc(route.code.slice(0, 6))}">
          <button type="submit" class="btn btn-secondary">Rejoindre</button>
        </form>
      </div>`
    $('#prompt-form').addEventListener('submit', (e) => {
      e.preventDefault()
      const code = $('#prompt-code').value.trim().toUpperCase()
      if (CODE_RE.test(code)) navigate(`/e/${code}`)
    })
    return
  }
  syncMeta('Chargement… — Dispoo', `/e/${route.code}`)
  view.innerHTML = `
    <div id="inv-share"></div>
    <div id="inv-head">${skeletonCards(1)}</div>
    <div id="inv-vote"></div>
    <div id="inv-results"></div>
    <div id="inv-owner"></div>`
  inviteState.code = route.code
  inviteState.data = null
  inviteState.detail = null
  inviteState.confirmSlot = null
  inviteState.confirmDelete = false
  const voter = getVoter(route.code)
  inviteState.votesSel = { ...(voter?.votes || {}) }
  inviteState.name = voter?.name || ''
  inviteState.showForm = !voter || !Object.keys(inviteState.votesSel).length
  loadInvite(route, seq)
}

async function loadInvite (route, seq) {
  const code = route.code
  let data
  try {
    data = await api(`/api/events?code=${code}`, { token: getOwnerToken(code) || undefined })
  } catch (err) {
    if (seq !== renderSeq) return
    const view = $('#view')
    if (err.status === 404) {
      syncMeta('Événement introuvable — Dispoo', `/e/${code}`)
      view.innerHTML = `
        <div class="card empty" role="alert">
          <h2>Événement introuvable</h2>
          <p>Ce code ne correspond à aucun événement. Vérifiez les 6 caractères ou redemandez le lien.</p>
          <div class="btn-row" style="justify-content:center">
            <a class="btn btn-secondary" href="/#voter" data-nav>Essayer un autre code</a>
            <a class="btn btn-ghost" href="/" data-nav>Revenir à l’accueil</a>
          </div>
        </div>`
      return
    }
    if (err.status === 410) {
      syncMeta('Lien expiré — Dispoo', `/e/${code}`)
      view.innerHTML = errorView({ title: 'Ce lien n’est plus valide', text: 'L’événement a été supprimé ou archivé.' })
      return
    }
    if (err.status === 503) showSetupBanner()
    syncMeta('Erreur — Dispoo', `/e/${code}`)
    view.innerHTML = errorView({
      title: err.data?.error || 'Une erreur est survenue',
      text: err.data?.hint || 'Réessayez dans un instant.',
      retry: true
    })
    view.querySelector('[data-action="retry"]')?.addEventListener('click', () => renderInviteShell(route, seq))
    return
  }
  if (seq !== renderSeq) return
  if (!data.is_owner && getOwnerToken(code)) dropOwnerToken(code)
  inviteState.data = data
  // Détail nominatif pour l'organisateur (les invités n'ont que les comptes).
  if (data.is_owner) {
    try {
      const detail = await api(`/api/votes?event_id=${data.event.id}&code=${code}`, { token: getOwnerToken(code) })
      if (seq === renderSeq) inviteState.detail = detail.detail || null
    } catch { inviteState.detail = null }
    if (seq !== renderSeq) return
  }
  renderInvite(route, seq)
}

function renderInvite (route, seq) {
  const { data } = inviteState
  if (!data) return
  const code = route.code
  const { event, options, counts, participants_count: pcount } = data
  syncMeta(`${event.title} — votez sur Dispoo`, `/e/${code}`)

  // --- panneau « prêt » (juste après création)
  const shareBox = $('#inv-share')
  if (route.fresh && data.is_owner) {
    shareBox.innerHTML = `
      <div class="card">
        <h1 style="font-size:28px">Votre événement est prêt</h1>
        <p class="muted">Partagez ce lien : vos invités votent sans compte. Gardez cette page : seul votre appareil peut modifier l’événement.</p>
        <div class="code-big" aria-label="Code de l’événement : ${esc(code)}">${esc(code)}</div>
        ${shareLinkBox(code, 'fresh')}
        <div class="btn-row">
          ${shareButton(code, event.title)}
          <button type="button" class="btn btn-secondary" data-action="goto-vote">Voir la page de vote</button>
        </div>
      </div>`
    bindShareButtons(shareBox, code, event.title)
    shareBox.querySelector('[data-action="goto-vote"]').addEventListener('click', () => {
      history.replaceState({}, '', `/e/${code}`)
      render()
    })
  } else {
    shareBox.innerHTML = ''
  }

  // --- en-tête
  const confirmed = event.status === 'confirme'
  const finalOption = data.final_option
  const badge = confirmed
    ? '<span class="badge badge-done">Confirmé</span>'
    : '<span class="badge badge-live">En cours de vote</span>'
  $('#inv-head').innerHTML = `
    <div class="card">
      ${badge}
      <h1 style="font-size:28px;margin-top:8px">${esc(event.title)}</h1>
      <p class="muted" style="margin-bottom:0">${esc(event.location)} · ${plural(options.length, 'créneau', 'créneaux')} · ${plural(pcount, 'invité', 'invités')} · Code <strong>${esc(code)}</strong></p>
    </div>
    ${confirmed && finalOption ? `
    <div class="confirm-banner" role="status">
      <strong>Confirmé — ${esc(formatDay(finalOption.day))}</strong><br>
      ${esc(finalOption.time_start)} → ${esc(finalOption.time_end)} · ${esc(event.location)}
      <div class="btn-row">
        <button type="button" class="btn btn-ghost btn-small" data-action="ics">Ajouter au calendrier</button>
      </div>
    </div>` : ''}`
  $('#inv-head').querySelector('[data-action="ics"]')?.addEventListener('click', () => downloadICS(event, finalOption))

  if (document.activeElement === document.body) {
    const h1 = $('#view h1')
    if (h1) {
      h1.setAttribute('tabindex', '-1')
      h1.focus({ preventScroll: true })
    }
  }

  renderVoteCard(seq)
  renderResultsCard()
  renderOwnerCard(route, seq)
}

function renderVoteCard (seq) {
  const box = $('#inv-vote')
  const { data, votesSel } = inviteState
  const code = inviteState.code
  const { event, options } = data
  if (event.status === 'confirme') {
    box.innerHTML = ''
    return
  }
  if (!inviteState.showForm) {
    const voted = Object.keys(votesSel).length
    box.innerHTML = `
      <div class="card empty" id="thanks">
        <h2 tabindex="-1">Merci, ${esc(inviteState.name || 'invité')} !</h2>
        <p>${voted < options.length
          ? `Votre réponse est enregistrée (${plural(voted, 'créneau', 'créneaux')} sur ${options.length}) : les créneaux sans réponse ne comptent pas comme « disponible partout ».</p>`
          : 'Votre réponse est enregistrée sur tous les créneaux.'}</p>
        <div class="btn-row" style="justify-content:center">
          <button type="button" class="btn btn-secondary" data-action="modify">Modifier mes disponibilités</button>
        </div>
      </div>`
    box.querySelector('[data-action="modify"]').addEventListener('click', () => {
      inviteState.showForm = true
      renderVoteCard(seq)
      $('#vote-name')?.focus()
    })
    return
  }
  box.innerHTML = `
    <div class="card">
      <h2>Vos disponibilités</h2>
      <div class="form-error" id="vote-errors" role="alert" hidden></div>
      <form id="vote-form" novalidate>
        <div class="field">
          <label for="vote-name">Prénom</label>
          <input id="vote-name" type="text" maxlength="40" autocomplete="nickname"
            placeholder="Léa" value="${esc(inviteState.name)}" required>
        </div>
        <div class="vote-grid" id="vote-slots">
          ${options.map((o) => `
          <div class="vote-slot" data-option="${o.id}">
            <h3>${esc(formatDay(o.day))}</h3>
            <p class="hours">${esc(o.time_start)} → ${esc(o.time_end)}</p>
            <div class="vote-choices" role="group" aria-label="Votre disponibilité pour le ${esc(formatDay(o.day))}">
              ${['yes', 'maybe', 'no'].map((v) => `
                <button type="button" class="vote-btn v-${v}" data-value="${v}"
                  aria-pressed="${votesSel[o.id] === v ? 'true' : 'false'}">${LABEL[v]}</button>`).join('')}
            </div>
          </div>`).join('')}
        </div>
        <p class="hint" id="vote-hint">Sélectionnez au moins un créneau. Sans réponse sur un créneau, vous n’y êtes pas compté comme disponible.</p>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary" id="vote-submit">Enregistrer mes disponibilités</button>
        </div>
      </form>
    </div>`

  box.querySelectorAll('.vote-slot').forEach((slot) => {
    const oid = slot.dataset.option
    slot.querySelectorAll('.vote-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.value
        if (inviteState.votesSel[oid] === v) delete inviteState.votesSel[oid]
        else inviteState.votesSel[oid] = v
        slot.querySelectorAll('.vote-btn').forEach((b) => {
          b.setAttribute('aria-pressed', inviteState.votesSel[oid] === b.dataset.value ? 'true' : 'false')
        })
      })
    })
  })

  $('#vote-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = $('#vote-name').value.trim().replace(/\s+/g, ' ')
    const errBox = $('#vote-errors')
    const entries = Object.entries(inviteState.votesSel)
    if (name.length < 2) {
      errBox.hidden = false
      errBox.innerHTML = '<strong>Prénom requis.</strong><br>Entre 2 et 40 caractères.'
      $('#vote-name').setAttribute('aria-invalid', 'true')
      return
    }
    if (!entries.length) {
      errBox.hidden = false
      errBox.innerHTML = '<strong>Sélectionnez au moins un créneau.</strong>'
      return
    }
    errBox.hidden = true
    const submitBtn = $('#vote-submit')
    submitBtn.disabled = true
    submitBtn.textContent = 'Enregistrement…'
    try {
      const voter = getVoter(code)
      const payload = {
        code,
        votes: entries.map(([option_id, value]) => ({ option_id: Number(option_id), value }))
      }
      // Même appareil, même invité : on modifie, on ne duplique pas.
      if (voter?.participant_id && voter.name === name) payload.participant_id = voter.participant_id
      else payload.name = name
      const resp = await api('/api/votes', { method: 'POST', body: payload })
      setVoter(code, {
        participant_id: resp.participant.id,
        name: resp.participant.name,
        votes: Object.fromEntries(resp.votes.map((v) => [v.option_id, v.value]))
      })
      inviteState.name = resp.participant.name
      inviteState.votesSel = { ...Object.fromEntries(resp.votes.map((v) => [v.option_id, v.value])) }
      inviteState.showForm = false
      // Recharge les comptes (et le détail organisateur) pour un affichage exact.
      const fresh = await api(`/api/events?code=${code}`, { token: getOwnerToken(code) || undefined })
      if (seq !== renderSeq) return
      inviteState.data = fresh
      if (fresh.is_owner) {
        try {
          const d = await api(`/api/votes?event_id=${fresh.event.id}&code=${code}`, { token: getOwnerToken(code) })
          inviteState.detail = d.detail || null
        } catch { inviteState.detail = null }
      }
      if (seq !== renderSeq) return
      renderVoteCard(seq)
      renderResultsCard()
      toast('Disponibilités enregistrées.')
      $('#thanks h2')?.focus({ preventScroll: false })
    } catch (err) {
      if (err.status === 503) showSetupBanner()
      if (err.status === 409) {
        // L'événement a été confirmé entre-temps : on recharge l'état réel.
        loadInvite({ code, fresh: false }, seq)
        return
      }
      errBox.hidden = false
      errBox.innerHTML = `<strong>${esc(err.data?.error || 'Une erreur est survenue.')}</strong>${err.data?.hint ? `<br>${esc(err.data.hint)}` : ''}`
      submitBtn.disabled = false
      submitBtn.textContent = 'Enregistrer mes disponibilités'
    }
  })
}

function bestOptionId (options, counts) {
  const byId = Object.fromEntries(counts.map((c) => [c.option_id, c]))
  let best = null
  for (const o of options) {
    const c = byId[o.id]
    if (!c || c.total === 0) continue
    if (!best) { best = c; continue }
    if (c.yes > best.yes || (c.yes === best.yes && c.maybe > best.maybe)) best = c
  }
  return best?.option_id ?? null
}

function renderResultsCard () {
  const box = $('#inv-results')
  const { data, detail } = inviteState
  const { event, options, counts, participants_count: pcount } = data
  const byId = Object.fromEntries(counts.map((c) => [c.option_id, c]))
  const best = event.status === 'sondage' ? bestOptionId(options, counts) : event.final_option_id

  const namesByOption = {}
  if (detail) {
    for (const v of detail) {
      (namesByOption[v.option_id] ??= { yes: [], maybe: [], no: [] })[v.value].push(v.name)
    }
  }

  box.innerHTML = `
    <div class="card">
      <h2>Résultats</h2>
      ${pcount === 0
        ? '<p class="muted">Aucun vote pour l’instant. Partagez le lien pour lancer les réponses.</p>'
        : `<p class="muted">${plural(pcount, 'invité a voté', 'invités ont voté')}.</p>`}
      <div class="vote-grid">
        ${options.map((o) => {
          const c = byId[o.id] || { yes: 0, maybe: 0, no: 0, total: 0 }
          const pct = (n) => (c.total ? Math.round((n / c.total) * 100) : 0)
          const names = namesByOption[o.id]
          return `
          <div class="result-slot ${o.id === best ? 'lead' : ''}">
            <div class="result-top">
              <h3>${esc(formatDay(o.day))}</h3>
              ${o.id === best ? '<span class="badge badge-lead">En tête</span>' : ''}
            </div>
            <p class="hint" style="margin:0 0 6px;font-variant-numeric:tabular-nums">${esc(o.time_start)} → ${esc(o.time_end)}</p>
            ${c.total === 0
              ? '<p class="result-counts">Aucune réponse pour l’instant.</p>'
              : `
              <p class="result-counts">${c.yes}/${c.total} ${c.yes > 1 ? 'disponibles' : 'disponible'} · ${c.maybe} peut-être · ${c.no} ${c.no > 1 ? 'indisponibles' : 'indisponible'}</p>
              <div class="turnout" role="img" aria-label="${c.yes} disponibles, ${c.maybe} peut-être, ${c.no} indisponibles">
                <span class="t-yes" style="width:${pct(c.yes)}%"></span><span class="t-maybe" style="width:${pct(c.maybe)}%"></span><span class="t-no" style="width:${pct(c.no)}%"></span>
              </div>`}
            ${names ? `
            <dl class="names">
              <dt>Disponibles</dt><dd>${names.yes.length ? names.yes.map(esc).join(', ') : '—'}</dd>
              <dt>Peut-être</dt><dd>${names.maybe.length ? names.maybe.map(esc).join(', ') : '—'}</dd>
              <dt>Indisponibles</dt><dd>${names.no.length ? names.no.map(esc).join(', ') : '—'}</dd>
            </dl>` : ''}
          </div>`
        }).join('')}
      </div>
    </div>
    <div class="card">
      <h2>Partager</h2>
      ${shareLinkBox(inviteState.code, 'inv')}
      <div class="btn-row">${shareButton(inviteState.code, event.title)}</div>
    </div>`
  bindShareButtons(box, inviteState.code, event.title)
}

function renderOwnerCard (route, seq) {
  const box = $('#inv-owner')
  const { data } = inviteState
  if (!data?.is_owner) {
    box.innerHTML = ''
    return
  }
  const code = route.code
  const { event, options } = data
  const confirmed = event.status === 'confirme'

  let chooseHTML = ''
  if (!confirmed) {
    if (inviteState.confirmSlot) {
      const o = options.find((x) => x.id === inviteState.confirmSlot)
      chooseHTML = `
        <p><strong>Choisir le ${esc(formatDay(o.day))} (${esc(o.time_start)} → ${esc(o.time_end)}) ?</strong><br>
        <span class="hint">Le vote sera clos et tous les invités verront ce créneau.</span></p>
        <div class="btn-row">
          <button type="button" class="btn btn-primary btn-small" data-action="choose-yes">Oui, choisir ce créneau</button>
          <button type="button" class="btn btn-ghost btn-small" data-action="choose-no">Annuler</button>
        </div>`
    } else {
      chooseHTML = `
        <p class="hint">Choisissez le créneau définitif pour clore le vote :</p>
        <div class="owner-actions">
          ${options.map((o) => `
            <button type="button" class="btn btn-ghost btn-small" data-action="choose" data-option="${o.id}">
              Choisir : ${esc(formatDay(o.day))}
            </button>`).join('')}
        </div>`
    }
  }

  box.innerHTML = `
    <div class="card">
      <h2>Organisateur</h2>
      ${confirmed ? `
        <p class="muted">Le créneau du ${esc(formatDay(data.final_option.day))} est confirmé.</p>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost btn-small" data-action="ics">Ajouter au calendrier</button>
          <button type="button" class="btn btn-ghost btn-small" data-action="reopen">Reprendre le vote</button>
        </div>` : chooseHTML}
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      ${inviteState.confirmDelete ? `
        <p><strong>Supprimer définitivement cet événement ?</strong><br>
        <span class="hint">Le lien cessera de fonctionner pour tous les invités.</span></p>
        <div class="btn-row">
          <button type="button" class="btn btn-danger btn-small" data-action="delete-yes">Oui, supprimer</button>
          <button type="button" class="btn btn-ghost btn-small" data-action="delete-no">Annuler</button>
        </div>` : `
        <button type="button" class="btn btn-danger btn-small" data-action="delete">Supprimer l’événement</button>`}
    </div>`

  const token = getOwnerToken(code)
  const refresh = async () => {
    try {
      const fresh = await api(`/api/events?code=${code}`, { token: token || undefined })
      if (seq !== renderSeq) return
      inviteState.data = fresh
      inviteState.confirmSlot = null
      if (fresh.is_owner) {
        try {
          const d = await api(`/api/votes?event_id=${fresh.event.id}&code=${code}`, { token })
          inviteState.detail = d.detail || null
        } catch { inviteState.detail = null }
      }
      if (seq !== renderSeq) return
      renderInvite(route, seq)
    } catch { loadInvite(route, seq) }
  }

  box.querySelectorAll('[data-action="choose"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      inviteState.confirmSlot = Number(btn.dataset.option)
      renderOwnerCard(route, seq)
    })
  })
  box.querySelector('[data-action="choose-no"]')?.addEventListener('click', () => {
    inviteState.confirmSlot = null
    renderOwnerCard(route, seq)
  })
  box.querySelector('[data-action="choose-yes"]')?.addEventListener('click', async () => {
    try {
      await api('/api/events', { method: 'PATCH', token, body: { code, final_option_id: inviteState.confirmSlot } })
      toast('Créneau confirmé.')
      refresh()
    } catch (err) {
      toast(err.data?.error || 'Confirmation impossible.', 'toast-error')
    }
  })
  box.querySelector('[data-action="reopen"]')?.addEventListener('click', async () => {
    try {
      await api('/api/events', { method: 'PATCH', token, body: { code, final_option_id: null } })
      toast('Vote repris.')
      refresh()
    } catch (err) {
      toast(err.data?.error || 'Action impossible.', 'toast-error')
    }
  })
  box.querySelector('[data-action="ics"]')?.addEventListener('click', () => {
    if (data.final_option) downloadICS(event, data.final_option)
  })
  box.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
    inviteState.confirmDelete = true
    renderOwnerCard(route, seq)
  })
  box.querySelector('[data-action="delete-no"]')?.addEventListener('click', () => {
    inviteState.confirmDelete = false
    renderOwnerCard(route, seq)
  })
  box.querySelector('[data-action="delete-yes"]')?.addEventListener('click', async () => {
    try {
      await api(`/api/events?code=${code}`, { method: 'DELETE', token })
      dropOwnerToken(code)
      dropMyCode(code)
      toast('Événement supprimé.')
      navigate('/')
    } catch (err) {
      toast(err.data?.error || 'Suppression impossible.', 'toast-error')
    }
  })
}

/* ------------------------------------------------------------------ calendrier (.ics) */

const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')

function downloadICS (event, option) {
  const compact = (d, t) => `${d.replaceAll('-', '')}T${t.replace(':', '')}00`
  const stamp = () => `${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dispoo//FR', 'BEGIN:VEVENT',
    `UID:${event.code}-${option.id}@dispoo`,
    `DTSTAMP:${stamp()}`,
    `DTSTART:${compact(option.day, option.time_start)}`,
    `DTEND:${compact(option.day, option.time_end)}`,
    `SUMMARY:${icsEsc(event.title)}`,
    `LOCATION:${icsEsc(event.location)}`,
    `DESCRIPTION:Vote clos sur Dispoo (${event.code})`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n')
  const blob = new Blob([lines], { type: 'text/calendar;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `dispoo-${event.code}.ics`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

/* ------------------------------------------------------------------ démarrage */

// Navigation interne sans rechargement (les vrais liens restent des <a> :
// clic-môle, nouvel onglet et retour arrière fonctionnent).
document.addEventListener('click', (e) => {
  const anchor = e.target.closest('a[href]')
  if (!anchor) return
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  const url = new URL(anchor.getAttribute('href'), location.origin)
  if (url.origin !== location.origin) return
  // Ancre de la page courante : défilement natif.
  if (url.pathname === location.pathname && !url.search && url.hash) return
  e.preventDefault()
  if (url.pathname + url.search + url.hash === location.pathname + location.search + location.hash) return
  navigate(url.pathname + url.search + url.hash)
})
window.addEventListener('popstate', () => render())

render()
