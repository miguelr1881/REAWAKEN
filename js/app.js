import { DEFAULT_ROUTINE, PROFILE, totalSets } from './routine.js';
import { db, requestPersistence, storageEstimate } from './db.js';
import { INBODY_FIELDS, parseInBody, formatValue, consistency, fieldMeta } from './inbody.js';
import { parseRoutineText, sanitizeRoutine, DAY_ACCENTS } from './routine-parser.js';
import * as sync from './sync.js';

/* ============================== Estado ============================== */

const state = {
  view: 'home',
  routine: DEFAULT_ROUTINE,   // rutina activa
  routineId: null,
  session: null,              // sesión activa (finishedAt === null)
  sessions: [],               // historial completo
  measures: [],               // mediciones InBody
  draft: null,                // rutina en edición
  theme: 'auto',
  chartMetric: 'pbf',
  rest: { id: null, left: 0, total: 45 }
};

const dayById = (id) => state.routine.find(d => d.id === id);

function findMovement(movementId) {
  for (const day of state.routine) {
    for (const block of day.blocks) {
      const m = block.movements.find(x => x.id === movementId);
      if (m) return { day, block, movement: m };
    }
  }
  return null;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));

/* ============================== Utilidades ============================== */

function fmtDate(ts, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Date(ts).toLocaleDateString('es-MX', opts);
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function haptic() {
  // iOS ignora vibrate; el feedback visual va por CSS. Se mantiene por compatibilidad Android.
  navigator.vibrate?.(8);
}

function isStandalone() {
  return window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
}

/* ---------- Tema ---------- */

const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(pref) {
  state.theme = pref;
  const light = pref === 'light' || (pref === 'auto' && prefersLight.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('#meta-theme-color').setAttribute('content', light ? '#f2f2f7' : '#000000');
  $('#meta-status-bar').setAttribute('content', light ? 'default' : 'black-translucent');
  // Espejo en localStorage para poder aplicar el tema antes de pintar en el siguiente arranque.
  try { localStorage.setItem('theme', pref); } catch { /* modo privado */ }
  $$('#theme-seg button').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === pref));
}

async function setTheme(pref) {
  applyTheme(pref);
  await db.setMeta('theme', pref);
}

prefersLight.addEventListener('change', () => { if (state.theme === 'auto') applyTheme('auto'); });

/* ============================== Sesiones ============================== */

function newSession(dayId) {
  const day = dayById(dayId);
  const entries = {};
  for (const block of day.blocks) {
    for (const mv of block.movements) {
      entries[mv.id] = Array.from({ length: block.sets }, () => (mv.kind === 'weight' ? '' : false));
    }
  }
  return { id: uid(), dayId, startedAt: Date.now(), finishedAt: null, notes: '', entries };
}

/** Mejor peso registrado en este ejercicio, para marcar récords. */
function personalBest(movementId, excludeId) {
  let best = null;
  for (const s of state.sessions) {
    if (!s.finishedAt || s.id === excludeId) continue;
    for (const v of s.entries?.[movementId] || []) {
      const n = parseFloat(v);
      if (Number.isFinite(n) && (best === null || n > best)) best = n;
    }
  }
  return best;
}

function sessionProgress(session) {
  const day = dayById(session.dayId);
  if (!day) return { done: 0, total: 0, pct: 0 };
  let done = 0;
  const total = totalSets(day);
  // Se cuenta contra la rutina actual: una sesión vieja puede traer ejercicios que ya no existen.
  for (const block of day.blocks) {
    for (const mv of block.movements) {
      const arr = session.entries[mv.id] || [];
      for (let i = 0; i < block.sets; i++) {
        const v = arr[i];
        if (v === true || (typeof v === 'string' && v.trim() !== '')) done++;
      }
    }
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/** Rellena las series que falten: la rutina pudo cambiar con la sesión ya abierta. */
function ensureEntries(session, day) {
  let changed = false;
  for (const block of day.blocks) {
    for (const mv of block.movements) {
      const blank = mv.kind === 'weight' ? '' : false;
      const arr = session.entries[mv.id];
      if (!Array.isArray(arr)) {
        session.entries[mv.id] = Array.from({ length: block.sets }, () => blank);
        changed = true;
      } else if (arr.length < block.sets) {
        while (arr.length < block.sets) arr.push(blank);
        changed = true;
      }
    }
  }
  return changed;
}

let saveTimer = null;
function saveSession(immediate = false) {
  if (!state.session) return;
  clearTimeout(saveTimer);
  const doSave = async () => {
    await db.putSession(state.session);
    const i = state.sessions.findIndex(s => s.id === state.session.id);
    if (i >= 0) state.sessions[i] = { ...state.session };
    else state.sessions.push({ ...state.session });
  };
  if (immediate) return doSave();
  saveTimer = setTimeout(doSave, 350);
}

/** Última sesión terminada que registró este movimiento, para mostrar referencia. */
function lastPerformance(movementId, excludeId) {
  const prev = state.sessions
    .filter(s => s.finishedAt && s.id !== excludeId && s.entries?.[movementId])
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const s of prev) {
    const vals = s.entries[movementId].filter(v => typeof v === 'string' && v.trim() !== '');
    if (vals.length) return { values: vals, at: s.startedAt };
  }
  return null;
}

/* ============================== Vistas ============================== */

function setView(name) {
  state.view = name;
  const fullscreen = name === 'workout' || name === 'editor';
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $('#tabbar').style.display = fullscreen ? 'none' : 'flex';
  document.body.classList.toggle('in-workout', fullscreen);
  closeSheet();
  if (name !== 'workout') hideRest();
  window.scrollTo({ top: 0 });
}

/* ---------- Home ---------- */

function renderHome() {
  $('#today-date').textContent = fmtDate(Date.now());

  const h = new Date().getHours();
  $('#greeting').textContent = h < 12 ? 'Buenos días, Miguel' : h < 19 ? 'Buenas tardes, Miguel' : 'Buenas noches, Miguel';

  const finished = state.sessions.filter(s => s.finishedAt);
  $('#stat-week').textContent = `${finished.filter(s => s.startedAt >= weekStart(Date.now())).length}/${PROFILE.daysPerWeek}`;
  $('#stat-total').textContent = finished.length;
  $('#stat-streak').textContent = calcWeekStreak(finished);

  // Banner de sesión en curso
  const slot = $('#resume-slot');
  if (state.session) {
    const day = dayById(state.session.dayId);
    const p = sessionProgress(state.session);
    slot.innerHTML = day ? `
      <button class="resume-banner" id="btn-resume" style="width:100%;text-align:left">
        <span class="pulse"></span>
        <div>
          <strong>${esc(day.label)} · ${esc(day.title)}</strong>
          <small>En curso · ${p.done}/${p.total} series · ${p.pct}%</small>
        </div>
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l6 6-6 6"/></svg>
      </button>` : '';
    if (day) $('#btn-resume').onclick = () => openWorkout(state.session.dayId);
  } else {
    slot.innerHTML = '';
  }

  const nextDayId = suggestNextDay(finished);

  renderRoutineAlert();

  $('#day-list').innerHTML = state.routine.map(day => {
    const last = finished.filter(s => s.dayId === day.id).sort((a, b) => b.startedAt - a.startedAt)[0];
    const lastTxt = last
      ? `Última vez <em>${fmtDate(last.startedAt, { day: 'numeric', month: 'short' })}</em>`
      : 'Sin registros';
    const count = finished.filter(s => s.dayId === day.id).length;
    const pct = last ? sessionProgress(last).pct : 0;
    const circ = 2 * Math.PI * 16;
    const ring = last ? `
          <svg class="ring" width="42" height="42" viewBox="0 0 42 42">
            <circle class="bg" cx="21" cy="21" r="16"/>
            <circle class="fg" cx="21" cy="21" r="16" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct / 100)}"/>
          </svg>` : '';
    return `
      <button class="day-card" data-day="${day.id}">
        <div class="row">
          <div style="flex:1;min-width:0">
            <div class="label">${esc(day.label)}${day.id === nextDayId ? '<span class="next-badge">Siguiente</span>' : ''}</div>
            <h3>${esc(day.title)}</h3>
            <p>${esc(day.subtitle)}</p>
          </div>${ring}
        </div>
        <div class="meta">
          <span>${totalSets(day)} series</span>
          <span>${lastTxt}</span>
          <span>${count}×</span>
        </div>
      </button>`;
  }).join('');

  $$('.day-card').forEach(c => { c.onclick = () => startOrOpen(c.dataset.day); });
}

/** Siguiente día de la rotación según el último entrenamiento cerrado. */
function suggestNextDay(finished) {
  if (state.session) return state.session.dayId;
  const last = finished.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!last) return PROFILE.firstDayId || state.routine[0].id;
  const i = state.routine.findIndex(d => d.id === last.dayId);
  return state.routine[(i + 1) % state.routine.length].id;
}

