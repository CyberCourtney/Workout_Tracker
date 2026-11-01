'use strict';
// Workout tracker frontend. Vanilla JS, no dependencies.
// Sections: dates & units, auth (Cognito Hosted UI + PKCE), API, draft,
// calendar, workout editor, progress chart, settings, boot.

const CFG = window.APP_CONFIG || {};
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------ dates & units
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => isoDate(new Date());
const longDate = s => parseDate(s).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = s => parseDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dayLabel = s => {
  const t = today();
  if (s === t) return 'Today';
  const d = parseDate(t); d.setDate(d.getDate() - 1);
  if (s === isoDate(d)) return 'Yesterday';
  return parseDate(s).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};

const KG_PER_LB = 0.45359237;
const getUnit = () => (localStorage.getItem('wt.unit') === 'lb' ? 'lb' : 'kg');
const kgTo = (kg, unit) => (unit === 'lb' ? kg / KG_PER_LB : kg);
const toKg = (v, unit) => (unit === 'lb' ? v * KG_PER_LB : v);
const fmt = n => (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
const norm = s => s.trim().replace(/\s+/g, ' ').toLowerCase();

// ------------------------------------------------------------ auth
// Tokens live in sessionStorage (cleared with the tab); localStorage is used
// only for the workout draft and the unit setting.
const AUTH_KEY = 'wt.auth';
const PKCE_KEY = 'wt.pkce';
const redirectUri = () => `${location.origin}/`;
const authBase = () => `https://${CFG.hostedUiDomain}`;

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function login() {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CFG.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email',
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.assign(`${authBase()}/oauth2/authorize?${q}`);
  return new Promise(() => {}); // page is navigating away
}

async function tokenRequest(params) {
  const res = await fetch(`${authBase()}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.clientId, ...params }),
  });
  if (!res.ok) throw new Error('Sign-in expired');
  return res.json();
}

function storeTokens(json, previous = {}) {
  const auth = {
    access: json.access_token,
    refresh: json.refresh_token || previous.refresh,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  return auth;
}

async function exchangeCode(code, state) {
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null');
  sessionStorage.removeItem(PKCE_KEY);
  if (!saved || saved.state !== state) throw new Error('Sign-in could not be verified. Please try again.');
  storeTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: saved.verifier }));
}

async function accessToken() {
  const auth = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null');
  if (auth && auth.expiresAt - Date.now() > 60_000) return auth.access;
  if (auth && auth.refresh) {
    try { return storeTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh }), auth).access; }
    catch { /* fall through to a fresh login */ }
  }
  sessionStorage.removeItem(AUTH_KEY);
  return login();
}

function signOut() {
  sessionStorage.removeItem(AUTH_KEY);
  const q = new URLSearchParams({ client_id: CFG.clientId, logout_uri: redirectUri() });
  location.assign(`${authBase()}/logout?${q}`);
}

// ------------------------------------------------------------ API
async function api(method, path, body) {
  const token = await accessToken();
  const headers = { authorization: `Bearer ${token}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(CFG.apiUrl.replace(/\/$/, '') + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { sessionStorage.removeItem(AUTH_KEY); return login(); }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const monthCache = new Map(); // 'YYYY-MM' -> workouts
let allWorkouts = null;       // every workout, for progress + autocomplete

async function loadMonth(ym) {
  if (!monthCache.has(ym)) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const { items } = await api('GET', `/workouts?from=${ym}-01&to=${ym}-${pad(last)}`);
    monthCache.set(ym, items);
  }
  return monthCache.get(ym);
}
async function loadAll() {
  if (!allWorkouts) allWorkouts = (await api('GET', '/workouts?from=1900-01-01&to=9999-12-31')).items;
  return allWorkouts;
}
function invalidate() { monthCache.clear(); allWorkouts = null; }

// ------------------------------------------------------------ draft
// The in-progress workout. Weights are kept as typed, in draft.unit, so a
// refresh restores exactly what was on screen.
const DRAFT_KEY = 'wt.draft';
let draft = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } })();
const persistDraft = () => draft ? localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) : localStorage.removeItem(DRAFT_KEY);
const blankExercise = () => ({ name: '', sets: [{ reps: '', weight: '' }] });
const draftHasContent = () => draft && draft.exercises.some(e => e.name.trim() || e.sets.some(s => s.reps !== '' || s.weight !== ''));