/**
 * La racha se cuenta por semanas cumplidas, no por días seguidos: el plan tiene
 * 2 días de descanso, así que una racha diaria se rompería siempre.
 * La semana en curso no rompe la racha mientras no termine.
 */
const WEEK_GOAL = 4;

function weekStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function calcWeekStreak(finished) {
  if (!finished.length) return 0;
  const byWeek = new Map();
  for (const s of finished) {
    const k = weekStart(s.startedAt);
    byWeek.set(k, (byWeek.get(k) || 0) + 1);
  }
  const cursor = new Date(weekStart(Date.now()));
  let streak = 0;
  if ((byWeek.get(cursor.getTime()) || 0) >= WEEK_GOAL) streak++;
  cursor.setDate(cursor.getDate() - 7);
  while ((byWeek.get(cursor.getTime()) || 0) >= WEEK_GOAL) {
    streak++;
    cursor.setDate(cursor.getDate() - 7);
  }
  return streak;
}

/* ---------- Entreno ---------- */

async function startOrOpen(dayId) {
  if (state.session && state.session.dayId !== dayId) {
    const day = dayById(state.session.dayId);
    const ok = await confirmSheet({
      title: 'Tienes una sesión abierta',
      body: `${day.label} · ${day.title} sigue en curso. ¿Qué quieres hacer?`,
      confirm: 'Empezar la nueva',
      cancel: 'Seguir la actual'
    });
    if (!ok) return openWorkout(state.session.dayId);
    await db.deleteSession(state.session.id);
    state.sessions = state.sessions.filter(s => s.id !== state.session.id);
    state.session = null;
  }
  if (!state.session) {
    state.session = newSession(dayId);
    await saveSession(true);
  }
  openWorkout(dayId);
}

function openWorkout(dayId) {
  const day = dayById(dayId);
  if (!day) return toast('Ese día ya no existe en tu rutina');
  if (ensureEntries(state.session, day)) saveSession(true);
  $('#wh-name').textContent = `${day.label} · ${day.title}`;
  renderBlocks(day);
  updateWorkoutHeader();
  updateNotesButton();
  setView('workout');
}

function renderBlocks(day) {
  const s = state.session;
  $('#blocks').innerHTML = day.blocks.map(block => {
    const floorLabel = block.floor ? `Piso ${block.floor}` : (block.tag || 'Bloque');
    const floorClass = block.floor ? '' : ' neutral';
    const movesHtml = block.movements.map(mv => {
      const vals = s.entries[mv.id] || [];
      const last = lastPerformance(mv.id, s.id);
      const best = mv.kind === 'weight' ? personalBest(mv.id, s.id) : null;
      const setsHtml = Array.from({ length: block.sets }, (_, i) => {
        if (mv.kind === 'weight') {
          const v = typeof vals[i] === 'string' ? vals[i] : '';
          const ph = last?.values[i] ?? last?.values[0] ?? '–';
          const isPr = best !== null && parseFloat(v) > best;
          return `<div class="set${v ? ' filled' : ''}${isPr ? ' pr' : ''}" data-mid="${mv.id}" data-idx="${i}" data-best="${best ?? ''}">
              <span class="n">${i + 1}</span>
              <input inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${esc(v)}" placeholder="${esc(ph)}" aria-label="Serie ${i + 1} peso" />
            </div>`;
        }
        const on = vals[i] === true;
        return `<button class="set check-set${on ? ' filled' : ''}" data-mid="${mv.id}" data-idx="${i}" aria-pressed="${on}" aria-label="Serie ${i + 1}">
            <span class="n">${i + 1}</span>
            <span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>
          </button>`;
      }).join('');

      return `
        <div class="movement">
          <button class="mv-head" data-history="${mv.id}">
            <div class="mv-name">${esc(mv.name)}</div>
            <svg class="mv-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            <div class="mv-reps">${esc(mv.reps)}</div>
          </button>
          ${mv.timer ? `<button class="mv-timer" data-timer="${mv.timer}" data-timer-name="${esc(mv.name)}">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
              Cronometrar ${mv.timer} s
            </button>` : ''}
          ${mv.note ? `<div class="mv-note">${esc(mv.note)}</div>` : ''}
          ${last ? `<div class="mv-last">Última vez: <b>${esc(last.values.join(' · '))}</b></div>` : ''}
          <div class="sets">${setsHtml}</div>
        </div>`;
    }).join('');

    return `
      <div class="block" data-block="${block.id}">
        <div class="block-head">
          <span class="floor${floorClass}">${esc(floorLabel)}</span>
          ${block.rest ? `<span class="floor neutral">Rest ${block.rest}s</span>` : ''}
          <span class="sets-badge">${block.sets} ${block.sets === 1 ? 'serie' : 'series'}</span>
        </div>
        ${block.note ? `<div class="block-note">${esc(block.note)}</div>` : ''}
        ${movesHtml}
      </div>`;
  }).join('');

  bindSetHandlers(day);
  day.blocks.forEach(b => updateBlockState(b));
}

function bindSetHandlers(day) {
  $$('#blocks .mv-head[data-history]').forEach(btn => {
    btn.onclick = () => openMovementHistory(btn.dataset.history);
  });

  $$('#blocks .mv-timer').forEach(btn => {
    btn.onclick = () => {
      haptic();
      startCountdown(+btn.dataset.timer, btn.dataset.timerName, '¡Tiempo! Siguiente ejercicio');
    };
  });

  $$('#blocks .set input').forEach(input => {
    const cell = input.closest('.set');
    input.addEventListener('input', () => {
      let v = input.value.replace(',', '.').replace(/[^0-9.]/g, '');
      const parts = v.split('.');
      if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
      if (v.length > 6) v = v.slice(0, 6);
      input.value = v;
      state.session.entries[cell.dataset.mid][+cell.dataset.idx] = v;
      cell.classList.toggle('filled', v.trim() !== '');

      const best = parseFloat(cell.dataset.best);
      const isPr = Number.isFinite(best) && parseFloat(v) > best;
      if (isPr && !cell.classList.contains('pr')) toast(`¡Récord! Tu mejor era ${best}`);
      cell.classList.toggle('pr', isPr);

      saveSession();
      updateWorkoutHeader();
      updateBlockState(findBlock(day, cell.dataset.mid));
    });
    input.addEventListener('blur', () => {
      if (input.value.trim() !== '') { startRest(currentRestFor(day, cell.dataset.mid)); }
      saveSession(true);
    });
  });

  $$('#blocks .check-set').forEach(btn => {
    btn.addEventListener('click', () => {
      const arr = state.session.entries[btn.dataset.mid];
      const i = +btn.dataset.idx;
      arr[i] = !arr[i];
      btn.classList.toggle('filled', arr[i]);
      btn.setAttribute('aria-pressed', String(arr[i]));
      haptic();
      saveSession();
      updateWorkoutHeader();
      updateBlockState(findBlock(day, btn.dataset.mid));
      if (arr[i]) startRest(currentRestFor(day, btn.dataset.mid));
    });
  });
}

function findBlock(day, movementId) {
  return day.blocks.find(b => b.movements.some(m => m.id === movementId));
}

function currentRestFor(day, movementId) {
  return findBlock(day, movementId)?.rest || state.rest.total || 45;
}

function updateBlockState(block) {
  if (!block) return;
  const el = document.querySelector(`.block[data-block="${block.id}"]`);
  if (!el) return;
  const complete = block.movements.every(mv =>
    (state.session.entries[mv.id] || []).every(v => v === true || (typeof v === 'string' && v.trim() !== ''))
  );
  el.classList.toggle('complete', complete);
}

function updateWorkoutHeader() {
  const p = sessionProgress(state.session);
  $('#wh-progress').style.width = `${p.pct}%`;
  const mins = fmtDuration(Date.now() - state.session.startedAt);
  $('#wh-sub').textContent = `${p.done}/${p.total} series · ${p.pct}% · ${mins}`;
}

/* ---------- Temporizador (descanso y ejercicios cronometrados) ---------- */

const REST_CIRC = 2 * Math.PI * 19;

function startCountdown(seconds, title, doneMsg) {
  state.rest.total = seconds;
  state.rest.left = seconds;
  state.rest.title = title;
  clearInterval(state.rest.id);
  $('#rt-title').textContent = title;
  $('#rest-timer').classList.add('show');
  paintRest();
  state.rest.id = setInterval(() => {
    state.rest.left--;
    paintRest();
    if (state.rest.left <= 0) {
      clearInterval(state.rest.id);
      $('#rt-label').textContent = doneMsg;
      setTimeout(hideRest, 2500);
    }
  }, 1000);
}

const startRest = (seconds) => startCountdown(seconds, 'Descanso', '¡Listo! Siguiente serie');

function paintRest() {
  $('#rt-num').textContent = Math.max(0, state.rest.left);
  $('#rt-label').textContent = state.rest.left > 0 ? `de ${state.rest.total} s` : '¡Listo!';
  const ratio = Math.max(0, state.rest.left) / state.rest.total;
  $('#rt-arc').style.strokeDashoffset = String(REST_CIRC * (1 - ratio));
}

function hideRest() {
  clearInterval(state.rest.id);
  $('#rest-timer').classList.remove('show');
}

/* ---------- Historial ---------- */