function confirmReplaceDraft() {
  return !draftHasContent() || confirm('You have an unfinished workout. Discard it and start this one?');
}

function newDraft(date) {
  draft = { id: null, mode: 'new', date, status: date > today() ? 'planned' : 'completed', unit: getUnit(), exercises: [blankExercise()] };
  persistDraft();
}

function draftFromWorkout(w, mode) {
  const unit = getUnit();
  draft = {
    id: w.id,
    mode, // 'edit' keeps date and status; 'start' turns a planned workout into today's
    date: mode === 'start' ? today() : w.date,
    status: mode === 'start' ? 'completed' : w.status,
    unit,
    exercises: w.exercises.map(e => ({
      name: e.name,
      sets: e.sets.length ? e.sets.map(s => ({ reps: String(s.reps), weight: String(Math.round(kgTo(s.weight, unit) * 10) / 10) })) : [{ reps: '', weight: '' }],
    })),
  };
  persistDraft();
}

// ------------------------------------------------------------ navigation
let currentView = 'calendar';
function show(view) {
  currentView = view;
  for (const v of ['calendar', 'workout', 'progress']) $(`#view-${v}`).hidden = v !== view;
  $$('.tabbar button').forEach(b => {
    b.classList.toggle('on', b.dataset.view === view);
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  });
  updateFab();
  window.scrollTo(0, 0);
  if (view === 'calendar') renderCalendar();
  if (view === 'workout') renderWorkout();
  if (view === 'progress') renderProgress();
}
function updateFab() {
  const fab = $('#start-btn');
  fab.hidden = currentView === 'workout';
  fab.textContent = draft ? 'Resume Workout' : 'Start Workout';
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

function startWorkout() {
  if (!draft) newDraft(today());
  show('workout');
}
$('#start-btn').addEventListener('click', startWorkout);
$('#wk-start-empty').addEventListener('click', startWorkout);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// ------------------------------------------------------------ calendar
let calMonth = today().slice(0, 7);
let selectedDay = today();

function summary(w) {
  return w.exercises.map(e => e.name).join(', ');
}

async function renderCalendar() {
  const ym = calMonth;
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  $('#month-title').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  drawGrid(ym, monthCache.get(ym) || []);
  renderDayList();
  try {
    const items = await loadMonth(ym);
    if (ym === calMonth) { drawGrid(ym, items); renderDayList(); }
  } catch (e) { toast(e.message); }
}

function drawGrid(ym, items) {
  const [y, m] = ym.split('-').map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // weeks start on Monday
  const days = new Date(y, m, 0).getDate();
  const byDate = new Map();
  for (const w of items) {
    const s = byDate.get(w.date) || { done: 0, planned: 0 };
    s[w.status === 'planned' ? 'planned' : 'done']++;
    byDate.set(w.date, s);
  }
  const t = today();
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  for (let i = 0; i < lead; i++) grid.append(Object.assign(document.createElement('span'), { className: 'cal-blank' }));
  for (let d = 1; d <= days; d++) {
    const date = `${ym}-${pad(d)}`;
    const s = byDate.get(date);
    const b = document.createElement('button');
    b.className = 'cal-day' + (date === t ? ' today' : '') + (date === selectedDay ? ' selected' : '');
    b.innerHTML = `<span class="n">${d}</span><span class="marks">${s && s.done ? '<i class="dot done"></i>' : ''}${s && s.planned ? '<i class="dot planned"></i>' : ''}</span>`;
    const parts = [];
    if (s && s.done) parts.push(`${s.done} completed`);
    if (s && s.planned) parts.push(`${s.planned} planned`);
    b.setAttribute('aria-label', `${longDate(date)}${parts.length ? ', ' + parts.join(', ') : ''}`);
    b.addEventListener('click', () => { selectedDay = date; drawGrid(ym, items); renderDayList(); });
    grid.append(b);
  }
}

function renderDayList() {
  $('#day-title').textContent = dayLabel(selectedDay);
  const items = (monthCache.get(selectedDay.slice(0, 7)) || [])
    .filter(w => w.date === selectedDay)
    .sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
  const ul = $('#day-list');
  ul.innerHTML = '';
  items.forEach((w, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'card workout-card';
    const planned = w.status === 'planned';
    const sets = w.exercises.reduce((n, e) => n + e.sets.length, 0);
    b.innerHTML = `<div class="top"><strong>${planned ? 'Planned workout' : `Workout${items.length > 1 ? ' ' + (i + 1) : ''}`}</strong>
      <span class="badge ${planned ? 'planned' : ''}">${planned ? 'Planned' : 'Completed'}</span></div>
      <p class="ex">${esc(summary(w))}</p><p class="ex">${w.exercises.length} exercise${w.exercises.length === 1 ? '' : 's'} · ${sets} set${sets === 1 ? '' : 's'}</p>`;
    b.addEventListener('click', () => openDetail(w));
    li.append(b);
    ul.append(li);
  });
  $('#day-empty').hidden = items.length > 0 || !monthCache.has(selectedDay.slice(0, 7));
}

function shiftMonth(n) {
  const [y, m] = calMonth.split('-').map(Number);
  calMonth = isoDate(new Date(y, m - 1 + n, 1)).slice(0, 7);
  renderCalendar();
}
$('#prev-month').addEventListener('click', () => shiftMonth(-1));
$('#next-month').addEventListener('click', () => shiftMonth(1));
$('#cal-today').addEventListener('click', () => { calMonth = today().slice(0, 7); selectedDay = today(); renderCalendar(); });
$('#day-add').addEventListener('click', () => {
  if (!confirmReplaceDraft()) return;
  newDraft(selectedDay);
  show('workout');
});

// ------------------------------------------------------------ workout detail sheet
const detail = $('#detail');
let detailWorkout = null;

function openDetail(w) {
  detailWorkout = w;
  const unit = getUnit();
  $('#detail-title').textContent = `${w.status === 'planned' ? 'Planned · ' : ''}${shortDate(w.date)}`;
  $('#detail-body').innerHTML = w.exercises.map(e => `
    <div class="card detail-ex"><h3>${esc(e.name)}</h3>
      <table>${e.sets.map((s, i) => `<tr><td>Set ${i + 1}</td><td>${fmt(s.reps)} reps</td><td>${fmt(kgTo(s.weight, unit))} ${unit}</td></tr>`).join('') || '<tr><td colspan="3">No sets</td></tr>'}</table>
    </div>`).join('');
  $('#detail-start').hidden = w.status !== 'planned';
  detail.showModal();
}
$$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog.sheet').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

$('#detail-start').addEventListener('click', () => {
  if (!confirmReplaceDraft()) return;
  draftFromWorkout(detailWorkout, 'start');
  detail.close();
  show('workout');
});
$('#detail-edit').addEventListener('click', () => {
  if (!confirmReplaceDraft()) return;
  draftFromWorkout(detailWorkout, 'edit');
  detail.close();
  show('workout');
});
$('#detail-delete').addEventListener('click', async () => {
  const w = detailWorkout;
  if (!confirm(`Delete this ${w.status === 'planned' ? 'planned ' : ''}workout from ${shortDate(w.date)}?`)) return;
  try {
    await api('DELETE', `/workouts/${encodeURIComponent(w.id)}`);
    if (draft && draft.id === w.id) { draft = null; persistDraft(); }
    invalidate();
    detail.close();
    toast('Workout deleted');
    renderCalendar();
  } catch (e) { toast(e.message); }
});

// ------------------------------------------------------------ workout editor
async function refreshNameSuggestions() {
  try {
    const counts = new Map();
    for (const w of await loadAll()) for (const e of w.exercises) {
      const k = norm(e.name);
      const c = counts.get(k) || { name: e.name, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    $('#exercise-names').innerHTML = [...counts.values()].sort((a, b) => b.n - a.n)
      .map(c => `<option value="${esc(c.name)}"></option>`).join('');
  } catch { /* suggestions are optional */ }
}

function renderWorkout() {
  updateFab();
  $('#wk-empty').hidden = !!draft;
  $('#wk-editor').hidden = !draft;
  $('#wk-error').hidden = true;
  if (!draft) { $('#wk-title').textContent = 'Workout'; $('#wk-sub').textContent = ''; return; }
  const planned = draft.status === 'planned';
  $('#wk-title').textContent = planned ? 'Plan Workout' : draft.mode === 'edit' ? 'Edit Workout' : 'Workout';
  $('#wk-sub').textContent = longDate(draft.date) + (planned ? ' · Planned' : '');
  $('#wk-finish').textContent = planned ? 'Save Plan' : draft.mode === 'edit' ? 'Save Changes' : 'Finish';
  $('#wk-discard').textContent = draft.mode === 'edit' ? 'Cancel Editing' : 'Discard';
  drawExercises();
  refreshNameSuggestions();
}

function drawExercises() {
  const ol = $('#wk-exercises');
  ol.innerHTML = '';
  draft.exercises.forEach((ex, i) => {
    const li = document.createElement('li');
    li.className = 'card exercise';
    li.innerHTML = `
      <div class="ex-head">
        <input class="ex-name" list="exercise-names" placeholder="Exercise name" autocomplete="off" autocapitalize="words" enterkeyhint="next" aria-label="Exercise ${i + 1} name">
        <button class="icon-btn small" data-act="up" aria-label="Move exercise up" ${i === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
        <button class="icon-btn small" data-act="down" aria-label="Move exercise down" ${i === draft.exercises.length - 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
        <button class="icon-btn small" data-act="remove" aria-label="Delete exercise">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
      </div>
      <div class="set-grid set-labels"><span>Set</span><span>Reps</span><span>${draft.unit}</span><span></span></div>
      <div class="sets"></div>
      <button class="add-set">+ Add Set</button>`;
    const name = $('.ex-name', li);
    name.value = ex.name;
    name.addEventListener('input', () => { ex.name = name.value; persistDraft(); });

    const setsEl = $('.sets', li);
    ex.sets.forEach((s, j) => {
      const row = document.createElement('div');
      row.className = 'set-grid set-row';
      row.innerHTML = `<span class="idx">${j + 1}</span>
        <input class="reps" type="text" inputmode="numeric" aria-label="Set ${j + 1} reps" placeholder="0">
        <input class="weight" type="text" inputmode="decimal" aria-label="Set ${j + 1} weight in ${draft.unit}" placeholder="0">
        <button class="icon-btn small" aria-label="Delete set ${j + 1}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
      const reps = $('.reps', row), weight = $('.weight', row);
      reps.value = s.reps; weight.value = s.weight;
      reps.addEventListener('input', () => { s.reps = reps.value; reps.removeAttribute('aria-invalid'); persistDraft(); });
      weight.addEventListener('input', () => { s.weight = weight.value; weight.removeAttribute('aria-invalid'); persistDraft(); });
      $('button', row).addEventListener('click', () => { ex.sets.splice(j, 1); persistDraft(); drawExercises(); });
      setsEl.append(row);
    });

    $('.add-set', li).addEventListener('click', () => {
      const last = ex.sets[ex.sets.length - 1];
      ex.sets.push(last ? { ...last } : { reps: '', weight: '' }); // usually "same again"
      persistDraft();
      drawExercises();
      const rows = $$('.exercise')[i].querySelectorAll('.reps');
      rows[rows.length - 1].focus();
    });
    li.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'remove') {
        const has = ex.name.trim() || ex.sets.some(s => s.reps !== '' || s.weight !== '');
        if (has && !confirm(`Delete ${ex.name.trim() || 'this exercise'}?`)) return;
        draft.exercises.splice(i, 1);
      } else {
        const to = act === 'up' ? i - 1 : i + 1;
        [draft.exercises[i], draft.exercises[to]] = [draft.exercises[to], draft.exercises[i]];
      }
      persistDraft();
      drawExercises();
    });
    ol.append(li);
  });
}

$('#wk-add-ex').addEventListener('click', () => {
  draft.exercises.push(blankExercise());
  persistDraft();
  drawExercises();
  const names = $$('.ex-name');
  names[names.length - 1].focus();
});

$('#wk-discard').addEventListener('click', () => {
  const msg = draft.mode === 'edit' ? 'Stop editing? Your changes will be lost.' : 'Discard this workout?';
  if (draftHasContent() && !confirm(msg)) return;
  draft = null;
  persistDraft();
  renderWorkout();
});

const NUM_RE = /^\d+(\.\d+)?$/;
function buildPayload() {
  let firstBad = null;
  const markBad = el => { el.setAttribute('aria-invalid', 'true'); firstBad = firstBad || el; };
  const cards = $$('.exercise');
  const exercises = [];
  draft.exercises.forEach((ex, i) => {
    const sets = [];
    ex.sets.forEach((s, j) => {
      const r = s.reps.trim(), w = s.weight.trim().replace(',', '.');
      if (r === '' && w === '') return; // ignore empty rows
      const row = cards[i].querySelectorAll('.set-row')[j];
      if (!NUM_RE.test(r)) markBad($('.reps', row));
      if (!NUM_RE.test(w)) markBad($('.weight', row));
      sets.push({ reps: Number(r), weight: Math.round(toKg(Number(w), draft.unit) * 1000) / 1000 });
    });
    const name = ex.name.trim();
    if (!name && !sets.length) return; // ignore an untouched exercise card
    if (!name) markBad($('.ex-name', cards[i]));
    exercises.push({ name, sets });
  });
  if (firstBad) { firstBad.focus(); throw new Error('Check the highlighted fields. Reps and weight must be numbers of 0 or more.'); }
  if (!exercises.length) throw new Error('Add at least one exercise first.');
  if (exercises.length > 30) throw new Error('A workout can have at most 30 exercises.');
  if (exercises.some(e => e.sets.length > 20)) throw new Error('An exercise can have at most 20 sets.');
  return { date: draft.date, status: draft.status, exercises };
}

$('#wk-finish').addEventListener('click', async () => {
  const err = $('#wk-error');
  err.hidden = true;
  let payload;
  try { payload = buildPayload(); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
  const btn = $('#wk-finish');
  btn.disabled = true;
  try {
    if (draft.id) await api('PUT', `/workouts/${encodeURIComponent(draft.id)}`, payload);
    else await api('POST', '/workouts', payload);
    const planned = payload.status === 'planned';
    draft = null;
    persistDraft();
    invalidate();
    toast(planned ? 'Workout planned' : 'Workout saved');
    selectedDay = payload.date;
    calMonth = payload.date.slice(0, 7);
    show('calendar');
  } catch (e) {
    err.textContent = e.message; // the draft is still saved locally
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ progress
let metric = 'e1rm';
const METRICS = {
  e1rm: { label: 'Estimated 1RM', caption: 'Best estimated one-rep max (Epley)', agg: 'max',
    of: w => Math.max(0, ...w.sets.map(s => (s.reps > 0 ? (s.reps === 1 ? s.weight : s.weight * (1 + s.reps / 30)) : 0))) },
  volume: { label: 'Total volume', caption: 'Total volume (reps × weight)', agg: 'sum',
    of: w => w.sets.reduce((n, s) => n + s.reps * s.weight, 0) },
  top: { label: 'Top set weight', caption: 'Heaviest set', agg: 'max',
    of: w => Math.max(0, ...w.sets.filter(s => s.reps > 0).map(s => s.weight)) },
};

async function renderProgress() {
  $$('#prog-metric button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.metric === metric)));
  let workouts;
  try { workouts = (await loadAll()).filter(w => w.status === 'completed'); }
  catch (e) { toast(e.message); return; }
  if (currentView !== 'progress') return;

  const names = new Map();
  for (const w of workouts) for (const e of w.exercises) {
    const k = norm(e.name);
    const c = names.get(k) || { name: e.name, n: 0 };
    c.n++;
    names.set(k, c);
  }
  $('#prog-empty').hidden = names.size > 0;
  $('#prog-content').hidden = names.size === 0;
  if (!names.size) return;

  const sel = $('#prog-exercise');
  const prev = sel.value;
  sel.innerHTML = [...names.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([k, c]) => `<option value="${esc(k)}">${esc(c.name)}</option>`).join('');
  if (names.has(prev)) sel.value = prev;

  const m = METRICS[metric];
  const unit = getUnit();
  const byDate = new Map(); // one point per workout date
  for (const w of workouts) for (const e of w.exercises) {
    if (norm(e.name) !== sel.value) continue;
    const v = m.of(e);
    const cur = byDate.get(w.date) || 0;
    byDate.set(w.date, m.agg === 'sum' ? cur + v : Math.max(cur, v));
  }
  const points = [...byDate.entries()].filter(([, v]) => v > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, v: kgTo(v, unit) }));
  $('#chart-caption').textContent = `${m.caption}, ${unit} · one point per workout date`;
  drawChart(points, unit);
}
$('#prog-exercise').addEventListener('change', renderProgress);
$$('#prog-metric button').forEach(b => b.addEventListener('click', () => { metric = b.dataset.metric; renderProgress(); }));

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { lo = Math.max(0, lo - 1); hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// Inline SVG line chart. Dates are spaced by real time so gaps between
// sessions read as gaps. Tap or hover shows the nearest point's date and value.
function drawChart(points, unit) {
  const el = $('#chart'), tip = $('#chart-tip');
  tip.hidden = true;
  if (!points.length) {
    el.innerHTML = '<p class="empty">No sets with reps and weight logged for this exercise yet.</p>';
    return;
  }
  const W = el.clientWidth || 340, H = el.clientHeight || 280;
  const M = { l: 48, r: 18, t: 30, b: 28 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const ts = points.map(p => parseDate(p.date).getTime());
  let x0 = ts[0], x1 = ts[ts.length - 1];
  if (x0 === x1) { x0 -= 3 * 864e5; x1 += 3 * 864e5; }
  const vals = points.map(p => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const padV = (hi - lo) * 0.15 || hi * 0.1 || 1;
  const yt = niceTicks(Math.max(0, lo - padV), hi + padV);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const X = t => M.l + ((t - x0) / (x1 - x0)) * iw;
  const Y = v => M.t + ih - ((v - y0) / (y1 - y0)) * ih;

  const nX = Math.min(4, points.length);
  const xt = Array.from({ length: nX }, (_, i) => (nX === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (nX - 1)));
  const sameYear = new Date(x0).getFullYear() === new Date(x1).getFullYear();
  const xLabel = t => new Date(t).toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { month: 'short', year: '2-digit' });
  const xAnchor = i => (nX === 1 ? 'middle' : i === 0 ? 'start' : i === nX - 1 ? 'end' : 'middle');

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(ts[i]).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${X(ts[ts.length - 1]).toFixed(1)},${Y(y0)}L${X(ts[0]).toFixed(1)},${Y(y0)}Z`;
  const bi = vals.indexOf(hi);
  const bx = X(ts[bi]);
  const bAnchor = bx > W - 70 ? 'end' : bx < M.l + 50 ? 'start' : 'middle';

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${points.length} workout dates. Latest ${fmt(vals[vals.length - 1])} ${unit}, best ${fmt(hi)} ${unit}.">
    ${yt.map(v => `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}
    ${yt.map(v => `<text class="axis" x="${M.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
    ${xt.map((t, i) => `<text class="axis" x="${X(t)}" y="${H - 6}" text-anchor="${xAnchor(i)}">${xLabel(t)}</text>`).join('')}
    ${points.length > 1 ? `<path class="area" d="${area}"/>` : ''}
    <path class="line" d="${line}"/>
    ${points.length <= 60 ? points.map((p, i) => `<circle class="pt" cx="${X(ts[i])}" cy="${Y(p.v)}" r="4"/>`).join('') : ''}
    <text class="best" x="${bx}" y="${Y(hi) - 12}" text-anchor="${bAnchor}">Best ${fmt(hi)}</text>
    <line class="cross" y1="${M.t}" y2="${M.t + ih}" visibility="hidden"/>
    <circle class="pt hot" r="6" visibility="hidden"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
  </svg>`;

  const svg = $('svg', el), cross = $('.cross', svg), hot = $('.hot', svg);
  const move = ev => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let i = 0;
    ts.forEach((t, j) => { if (Math.abs(X(t) - px) < Math.abs(X(ts[i]) - px)) i = j; });
    const cx = X(ts[i]), cy = Y(points[i].v);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    hot.setAttribute('cx', cx); hot.setAttribute('cy', cy); hot.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${fmt(points[i].v)} ${unit}</b>${shortDate(points[i].date)}`;
    tip.hidden = false;
    const left = (cx / W) * r.width + 8;
    tip.style.left = `${Math.min(Math.max(left, 70), r.width - 54)}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
}
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (currentView === 'progress') renderProgress(); }, 150);
});

// ------------------------------------------------------------ settings
function renderSettings() {
  $$('#unit-toggle button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.unit === getUnit())));
}
$$('[data-open-settings]').forEach(b => b.addEventListener('click', () => { renderSettings(); $('#settings').showModal(); }));
$$('#unit-toggle button').forEach(b => b.addEventListener('click', () => {
  const unit = b.dataset.unit;
  localStorage.setItem('wt.unit', unit);
  if (draft && draft.unit !== unit) { // convert the open draft so nothing changes meaning
    for (const e of draft.exercises) for (const s of e.sets) {
      if (NUM_RE.test(s.weight.trim())) s.weight = String(Math.round(kgTo(toKg(+s.weight, draft.unit), unit) * 10) / 10);
    }
    draft.unit = unit;
    persistDraft();
  }
  renderSettings();
  show(currentView);
}));
$('#sign-out').addEventListener('click', signOut);

// ------------------------------------------------------------ boot
async function boot() {
  const msg = $('#boot-msg');
  if (!CFG.apiUrl || !CFG.clientId || !CFG.hostedUiDomain) {
    msg.textContent = 'This site is not configured yet. Run scripts/deploy.sh to generate config.js.';
    return;
  }
  const q = new URLSearchParams(location.search);
  try {
    if (q.get('error')) throw new Error(q.get('error_description') || 'Sign-in failed.');
    if (q.get('code')) {
      await exchangeCode(q.get('code'), q.get('state'));
      history.replaceState(null, '', '/');
    }
    await accessToken(); // redirects to the Hosted UI when there is no session
  } catch (e) {
    history.replaceState(null, '', '/');
    msg.innerHTML = '';
    msg.append(e.message, document.createElement('br'));
    const retry = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Sign In' });
    retry.addEventListener('click', login);
    msg.append(retry);
    return;
  }
  $('#boot').hidden = true;
  $('#app').hidden = false;
  show(draft ? 'workout' : 'calendar');
}
boot();