function renderHistory() {
  const finished = state.sessions.filter(s => s.finishedAt).sort((a, b) => b.startedAt - a.startedAt);
  $('#history-sub').textContent = finished.length
    ? `${finished.length} ${finished.length === 1 ? 'sesión completada' : 'sesiones completadas'}`
    : 'Aún sin entrenamientos';

  const slot = $('#history-slot');
  if (!finished.length) {
    slot.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9v6M18 9v6M3 10.5v3M21 10.5v3M6 12h12"/></svg>
        <p>Cuando termines tu primer entrenamiento<br />aparecerá aquí tu historial.</p>
      </div>`;
    return;
  }

  slot.innerHTML = `<div class="list-card">${finished.map(s => {
    const day = dayById(s.dayId);
    const p = sessionProgress(s);
    const dur = s.finishedAt ? fmtDuration(s.finishedAt - s.startedAt) : '';
    return `
      <button class="history-item" data-session="${esc(s.id)}" style="width:100%;background:none">
        <span class="hi-dot" style="background:var(--brand)"></span>
        <span class="hi-body">
          <strong>${esc(day?.title || 'Sesión')}</strong>
          <small>${fmtDate(s.startedAt, { weekday: 'short', day: 'numeric', month: 'short' })} · ${dur}</small>
        </span>
        <span class="hi-pct" style="color:${p.pct >= 80 ? 'var(--green)' : 'var(--text-2)'}">${p.pct}%</span>
      </button>`;
  }).join('')}</div>`;

  $$('.history-item').forEach(el => { el.onclick = () => showSessionDetail(el.dataset.session); });
}

function showSessionDetail(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  const day = dayById(s.dayId);
  if (!day) return toast('Esa sesión es de una rutina anterior');
  const p = sessionProgress(s);

  const rows = day.blocks.flatMap(b => b.movements.map(mv => {
    const vals = s.entries[mv.id] || [];
    const txt = mv.kind === 'weight'
      ? (vals.filter(v => typeof v === 'string' && v.trim()).join(' · ') || '—')
      : `${vals.filter(v => v === true).length}/${vals.length} ✓`;
    return `<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--stroke)">
        <span style="flex:1;font-size:14px">${esc(mv.name)}</span>
        <span style="font-size:13px;font-weight:700;color:var(--text-2);font-variant-numeric:tabular-nums">${esc(txt)}</span>
      </div>`;
  })).join('');

  openSheet(`
    <div class="grabber"></div>
    <h2>${esc(day.title)}</h2>
    <p>${fmtDate(s.startedAt)} · ${fmtDuration(s.finishedAt - s.startedAt)}</p>
    <div class="summary-grid">
      <div><b>${p.done}</b><span>Series</span></div>
      <div><b>${p.pct}%</b><span>Completado</span></div>
      <div><b>${esc(day.label.replace('Día ', 'D'))}</b><span>Rutina</span></div>
    </div>
    ${s.notes ? `<div class="block-note" style="margin-bottom:16px">${esc(s.notes)}</div>` : ''}
    <div style="margin-bottom:18px">${rows}</div>
    <button class="btn btn-danger" id="sheet-delete">Eliminar esta sesión</button>
    <button class="btn btn-ghost" id="sheet-close">Cerrar</button>
  `);

  $('#sheet-close').onclick = closeSheet;
  $('#sheet-delete').onclick = async () => {
    await db.deleteSession(id);
    state.sessions = state.sessions.filter(x => x.id !== id);
    closeSheet();
    renderHistory();
    renderHome();
    toast('Sesión eliminada');
  };
}

/** Aviso de cambio de rutina: aparece 14 días antes de la fecha del plan. */
function renderRoutineAlert() {
  const slot = $('#routine-alert');
  const target = new Date(PROFILE.routineChangeDate + 'T12:00:00').getTime();
  const days = Math.ceil((target - Date.now()) / 86400000);

  if (days > 14) { slot.innerHTML = ''; return; }

  const vencida = days <= 0;
  slot.innerHTML = `
    <button class="routine-alert${vencida ? ' due' : ''}" id="btn-routine-alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>
      <div>
        <strong>${vencida ? 'Toca cambiar de rutina' : `Cambio de rutina en ${days} ${days === 1 ? 'día' : 'días'}`}</strong>
        <small>${fmtDate(target, { day: 'numeric', month: 'long' })} · toca para importar el plan nuevo</small>
      </div>
      <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l6 6-6 6"/></svg>
    </button>`;
  $('#btn-routine-alert').onclick = openImportRoutine;
}

/* ---------- Notas del entrenamiento ---------- */

function updateNotesButton() {
  $('#btn-notes').classList.toggle('has-note', Boolean(state.session?.notes?.trim()));
}

function openNotes() {
  const current = state.session?.notes || '';
  openSheet(`
    <div class="grabber"></div>
    <h2>Nota del entrenamiento</h2>
    <p>Cómo te sentiste, molestias, qué máquina estaba ocupada… lo que te sirva al revisarlo después.</p>
    <textarea class="paste-area" id="note-area" style="min-height:110px" placeholder="Hoy dormí poco y bajé el peso en sentadilla…">${esc(current)}</textarea>
    <button class="btn btn-primary" id="note-save">Guardar</button>
    <button class="btn btn-ghost" id="note-cancel">Cancelar</button>
  `);
  $('#note-cancel').onclick = closeSheet;
  $('#note-save').onclick = async () => {
    state.session.notes = $('#note-area').value.trim();
    await saveSession(true);
    updateNotesButton();
    closeSheet();
    toast(state.session.notes ? 'Nota guardada' : 'Nota vacía');
  };
}

/* ---------- Historial de un ejercicio ---------- */

function openMovementHistory(movementId) {
  const found = findMovement(movementId);
  if (!found) return;
  const { movement, block } = found;
  const weighted = movement.kind === 'weight';

  const rows = state.sessions
    .filter(s => s.finishedAt && s.entries?.[movementId])
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(s => ({ at: s.startedAt, vals: s.entries[movementId] }))
    .filter(r => r.vals.some(v => v === true || (typeof v === 'string' && v.trim() !== '')));

  const nums = weighted
    ? rows.flatMap(r => r.vals.map(v => parseFloat(v)).filter(Number.isFinite))
    : [];
  const best = nums.length ? Math.max(...nums) : null;

  const body = rows.length
    ? rows.map(r => {
        const txt = weighted
          ? r.vals.map(v => (typeof v === 'string' && v.trim() ? v : '–')).join('  ·  ')
          : `${r.vals.filter(v => v === true).length}/${r.vals.length} completadas`;
        return `<div style="display:flex;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--stroke)">
            <span style="flex:none;width:78px;font-size:12.5px;color:var(--text-2);text-transform:capitalize">${fmtDate(r.at, { day: 'numeric', month: 'short' })}</span>
            <span style="flex:1;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums">${esc(txt)}</span>
          </div>`;
      }).join('')
    : '<p style="color:var(--text-3);font-size:13.5px;padding:14px 0">Todavía no has registrado este ejercicio.</p>';

  openSheet(`
    <div class="grabber"></div>
    <h2>${esc(movement.name)}</h2>
    <p>${esc(movement.reps)} · ${block.sets} ${block.sets === 1 ? 'serie' : 'series'}${movement.note ? ` · ${esc(movement.note)}` : ''}</p>
    ${best !== null ? `<div class="summary-grid">
        <div><b>${best}</b><span>Máximo</span></div>
        <div><b>${rows.length}</b><span>Sesiones</span></div>
        <div><b>${esc(String(rows[0]?.vals.filter(v => typeof v === 'string' && v.trim()).at(-1) ?? '—'))}</b><span>Último</span></div>
      </div>` : ''}
    <div style="margin-bottom:16px">${body}</div>
    <button class="btn btn-ghost" id="mh-close">Cerrar</button>
  `);
  $('#mh-close').onclick = closeSheet;
}

/* ---------- Rutina: carga, importación y editor ---------- */

const ROUTINE_ID = 'active';

async function loadRoutine() {
  const saved = (await db.allRoutines()).find(r => r.id === ROUTINE_ID);
  if (saved?.days?.length) {
    state.routine = sanitizeRoutine(saved.days);
    state.routineId = saved.id;
  } else {
    state.routine = DEFAULT_ROUTINE;
  }
}

async function saveRoutine(days, name) {
  const clean = sanitizeRoutine(days);
  if (!clean.length) throw new Error('La rutina quedó vacía');
  await db.putRoutine({ id: ROUTINE_ID, name: name || 'Mi rutina', days: clean, active: true });
  state.routine = clean;
  state.routineId = ROUTINE_ID;
}

function openImportRoutine() {
  openSheet(`
    <div class="grabber"></div>
    <h2>Importar rutina</h2>
    <ol class="steps">
      <li>Copia el texto del plan que te dio el coach (PDF, foto con Live Text o WhatsApp).</li>
      <li>Pégalo aquí abajo tal cual, sin acomodarlo.</li>
      <li>Lo interpreto y lo revisas en el editor antes de guardar.</li>
    </ol>
    <textarea class="paste-area" id="routine-paste" placeholder="Piso: DIA 1 Fuerza y potencia (tren inferior)&#10;1  Sentadilla en Smith  4  5 a 6&#10;2  Prensa + Goblet  3  8+12+15_7"></textarea>
    <button class="btn btn-primary" id="btn-parse-routine">Interpretar rutina</button>
    <button class="btn btn-ghost" id="btn-cancel-routine">Cancelar</button>
  `);
  $('#btn-cancel-routine').onclick = closeSheet;
  $('#btn-parse-routine').onclick = () => {
    const { days, warnings } = parseRoutineText($('#routine-paste').value);
    if (!days.length) return toast('No pude reconocer ningún día. Revisa el texto.');
    closeSheet();
    openEditor(days, warnings);
    toast(`${days.length} días interpretados · revísalos`);
  };
}

function openEditor(days, warnings = []) {
  state.draft = JSON.parse(JSON.stringify(days));
  state.draftWarnings = warnings;
  renderEditor();
  setView('editor');
}

function renderEditor() {
  const d = state.draft;
  const totalMv = d.reduce((a, day) => a + day.blocks.reduce((b, bl) => b + bl.movements.length, 0), 0);
  $('#ed-sub').textContent = `${d.length} días · ${totalMv} ejercicios`;

  const warn = state.draftWarnings?.length
    ? `<div class="notice warn" style="margin-bottom:4px">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v5M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg>
         <div>${state.draftWarnings.map(w => esc(w)).join('<br>')}</div>
       </div>`
    : '';

  $('#ed-body').innerHTML = warn + d.map((day, di) => `
    <div class="block">
      <div class="ed-day-head">
        <input class="ed-title" data-path="${di}.title" value="${esc(day.title)}" placeholder="Nombre del día" />
        <button class="ed-del" data-del-day="${di}" aria-label="Eliminar día">✕</button>
      </div>
      <input class="ed-sub" data-path="${di}.subtitle" value="${esc(day.subtitle || '')}" placeholder="Grupo muscular" />

      ${day.blocks.map((b, bi) => `
        <div class="ed-block">
          <div class="ed-block-head">
            <input class="ed-mini" data-path="${di}.${bi}.floor" value="${esc(b.floor || '')}" placeholder="Piso" />
            <input class="ed-mini" data-path="${di}.${bi}.sets" value="${b.sets}" inputmode="numeric" placeholder="Series" />
            <input class="ed-mini" data-path="${di}.${bi}.rest" value="${b.rest ?? ''}" inputmode="numeric" placeholder="Rest s" />
            <button class="ed-del" data-del-block="${di}.${bi}" aria-label="Eliminar bloque">✕</button>
          </div>
          ${b.movements.map((m, mi) => `
            <div class="ed-mv">
              <input class="ed-name" data-path="${di}.${bi}.${mi}.name" value="${esc(m.name)}" placeholder="Ejercicio" />
              <input class="ed-reps" data-path="${di}.${bi}.${mi}.reps" value="${esc(m.reps)}" placeholder="Reps" />
              <button class="ed-kind ${m.kind}" data-kind="${di}.${bi}.${mi}">${m.kind === 'weight' ? 'Peso' : 'Check'}</button>
              <button class="ed-del" data-del-mv="${di}.${bi}.${mi}" aria-label="Eliminar ejercicio">✕</button>
              <input class="ed-note" data-path="${di}.${bi}.${mi}.note" value="${esc(m.note || '')}" placeholder="Nota (opcional)" />
            </div>`).join('')}
          <button class="ed-add" data-add-mv="${di}.${bi}">+ Ejercicio</button>
        </div>`).join('')}

      <button class="ed-add" data-add-block="${di}">+ Bloque</button>
    </div>`).join('') + `
    <button class="btn btn-ghost" id="ed-add-day">+ Agregar día</button>`;

  bindEditor();
}

function bindEditor() {
  const draft = state.draft;
  const at = (path) => {
    const p = path.split('.');
    const day = draft[+p[0]];
    if (p.length === 2) return { obj: day, key: p[1] };
    const block = day.blocks[+p[1]];
    if (p.length === 3) return { obj: block, key: p[2] };
    return { obj: block.movements[+p[2]], key: p[3] };
  };

  $$('#ed-body input[data-path]').forEach(inp => {
    inp.addEventListener('input', () => {
      const { obj, key } = at(inp.dataset.path);
      if (key === 'sets' || key === 'rest') {
        const n = parseInt(inp.value, 10);
        obj[key] = Number.isFinite(n) ? n : (key === 'sets' ? 1 : undefined);
      } else {
        obj[key] = inp.value;
      }
    });
  });

  $$('#ed-body .ed-kind').forEach(btn => {
    btn.onclick = () => {
      const p = btn.dataset.kind.split('.');
      const mv = draft[+p[0]].blocks[+p[1]].movements[+p[2]];
      mv.kind = mv.kind === 'weight' ? 'check' : 'weight';
      btn.textContent = mv.kind === 'weight' ? 'Peso' : 'Check';
      btn.className = `ed-kind ${mv.kind}`;
    };
  });

  const rerender = () => renderEditor();

  $$('#ed-body [data-del-mv]').forEach(b => {
    b.onclick = () => {
      const p = b.dataset.delMv.split('.');
      draft[+p[0]].blocks[+p[1]].movements.splice(+p[2], 1);
      rerender();
    };
  });
  $$('#ed-body [data-del-block]').forEach(b => {
    b.onclick = () => {
      const p = b.dataset.delBlock.split('.');
      draft[+p[0]].blocks.splice(+p[1], 1);
      rerender();
    };
  });
  $$('#ed-body [data-del-day]').forEach(b => {
    b.onclick = async () => {
      const ok = await confirmSheet({
        title: 'Eliminar día', body: `Se quita "${draft[+b.dataset.delDay].title}" de la rutina.`,
        confirm: 'Eliminar', cancel: 'Cancelar', danger: true
      });
      if (!ok) return;
      draft.splice(+b.dataset.delDay, 1);
      rerender();
    };
  });
  $$('#ed-body [data-add-mv]').forEach(b => {
    b.onclick = () => {
      const p = b.dataset.addMv.split('.');
      draft[+p[0]].blocks[+p[1]].movements.push({ id: uid(), name: '', reps: '10', kind: 'weight' });
      rerender();
    };
  });
  $$('#ed-body [data-add-block]').forEach(b => {
    b.onclick = () => {
      draft[+b.dataset.addBlock].blocks.push({
        id: uid(), floor: null, sets: 3,
        movements: [{ id: uid(), name: '', reps: '10', kind: 'weight' }]
      });
      rerender();
    };
  });
  $('#ed-add-day').onclick = () => {
    const n = draft.length + 1;
    draft.push({
      id: `d${n}`, label: `Día ${n}`, title: `Entrenamiento ${n}`, subtitle: '',
      accent: DAY_ACCENTS[(n - 1) % DAY_ACCENTS.length],
      blocks: [{ id: uid(), floor: null, sets: 3, movements: [{ id: uid(), name: '', reps: '10', kind: 'weight' }] }]
    });
    rerender();
  };
}

/* ---------- Stats / InBody ---------- */

/** Atributos que se muestran como barras, medidos contra tu propio histórico. */
const ATTRS = [
  { key: 'smm', label: 'Músculo', better: 'up' },
  { key: 'pbf', label: 'Grasa corporal', better: 'down' },
  { key: 'tbw', label: 'Agua', better: 'up' },
  { key: 'protein', label: 'Proteína', better: 'up' },
  { key: 'bmr', label: 'Metabolismo', better: 'up' }
];

function renderBody() {
  const list = state.measures;
  $('#body-sub').textContent = list.length
    ? `${list.length} ${list.length === 1 ? 'medición registrada' : 'mediciones registradas'}`
    : 'Registra tu primer InBody';

  const slot = $('#body-slot');
  if (!list.length) {
    slot.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20v-6M12 20V5M18 20v-9"/></svg>
        <p>Toma la foto de tu hoja InBody,<br />copia el texto con Live Text y pégalo aquí.</p>
      </div>`;
    return;
  }

  const latest = list[list.length - 1];
  const prev = list[list.length - 2];

  const heroHtml = INBODY_FIELDS.filter(f => f.primary).map(f => {
    const v = latest.values[f.key];
    const p = prev?.values[f.key];
    let delta = '<div class="md flat">—</div>';
    if (v !== undefined && p !== undefined) {
      const d = +(v - p).toFixed(1);
      const cls = d === 0 ? 'flat' : (f.better === 'down' ? (d < 0 ? 'good' : 'bad') : (d > 0 ? 'good' : 'bad'));
      delta = `<div class="md ${cls}">${d > 0 ? '↑' : d < 0 ? '↓' : ''} ${Math.abs(d).toFixed(1)}${f.percent ? '%' : ''}</div>`;
    }
    return `<div class="metric">
        <div class="mv">${esc(formatValue(f.key, v))}</div>
        <div class="ml">${esc(f.label)}</div>
        ${delta}
      </div>`;
  }).join('');

  const attrsHtml = ATTRS.map(a => {
    const vals = list.map(m => m.values[a.key]).filter(Number.isFinite);
    const v = latest.values[a.key];
    if (v === undefined || vals.length < 2) return '';
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = (max - min) || 1;
    // La barra mide tu posición entre tu peor y tu mejor registro histórico.
    const raw = (v - min) / span;
    const pct = Math.round((a.better === 'down' ? 1 - raw : raw) * 100);
    const p = prev?.values[a.key];
    const d = p !== undefined ? +(v - p).toFixed(1) : null;
    const good = d === null || d === 0 ? 'flat' : (a.better === 'down' ? (d < 0 ? 'good' : 'bad') : (d > 0 ? 'good' : 'bad'));
    const color = good === 'good' ? 'var(--green)' : good === 'bad' ? 'var(--orange)' : 'var(--brand)';
    return `<div class="attr">
        <div class="attr-head">
          <span class="an">${esc(a.label)}</span>
          <span class="av">${esc(formatValue(a.key, v))}</span>
          ${d !== null ? `<span class="ad md ${good}">${d > 0 ? '+' : ''}${d}</span>` : ''}
        </div>
        <div class="attr-track"><div class="attr-fill" style="width:${Math.max(4, pct)}%;background:${color}"></div></div>
      </div>`;
  }).join('');

  const rest = INBODY_FIELDS.filter(f => !f.primary && latest.values[f.key] !== undefined).map(f =>
    `<div class="measure-row"><span class="mr-body"><strong style="text-transform:none">${esc(f.label)}</strong></span>
      <span style="font-size:16px;font-weight:700;font-variant-numeric:tabular-nums">${esc(formatValue(f.key, latest.values[f.key]))}</span></div>`
  ).join('');

  slot.innerHTML = `
    <div class="metric-hero">${heroHtml}</div>

    <h2 class="section-title">Evolución</h2>
    <div class="card chart-card">
      <div class="chart-chips">
        ${INBODY_FIELDS.filter(f => list.some(m => m.values[f.key] !== undefined)).slice(0, 6)
          .map(f => `<button class="chip${state.chartMetric === f.key ? ' on' : ''}" data-metric="${f.key}">${esc(f.label)}</button>`).join('')}
      </div>
      ${sparkline(state.chartMetric)}
    </div>

    ${attrsHtml ? `<h2 class="section-title">Atributos</h2>
    <div class="card attrs">
      ${attrsHtml}
      <p class="attr-note">La barra marca dónde estás hoy entre tu peor y tu mejor registro. El número de al lado es el cambio contra la medición anterior.</p>
    </div>` : ''}

    <h2 class="section-title">Última medición · ${fmtDate(latest.at, { day: 'numeric', month: 'long', year: 'numeric' })}</h2>
    <div class="list-card">${rest || '<div class="measure-row"><span class="mr-body"><small>Sin datos adicionales</small></span></div>'}</div>

    <h2 class="section-title">Todas las mediciones</h2>
    <div class="list-card">${list.slice().reverse().map(m => `
      <button class="measure-row" data-measure="${esc(m.id)}">
        <span class="mr-body">
          <strong>${fmtDate(m.at, { day: 'numeric', month: 'long', year: 'numeric' })}</strong>
          <small>${esc(formatValue('weight', m.values.weight))} · ${esc(formatValue('pbf', m.values.pbf))} grasa · ${esc(formatValue('smm', m.values.smm))} músculo</small>
        </span>
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="color:var(--text-3)"><path d="M1 1l6 6-6 6"/></svg>
      </button>`).join('')}</div>`;

  $$('.chip[data-metric]').forEach(c => {
    c.onclick = () => { state.chartMetric = c.dataset.metric; renderBody(); };
  });
  $$('.measure-row[data-measure]').forEach(r => {
    r.onclick = () => openMeasureSheet(state.measures.find(m => m.id === r.dataset.measure));
  });
}

function sparkline(key) {
  const pts = state.measures
    .filter(m => Number.isFinite(m.values[key]))
    .map(m => ({ x: m.at, y: m.values[key] }));

  if (pts.length < 2) {
    return `<p style="color:var(--text-3);font-size:13px;padding:22px 4px;text-align:center">
      Necesitas al menos 2 mediciones para ver la tendencia.</p>`;
  }

  const W = 300, H = 110, PAD_X = 16, PAD_TOP = 16, PAD_BOT = 24;
  const ys = pts.map(p => p.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = (max - min) || 1;
  const sx = i => PAD_X + (i / (pts.length - 1)) * (W - PAD_X * 2);
  const sy = v => PAD_TOP + (1 - (v - min) / span) * (H - PAD_TOP - PAD_BOT);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(pts.length - 1).toFixed(1)},${H - PAD_BOT} L${PAD_X},${H - PAD_BOT} Z`;

  const dots = pts.map((p, i) => `
    <circle class="dot" cx="${sx(i).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3"/>
    <text class="val" x="${sx(i).toFixed(1)}" y="${(sy(p.y) - 8).toFixed(1)}" text-anchor="middle">${esc(formatValue(key, p.y))}</text>
    <text class="lbl" x="${sx(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${new Date(p.x).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</text>`).join('');

  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="sparkgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      ${dots}
    </svg>`;
}

function measureFieldsHtml(values, parsedKeys = [], fixedKeys = []) {
  return `<div class="field-grid">${INBODY_FIELDS.map(f => {
    const cls = fixedKeys.includes(f.key) ? ' fixed' : (parsedKeys.includes(f.key) ? ' parsed' : '');
    return `
    <div class="field${cls}">
      <label for="fld-${f.key}">${esc(f.label)}${f.percent ? ' (%)' : ''}${fixedKeys.includes(f.key) ? ' · corregido' : ''}</label>
      <input id="fld-${f.key}" data-field="${f.key}" inputmode="decimal" autocomplete="off"
             value="${values[f.key] ?? ''}" placeholder="—" />
    </div>`;
  }).join('')}</div>`;
}

function checksHtml(values) {
  const checks = consistency(values);
  if (!checks.length) return '';
  return `<div class="checks">${checks.map(c => `
    <div class="check ${c.ok ? 'ok' : 'bad'}">
      <span class="ci">${c.ok ? '✓' : '!'}</span>
      <span class="cl">${esc(c.label)}</span>
      <span class="cv">${c.ok ? esc(String(c.actual)) : `${esc(String(c.actual))} ≠ ${esc(String(c.expected))}`}</span>
    </div>`).join('')}</div>`;
}

function openNewMeasure() {
  openSheet(`
    <div class="grabber"></div>
    <h2>Nueva medición</h2>
    <ol class="steps">
      <li>Abre la foto del InBody en <b>Fotos</b>.</li>
      <li>Toca el icono de texto (abajo a la derecha) → <b>Seleccionar todo</b> → <b>Copiar</b>.</li>
      <li>Pega aquí abajo y toca <b>Analizar</b>.</li>
    </ol>
    <textarea class="paste-area" id="paste-area" placeholder="Pega aquí el texto de la hoja InBody…"></textarea>
    <button class="btn btn-primary" id="btn-parse">Analizar texto</button>
    <button class="btn btn-ghost" id="btn-manual">Capturar a mano</button>
  `);
  $('#btn-parse').onclick = () => {
    const txt = $('#paste-area').value;
    if (!txt.trim()) return toast('Pega primero el texto');
    const lastHeight = state.measures.at(-1)?.values.height || PROFILE.height;
    const { values, at, missing, fixed } = parseInBody(txt, lastHeight);
    const found = INBODY_FIELDS.length - missing.length;
    if (!found) return toast('No reconocí ningún dato. Revisa el texto o captúralo a mano.');
    openMeasureForm({ at: at ?? Date.now(), values }, Object.keys(values), fixed);
    toast(fixed.length
      ? `${found}/${INBODY_FIELDS.length} datos · corregí ${fixed.map(k => fieldMeta(k).label).join(', ')}`
      : `${found} de ${INBODY_FIELDS.length} datos reconocidos`);
  };
  $('#btn-manual').onclick = () => openMeasureForm({ at: Date.now(), values: {} }, []);
}

function openMeasureForm(measure, parsedKeys, fixedKeys = []) {
  const dateStr = new Date(measure.at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  openSheet(`
    <div class="grabber"></div>
    <h2>${measure.id ? 'Editar medición' : 'Revisa los datos'}</h2>
    <p>Verde = detectado en el texto. Naranja = lo corregí porque no cuadraba con el resto.</p>
    <div id="checks-slot">${checksHtml(measure.values)}</div>
    <div class="field" style="margin-bottom:14px">
      <label for="fld-date">Fecha de la prueba</label>
      <input id="fld-date" type="date" value="${dateStr}" style="font-size:17px" />
    </div>
    ${measureFieldsHtml(measure.values, parsedKeys, fixedKeys)}
    <button class="btn btn-primary" id="btn-save-measure">Guardar medición</button>
    ${measure.id ? '<button class="btn btn-danger" id="btn-del-measure">Eliminar</button>' : ''}
    <button class="btn btn-ghost" id="btn-cancel-measure">Cancelar</button>
  `);

  const readValues = () => {
    const values = {};
    $$('#sheet input[data-field]').forEach(inp => {
      const raw = inp.value.replace(',', '.').trim();
      if (raw === '') return;
      const n = parseFloat(raw);
      if (Number.isFinite(n)) values[inp.dataset.field] = n;
    });
    return values;
  };

  $$('#sheet input[data-field]').forEach(inp => {
    inp.addEventListener('input', () => { $('#checks-slot').innerHTML = checksHtml(readValues()); });
  });

  $('#btn-cancel-measure').onclick = closeSheet;

  $('#btn-save-measure').onclick = async () => {
    const values = readValues();
    if (!Object.keys(values).length) return toast('Captura al menos un dato');

    const d = $('#fld-date').value;
    const at = d ? new Date(`${d}T12:00:00`).getTime() : measure.at;
    const sameDay = state.measures.find(m => m.id !== measure.id &&
      new Date(m.at).toDateString() === new Date(at).toDateString());
    if (sameDay) {
      const ok = await confirmSheet({
        title: 'Ya hay una medición ese día',
        body: 'Se reemplazará la que ya tenías con esa fecha.',
        confirm: 'Reemplazar', cancel: 'Cancelar'
      });
      if (!ok) return;
      await db.deleteMeasure(sameDay.id);
      state.measures = state.measures.filter(m => m.id !== sameDay.id);
    }

    const rec = { id: measure.id || uid(), at, values };
    await db.putMeasure(rec);
    state.measures = state.measures.filter(m => m.id !== rec.id).concat(rec).sort((a, b) => a.at - b.at);
    closeSheet();
    renderBody();
    toast('Medición guardada');
    sync.syncQuietly();
  };

  if (measure.id) {
    $('#btn-del-measure').onclick = async () => {
      await db.deleteMeasure(measure.id);
      state.measures = state.measures.filter(m => m.id !== measure.id);
      closeSheet();
      renderBody();
      toast('Medición eliminada');
    };
  }
}

function openMeasureSheet(measure) {
  if (!measure) return;
  openMeasureForm(measure, []);
}

/* ---------- Terminar sesión ---------- */

async function finishWorkout() {
  const s = state.session;
  const day = dayById(s.dayId);
  const p = sessionProgress(s);
  s.finishedAt = Date.now();
  await saveSession(true);
  state.session = null;

  openSheet(`
    <div class="grabber"></div>
    <h2>¡Entrenamiento cerrado!</h2>
    <p>${esc(day.label)} · ${esc(day.title)}</p>
    <div class="summary-grid">
      <div><b>${p.done}</b><span>Series</span></div>
      <div><b>${p.pct}%</b><span>Completado</span></div>
      <div><b>${fmtDuration(s.finishedAt - s.startedAt).replace(' min', '′').replace(' h ', 'h')}</b><span>Duración</span></div>
    </div>
    <button class="btn btn-primary" id="sheet-ok">Perfecto</button>
  `);
  $('#sheet-ok').onclick = () => { closeSheet(); setView('home'); renderHome(); renderHistory(); checkBackupReminder(); };
  sync.syncQuietly();
}

/* ---------- Hojas modales ---------- */

let sheetToken = 0;

function openSheet(html) {
  sheetToken++;
  $('#sheet').innerHTML = html;
  const backdrop = $('#sheet-backdrop');
  backdrop.inert = false;
  backdrop.classList.add('show');
}

function closeSheet() {
  const backdrop = $('#sheet-backdrop');
  if (!backdrop.classList.contains('show')) return;
  // Soltar el foco antes de ocultar: si no, queda atrapado en contenido invisible.
  if (backdrop.contains(document.activeElement)) document.activeElement.blur();
  backdrop.classList.remove('show');
  backdrop.inert = true;
  // Se vacía al terminar la animación: si no, los botones siguen en el DOM fuera de pantalla.
  const token = ++sheetToken;
  setTimeout(() => { if (token === sheetToken) $('#sheet').innerHTML = ''; }, 450);
}

function confirmSheet({ title, body, confirm, cancel, danger }) {
  return new Promise(resolve => {
    openSheet(`
      <div class="grabber"></div>
      <h2>${esc(title)}</h2>
      <p>${esc(body)}</p>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cf-yes">${esc(confirm)}</button>
      <button class="btn btn-ghost" id="cf-no">${esc(cancel)}</button>
    `);
    $('#cf-yes').onclick = () => { closeSheet(); resolve(true); };
    $('#cf-no').onclick = () => { closeSheet(); resolve(false); };
  });
}

/* ============================== Respaldo ============================== */

async function buildBackup() {
  return {
    app: 'gymtrack',
    version: 3,
    exportedAt: new Date().toISOString(),
    profile: PROFILE.name,
    sessions: state.sessions,
    measures: state.measures,
    routines: await db.allRoutines()
  };
}

async function exportBackup() {
  const data = JSON.stringify(await buildBackup(), null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `reawaken-respaldo-${stamp}.json`;
  const file = new File([data], filename, { type: 'application/json' });

  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Respaldo REAWAKEN' });
    } else {
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
    await db.setMeta('lastBackup', Date.now());
    renderSettings();
    toast('Respaldo generado');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('No se pudo exportar');
  }
}

async function importBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return toast('Archivo no válido');
  }
  if (parsed?.app !== 'gymtrack' || !Array.isArray(parsed.sessions)) {
    return toast('Ese archivo no es un respaldo de REAWAKEN');
  }

  const clean = parsed.sessions.filter(s =>
    s && typeof s.id === 'string' && typeof s.dayId === 'string' &&
    Number.isFinite(s.startedAt) && s.entries && typeof s.entries === 'object'
  ).map(s => ({ ...s, notes: typeof s.notes === 'string' ? s.notes : '' }));
  const cleanMeasures = (Array.isArray(parsed.measures) ? parsed.measures : []).filter(m =>
    m && typeof m.id === 'string' && Number.isFinite(m.at) && m.values && typeof m.values === 'object'
  );
  const cleanRoutines = (Array.isArray(parsed.routines) ? parsed.routines : []).filter(r =>
    r && typeof r.id === 'string' && Array.isArray(r.days) && r.days.length
  );
  if (!clean.length && !cleanMeasures.length && !cleanRoutines.length) return toast('El respaldo está vacío');

  const ok = await confirmSheet({
    title: 'Importar respaldo',
    body: `Se fusionarán ${clean.length} sesiones, ${cleanMeasures.length} mediciones${cleanRoutines.length ? ' y tu rutina guardada' : ''} con lo que ya tienes. Lo que coincida por id se sobrescribe.`,
    confirm: 'Importar',
    cancel: 'Cancelar'
  });
  if (!ok) return;

  for (const s of clean) await db.putSession(s);
  for (const m of cleanMeasures) await db.putMeasure(m);
  for (const r of cleanRoutines) await db.putRoutine({ ...r, days: sanitizeRoutine(r.days) });
  await loadAll();
  await loadRoutine();
  renderHome(); renderBody(); renderHistory(); renderSettings();
  toast('Respaldo importado');
}

async function checkBackupReminder() {
  const finished = state.sessions.filter(s => s.finishedAt).length;
  if (finished < 3) return;
  const last = await db.getMeta('lastBackup');
  const days = last ? (Date.now() - last) / 86400000 : Infinity;
  if (days > 14) toast('Han pasado 2 semanas sin respaldo · Ajustes → Exportar');
}

/* ---------- Sincronización ---------- */

async function renderSync() {
  const st = sync.status();
  const slot = $('#sync-slot');
  const last = await db.getMeta('lastSync');

  if (!st.configured) {
    slot.innerHTML = `<div class="list-card">
      <button class="list-row" id="btn-sync-setup">
        <div class="lr-icon" style="background:color-mix(in srgb, #0A84FF 22%, transparent);color:#0A84FF">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 01-9 9 9 9 0 01-7.6-4.2M3 12a9 9 0 019-9 9 9 0 017.6 4.2"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>
        </div>
        <div class="lr-body"><strong>Conectar Supabase</strong><small>Para que tus datos vivan también en la nube</small></div>
        <svg class="chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l6 6-6 6"/></svg>
      </button>
    </div>`;
    $('#btn-sync-setup').onclick = openSyncSetup;
    return;
  }

  if (!st.signedIn) {
    slot.innerHTML = `<div class="list-card">
      <button class="list-row" id="btn-sync-login">
        <div class="lr-icon" style="background:color-mix(in srgb, #FF9F0A 22%, transparent);color:#FF9F0A">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>
        </div>
        <div class="lr-body"><strong>Iniciar sesión</strong><small>Supabase conectado, falta tu cuenta</small></div>
        <svg class="chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l6 6-6 6"/></svg>
      </button>
      <button class="list-row" id="btn-sync-forget">
        <div class="lr-body"><strong>Desconectar Supabase</strong><small>Olvidar la URL y la clave</small></div>
      </button>
    </div>`;
    $('#btn-sync-login').onclick = openSyncLogin;
    $('#btn-sync-forget').onclick = forgetSync;
    return;
  }

  slot.innerHTML = `<div class="list-card">
    <button class="list-row" id="btn-sync-now">
      <div class="lr-icon" style="background:color-mix(in srgb, #30D158 22%, transparent);color:#30D158">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 01-9 9 9 9 0 01-7.6-4.2M3 12a9 9 0 019-9 9 9 0 017.6 4.2"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>
      </div>
      <div class="lr-body"><strong>Sincronizar ahora</strong><small>${last ? `Última vez: ${fmtDate(last, { day: 'numeric', month: 'short' })} ${new Date(last).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}` : 'Nunca'}</small></div>
      <svg class="chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l6 6-6 6"/></svg>
    </button>
    <div class="list-row">
      <div class="lr-body"><strong>Sesión</strong><small>${esc(st.email || '')}</small></div>
    </div>
    <button class="list-row" id="btn-sync-logout">
      <div class="lr-body"><strong style="color:#FF453A">Cerrar sesión</strong><small>Los datos locales se quedan en el teléfono</small></div>
    </button>
  </div>`;

  $('#btn-sync-now').onclick = async () => {
    toast('Sincronizando…');
    try {
      const r = await sync.syncAll();
      await loadAll();
      await loadRoutine();
      renderHome(); renderBody(); renderHistory(); renderSettings();
      toast(`Listo · ${r.pulled} bajadas, ${r.pushed} subidas`);
    } catch (e) {
      toast(e.message);
    }
  };
  $('#btn-sync-logout').onclick = async () => {
    await sync.signOut();
    renderSettings();
    toast('Sesión cerrada');
  };
}

function openSyncSetup() {
  openSheet(`
    <div class="grabber"></div>
    <h2>Conectar Supabase</h2>
    <p>En tu proyecto: <b>Project Settings → Data API</b> para la URL, y <b>API Keys</b> para la clave. Antes corre el archivo <b>sql/schema.sql</b> en el SQL Editor.</p>
    <div class="field" style="margin-bottom:10px">
      <label for="sb-url">Project URL</label>
      <input id="sb-url" placeholder="https://xxxxx.supabase.co" autocapitalize="off" autocorrect="off" spellcheck="false" style="font-size:15px" />
    </div>
    <div class="field" style="margin-bottom:16px">
      <label for="sb-key">Publishable key</label>
      <input id="sb-key" placeholder="sb_publishable_…" autocapitalize="off" autocorrect="off" spellcheck="false" style="font-size:15px" />
    </div>
    <button class="btn btn-primary" id="sb-save">Guardar</button>
    <button class="btn btn-ghost" id="sb-cancel">Cancelar</button>
  `);
  $('#sb-cancel').onclick = closeSheet;
  $('#sb-save').onclick = async () => {
    try {
      await sync.saveConfig($('#sb-url').value, $('#sb-key').value);
      closeSheet();
      renderSettings();
      openSyncLogin();
    } catch (e) {
      toast(e.message);
    }
  };
}

function openSyncLogin() {
  openSheet(`
    <div class="grabber"></div>
    <h2>Tu cuenta</h2>
    <p>Usa el mismo correo en todos tus dispositivos para que compartan los datos.</p>
    <div class="field" style="margin-bottom:10px">
      <label for="sb-email">Correo</label>
      <input id="sb-email" type="email" autocapitalize="off" autocorrect="off" spellcheck="false" style="font-size:16px" />
    </div>
    <div class="field" style="margin-bottom:16px">
      <label for="sb-pass">Contraseña</label>
      <input id="sb-pass" type="password" autocomplete="current-password" style="font-size:16px" />
    </div>
    <button class="btn btn-primary" id="sb-login">Entrar</button>
    <button class="btn btn-ghost" id="sb-signup">Crear cuenta</button>
    <button class="btn btn-ghost" id="sb-cancel2">Cancelar</button>
  `);
  $('#sb-cancel2').onclick = closeSheet;

  const run = async (fn, okMsg) => {
    const email = $('#sb-email').value.trim();
    const pass = $('#sb-pass').value;
    if (!email || !pass) return toast('Falta correo o contraseña');
    try {
      await fn(email, pass);
      closeSheet();
      renderSettings();
      toast(okMsg);
      if (sync.status().signedIn) {
        const r = await sync.syncAll();
        await loadAll(); await loadRoutine();
        renderHome(); renderBody(); renderHistory();
        toast(`Sincronizado · ${r.pulled} bajadas, ${r.pushed} subidas`);
      }
    } catch (e) {
      toast(e.message);
    }
  };

  $('#sb-login').onclick = () => run(sync.signIn, 'Sesión iniciada');
  $('#sb-signup').onclick = () => run(sync.signUp, 'Cuenta creada');
}

async function forgetSync() {
  const ok = await confirmSheet({
    title: 'Desconectar Supabase',
    body: 'Se olvidan la URL, la clave y tu sesión. Los datos locales no se tocan.',
    confirm: 'Desconectar', cancel: 'Cancelar', danger: true
  });
  if (!ok) return;
  await sync.forgetConfig();
  renderSettings();
}

/* ---------- Ajustes ---------- */

async function renderSettings() {
  const notice = $('#storage-notice');
  const standalone = isStandalone();
  const { persisted } = await requestPersistence();

  if (!standalone) {
    notice.innerHTML = `<div class="notice warn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v5M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg>
      <div><b>Instálala en la pantalla de inicio.</b> En Safari toca Compartir → «Añadir a pantalla de inicio». Así iOS deja de borrar los datos tras 7 días sin abrirla.</div>
    </div>`;
  } else {
    notice.innerHTML = `<div class="notice ok">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
      <div>Instalada en la pantalla de inicio${persisted ? ' y con almacenamiento persistente' : ''}. Aun así, exporta un respaldo de vez en cuando.</div>
    </div>`;
  }

  const last = await db.getMeta('lastBackup');
  $('#last-backup').textContent = last
    ? `Último respaldo: ${fmtDate(last, { day: 'numeric', month: 'long', year: 'numeric' })}`
    : 'Nunca has respaldado. Hazlo ahora.';

  const est = await storageEstimate();
  const finished = state.sessions.filter(s => s.finishedAt).length;
  const plural = `${finished} ${finished === 1 ? 'sesión' : 'sesiones'}`;
  const meas = `${state.measures.length} ${state.measures.length === 1 ? 'medición' : 'mediciones'}`;
  $('#storage-info').textContent = est
    ? `${plural} · ${meas} · ${(est.usage / 1024).toFixed(0)} KB usados`
    : `${plural} · ${meas}`;

  $('#routine-change').textContent = new Date(PROFILE.routineChangeDate + 'T12:00:00')
    .toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

  const mv = state.routine.reduce((a, d) => a + d.blocks.reduce((b, bl) => b + bl.movements.length, 0), 0);
  $('#routine-summary').textContent = `${state.routine.length} días · ${mv} ejercicios`;

  applyTheme(state.theme);
  await renderSync();
}

/* ============================== Arranque ============================== */

async function loadAll() {
  // Los registros con `deletedAt` son lápidas para sincronizar: no se muestran.
  state.sessions = ((await db.allSessions()) || []).filter(s => !s.deletedAt);
  state.measures = ((await db.allMeasures()) || []).filter(m => !m.deletedAt).sort((a, b) => a.at - b.at);
  state.session = state.sessions.find(s => !s.finishedAt) || null;
}

/** Carga las mediciones InBody que ya existían antes de la app (solo la primera vez). */
async function seedMeasures() {
  if (await db.getMeta('measuresSeeded')) return;
  try {
    const res = await fetch('data/seed-measures.json');
    if (!res.ok) return;
    const data = await res.json();
    for (const m of data.measures || []) {
      await db.putMeasure({ id: m.id, at: new Date(m.at).getTime(), values: m.values });
    }
    await db.setMeta('measuresSeeded', true);
    state.measures = ((await db.allMeasures()) || []).sort((a, b) => a.at - b.at);
  } catch {
    // Sin red y sin caché: se puede capturar a mano más tarde.
  }
}

function bindGlobal() {
  $$('.tab').forEach(t => {
    t.onclick = () => {
      const v = t.dataset.view;
      setView(v);
      if (v === 'home') renderHome();
      if (v === 'body') renderBody();
      if (v === 'history') renderHistory();
      if (v === 'settings') renderSettings();
    };
  });

  $('#btn-back').onclick = () => { setView('home'); renderHome(); };

  $('#btn-timer').onclick = () => startRest(state.rest.total || 45);
  $('#btn-notes').onclick = openNotes;
  $('#rt-close').onclick = hideRest;
  $$('.rt-chip[data-rest]').forEach(b => { b.onclick = () => startRest(+b.dataset.rest); });
  $('#btn-finish').onclick = async () => {
    const p = sessionProgress(state.session);
    if (p.done === 0) return toast('Aún no registras ninguna serie');
    if (p.pct < 100) {
      const ok = await confirmSheet({
        title: '¿Terminar ya?',
        body: `Llevas ${p.done} de ${p.total} series (${p.pct}%). Se guardará tal cual.`,
        confirm: 'Terminar', cancel: 'Seguir entrenando'
      });
      if (!ok) return;
    }
    finishWorkout();
  };

  $('#btn-discard').onclick = async () => {
    const ok = await confirmSheet({
      title: 'Descartar sesión',
      body: 'Se borrará todo lo que registraste en esta sesión. No se puede deshacer.',
      confirm: 'Descartar', cancel: 'Cancelar', danger: true
    });
    if (!ok) return;
    await db.deleteSession(state.session.id);
    state.sessions = state.sessions.filter(s => s.id !== state.session.id);
    state.session = null;
    setView('home'); renderHome();
    toast('Sesión descartada');
  };

  $('#btn-export').onclick = exportBackup;
  $('#btn-import').onclick = () => $('#file-input').click();

  $('#btn-edit-routine').onclick = () => openEditor(state.routine, []);
  $('#btn-import-routine').onclick = openImportRoutine;
  $('#btn-reset-routine').onclick = async () => {
    const ok = await confirmSheet({
      title: 'Restaurar rutina original',
      body: 'Vuelve la rutina del PDF de Anderson. Tu historial de entrenamientos no se borra.',
      confirm: 'Restaurar', cancel: 'Cancelar'
    });
    if (!ok) return;
    await saveRoutine(DEFAULT_ROUTINE, 'Rutina Anderson');
    renderHome(); renderSettings();
    toast('Rutina restaurada');
  };

  $('#ed-cancel').onclick = async () => {
    const ok = await confirmSheet({
      title: 'Salir sin guardar', body: 'Se pierden los cambios de la rutina.',
      confirm: 'Salir', cancel: 'Seguir editando', danger: true
    });
    if (!ok) return;
    state.draft = null;
    setView('settings'); renderSettings();
  };

  $('#ed-save').onclick = async () => {
    try {
      await saveRoutine(state.draft, 'Mi rutina');
      state.draft = null;
      setView('home'); renderHome();
      sync.syncQuietly();
      toast('Rutina guardada');
    } catch (e) {
      toast(e.message);
    }
  };
  $('#file-input').onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importBackup(f);
  };

  $('#btn-wipe').onclick = async () => {
    const ok = await confirmSheet({
      title: 'Borrar todo',
      body: 'Se eliminarán todas tus sesiones y mediciones de este dispositivo. Exporta un respaldo antes si no quieres perderlas.',
      confirm: 'Sí, borrar todo', cancel: 'Cancelar', danger: true
    });
    if (!ok) return;
    await db.clearSessions();
    await db.clearMeasures();
    state.sessions = []; state.session = null; state.measures = [];
    renderHome(); renderBody(); renderHistory(); renderSettings();
    toast('Datos borrados');
  };

  $('#btn-add-measure').onclick = openNewMeasure;

  $$('#theme-seg button').forEach(b => {
    b.onclick = () => setTheme(b.dataset.themeOpt);
  });

  $('#sheet-backdrop').onclick = (e) => { if (e.target.id === 'sheet-backdrop') closeSheet(); };

  // Guardado defensivo al salir de la app (iOS puede matarla en segundo plano)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSession(true);
  });
  window.addEventListener('pagehide', () => saveSession(true));

  setInterval(() => { if (state.view === 'workout' && state.session) updateWorkoutHeader(); }, 30000);
}

async function init() {
  await loadAll();
  await loadRoutine();
  applyTheme((await db.getMeta('theme')) || 'auto');
  await seedMeasures();
  bindGlobal();
  renderHome();
  requestPersistence();
  checkBackupReminder();

  sync.loadConfig().then(() => sync.syncQuietly().then(async r => {
    if (!r || (!r.pulled && !r.pushed)) return;
    await loadAll();
    await loadRoutine();
    renderHome();
  }));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
