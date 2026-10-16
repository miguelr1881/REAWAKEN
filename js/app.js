import { DEFAULT_ROUTINE, PROFILE, totalSets } from './routine.js';
import { db, requestPersistence, storageEstimate } from './db.js';
import { prepareBackup, backupActiveRoutines } from './backup.js';
import { INBODY_FIELDS, parseInBody, formatValue, consistency, fieldMeta } from './inbody.js';
import { parseRoutineText, sanitizeRoutine, DAY_ACCENTS } from './routine-parser.js';
import { extractRoutinePdf } from './routine-pdf.js';
import { EXERCISE_CATALOG } from './exercise-catalog.js';
import * as sync from './sync.js';
import { MUSCLE_GROUPS, exerciseFocus, exerciseGroups, imageSearchUrl, muscleAtlas, dayFocus } from './exercise-info.js';
import { EMPTY_PROFILE, normalizeProfile, validProfileDate, monthlyInBody, validatePersonalProfile } from './profile.js';
import { sessionDuration, trainingAchievements } from './progress.js';
import { enterView, resizeContent, disclose, bindDisclosures } from './motion.js';
import { createTrainingUI } from './training-ui.js';
import { equipmentChoice, setRecord, comparisonKey, personalBestForSet, normalizeExercise } from './intelligence.js';
import { correctSessionWeight, movementLoadHistory } from './session-history.js';
import { trainingPreferences, createScreenWakeLock } from './training-preferences.js';
import { sessionPersonalRecords } from './personal-records.js';
import { generateRoutine } from './routine-generator.js';

const APP_VERSION = '2.9.2';

/* ============================== Estado ============================== */

const state = {
  view: 'home',
  routine: DEFAULT_ROUTINE,   // rutina activa
  routineId: null,
  routines: [],               // catálogo local de rutinas guardadas
  routineRevisions: new Map(),
  routineConflict: false,
  activeRoutineId: null,
  exercises: [],
  profile: normalizeProfile(),
  personalProfile: undefined,
  session: null,              // sesión activa (finishedAt === null)
  sessions: [],               // historial completo
  measures: [],               // mediciones InBody
  draft: null,                // rutina en edición
  edDay: 0,                   // día visible en el editor
  edDirty: false,             // el borrador tiene cambios sin guardar
  draftRoutineId: null,
  draftBaseline: null,
  draftGeneration: null,
  draftRoutineName: '',
  draftActivate: true,
  draftSource: 'manual',
  theme: 'auto',
  chartMetric: 'pbf',
  viewScroll: {},
  restSeconds: 45,
  keepScreenAwake: false,
  wakeLockStatus: 'inactive',
  sessionSaveStatus: 'saved',
  multimediaAudio: false,
  rest: { id: null, left: 0, total: 45 }
};

const dayById = (id) => state.routine.find(d => d.id === id);
const sessionDay = session => session?.routineSnapshot || dayById(session?.dayId);
const recordedSet = value => value === true || (typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value)));

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

const screenWakeLock = createScreenWakeLock(
  () => state.keepScreenAwake && state.view === 'workout' && Boolean(state.session),
  status => {
    state.wakeLockStatus = status;
    if ($('#wake-support')) $('#wake-support').textContent = wakeLockDescription();
  }
);

const trainingUI = createTrainingUI({
  state, dayFor: sessionDay, esc, openSheet, closeSheet, saveSession, startRest,
  onSaveError: warnSessionSave,
  onRecordChange: movementId => updatePersonalRecords(movementId),
  redraw: () => { const scroll = window.scrollY; renderBlocks(sessionDay(state.session)); updateWorkoutHeader(); window.scrollTo(0, scroll); },
  showSession: showSessionDetail
});

/* ============================== Utilidades ============================== */

function fmtDate(ts, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Date(ts).toLocaleDateString('es-MX', opts);
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function toastCopy(msg) {
  const copy = document.createElement('span');
  copy.className = 'toast-copy';
  const parts = String(msg).split(/\s+·\s+/);
  if (parts.length > 1) {
    const title = document.createElement('strong');
    title.textContent = parts.shift();
    const detail = document.createElement('span');
    detail.className = 'toast-text';
    detail.textContent = parts.join(' · ');
    copy.append(title, detail);
  } else {
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = msg;
    copy.append(text);
  }
  return copy;
}

/** `action` opcional: `{ label, fn }` pinta un botón dentro del toast (deshacer). */
function toast(msg, action = null, duration = action ? 10000 : 6500, dismissible = true) {
  const el = $('#toast');
  const dismiss = () => {
    clearTimeout(el._t);
    el.inert = true;
    el.classList.remove('show', 'has-action', 'dismissible');
    el.replaceChildren();
  };
  el.inert = false;
  el.replaceChildren(toastCopy(msg));
  el.classList.toggle('has-action', !!action);
  el.classList.toggle('dismissible', dismissible);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { dismiss(); action.fn(); };
    el.append(btn);
  }
  if (dismissible) {
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.setAttribute('aria-label', 'Cerrar aviso');
    close.title = 'Cerrar aviso';
    close.onclick = dismiss;
    el.append(close);
  }
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(dismiss, duration);
}

function haptic() {
  // iOS ignora vibrate; el feedback visual va por CSS. Se mantiene por compatibilidad Android.
  navigator.vibrate?.(8);
}

function freezeControls(controls) {
  const previous = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  return () => controls.forEach((control, index) => { control.disabled = previous[index]; });
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
  $('#meta-theme-color').setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  $('#meta-status-bar').setAttribute('content', light ? 'default' : 'black-translucent');
  // Espejo en localStorage para poder aplicar el tema antes de pintar en el siguiente arranque.
  try { localStorage.setItem('theme', pref); } catch { /* modo privado */ }
  $$('#theme-seg button').forEach(button => {
    const selected = button.dataset.themeOpt === pref;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

let confirmedTheme = 'auto', themeRevision = 0, themeQueue = Promise.resolve();

async function setTheme(pref) {
  if (!['auto', 'dark', 'light'].includes(pref)) {
    console.error('Preferencia de tema no válida.');
    toast('No se pudo aplicar ese tema.');
    return false;
  }
  const revision = ++themeRevision;
  applyTheme(pref);
  const writing = themeQueue.then(() => db.setMeta('theme', pref));
  themeQueue = writing.then(() => undefined, () => undefined);
  try {
    await writing;
    confirmedTheme = pref;
    return true;
  } catch (error) {
    console.error('No se pudo guardar el tema.', error);
    if (revision === themeRevision) {
      applyTheme(confirmedTheme);
      toast('No se pudo guardar el tema. Se conservó el anterior; vuelve a intentarlo.');
    }
    return false;
  }
}

prefersLight.addEventListener('change', () => { if (state.theme === 'auto') applyTheme('auto'); });

/* ============================== Sesiones ============================== */

function newSession(dayId) {
  state.workoutScroll = 0;
  const day = dayById(dayId);
  const entries = {};
  entries._cycle = { id: day.cycleId || 'legacy', name: day.cycleName || 'Historial sin ciclo' };
  for (const block of day.blocks) {
    for (const mv of block.movements) {
      entries[mv.id] = Array.from({ length: block.sets }, () => (mv.kind === 'weight' ? '' : false));
    }
  }
  return { id: uid(), dayId, routineSnapshot: JSON.parse(JSON.stringify(day)), startedAt: Date.now(), finishedAt: null, notes: '', entries };
}

function updatePersonalRecords(movementId, celebrate = false) {
  const movement = sessionDay(state.session)?.blocks.flatMap(block => block.movements).find(item => item.id === movementId);
  if (!movement) return;
  for (const cell of $$('#blocks .set[data-mid]').filter(item => item.dataset.mid === movementId)) {
    const index = Number(cell.dataset.idx);
    const best = personalBestForSet(state.session, movement, index, state.sessions, sessionDay);
    const value = state.session.entries[movementId]?.[index];
    const isPr = best !== null && recordedSet(value) && Number(value) > best;
    if (celebrate && isPr && !cell.classList.contains('pr')) toast(`¡Récord! Tu mejor con estas reps era ${best}`);
    cell.dataset.best = best ?? '';
    cell.classList.toggle('pr', isPr);
  }
}

function sessionProgress(session) {
  const day = sessionDay(session);
  if (!day) return { done: 0, total: 0, pct: 0 };
  let done = 0;
  const total = totalSets(day);
  // Se cuenta contra la rutina actual: una sesión vieja puede traer ejercicios que ya no existen.
  for (const block of day.blocks) {
    for (const mv of block.movements) {
      const arr = session.entries[mv.id] || [];
      for (let i = 0; i < block.sets; i++) {
        const v = arr[i];
        if (recordedSet(v)) done++;
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
function warnSessionSave(error) {
  console.error('No se pudo guardar el entrenamiento.', error);
  toast('No se pudo guardar. Tus cambios siguen en pantalla; vuelve a intentarlo antes de cerrar la app.');
}

let saveQueue = Promise.resolve(), saveRevision = 0, discardingSessionId = null;
function updateSaveStatus() {
  const label = $('#session-save-status');
  if (!label) return;
  const cloud = sync.status();
  const text = state.sessionSaveStatus === 'saving' ? 'Guardando…' : state.sessionSaveStatus === 'error' ? 'Sin guardar' :
    !navigator.onLine ? 'Guardado aquí · sin conexión' :
    cloud.configured && cloud.signedIn ? 'Guardado aquí · nube pendiente' : 'Guardado en este dispositivo';
  if (label.textContent !== text) label.textContent = text;
  $('#workout-save').dataset.state = state.sessionSaveStatus;
  $('#retry-session-save').hidden = state.sessionSaveStatus !== 'error';
  const summary = $('#summary-save-status');
  if (summary) summary.textContent = cloud.syncing ? 'Guardado aquí · sincronizando registros…' :
    cloud.error ? 'Guardado aquí · revisa la sincronización en Ajustes.' : 'Guardado en este dispositivo.';
}

function saveSession(immediate = false) {
  if (!state.session || state.session.id === discardingSessionId) return;
  clearTimeout(saveTimer);
  const session = state.session;
  const revision = ++saveRevision;
  state.sessionSaveStatus = 'saving';
  updateSaveStatus();
  const doSave = async () => {
    try {
      const snapshot = structuredClone(session);
      const writing = saveQueue.then(() => db.putSession(snapshot));
      // La cola continúa tras un fallo; writing conserva el rechazo para el formulario.
      saveQueue = writing.then(() => undefined, () => undefined);
      await writing;
      const i = state.sessions.findIndex(s => s.id === snapshot.id);
      if (i >= 0) state.sessions[i] = snapshot;
      else state.sessions.push(snapshot);
      if (revision === saveRevision) state.sessionSaveStatus = 'saved';
    } catch (error) {
      if (revision === saveRevision) state.sessionSaveStatus = 'error';
      throw error;
    } finally {
      updateSaveStatus();
    }
  };
  if (immediate) return doSave();
  saveTimer = setTimeout(() => doSave().catch(warnSessionSave), 350);
}

/** Última sesión terminada que registró este movimiento, para mostrar referencia. */
function lastPerformance(movementId, excludeId) {
  const movement = sessionDay(state.session)?.blocks.flatMap(block => block.movements).find(item => item.id === movementId);
  if (!movement) return null;
  const choice = equipmentChoice(state.session, movement);
  const prev = state.sessions
    .filter(s => s.finishedAt && s.id !== excludeId && s.entries?.[movementId])
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const s of prev) {
    const original = sessionDay(s)?.blocks.flatMap(block => block.movements).find(item => item.id === movementId);
    if (!original || original.name !== movement.name || original.reps !== movement.reps) continue;
    const vals = s.entries[movementId].map((value, index) => {
      if (typeof value !== 'string' || !recordedSet(value)) return null;
      const record = setRecord(s, movementId, index);
      const compatible = record ? comparisonKey(movement, choice) === comparisonKey(original, record) : !s.entries?._training && choice.variant === 'original' && choice.label === 'Habitual' && choice.unit === 'escala';
      return compatible ? value : null;
    });
    if (vals.some(value => value !== null)) return { values: vals, at: s.startedAt };
  }
  return null;
}

/* ============================== Vistas ============================== */

function setView(name) {
  const previousView = state.view;
  state.viewScroll[state.view] = window.scrollY;
  if (state.view === 'workout' && name !== 'workout') state.workoutScroll = window.scrollY;
  state.view = name;
  const fullscreen = name === 'workout' || name === 'editor';
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((tab, index) => {
    const selected = tab.dataset.view === name;
    tab.classList.toggle('active', selected);
    if (selected) {
      tab.setAttribute('aria-current', 'page');
      $('#tabbar').style.setProperty('--nav-index', index);
    } else tab.removeAttribute('aria-current');
  });
  $('#tabbar').style.display = fullscreen ? 'none' : 'flex';
  document.body.classList.toggle('in-workout', fullscreen);
  closeSheet();
  if (name !== 'workout') hideRest();
  window.scrollTo({ top: name === 'workout' ? state.workoutScroll || 0 : state.viewScroll[name] || 0 });
  if (name !== previousView) enterView($(`#view-${name}`), 0);
  screenWakeLock.update();
}

/* ---------- Home ---------- */

function renderHome() {
  $('#today-date').textContent = fmtDate(Date.now());

  const h = new Date().getHours();
  const greeting = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  const firstName = state.profile.name.trim().split(/\s+/)[0];
  $('#greeting').textContent = firstName ? `${greeting}, ${firstName}` : greeting;
  $('#coach-credit').textContent = [state.profile.sport, state.profile.coach ? `Coach: ${state.profile.coach}` : ''].filter(Boolean).join(' · ');
  renderInBodyReminder();

  const finished = state.sessions.filter(s => s.finishedAt);
  const unlocked = achievementState().badges.filter(badge => badge.unlocked).length;
  $('#btn-achievements').setAttribute('aria-label', `Logros: ${unlocked} desbloqueados`);
  $('#stat-week').textContent = `${finished.filter(s => s.startedAt >= weekStart(Date.now())).length}/${state.profile.daysPerWeek}`;
  $('#stat-total').textContent = finished.length;
  $('#stat-streak').textContent = calcWeekStreak(finished);
  $('#stat-streak').parentElement.title = `Racha: semanas con al menos ${state.profile.daysPerWeek} sesiones`;
  const activeName = activeRoutineRecord()?.name;
  $('#routine-heading').textContent = `${activeName || 'Tu rutina'} · ${plural(state.routine.length, 'día', 'días')}`;
  const today = new Date().toDateString();
  $('#week-strip').innerHTML = ['L', 'K', 'M', 'J', 'V', 'S', 'D'].map((label, index) => {
    const date = new Date(weekStart(Date.now()));
    date.setDate(date.getDate() + index);
    const done = finished.some(session => new Date(session.startedAt).toDateString() === date.toDateString());
    return `<div class="week-day${done ? ' done' : ''}${date.toDateString() === today ? ' today' : ''}" aria-label="${esc(fmtDate(date))}${done ? ', entrenado' : ''}"><span>${label}</span><b>${done ? '✓' : date.getDate()}</b></div>`;
  }).join('');

  // Banner de sesión en curso
  const slot = $('#resume-slot');
  if (state.session) {
    const day = sessionDay(state.session);
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
  const next = dayById(nextDayId);
  const focus = next ? dayFocus(next) : [];
  $('#next-slot').innerHTML = !state.session && next ? `
    <section class="next-workout">
      <div class="next-kicker">Siguiente sesión · ${esc(next.label)}</div>
      <div class="next-main"><div class="next-copy"><h2>${esc(next.title)}</h2>
      <p>${esc(next.subtitle)}</p>
      <div class="next-numbers"><strong>${next.blocks.reduce((count, block) => count + block.movements.length, 0)}<small>ejercicios</small></strong><strong>${totalSets(next)}<small>series</small></strong></div></div>
      <div class="next-anatomy" aria-label="Enfoque muscular orientativo">${muscleAtlas(focus)}</div></div>
      ${focus.length ? `<div class="next-focus">${focus.slice(0, 3).map(group => `<span>${MUSCLE_GROUPS[group]}</span>`).join('')}</div>` : ''}
      <button class="btn btn-primary" id="btn-start-next"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>Empezar entrenamiento</button>
    </section>` : !state.session && !next ? `<section class="next-workout"><span class="eyebrow">${state.routineConflict ? 'Revisar biblioteca' : 'Empieza con tu plan'}</span><h2>${state.routineConflict ? 'Elige tu rutina activa' : 'Importa la rutina de tu gym'}</h2><p>${state.routineConflict ? 'Hay más de un plan activo. No elegimos por ti ni cambiamos tu historial.' : 'Carga el PDF o pega el texto de tu coach. Sus ejercicios quedarán disponibles para crear tus próximas rutinas.'}</p>${!state.routineConflict ? '<button class="btn btn-primary" id="home-import">Importar PDF o texto</button>' : ''}<button class="btn ${state.routineConflict ? 'btn-primary' : 'btn-ghost'}" id="home-setup">${state.routineConflict ? 'Elegir rutina' : 'Perfil y ajustes'}</button></section>` : '';
  if ($('#btn-start-next')) $('#btn-start-next').onclick = () => startOrOpen(nextDayId);
  if ($('#home-import')) $('#home-import').onclick = openImportRoutine;
  if ($('#home-setup')) $('#home-setup').onclick = state.routineConflict ? openRoutineCatalog : openPersonalSetup;

  renderRoutineAlert();

  $('#day-list').innerHTML = state.routine.map((day, dayIndex) => {
    const last = finished.filter(s => s.dayId === day.id).sort((a, b) => b.startedAt - a.startedAt)[0];
    const lastTxt = last
      ? `Última vez <em>${fmtDate(last.startedAt, { day: 'numeric', month: 'short' })}</em>`
      : 'Sin registros';
    const count = finished.filter(s => s.dayId === day.id).length;
        const currentWeek = new Date(weekStart(Date.now()));
        const nextWeek = new Date(currentWeek);
        nextWeek.setDate(nextWeek.getDate() + 7);
        const weeklyLast = finished.filter(session => session.dayId === day.id && session.startedAt >= currentWeek.getTime() && session.startedAt < nextWeek.getTime()).sort((first, second) => second.startedAt - first.startedAt)[0];
        const pct = weeklyLast ? sessionProgress(weeklyLast).pct : 0;
    const circ = 2 * Math.PI * 16;
        const ring = weeklyLast ? `
          <svg class="ring" width="42" height="42" viewBox="0 0 42 42" role="img" aria-label="Esta semana: ${pct}% completado">
            <circle class="bg" cx="21" cy="21" r="16"/>
            <circle class="fg" cx="21" cy="21" r="16" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct / 100)}"/>
          </svg>` : '';
    return `
      <button class="day-card" data-day="${day.id}">
        <div class="row">
          <span class="day-index" aria-hidden="true">${String(dayIndex + 1).padStart(2, '0')}</span>
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
  if (!state.routine.length) return null;
  const last = finished.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!last) return dayById(PROFILE.firstDayId)?.id || state.routine[0]?.id;
  const i = state.routine.findIndex(d => d.id === last.dayId);
  return state.routine[(i + 1) % state.routine.length].id;
}

/**
 * La racha se cuenta por semanas cumplidas, no por días seguidos: el plan tiene
 * 2 días de descanso, así que una racha diaria se rompería siempre.
 * La semana en curso no rompe la racha mientras no termine.
 */

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
  if ((byWeek.get(cursor.getTime()) || 0) >= state.profile.daysPerWeek) streak++;
  cursor.setDate(cursor.getDate() - 7);
  while ((byWeek.get(cursor.getTime()) || 0) >= state.profile.daysPerWeek) {
    streak++;
    cursor.setDate(cursor.getDate() - 7);
  }
  return streak;
}

/* ---------- Entreno ---------- */

async function startOrOpen(dayId) {
  if (state.startingSession) return;
  state.startingSession = true;
  try {
  if (state.session && state.session.dayId !== dayId) {
    const day = sessionDay(state.session);
    const ok = await confirmSheet({
      title: 'Tienes una sesión abierta',
      body: `${day?.label || 'Tu entrenamiento'} · ${day?.title || 'Sesión anterior'} sigue en curso. Empezar otra descartará la sesión abierta.`,
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
  } catch (error) {
    toast(error.message || 'No se pudo abrir el entrenamiento');
  } finally {
    state.startingSession = false;
  }
}

function openWorkout(dayId) {
  const day = state.session?.dayId === dayId ? sessionDay(state.session) : dayById(dayId);
  if (!day) return toast('Ese día ya no existe en tu rutina');
  if (!state.session.routineSnapshot) state.session.routineSnapshot = JSON.parse(JSON.stringify(day));
  if (ensureEntries(state.session, day)) saveSession(true)?.catch(warnSessionSave);
  $('#wh-name').textContent = `${day.label} · ${day.title}`;
  renderBlocks(day);
  updateWorkoutHeader();
  updateNotesButton();
  setView('workout');
}

function renderBlocks(day) {
  const s = state.session;
  trainingUI.seedChoices(s, day);
  const focus = dayFocus(day);
  const unassigned = day.blocks.flatMap(block => block.movements).filter(movement => exerciseFocus(movement) === 'none').length;
  $('#blocks').innerHTML = `<section class="workout-focus" aria-label="Enfoque orientativo de esta sesión"><div><span class="eyebrow">${esc(day.label)} · Enfoque</span><h2>${esc(day.subtitle || day.title)}</h2><p>${focus.map(group => MUSCLE_GROUPS[group]).join(' · ') || 'Sin grupos asignados'}${unassigned ? `<br><span class="focus-unassigned">${unassigned} sin clasificar</span>` : ''}</p></div><div class="workout-atlas">${muscleAtlas(focus)}</div></section>` + day.blocks.map((block, blockIndex) => {
    const floorLabel = block.floor ? `Piso ${block.floor}` : (block.tag || 'Bloque');
    const floorClass = block.floor ? '' : ' neutral';
    const movesHtml = block.movements.map(mv => {
      const vals = s.entries[mv.id] || [];
      const last = lastPerformance(mv.id, s.id);
      const setsHtml = Array.from({ length: block.sets }, (_, i) => {
        if (mv.kind === 'weight') {
          const v = typeof vals[i] === 'string' ? vals[i] : '';
          const ph = last?.values[i] ?? last?.values.find(value => value !== null) ?? '–';
          const best = personalBestForSet(s, mv, i, state.sessions, sessionDay);
          const isPr = best !== null && parseFloat(v) > best;
          return `<div class="set${v ? ' filled' : ''}${isPr ? ' pr' : ''}" data-mid="${mv.id}" data-idx="${i}" data-best="${best ?? ''}">
              <span class="n">${i + 1}</span>
              ${trainingUI.repsInput(s, mv, i)}
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
          <div class="mv-heading-row">
          <button class="mv-head" data-muscle="${esc(mv.id)}" aria-label="Ver enfoque muscular de ${esc(mv.name)}">
            <div class="mv-name">${esc(mv.name)}</div>
            <div class="mv-subline"><span>${MUSCLE_GROUPS[exerciseFocus(mv)]}</span><span class="mv-reps">${esc(mv.reps)}</span></div>
          </button>
          <button class="icon-btn mv-history" data-history="${esc(mv.id)}" aria-label="Historial de ${esc(mv.name)}" title="Historial del ejercicio"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>
          <a class="icon-btn exercise-search" href="${esc(imageSearchUrl(mv.name))}" target="_blank" rel="noopener noreferrer" aria-label="Buscar imágenes de ${esc(mv.name)}" title="Buscar imágenes en Google"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg></a>
          </div>
          ${mv.timer ? `<button class="mv-timer" data-timer="${mv.timer}" data-timer-name="${esc(mv.name)}">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
              Cronometrar ${mv.timer} s
            </button>` : ''}
          ${mv.note ? `<div class="mv-note">${esc(mv.note)}</div>` : ''}
          ${last ? `<div class="mv-last">Última vez: <b>${esc(last.values.map(value => value ?? '–').join(' · '))}</b></div>` : ''}
          <div class="sets">${setsHtml}</div>
          <div data-training-extra="${esc(mv.id)}">${trainingUI.extras(s, mv, block)}</div>
          ${mv.kind === 'weight' && (block.rest ?? state.restSeconds) > 0 ? `<button class="mv-rest" data-seconds="${block.rest ?? state.restSeconds}" aria-label="Descansar después de ${esc(mv.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 8v5l3 2M9 2h6"/></svg>Descansar ${block.rest ?? state.restSeconds} s</button>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="block" data-block="${block.id}">
        <div class="block-divider"><span class="block-number">${String(blockIndex + 1).padStart(2, '0')}</span><h2>${esc(block.tag || (block.movements.length > 1 ? `Grupo de ${block.movements.length} ejercicios` : 'Ejercicio individual'))}</h2><span class="block-status">Pendiente</span></div>
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
  $('#blocks .workout-focus').insertAdjacentHTML('afterend', trainingUI.workoutNote(day));
  trainingUI.bind(day);
  day.blocks.forEach(b => updateBlockState(b));
}

function bindSetHandlers(day) {
  $$('#blocks [data-muscle]').forEach(button => {
    button.onclick = () => openExerciseInfo(day.blocks.flatMap(block => block.movements).find(movement => movement.id === button.dataset.muscle));
  });
  $$('#blocks .mv-rest').forEach(button => {
    button.onclick = () => startRest(Number(button.dataset.seconds));
  });
  $$('#blocks [data-history]').forEach(btn => {
    btn.onclick = () => openMovementHistory(btn.dataset.history);
  });

  $$('#blocks .mv-timer').forEach(btn => {
    btn.onclick = () => {
      haptic();
      startCountdown(+btn.dataset.timer, btn.dataset.timerName, '¡Tiempo! Siguiente ejercicio', true);
    };
  });

  $$('#blocks .set input:not([data-reps])').forEach(input => {
    const cell = input.closest('.set');
    let wasRecorded = recordedSet(input.value);
    input.addEventListener('focus', () => { wasRecorded = recordedSet(input.value); });
    input.addEventListener('input', () => {
      let v = input.value.replace(',', '.').replace(/[^0-9.]/g, '');
      const parts = v.split('.');
      if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
      if (v.length > 6) v = v.slice(0, 6);
      input.value = v;
      state.session.entries[cell.dataset.mid][+cell.dataset.idx] = v;
      const movement = day.blocks.flatMap(block => block.movements).find(item => item.id === cell.dataset.mid);
      trainingUI.updateInlineRecord(state.session, movement, +cell.dataset.idx, cell.querySelector('[data-reps]')?.value);
      cell.classList.toggle('filled', v.trim() !== '');

      updatePersonalRecords(cell.dataset.mid, true);

      saveSession();
      trainingUI.refreshAdvice(day, cell.dataset.mid);
      updateWorkoutHeader();
      updateBlockState(findBlock(day, cell.dataset.mid));
    });
    input.addEventListener('blur', () => {
      saveSession(true)?.catch(warnSessionSave);
      if (!wasRecorded && recordedSet(input.value)) startRest(currentRestFor(day, cell.dataset.mid));
      wasRecorded = recordedSet(input.value);
      trainingUI.refreshAdvice(day, cell.dataset.mid);
    });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !recordedSet(input.value)) return;
      event.preventDefault();
      input.blur();
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
  return findBlock(day, movementId)?.rest ?? state.restSeconds;
}

function updateBlockState(block) {
  if (!block) return;
  const el = document.querySelector(`.block[data-block="${block.id}"]`);
  if (!el) return;
  const complete = block.movements.every(mv =>
    (state.session.entries[mv.id] || []).slice(0, block.sets).every(recordedSet)
  );
  el.classList.toggle('complete', complete);
  const done = block.movements.reduce((sum, movement) => sum + (state.session.entries[movement.id] || []).slice(0, block.sets).filter(recordedSet).length, 0);
  el.querySelector('.block-status').textContent = complete ? 'Completado' : `${done}/${block.sets * block.movements.length} series`;
}

function updateWorkoutHeader() {
  const p = sessionProgress(state.session);
  $('#wh-progress').style.width = `${p.pct}%`;
  const mins = fmtDuration(Date.now() - state.session.startedAt);
  $('#wh-sub').textContent = `${p.done}/${p.total} series · ${p.pct}% · ${mins}`;
  updateSaveStatus();
}

/* ---------- Temporizador (descanso y ejercicios cronometrados) ---------- */

const REST_CIRC = 2 * Math.PI * 19;
let countdownAudio = null;
let countdownHideTimeout = null;
const countdownTones = new Set();
let previousAudioType = null;

function restoreAudioType() {
  if (previousAudioType === null) return;
  try { navigator.audioSession.type = previousAudioType; } catch {}
  previousAudioType = null;
}

function stopCountdownSound() {
  for (const oscillator of countdownTones) {
    try { oscillator.stop(); } catch {}
  }
  countdownTones.clear();
  restoreAudioType();
}

function prepareCountdownAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (state.multimediaAudio && navigator.audioSession) {
      try {
        if (previousAudioType === null) previousAudioType = navigator.audioSession.type;
        navigator.audioSession.type = 'playback';
      } catch {}
    }
    if (!countdownAudio || countdownAudio.state === 'closed') countdownAudio = new AudioContextClass();
    if (countdownAudio.state !== 'running') return countdownAudio.resume().catch(() => { restoreAudioType(); });
  } catch { restoreAudioType(); }
}

function playCountdownSound() {
  if (countdownAudio?.state !== 'running') { restoreAudioType(); return; }
  try {
    for (let tone = 0; tone < 3; tone++) {
      const oscillator = countdownAudio.createOscillator();
      const gain = countdownAudio.createGain();
      const now = countdownAudio.currentTime + tone * 0.65;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      gain.gain.linearRampToValueAtTime(0, now + 0.5);
      oscillator.connect(gain);
      gain.connect(countdownAudio.destination);
      countdownTones.add(oscillator);
      oscillator.onended = () => {
        oscillator.disconnect(); gain.disconnect();
        if (countdownTones.delete(oscillator) && !countdownTones.size) restoreAudioType();
      };
      oscillator.start(now);
      oscillator.stop(now + 0.5);
    }
  } catch { stopCountdownSound(); }
}

function startCountdown(seconds, title, doneMsg, soundOnComplete = false) {
  seconds = Math.min(7200, Math.max(1, Math.round(Number(seconds) || 1)));
  stopCountdownSound();
  if (soundOnComplete) prepareCountdownAudio();
  clearTimeout(countdownHideTimeout);
  state.rest.total = seconds;
  state.rest.left = seconds;
  state.rest.title = title;
  state.rest.endsAt = Date.now() + seconds * 1000;
  state.rest.doneMsg = doneMsg;
  state.rest.soundOnComplete = soundOnComplete;
  state.rest.running = true;
  state.rest.paused = false;
  clearInterval(state.rest.id);
  $('#rt-title').textContent = title;
  $('#rest-timer').dataset.mode = soundOnComplete ? 'exercise' : 'rest';
  $('#rt-presets').hidden = soundOnComplete;
  $('#rt-toggle').disabled = false;
  $('#rest-timer').inert = false;
  $('#rest-timer').classList.add('show');
  document.body.classList.add('timer-visible');
  paintRest();
  state.rest.id = setInterval(tickCountdown, 200);
}

function tickCountdown() {
  if (!state.rest.running || state.rest.paused) return;
  state.rest.left = Math.max(0, Math.ceil((state.rest.endsAt - Date.now()) / 1000));
  paintRest();
  if (state.rest.left > 0) return;
  state.rest.running = false;
  clearInterval(state.rest.id);
  $('#rt-label').textContent = state.rest.doneMsg;
  $('#rt-toggle').disabled = true;
  if (state.rest.soundOnComplete) playCountdownSound();
  countdownHideTimeout = setTimeout(hideRest, 3500);
}

function toggleCountdown() {
  if (!state.rest.running) return;
  if (state.rest.paused) {
    if (state.rest.soundOnComplete) prepareCountdownAudio();
    state.rest.endsAt = Date.now() + state.rest.remainingMs;
    state.rest.paused = false;
  } else {
    tickCountdown();
    if (!state.rest.running) return;
    state.rest.remainingMs = Math.max(0, state.rest.endsAt - Date.now());
    state.rest.paused = true;
  }
  paintRest();
}

function startRest(seconds) {
  if (seconds <= 0) return;
  startCountdown(seconds, 'Descanso', '¡Listo! Siguiente serie');
}

function paintRest() {
  const seconds = Math.max(0, state.rest.left);
  $('#rt-num').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('#rt-label').textContent = state.rest.paused ? 'En pausa' : state.rest.left > 0 ? `de ${state.rest.total} s` : '¡Listo!';
  $('#rt-toggle').setAttribute('aria-label', state.rest.paused ? 'Reanudar temporizador' : 'Pausar temporizador');
  $('#rt-toggle').setAttribute('title', state.rest.paused ? 'Reanudar' : 'Pausar');
  $('#rt-toggle').classList.toggle('paused', !!state.rest.paused);
  const ratio = Math.max(0, state.rest.left) / state.rest.total;
  $('#rt-arc').style.strokeDashoffset = String(REST_CIRC * (1 - ratio));
}

function hideRest() {
  stopCountdownSound();
  clearInterval(state.rest.id);
  clearTimeout(countdownHideTimeout);
  state.rest.running = false;
  state.rest.paused = false;
  $('#rest-timer').classList.remove('show');
  document.body.classList.remove('timer-visible');
  $('#rest-timer').inert = true;
}

/* ---------- Historial ---------- */

const dateKey = timestamp => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const historyState = { mode: 'calendar', month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), selected: dateKey(Date.now()) };

function historyCalendar(finished) {
  const month = historyState.month;
  const monthCount = finished.filter(session => new Date(session.startedAt).getFullYear() === month.getFullYear() && new Date(session.startedAt).getMonth() === month.getMonth()).length;
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const counts = new Map();
  finished.forEach(session => {
    const key = dateKey(session.startedAt);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(month.getFullYear(), month.getMonth(), index - offset + 1, 12);
    const key = dateKey(date);
    const count = counts.get(key) || 0;
    const current = date.getMonth() === month.getMonth();
    return `<button class="calendar-day${current ? '' : ' adjacent'}${key === dateKey(Date.now()) ? ' today' : ''}${count ? ' trained' : ''}" data-history-date="${key}" aria-pressed="${key === historyState.selected}" aria-label="${esc(fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}, ${count} sesiones" ${key === dateKey(Date.now()) ? 'aria-current="date"' : ''}><span>${date.getDate()}</span><i aria-hidden="true">${count > 1 ? count : count ? '•' : ''}</i></button>`;
  }).join('');
  return `<section class="history-calendar" aria-label="Calendario de entrenamientos">
    <div class="calendar-heading">
      <button class="icon-btn" data-month-step="-1" aria-label="Mes anterior" title="Mes anterior"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 6-6 6 6 6"/></svg></button>
      <label class="calendar-month"><span>${esc(fmtDate(month, { month: 'long', year: 'numeric' }))}</span><input type="month" id="history-month" value="${dateKey(month).slice(0, 7)}" min="1900-01" max="2100-12" aria-label="Elegir mes y año" /></label>
      <button class="icon-btn" data-month-step="1" aria-label="Mes siguiente" title="Mes siguiente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg></button>
    </div>
    <div class="calendar-grid"><div class="calendar-weekday" aria-label="Lunes">L</div><div class="calendar-weekday" aria-label="Martes">K</div><div class="calendar-weekday" aria-label="Miércoles">M</div><div class="calendar-weekday">J</div><div class="calendar-weekday">V</div><div class="calendar-weekday">S</div><div class="calendar-weekday">D</div>${cells}</div>
    <div class="calendar-footer"><span>${monthCount} ${monthCount === 1 ? 'sesión' : 'sesiones'} este mes</span><button id="history-today">Hoy</button></div>
  </section>`;
}

function annualActivityHtml(finished) {
  const year = historyState.activityYear || new Date().getFullYear();
  const sessions = finished.filter(session => new Date(session.startedAt).getFullYear() === year);
  const counts = new Map();
  for (const session of sessions) {
    const key = dateKey(session.startedAt);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return `<details class="annual-activity" id="annual-activity" ${historyState.activityOpen ? 'open' : ''}><summary>Tu año de entrenamiento <span>${plural(sessions.length, 'sesión', 'sesiones')}</span></summary>
    <div><div class="activity-year-controls"><button class="icon-btn" data-activity-step="-1" aria-label="Año anterior" ${year <= 1900 ? 'disabled' : ''}>‹</button><label><span class="eyebrow">Actividad anual</span><input id="activity-year" type="number" min="1900" max="2100" step="1" value="${year}" aria-label="Año de actividad"></label><button class="icon-btn" data-activity-step="1" aria-label="Año siguiente" ${year >= 2100 ? 'disabled' : ''}>›</button></div>
    <p class="training-caption">${plural(counts.size, 'día activo', 'días activos')}. Toca un mes para abrir sus registros.</p><div class="activity-months">${Array.from({ length: 12 }, (_, month) => {
      const first = new Date(year, month, 1, 12), days = new Date(year, month + 1, 0).getDate();
      const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
      const total = sessions.filter(session => new Date(session.startedAt).getMonth() === month).length;
      const cells = Array.from({ length: (first.getDay() + 6) % 7 }, () => '<i class="activity-spacer"></i>').join('') +
        Array.from({ length: days }, (_, index) => {
          const key = `${prefix}-${String(index + 1).padStart(2, '0')}`;
          return `<i data-activity-day="${key}" data-count="${Math.min(3, counts.get(key) || 0)}"></i>`;
        }).join('');
      return `<button class="activity-month" data-activity-month="${prefix}" aria-label="${esc(fmtDate(first, { month: 'long', year: 'numeric' }))}, ${plural(total, 'sesión', 'sesiones')}"><strong>${esc(fmtDate(first, { month: 'short' }))}</strong><span class="activity-dots" aria-hidden="true">${cells}</span><small>${plural(total, 'sesión', 'sesiones')}</small></button>`;
    }).join('')}</div></div></details>`;
}

function renderHistory() {
  const finished = state.sessions.filter(s => s.finishedAt).sort((a, b) => b.startedAt - a.startedAt);
  $('#history-sub').textContent = finished.length
    ? `${finished.length} ${finished.length === 1 ? 'sesión completada' : 'sesiones completadas'}`
    : 'Aún sin entrenamientos';

  const slot = $('#history-slot');
  const calendar = historyState.mode === 'calendar';
  const period = calendar ? finished.filter(session => dateKey(session.startedAt).slice(0, 7) === dateKey(historyState.month).slice(0, 7)) : finished;
  const minutes = Math.round(period.reduce((total, session) => total + sessionDuration(session), 0) / 60000);
  const summary = `<div class="history-totals" aria-label="${calendar ? 'Resumen del mes' : 'Resumen completo'}"><div><strong>${period.length}</strong><span>Sesiones${calendar ? ' del mes' : ''}</span></div><div><strong>${new Set(period.map(session => dateKey(session.startedAt))).size}</strong><span>Días activos</span></div><div><strong>${minutes}</strong><span>Minutos</span></div></div>`;
  const visible = calendar ? finished.filter(session => dateKey(session.startedAt) === historyState.selected) : finished;
  slot.innerHTML = `${summary}<button class="progress-entry" id="history-exercises"><span>Tu progreso por ejercicio</span><small>Cargas, repeticiones y sesiones anteriores</small><span aria-hidden="true">›</span></button>${annualActivityHtml(finished)}<div class="history-switch seg" role="group" aria-label="Vista del historial"><button data-history-mode="calendar" class="${calendar ? 'on' : ''}" aria-pressed="${calendar}">Calendario</button><button data-history-mode="list" class="${calendar ? '' : 'on'}" aria-pressed="${!calendar}">Todas las sesiones</button></div>
    ${calendar ? historyCalendar(finished) : ''}
    <h2 class="section-title history-date" id="history-date-title">${calendar ? esc(fmtDate(new Date(`${historyState.selected}T12:00:00`), { weekday: 'long', day: 'numeric', month: 'long' })) : 'Sesiones completadas'}</h2>
    <div aria-labelledby="history-date-title">${visible.length ? `<div class="list-card">${visible.map(s => {
    const day = sessionDay(s);
    const p = sessionProgress(s);
    const dur = s.finishedAt ? fmtDuration(sessionDuration(s)) : '';
    return `
      <button class="history-item" data-session="${esc(s.id)}" style="width:100%;background:none">
        <span class="history-stamp" aria-hidden="true"><b>${new Date(s.startedAt).getDate()}</b><small>${esc(fmtDate(s.startedAt, { month: 'short' }))}</small></span>
        <span class="hi-body">
          <strong>${esc(day?.title || 'Sesión')}</strong>
          <small>${fmtDate(s.startedAt, { weekday: 'short', day: 'numeric', month: 'short' })} · ${dur}</small>
        </span>
        <span class="hi-pct" style="color:${p.pct >= 80 ? 'var(--green)' : 'var(--text-2)'}">${day ? `${p.pct}%` : 'Ver'}</span>
      </button>`;
  }).join('')}</div>` : `<div class="history-empty"><p>${calendar ? 'Sin entrenamientos registrados este día.' : 'Aún no hay sesiones completadas.'}</p></div>`}</div>`;

  $$('.history-item').forEach(el => { el.onclick = () => showSessionDetail(el.dataset.session); });
  $('#history-exercises').onclick = openExerciseProgress;
  const activity = $('#annual-activity');
  activity.ontoggle = () => { if (activity.isConnected) historyState.activityOpen = activity.open; };
  const changeYear = year => {
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      toast('Elige un año entre 1900 y 2100.');
      $('#activity-year').value = historyState.activityYear || new Date().getFullYear();
      return;
    }
    historyState.activityYear = year;
    historyState.activityOpen = true;
    renderHistory();
    $('#activity-year').focus({ preventScroll: true });
  };
  $('#activity-year').onchange = event => changeYear(Number(event.target.value));
  $$('[data-activity-step]').forEach(button => {
    button.onclick = () => changeYear((historyState.activityYear || new Date().getFullYear()) + Number(button.dataset.activityStep));
  });
  $$('[data-activity-month]').forEach(button => {
    button.onclick = () => {
      const month = button.dataset.activityMonth;
      historyState.mode = 'calendar';
      historyState.month = new Date(`${month}-01T12:00:00`);
      const recent = finished.find(session => dateKey(session.startedAt).startsWith(month));
      historyState.selected = recent ? dateKey(recent.startedAt) : `${month}-01`;
      historyState.activityOpen = false;
      renderHistory();
      $('#history-month').focus({ preventScroll: true });
    };
  });
  slot.onkeydown = event => {
    const button = event.target.closest('[data-history-date]');
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!button || !step) return;
    event.preventDefault();
    const date = new Date(`${button.dataset.historyDate}T12:00:00`);
    date.setDate(date.getDate() + step);
    if (date.getFullYear() < 1900 || date.getFullYear() > 2100) return;
    historyState.month = new Date(date.getFullYear(), date.getMonth(), 1);
    historyState.selected = dateKey(date);
    renderHistory();
    $(`[data-history-date="${historyState.selected}"]`)?.focus({ preventScroll: true });
  };
  $$('[data-history-mode]').forEach(button => {
    button.onclick = () => { historyState.mode = button.dataset.historyMode; renderHistory(); $(`[data-history-mode="${historyState.mode}"]`).focus({ preventScroll: true }); };
  });
  $$('[data-history-date]').forEach(button => {
    button.onclick = () => {
      historyState.selected = button.dataset.historyDate;
      const selected = new Date(`${historyState.selected}T12:00:00`);
      historyState.month = new Date(selected.getFullYear(), selected.getMonth(), 1);
      renderHistory();
      $(`[data-history-date="${historyState.selected}"]`)?.focus({ preventScroll: true });
    };
  });
  $$('[data-month-step]').forEach(button => {
    button.onclick = () => {
      const target = new Date(historyState.month.getFullYear(), historyState.month.getMonth() + Number(button.dataset.monthStep), 1);
      if (target.getFullYear() < 1900 || target.getFullYear() > 2100) return;
      historyState.month = target;
      historyState.selected = dateKey(target);
      renderHistory();
      $(`[data-month-step="${button.dataset.monthStep}"]`)?.focus({ preventScroll: true });
    };
  });
  if ($('#history-month')) $('#history-month').onchange = event => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value) || !event.target.validity.valid) return;
    historyState.month = new Date(`${event.target.value}-01T12:00:00`);
    historyState.selected = dateKey(historyState.month);
    renderHistory();
    $('#history-month').focus({ preventScroll: true });
  };
  if ($('#history-today')) $('#history-today').onclick = () => {
    historyState.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    historyState.selected = dateKey(Date.now());
    renderHistory();
    $('#history-today').focus({ preventScroll: true });
  };
}

function showSessionDetail(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  const day = sessionDay(s);
  const p = sessionProgress(s);

  const blocks = day?.blocks || [{ sets: 0, movements: Object.keys(s.entries || {}).filter(key => !key.startsWith('_')).map((key, index) => ({ id: key, name: `Ejercicio ${index + 1}`, kind: (s.entries[key] || []).some(value => typeof value === 'string') ? 'weight' : 'check' })) }];
  const rows = blocks.map((block, index) => `<section class="session-block"><h3>${esc(block.tag || `Bloque ${index + 1}`)}${block.floor ? ` · Piso ${esc(block.floor)}` : ''}</h3><p class="session-block-meta">${block.sets ? `${block.sets} ${block.sets === 1 ? 'serie' : 'series'}` : 'Registros disponibles'}${block.rest ? ` · Descanso ${block.rest} s` : ''}</p>${block.note ? `<p class="session-note">${esc(block.note)}</p>` : ''}${block.movements.map(mv => {
    const vals = s.entries[mv.id] || [];
    const sets = Array.from({ length: Math.max(block.sets, vals.length) }, (_, setIndex) => {
      const value = vals[setIndex];
      const done = recordedSet(value);
      const record = setRecord(s, mv.id, setIndex);
      const context = record ? [
        Number.isInteger(record.reps) ? `${record.reps} reps${record.repsSource === 'plan' ? ' del plan' : ''}` : null,
        record.label && record.label !== 'Habitual' ? record.label : null,
        Number.isInteger(record.rir) ? `${record.rir === 3 ? '3+' : record.rir} en reserva` : null,
        record.discomfort ? 'Molestia' : null
      ].filter(Boolean).join(' · ') : done ? 'Registrada' : 'Sin registrar';
      return `<div class="session-set${done ? ' done' : ''}"><small>Serie ${setIndex + 1}</small><b>${mv.kind === 'weight' ? done ? esc(value) : '—' : done ? '✓' : '—'}${record?.unit && record.unit !== 'escala' ? `<small> ${esc(record.unit)}</small>` : ''}</b><span>${esc(context)}</span>${s.finishedAt && mv.kind === 'weight' && done && typeof value === 'string' ? `<button class="history-edit-weight" data-edit-weight="${esc(mv.id)}" data-set-index="${setIndex}" aria-label="Corregir peso, serie ${setIndex + 1} de ${esc(mv.name)}">Corregir</button>` : ''}</div>`;
    }).join('');
    return `<div class="session-movement"><div class="session-movement-heading"><h4>${esc(mv.name)}</h4>${s.routineSnapshot ? `<button class="text-action" data-movement-progress="${esc(mv.id)}" aria-label="Ver progreso de ${esc(mv.name)}">Progreso</button>` : ''}</div><p>${esc(mv.reps || '')}${mv.timer ? ` · ${mv.timer} s` : ''}</p>${mv.note ? `<p class="session-note">${esc(mv.note)}</p>` : ''}<div class="session-sets">${sets}</div></div>`;
  }).join('')}</section>`).join('');

  openSheet(`
    <span class="eyebrow">Tu historial</span>
    <h2>${esc(day?.title || 'Entrenamiento anterior')}</h2>
    <p>${fmtDate(s.startedAt)} · ${fmtDuration(sessionDuration(s))}</p>
    <div class="session-actions"><button class="btn btn-ghost duration-edit" id="edit-duration">Editar duración</button>
    <button class="btn btn-ghost" id="session-day-report">Balance del día</button></div>
    ${!s.routineSnapshot ? '<p class="session-legacy">Esta sesión no conserva una copia original de su rutina. Los datos disponibles pueden no reflejar el plan de ese día.</p>' : ''}
    <div class="summary-grid">
      <div><b>${day ? p.done : Object.values(s.entries || {}).filter(Array.isArray).flat().filter(recordedSet).length}</b><span>Series</span></div>
      <div><b>${day ? `${p.pct}%` : '—'}</b><span>Completado</span></div>
      <div><b>${esc(day?.label?.replace('Día ', 'D') || '—')}</b><span>Rutina</span></div>
    </div>
    ${s.notes ? `<div class="block-note" style="margin-bottom:16px">${esc(s.notes)}</div>` : ''}
    ${personalRecordsHtml(s)}
    <div style="margin-bottom:18px">${rows}</div>
    <button class="btn btn-ghost" id="sheet-close">Cerrar</button>
    <button class="session-delete" id="sheet-delete">Eliminar sesión</button>
  `);

  $('#sheet-close').onclick = closeSheet;
  $('#edit-duration').onclick = () => openDurationEditor(s, () => showSessionDetail(id));
  $('#session-day-report').onclick = () => trainingUI.openProgress('day', s.startedAt);
  bindRecordLinks();
  $$('[data-movement-progress]').forEach(button => {
    button.onclick = () => openMovementHistory(button.dataset.movementProgress, id);
  });
  $$('[data-edit-weight]').forEach(button => {
    button.onclick = () => {
      const movement = blocks.flatMap(block => block.movements).find(item => item.id === button.dataset.editWeight);
      const scroll = $('#sheet').scrollTop;
      const index = Number(button.dataset.setIndex);
      openHistoryWeightEditor(id, movement, index, () => {
        showSessionDetail(id);
        $('#sheet').scrollTop = scroll;
        $$('[data-edit-weight]').find(item => item.dataset.editWeight === movement.id && Number(item.dataset.setIndex) === index)?.focus({ preventScroll: true });
      });
    };
  });
  $('#sheet-delete').onclick = async () => {
    const confirmed = await confirmSheet({ title: 'Eliminar sesión', body: 'Se eliminará este entrenamiento. El cambio también se enviará a tus dispositivos al sincronizar.', confirm: 'Eliminar', cancel: 'Conservar', danger: true });
    if (!confirmed) return;
    await db.deleteSession(id);
    state.sessions = state.sessions.filter(x => x.id !== id);
    closeSheet();
    renderHistory();
    renderHome();
    toast('Sesión eliminada', { label: 'Deshacer', fn: async () => {
      const restored = { ...s };
      delete restored.deletedAt;
      await db.putSession(restored);
      state.sessions.push(restored);
      renderHistory(); renderHome();
    } });
  };
}

/** Aviso de cambio de rutina: aparece 14 días antes de la fecha del plan. */
function renderRoutineAlert() {
  const slot = $('#routine-alert');
  if (state.legacyFallback) {
    slot.innerHTML = '<p class="notice warn" role="status">Plan histórico de compatibilidad, no confirmado: no hay una copia guardada de la rutina original. Revisa o importa tu plan desde Mis rutinas; el historial se conserva.</p>';
    return;
  }
  if (!state.profile.routineChangeDate) { slot.innerHTML = ''; return; }
  const target = new Date(state.profile.routineChangeDate + 'T12:00:00').getTime();
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
  $('#btn-workout-menu').classList.toggle('has-note', Boolean(state.session?.notes?.trim()));
}

function openWorkoutMenu() {
  openSheet(`<span class="eyebrow">Tu entrenamiento</span><h2>A mano, sin estorbar</h2><div class="list-card">
    <button class="list-row" id="workout-notes"><span class="lr-body"><strong>Nota del entrenamiento</strong><small>${state.session?.notes ? 'Tienes una nota guardada' : 'Sensaciones o detalles que quieras recordar'}</small></span><span aria-hidden="true">›</span></button>
    <button class="list-row" id="workout-rest"><span class="lr-body"><strong>Iniciar descanso</strong><small>${state.restSeconds} segundos</small></span><span aria-hidden="true">›</span></button>
    <button class="list-row" id="workout-preferences"><span class="lr-body"><strong>Descanso y pantalla</strong><small>Preferencias, sin cambiar las series del coach</small></span><span aria-hidden="true">›</span></button>
    <button class="list-row" id="workout-balance"><span class="lr-body"><strong>Balance de la semana</strong><small>Sesiones finalizadas y registros comparables</small></span><span aria-hidden="true">›</span></button></div>`);
  $('#workout-notes').onclick = openNotes;
  $('#workout-rest').onclick = () => { closeSheet(); startRest(state.restSeconds); };
  $('#workout-preferences').onclick = openTrainingPreferences;
  $('#workout-balance').onclick = () => trainingUI.openProgress('week', Date.now());
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

function openExerciseProgress() {
  const exercises = new Map();
  for (const session of state.sessions.filter(item => item.finishedAt && !item.deletedAt).sort((a, b) => b.startedAt - a.startedAt)) {
    for (const movement of session.routineSnapshot?.blocks.flatMap(block => block.movements) || []) {
      if (!session.entries?.[movement.id]?.some(recordedSet)) continue;
      const key = JSON.stringify([movement.id, movement.name]);
      if (!exercises.has(key)) exercises.set(key, { movement, sessionId: session.id, sessions: new Set() });
      exercises.get(key).sessions.add(session.id);
    }
  }
  openSheet(`<span class="eyebrow">Tu historial</span><h2>Progreso por ejercicio</h2><p class="training-caption">Tus registros, sin rankings ni unidades inventadas.</p><label class="progress-search"><span>Buscar ejercicio</span><input id="progress-search" type="search" placeholder="Nombre del ejercicio" autocomplete="off"></label><div class="exercise-progress-list" id="exercise-progress-list"></div>`);
  const render = () => {
    const query = normalizeExercise($('#progress-search').value);
    const rows = [...exercises.values()].filter(item => normalizeExercise(item.movement.name).includes(query));
    $('#exercise-progress-list').innerHTML = rows.length ? rows.map(item => `<button class="exercise-progress-item" data-progress-movement="${esc(item.movement.id)}" data-source-session="${esc(item.sessionId)}"><span><strong>${esc(item.movement.name)}</strong><small>${plural(item.sessions.size, 'sesión registrada', 'sesiones registradas')}</small></span><span aria-hidden="true">›</span></button>`).join('') : `<p class="movement-history-empty">${query ? 'No hay ejercicios con ese nombre.' : 'Tus ejercicios aparecerán aquí al completar un entrenamiento. Los registros sin copia de la rutina siguen disponibles por fecha.'}</p>`;
    $$('[data-progress-movement]').forEach(button => {
      button.onclick = () => openMovementHistory(button.dataset.progressMovement, button.dataset.sourceSession);
    });
  };
  $('#progress-search').oninput = render;
  render();
}

function loadTrendHtml(group) {
  const { points, record } = group;
  const first = points[0], last = points.at(-1);
  const min = Math.min(...points.map(point => point.load)), max = Math.max(...points.map(point => point.load));
  const coordinates = points.map(point => ({
    x: points.length === 1 ? 160 : 24 + (point.at - first.at) / Math.max(1, last.at - first.at) * 272,
    y: max === min ? 76 : 128 - (point.load - min) / (max - min) * 104
  }));
  const line = coordinates.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const percentage = first.load > 0 && points.length > 1 ? (last.load - first.load) / first.load * 100 : null;
  const change = Number.isFinite(percentage) ? percentage : null;
  const unit = record.unit === 'escala' ? '' : ` ${esc(record.unit)}`;
  return `<div class="load-trend-card">
    <div class="load-trend-heading"><span class="eyebrow">Carga registrada · ${record.reps} reps</span><span>${plural(points.length, 'sesión', 'sesiones')}</span></div>
    <div class="load-trend-value"><strong>${last.load}<small>${unit}</small></strong><span>${change === null ? points.length === 1 ? 'Primera referencia' : first.load === 0 ? 'Referencia inicial en cero' : 'No se puede calcular el porcentaje' : `${change > 0 ? '+' : ''}${change.toLocaleString('es-MX', { maximumFractionDigits: 1 })}% desde el primer registro comparable`}</span></div>
    <svg class="load-trend-chart" viewBox="0 0 320 152" role="img" aria-label="${esc(`Carga máxima por sesión con ${record.reps} reps. Primer registro: ${first.load}; último: ${last.load}; mejor: ${max}.`)}">
      <path class="load-trend-grid" d="M24 24H296M24 76H296M24 128H296"/>
      <polyline class="load-trend-line" points="${line}"/>
      ${coordinates.map((point, index) => `<circle class="${index === coordinates.length - 1 ? 'latest' : ''}" cx="${point.x}" cy="${point.y}" r="${index === coordinates.length - 1 ? 5 : 3}"/>`).join('')}
    </svg>
    <div class="load-trend-dates"><span>${fmtDate(first.at, { day: 'numeric', month: 'short', year: 'numeric' })}</span>${points.length > 1 ? `<span>${fmtDate(last.at, { day: 'numeric', month: 'short', year: 'numeric' })}</span>` : ''}</div>
    <div class="load-trend-best"><span>Mejor registro comparable</span><b>${max}${unit} × ${record.reps}</b></div>
  </div><p class="training-caption">Compara números del mismo equipo y reps registradas; no mide tu nivel de fuerza. Si cambias de máquina o de escala sin registrarlo, la app no puede distinguirlo. Las reps del plan no demuestran esfuerzo.</p>`;
}

function openMovementHistory(movementId, sourceSessionId = null) {
  const activeDay = sessionDay(sourceSessionId ? state.sessions.find(item => item.id === sourceSessionId) : state.session);
  const activeBlock = activeDay?.blocks.find(item => item.movements.some(movement => movement.id === movementId));
  const found = activeBlock ? { movement: activeBlock.movements.find(item => item.id === movementId), block: activeBlock } : findMovement(movementId);
  if (!found) return;
  const { movement } = found;
  const rows = state.sessions
    .filter(s => s.finishedAt && !s.deletedAt && Array.isArray(s.entries?.[movementId]))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(session => ({ session, movement: sessionDay(session)?.blocks.flatMap(item => item.movements).find(item => item.id === movementId && item.name === movement.name) }))
    .filter(row => row.movement)
    .map(row => ({ ...row, sets: row.session.entries[movementId].flatMap((value, index) => recordedSet(value) ? [{ value, index, record: setRecord(row.session, movementId, index) }] : []) }))
    .filter(row => row.sets.length);
  const groups = movementLoadHistory(movement, state.sessions);
  const groupLabel = group => [
    group.record.label === 'Habitual' ? 'Tu equipo' : group.record.label,
    group.record.variant === 'alternative' ? 'Alternativo' : null,
    `${group.record.reps} reps`, group.record.unit === 'escala' ? null : group.record.unit,
    `Plan ${group.prescription}`, group.note
  ].filter(Boolean).join(' · ');
  openSheet(`<span class="eyebrow">Historial del ejercicio</span><h2>${esc(movement.name)}</h2>
    <p class="movement-history-count">${plural(rows.length, 'sesión', 'sesiones')}</p>
    ${groups.length === 1 ? `<p class="training-caption">${esc(groupLabel(groups[0]))}</p>` : ''}
    ${groups.length > 1 ? `<div class="progress-contexts" role="group" aria-label="Registros comparables">${groups.map((group, index) => `<button data-trend-group="${index}" aria-pressed="${index === 0}">${esc(groupLabel(group))}</button>`).join('')}</div>` : ''}
    <div id="movement-load-trend">${groups.length ? loadTrendHtml(groups[0]) : movement.kind === 'weight' && rows.length ? '<p class="training-caption">Tus pesos siguen abajo. La curva necesita registros con reps y contexto comparables; no adivinamos los datos antiguos ni comparamos asistencia o planes especiales.</p>' : ''}</div>
    <div class="movement-history">${rows.length ? rows.map(row => `<section class="movement-history-row">
      <header><h3>${fmtDate(row.session.startedAt, { day: 'numeric', month: 'short', year: 'numeric' })}</h3><button class="text-action" data-history-session="${esc(row.session.id)}">Ver sesión</button><span>${esc(row.movement.reps)} · ${plural(row.sets.length, 'serie', 'series')}</span></header>
      <div class="movement-history-sets">${row.sets.map(item => `<div class="movement-history-set"><span class="history-set-number">${item.index + 1}</span><strong>${row.movement.kind === 'weight' ? esc(item.value) : 'Hecha'}${item.record?.unit && item.record.unit !== 'escala' ? `<small>${esc(item.record.unit)}</small>` : ''}</strong><span>${item.record?.reps != null ? `${esc(item.record.reps)} reps` : esc(row.movement.reps)}</span>${item.record?.label && item.record.variant !== 'original' ? `<small class="history-set-equipment">${esc(item.record.label)}</small>` : ''}</div>`).join('')}</div>
    </section>`).join('') : '<p class="movement-history-empty">Aún no has registrado este ejercicio.</p>'}</div>`);
  $$('[data-trend-group]').forEach(button => {
    button.onclick = () => {
      $$('[data-trend-group]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      $('#movement-load-trend').innerHTML = loadTrendHtml(groups[Number(button.dataset.trendGroup)]);
    };
  });
  $$('[data-history-session]').forEach(button => {
    button.onclick = () => showSessionDetail(button.dataset.historySession);
  });
}

/* ---------- Rutina: carga, importación y editor ---------- */

const ROUTINE_ID = 'active';

function routineRecord(record) {
  return {
    ...record,
    days: sanitizeRoutine(record.days),
    active: record.active == null && record.id === ROUTINE_ID ? true : Boolean(record.active),
    archived: Boolean(record.archived)
  };
}

function routineStats(days) {
  const clean = Array.isArray(days) ? days : [];
  return {
    days: clean.length,
    movements: clean.reduce((total, day) => total + day.blocks.reduce((count, block) => count + block.movements.length, 0), 0),
    sets: clean.reduce((total, day) => total + totalSets(day), 0)
  };
}

function activeRoutineRecord() {
  return state.routines.find(record => record.id === state.routineId) || null;
}

function pendingSessionSnapshots(sessions, days) {
  return sessions.filter(session => !session.deletedAt && !session.routineSnapshot && days.some(day => day.id === session.dayId))
    .map(session => ({ ...session, routineSnapshot: structuredClone(days.find(day => day.id === session.dayId)) }));
}

function verifyRoutineRevision(record, expected) {
  if ((record ? JSON.stringify(record) : null) !== expected) {
    throw new Error('Esta rutina cambió en otra ventana. No se sobrescribió nada; vuelve a abrir la biblioteca o el editor.');
  }
}

async function loadRoutine() {
  const raw = (await db.allRoutines()) || [];
  state.personalProfile = await db.getMeta('personalProfile');
  if (state.personalProfile != null) validatePersonalProfile(state.personalProfile);
  state.routineRevisions = new Map(raw.map(record => [record.id, JSON.stringify(record)]));
  const records = raw.filter(record => record && typeof record.id === 'string' && !record.deletedAt).map(routineRecord);
  const candidates = records.filter(record => record.active && !record.archived).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  state.routineConflict = candidates.length > 1;
  const legacyRecord = raw.find(record => record.id === ROUTINE_ID && record.active == null && !record.archived && !record.deletedAt);
  let active = state.routineConflict ? null : candidates[0] || (legacyRecord ? routineRecord(legacyRecord) : null);

  const legacyInstall = !raw.length && state.sessions.some(session => {
    if (session.routineSnapshot) return false;
    const day = DEFAULT_ROUTINE.find(item => item.id === session.dayId);
    const keys = Object.keys(session.entries || {}).filter(key => !key.startsWith('_'));
    const ids = new Set(day?.blocks.flatMap(block => block.movements.map(movement => movement.id)) || []);
    return keys.length > 0 && keys.every(key => ids.has(key));
  });
  state.legacyFallback = legacyInstall;
  if (!active && legacyInstall) {
    active = routineRecord({ id: ROUTINE_ID, name: 'Mi rutina', days: structuredClone(DEFAULT_ROUTINE), active: true, source: 'legacy' });
    records.push(active);
  }

  state.routines = records;
  state.activeRoutineId = active?.id || null;
  state.routineId = active?.id || null;
  state.routineUpdatedAt = active?.updatedAt || null;
  state.routine = active?.days?.length ? active.days : [];
  const legacyProfile = active?.id === ROUTINE_ID || active?.source === 'legacy';
  const fallbackProfile = state.personalProfile || (legacyProfile ? PROFILE : EMPTY_PROFILE);
  state.profile = normalizeProfile(active?.profile || {}, fallbackProfile);

  await rebuildExerciseLibrary();
}

async function saveRoutine(days, name, newCycle = false) {
  const clean = sanitizeRoutine(days);
  if (!clean.length) throw new Error('La rutina quedó vacía');
  const targetId = state.draftRoutineId || state.routineId || ROUTINE_ID;
  const expectedActiveId = state.activeRoutineId;
  const expectedStoredActiveId = state.routineRevisions.has(expectedActiveId) ? expectedActiveId : null;
  const draft = Boolean(state.draft);
  const draftActivate = state.draftActivate;
  const draftSource = state.draftSource;
  const draftGeneration = draft ? structuredClone(state.draftGeneration) : null;
  const expectedRevision = state.draftBaseline?.id === targetId ? state.draftBaseline.revision : state.routineRevisions.get(targetId) || null;
  const result = await db.updateRoutineLibrary(({ routines: records, sessions, exercises, personalProfile }) => {
    const existing = records.find(record => record.id === targetId);
    verifyRoutineRevision(existing, expectedRevision);
    if (backupActiveRoutines(records, []).length > 1) throw new Error('Elige primero una sola rutina activa desde Mis rutinas.');
    const oldActive = backupActiveRoutines(records, [])[0];
    const inheritedProfile = oldActive?.profile || (personalProfile ? validatePersonalProfile(personalProfile) : state.profile);
    if ((oldActive?.id || null) !== expectedStoredActiveId) {
      throw new Error('La rutina activa cambio en otra ventana. Abre de nuevo el editor.');
    }
    const keepCurrentActive = existing?.active && targetId === expectedActiveId;
    const activate = keepCurrentActive || (draft ? draftActivate !== false : true);
    if (activate && (state.session || sessions.some(session => !session.finishedAt && !session.deletedAt)) && targetId !== expectedActiveId) {
      throw new Error('Termina la sesión antes de activar otra rutina. Puedes guardarla sin activarla.');
    }
    const previousDays = oldActive?.days || state.routine;
    const previousCycle = existing?.days?.[0] || (targetId === state.routineId ? state.routine[0] : clean[0]);
    const oldCycle = previousDays[0]?.cycleId || 'legacy';
    const cycle = newCycle
      ? { cycleId: uid(), cycleName: `Rutina · ${fmtDate(Date.now(), { day: 'numeric', month: 'short', year: 'numeric' })}`, cycleStartedAt: Date.now() }
      : { cycleId: previousCycle?.cycleId, cycleName: previousCycle?.cycleName, cycleStartedAt: previousCycle?.cycleStartedAt };
    clean.forEach(day => Object.assign(day, cycle));
    const changes = [];
    if (newCycle && activate && oldActive?.days?.length) {
      changes.push({
        id: `cycle-${oldCycle === 'legacy' ? uid() : oldCycle}`,
        name: oldActive.name || previousDays[0]?.cycleName || 'Historial sin ciclo',
        days: structuredClone(oldActive.days), active: false, archived: true, source: 'cycle'
      });
    }
    if (activate) {
      for (const record of backupActiveRoutines(records, []).filter(record => record.id !== targetId)) {
        changes.push({ ...record, active: false });
      }
    }
    const now = Date.now();
    const routineSource = existing?.source === 'legacy' ? 'manual' : existing?.source || draftSource || 'manual';
    changes.push({
      ...(existing || {}),
      id: targetId,
      name: String(name || 'Mi rutina').trim().slice(0, 100) || 'Mi rutina',
      days: clean,
      active: activate,
      archived: false,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastUsedAt: activate ? now : existing?.lastUsedAt,
      source: routineSource,
      ...(draftGeneration ? { generation: draftGeneration } : {}),
      userModifiedAt: now,
      ...(existing?.profile ? { profile: existing.profile } : activate && inheritedProfile?.name ? { profile: inheritedProfile } : {})
    });
    const exerciseSource = draftSource === 'import' || ['import', 'imported', 'legacy'].includes(routineSource) ? 'imported' : 'private';
    return {
      routines: changes,
      sessions: pendingSessionSnapshots(sessions, previousDays),
      exercises: routineExerciseChanges(clean, targetId, exerciseSource, exercises, Boolean(draftGeneration)),
      result: newCycle && activate && oldActive?.days?.length ? oldCycle : null
    };
  });
  try {
    await loadAll({ preserveSession: true });
    await loadRoutine();
  } catch {
    throw new Error('La rutina se guardo, pero no se pudo actualizar la pantalla. Vuelve a abrir la app antes de crear otro ciclo.');
  }
  return result;
}

function exerciseNameKey(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function routineExerciseChanges(days, routineId, origin, existing, preserveExisting = false) {
  const byName = new Map(existing.map(record => [record.nameKey || exerciseNameKey(record.name), record]));
  const changes = new Map();
  const catalogByName = new Map(EXERCISE_CATALOG.map(record => [exerciseNameKey(record.name), record]));
  const personalSource = origin === 'imported' ? 'imported' : origin === 'restored' ? 'restored' : 'private';
  const now = Date.now();
  for (const movement of days.flatMap(day => day.blocks.flatMap(block => block.movements))) {
    const name = String(movement.name || '').trim();
    const nameKey = exerciseNameKey(name);
    if (!name || !nameKey) continue;
    const previous = byName.get(nameKey);
    if (previous && preserveExisting) continue;
    const catalogMatch = catalogByName.get(nameKey);
    const sources = new Set(previous?.sources || (previous?.source ? [previous.source] : []));
    sources.add(personalSource);
    const record = {
      ...(previous || {}),
      id: previous?.id || `exercise-${uid()}`,
      name: previous?.name || name,
      nameKey,
      muscleGroup: previous?.muscleGroup || movement.muscleGroup || catalogMatch?.muscleGroup || exerciseFocus(movement),
      kind: previous?.kind || movement.kind || catalogMatch?.kind || 'weight',
      timer: previous?.timer ?? movement.timer,
      equipment: previous?.equipment || movement.equipment || catalogMatch?.equipment || '',
      source: sources.has('private') ? 'private' : sources.has('imported') ? 'imported' : 'restored',
      sources: [...sources],
      importedRoutineIds: personalSource === 'imported' ? [...new Set([...(previous?.importedRoutineIds || []), routineId])] : previous?.importedRoutineIds || [],
      createdRoutineIds: personalSource === 'private' ? [...new Set([...(previous?.createdRoutineIds || []), routineId])] : previous?.createdRoutineIds || [],
      ...(personalSource === 'restored' ? { restoredRoutineIds: [...new Set([...(previous?.restoredRoutineIds || []), routineId])] } : {}),
      importedAt: previous?.importedAt || now,
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    changes.set(record.id, record);
    byName.set(nameKey, record);
  }
  return [...changes.values()];
}

async function rebuildExerciseLibrary() {
  await db.updateRoutineLibrary(({ routines, exercises }) => {
    const current = new Map(exercises.map(record => [record.id, record]));
    const changes = [];
    for (const routine of routines.filter(record => !record.deletedAt)) {
      const origin = ['import', 'imported', 'legacy'].includes(routine.source) ? 'imported' :
        ['manual', 'private', 'generated', 'duplicate', 'cycle'].includes(routine.source) ? 'private' : 'restored';
      for (const exercise of routineExerciseChanges(sanitizeRoutine(routine.days), routine.id, origin, [...current.values()], true)) {
        current.set(exercise.id, exercise);
        changes.push(exercise);
      }
    }
    return { exercises: changes };
  });
  state.exercises = (await db.allExercises()).filter(record => !record.deletedAt);
}

async function activateRoutine(id) {
  if (state.session) return toast('Termina o descarta la sesión antes de cambiar de rutina');
  let committed = false;
  try {
    const target = await db.updateRoutineLibrary(({ routines, sessions, personalProfile }) => {
      if (sessions.some(session => !session.finishedAt && !session.deletedAt)) {
        throw new Error('Termina o descarta la sesion antes de cambiar de rutina.');
      }
      const selected = routines.find(record => record.id === id && !record.archived && !record.deletedAt);
      if (!selected) throw new Error('La rutina ya no esta disponible. Abre de nuevo la biblioteca.');
      const activePlans = backupActiveRoutines(routines, []);
      const days = activePlans.length === 1 ? activePlans[0].days : activePlans.length ? [] : state.routine;
      const inheritedProfile = (activePlans.length === 1 ? activePlans[0].profile : null) ||
        (personalProfile ? validatePersonalProfile(personalProfile) : null);
      return {
        routines: [...activePlans.filter(record => record.id !== id).map(record => ({ ...record, active: false })),
          { ...selected, active: true, lastUsedAt: Date.now(),
            ...(!selected.profile && inheritedProfile?.name ? { profile: { ...inheritedProfile } } : {}) }],
        sessions: pendingSessionSnapshots(sessions, days),
        result: selected
      };
    });
    committed = true;
    await loadAll();
    await loadRoutine();
    closeSheet();
    renderHome(); await renderSettings();
    sync.syncQuietly();
    toast(`${target.name || 'Rutina'} · ahora está activa`);
  } catch (error) {
    toast(committed ? 'La rutina se activo, pero no se pudo actualizar la pantalla. Vuelve a abrir la app.' :
      `No se cambio la rutina. ${error?.message || 'Intentalo de nuevo.'}`);
  }
}

async function duplicateRoutine(id) {
  const source = state.routines.find(record => record.id === id);
  if (!source) return;
  await db.putRoutine({
    ...source,
    id: `routine-${uid()}`,
    name: `${source.name || 'Rutina'} · copia`,
    days: structuredClone(source.days),
    active: false,
    archived: false,
    source: 'duplicate',
    createdAt: Date.now(),
    updatedAt: undefined
  });
  await loadRoutine();
  openRoutineCatalog();
  toast('Rutina duplicada');
}

async function archiveRoutine(id) {
  const target = state.routines.find(record => record.id === id);
  if (!target || target.active) return toast('La rutina activa no se puede archivar');
  const revision = state.routineRevisions.get(id) || null;
  const ok = await confirmSheet({ title: 'Archivar rutina', body: `“${target.name || 'Rutina'}” seguirá guardada, pero dejará de aparecer entre tus rutinas disponibles.`, confirm: 'Archivar', cancel: 'Conservar' });
  if (!ok) return;
  await changeRoutineArchive(id, true, revision);
}

async function changeRoutineArchive(id, archived, revision = state.routineRevisions.get(id) || null) {
  let committed = false;
  try {
    await db.updateRoutineLibrary(({ routines }) => {
      const current = routines.find(record => record.id === id);
      verifyRoutineRevision(current, revision);
      if (!current || (archived && current.active)) throw new Error('La rutina ya no está disponible para esta acción.');
      return { routines: [{ ...current, archived, ...(archived ? { active: false } : {}) }] };
    });
    committed = true;
    await loadRoutine();
    openRoutineCatalog();
    toast(archived ? 'Rutina archivada' : 'Rutina restaurada');
  } catch (error) {
    console.error('No se pudo actualizar el archivo de rutinas.', error);
    toast(committed ? 'El cambio se guardó, pero no se pudo actualizar la pantalla. Vuelve a abrir la app.' : error.message);
  }
}

function routineCard(record, archived = false) {
  const stats = routineStats(record.days);
  const label = record.active ? 'Activa' : archived ? 'Archivada' : 'Guardada';
  return `<article class="routine-card${record.active ? ' active' : ''}${archived ? ' archived' : ''}">
    <button class="routine-choice" data-routine-open="${esc(record.id)}" aria-pressed="${record.active}">
      <span class="routine-card-mark" aria-hidden="true">${record.active ? '✓' : '·'}</span>
      <span class="routine-card-copy"><strong>${esc(record.name || 'Rutina sin nombre')}</strong><small>${stats.days} ${stats.days === 1 ? 'día' : 'días'} · ${stats.movements} ${stats.movements === 1 ? 'ejercicio' : 'ejercicios'} · ${stats.sets} series</small></span>
      <span class="routine-card-state">${label}</span>
    </button>
    <div class="routine-card-actions">
      ${archived ? `<button class="routine-card-action" data-routine-restore="${esc(record.id)}" aria-label="Restaurar ${esc(record.name || 'rutina')}" title="Restaurar">${ED_ICON.restore}</button>` : `<button class="routine-card-action" data-routine-edit="${esc(record.id)}" aria-label="Editar ${esc(record.name || 'rutina')}" title="Editar">${ED_ICON.edit}</button><button class="routine-card-action" data-routine-duplicate="${esc(record.id)}" aria-label="Duplicar ${esc(record.name || 'rutina')}" title="Duplicar">${ED_ICON.duplicate}</button>${record.active ? '' : `<button class="routine-card-action danger" data-routine-archive="${esc(record.id)}" aria-label="Archivar ${esc(record.name || 'rutina')}" title="Archivar">${ED_ICON.trash}</button>`}`}
    </div>
  </article>`;
}

async function openRoutineCatalog() {
  const token = sheetToken;
  try {
    await loadRoutine();
  } catch (error) {
    console.error('No se pudo leer la biblioteca de rutinas.', error);
    toast('No se pudo leer la biblioteca. Tus planes se conservan; vuelve a intentar.');
    return;
  }
  if (token !== sheetToken) return;
  const available = state.routines.filter(record => !record.archived);
  const archived = state.routines.filter(record => record.archived);
  openSheet(`<div class="routine-catalog">
    <div class="routine-catalog-heading"><span class="eyebrow">Biblioteca de entrenamiento</span><h2>Mis rutinas</h2><p>Importa los planes que te den en el gym. Conservamos sus ejercicios para que después puedas crear nuevas rutinas con ellos.</p></div>
    ${state.routineConflict ? '<p class="notice warn" role="alert">Hay varias rutinas marcadas como activas. Elige una para resolverlo; las otras y tu historial se conservarán.</p>' : ''}
    <div class="routine-catalog-list">${available.length ? available.map(record => routineCard(record)).join('') : '<div class="routine-catalog-empty"><span>+</span><strong>Aún no tienes rutinas guardadas</strong><small>Importa un PDF o crea la primera desde cero.</small></div>'}</div>
    ${archived.length ? `<details class="routine-archive"><summary>Archivadas · ${archived.length}</summary>${archived.map(record => routineCard(record, true)).join('')}</details>` : ''}
    <div class="routine-catalog-actions"><button class="btn btn-primary" id="btn-catalog-import">Importar rutina del gym</button><button class="btn btn-ghost" id="btn-catalog-generate">Crear rutina con mis ejercicios</button><button class="btn btn-ghost" id="btn-catalog-new">Crear desde cero</button></div>
  </div>`);
  $('#btn-catalog-import').onclick = openImportRoutine;
  $('#btn-catalog-new').onclick = openBlankRoutine;
  $('#btn-catalog-generate').onclick = () => openRoutineGenerator();
  $$('[data-routine-open]').forEach(button => { button.onclick = () => activateRoutine(button.dataset.routineOpen); });
  $$('[data-routine-edit]').forEach(button => { button.onclick = () => {
    const record = state.routines.find(item => item.id === button.dataset.routineEdit);
    if (record) openEditor(record.days, [], { routineId: record.id, name: record.name, activate: record.active, source: record.source || 'manual' });
  }; });
  $$('[data-routine-duplicate]').forEach(button => { button.onclick = () => duplicateRoutine(button.dataset.routineDuplicate); });
  $$('[data-routine-archive]').forEach(button => { button.onclick = () => archiveRoutine(button.dataset.routineArchive); });
  $$('[data-routine-restore]').forEach(button => { button.onclick = () => changeRoutineArchive(button.dataset.routineRestore, false); });
}

function exerciseKindLabel(kind) {
  return kind === 'check' ? 'Marca o tiempo' : 'Registro de peso';
}

function exerciseGroupKey(record) {
  return record.muscleGroup && MUSCLE_GROUPS[record.muscleGroup] ? record.muscleGroup : exerciseFocus(record);
}

function exerciseGroupLabel(record) {
  const group = exerciseGroupKey(record);
  return record.muscleGroup && MUSCLE_GROUPS[record.muscleGroup] ? MUSCLE_GROUPS[group] : group === 'none' ? 'Enfoque automático' : `Automático · ${MUSCLE_GROUPS[group]}`;
}

function exerciseSourceSet(record) {
  return new Set(Array.isArray(record.sources) && record.sources.length ? record.sources : [record.source].filter(Boolean));
}

function allExerciseRecords() {
  return [
    ...EXERCISE_CATALOG.map(record => ({ ...record, source: 'catalog', sources: ['catalog'] })),
    ...personalExerciseViews()
  ];
}

function personalExerciseViews() {
  const groups = new Map();
  const ignored = new Set(['id', 'createdAt', 'updatedAt', 'importedAt', 'importedRoutineIds', 'createdRoutineIds', 'restoredRoutineIds']);
  for (const record of state.exercises) {
    const signature = JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => !ignored.has(key)).sort(([a], [b]) => a.localeCompare(b))));
    const previous = groups.get(signature);
    if (!previous) { groups.set(signature, { ...record, duplicateCount: 1 }); continue; }
    previous.duplicateCount++;
    for (const key of ['importedRoutineIds', 'createdRoutineIds', 'restoredRoutineIds']) {
      previous[key] = [...new Set([...(Array.isArray(previous[key]) ? previous[key] : []), ...(Array.isArray(record[key]) ? record[key] : [])])];
    }
  }
  return [...groups.values()];
}

function exerciseRecordPriority(record) {
  if (record.favorite) return -1;
  const sources = exerciseSourceSet(record);
  if (sources.has('imported')) return 0;
  if (sources.has('restored')) return 0;
  if (sources.has('private')) return 1;
  return 2;
}

function pickerExerciseRecords() {
  const unique = new Map();
  for (const record of allExerciseRecords().sort((first, second) => exerciseRecordPriority(first) - exerciseRecordPriority(second) || first.name.localeCompare(second.name, 'es'))) {
    const key = record.nameKey || exerciseNameKey(record.name);
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

function exerciseSourceLabel(record) {
  if (record.source === 'catalog') return 'Catálogo REAWAKEN';
  const sources = exerciseSourceSet(record);
  if (sources.has('imported') && sources.has('private')) return 'Tuyo · también importado';
  if (sources.has('imported') || record.source === 'import') return 'Importado de una rutina';
  if (sources.has('restored')) return 'Desde una rutina guardada';
  return 'Creado por ti';
}

function exerciseEquipmentValues() {
  return [...new Set([
    ...EXERCISE_CATALOG.map(record => record.equipment),
    ...state.exercises.map(record => record.equipment)
  ].filter(Boolean))].sort((first, second) => first.localeCompare(second, 'es'));
}

function exerciseCard(record, lastUsed) {
  const action = record.source === 'catalog'
    ? `<button class="routine-card-action" data-exercise-copy="${esc(record.id)}" aria-label="Crear ficha personal de ${esc(record.name)}" title="Crear ficha personal">${ED_ICON.plus}</button>`
    : `<button class="routine-card-action" data-exercise-edit="${esc(record.id)}" aria-label="Editar ${esc(record.name)}" title="Editar">${ED_ICON.edit}</button>`;
  const details = [record.gym, record.zone, ...(Array.isArray(record.tags) ? record.tags : [])].filter(Boolean);
  return `<article class="exercise-card">
    <div class="exercise-card-copy"><strong>${record.favorite ? '<span class="exercise-favorite" aria-label="Favorito">★</span> ' : ''}${esc(record.name)}</strong><small>${esc(exerciseGroupLabel(record))} · ${esc(exerciseKindLabel(record.kind))}${record.equipment ? ` · ${esc(record.equipment)}` : ''}</small>${details.length ? `<small>${esc(details.join(' · '))}</small>` : ''}${lastUsed ? `<small>Último registro con este nombre: ${fmtDate(lastUsed, { day: 'numeric', month: 'short' })}</small>` : ''}<span class="exercise-card-source">${esc(exerciseSourceLabel(record))}</span>${record.duplicateCount > 1 ? `<small>${record.duplicateCount} fichas idénticas agrupadas · sin borrar registros</small>` : ''}</div>
    ${action}
  </article>`;
}

function renderExerciseLibrary() {
  const query = exerciseNameKey($('#exercise-search')?.value || '');
  const source = $('#exercise-source')?.value || 'all';
  const group = $('#exercise-group-filter')?.value || 'all';
  const equipment = $('#exercise-equipment-filter')?.value || 'all';
  const organization = $('#exercise-organization')?.value || 'all';
  const dates = new Map();
  for (const session of state.sessions.filter(item => item.finishedAt && !item.deletedAt)) {
    for (const movement of session.routineSnapshot?.blocks.flatMap(block => block.movements) || []) {
      if (session.entries?.[movement.id]?.some(recordedSet)) {
        const key = exerciseNameKey(movement.name);
        dates.set(key, Math.max(dates.get(key) || 0, session.startedAt));
      }
    }
  }
  const records = allExerciseRecords().filter(record => {
    const sources = exerciseSourceSet(record);
    const searchable = [record.name, record.gym, record.zone, ...(Array.isArray(record.tags) ? record.tags : [])].filter(Boolean).join(' ');
    return (!query || exerciseNameKey(searchable).includes(query)) &&
      (organization === 'all' || (organization === 'favorites' ? record.favorite : organization.startsWith('gym:') && record.gym === organization.slice(4))) &&
      (source === 'all' || (source === 'catalog' ? record.source === 'catalog' : sources.has(source) || (source === 'imported' && record.source === 'import'))) &&
      (group === 'all' || exerciseGroupKey(record) === group) &&
      (equipment === 'all' || (equipment === 'none' ? !record.equipment : record.equipment === equipment));
  }).sort((first, second) => Number(Boolean(second.favorite)) - Number(Boolean(first.favorite)) || first.name.localeCompare(second.name, 'es'));
  $('#exercise-library-count').textContent = `${records.length} ${records.length === 1 ? 'ejercicio visible' : 'ejercicios visibles'}`;
  $('#exercise-library-list').innerHTML = records.length
    ? records.map(record => exerciseCard(record, dates.get(exerciseNameKey(record.name)))).join('')
    : '<div class="exercise-library-empty"><span>⌕</span><strong>No hay coincidencias</strong><small>Prueba otro nombre, enfoque u origen.</small></div>';
  $$('[data-exercise-edit]').forEach(button => {
    button.onclick = () => openExerciseForm(state.exercises.find(item => item.id === button.dataset.exerciseEdit));
  });
  $$('[data-exercise-copy]').forEach(button => {
    button.onclick = () => openExerciseForm(null, EXERCISE_CATALOG.find(item => item.id === button.dataset.exerciseCopy));
  });
}

function openExercisePicker(blockIndex, movementIndex) {
  const movement = edDay()?.blocks[blockIndex]?.movements[movementIndex];
  if (!movement) return;
  openSheet(`<div class="exercise-picker">
    <div class="exercise-library-heading"><span class="eyebrow">REAWAKEN · Biblioteca</span><h2>Elegir ejercicio</h2><p>Tus importados aparecen primero; el catálogo base queda disponible debajo.</p></div>
    <label class="field"><span>Buscar</span><input id="exercise-picker-search" autocomplete="off" placeholder="Nombre del ejercicio"></label>
    <p class="exercise-library-count" id="exercise-picker-count"></p>
    <div class="exercise-picker-list" id="exercise-picker-list"></div>
    <button class="btn btn-ghost exercise-picker-manual" id="exercise-picker-manual" type="button">Escribir manualmente</button>
  </div>`);

  const render = () => {
    const query = exerciseNameKey($('#exercise-picker-search')?.value || '');
    const records = pickerExerciseRecords()
      .filter(record => !query || exerciseNameKey(record.name).includes(query));
    $('#exercise-picker-count').textContent = `${records.length} ${records.length === 1 ? 'coincidencia' : 'coincidencias'}`;
    $('#exercise-picker-list').innerHTML = records.length ? records.map(record => `<button class="exercise-picker-option" type="button" data-pick-exercise="${esc(record.id)}">
      <span><strong>${esc(record.name)}</strong><small>${esc(exerciseGroupLabel(record))} · ${esc(exerciseKindLabel(record.kind))}${record.equipment ? ` · ${esc(record.equipment)}` : ''}</small></span><span aria-hidden="true">›</span>
    </button>`).join('') : '<div class="exercise-library-empty"><span>⌕</span><strong>No hay coincidencias</strong><small>Prueba otro nombre.</small></div>';
    $$('#exercise-picker-list [data-pick-exercise]').forEach(button => {
      button.onclick = () => {
        const record = records.find(item => item.id === button.dataset.pickExercise);
        if (!record) return;
        const target = edDay()?.blocks[blockIndex]?.movements[movementIndex];
        if (!target) return closeSheet();
        target.name = record.name;
        target.muscleGroup = record.muscleGroup || '';
        target.kind = record.kind === 'check' ? 'check' : 'weight';
        if (Number.isFinite(record.timer)) target.timer = record.timer;
        else delete target.timer;
        if (record.equipment) target.equipment = record.equipment;
        else delete target.equipment;
        edTouch();
        closeSheet();
        refreshEdDay();
        toast('Ejercicio seleccionado');
      };
    });
  };
  render();
  $('#exercise-picker-search').oninput = render;
  $('#exercise-picker-manual').onclick = closeSheet;
}

function openExerciseLibrary() {
  openSheet(`<div class="exercise-library">
    <div class="exercise-library-heading"><span class="eyebrow">Tu biblioteca de ejercicios</span><h2>Ejercicios</h2><p>Los ejercicios de tus rutinas guardadas se reúnen aquí para reutilizarlos. El catálogo es una fuente opcional.</p></div>
    <p class="training-caption" id="library-storage-note">Las rutinas incluyen sus ejercicios al sincronizar. Los favoritos, las etiquetas y los cambios de estas fichas se guardan en este dispositivo y en tu respaldo JSON; todavía no se sincronizan.</p>
    <div class="exercise-library-filters">
      <label class="field"><span>Buscar</span><input id="exercise-search" autocomplete="off" placeholder="Nombre del ejercicio"></label>
      <div class="field-grid">
        <label class="field"><span>Origen</span><select id="exercise-source"><option value="all">Todos</option><option value="catalog">Catálogo base</option><option value="imported">Importados</option><option value="restored">De rutinas guardadas</option><option value="private">Creados por ti</option></select></label>
        <label class="field"><span>Enfoque</span><select id="exercise-group-filter"><option value="all">Todos</option>${Object.entries(MUSCLE_GROUPS).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Equipo</span><select id="exercise-equipment-filter"><option value="all">Todos</option><option value="none">Sin equipo indicado</option>${exerciseEquipmentValues().map(equipment => `<option value="${esc(equipment)}">${esc(equipment)}</option>`).join('')}</select></label>
      <label class="field"><span>Mi organización</span><select id="exercise-organization"><option value="all">Todos</option><option value="favorites">Favoritos</option>${[...new Set(state.exercises.map(record => record.gym).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')).map(gym => `<option value="gym:${esc(gym)}">${esc(gym)}</option>`).join('')}</select></label>
    </div>
    <p class="exercise-library-count" id="exercise-library-count"></p>
    <div class="exercise-library-list" id="exercise-library-list"></div>
    <button class="btn btn-primary exercise-library-add" id="btn-exercise-new">${ED_ICON.plus} Nuevo ejercicio</button>
  </div>`);
  renderExerciseLibrary();
  $('#exercise-search').oninput = renderExerciseLibrary;
  $('#exercise-source').onchange = renderExerciseLibrary;
  $('#exercise-group-filter').onchange = renderExerciseLibrary;
  $('#exercise-equipment-filter').onchange = renderExerciseLibrary;
  $('#exercise-organization').onchange = renderExerciseLibrary;
  $('#btn-exercise-new').onclick = () => openExerciseForm();
}

async function openExerciseForm(existing = null, preset = null) {
  const token = sheetToken;
  if (existing) {
    try {
      existing = await db.getExercise(existing.id);
      if (!existing || existing.deletedAt) throw new Error('Esta ficha ya no está disponible.');
    } catch (error) {
      console.error('No se pudo abrir la ficha.', error);
      toast(error.message);
      return;
    }
    if (token !== sheetToken) return;
  }
  const base = existing || preset || {};
  const expected = existing ? JSON.stringify(existing) : null;
  const groupOptions = Object.entries(MUSCLE_GROUPS).map(([key, label]) => `<option value="${key}" ${base.muscleGroup === key ? 'selected' : ''}>${esc(label)}</option>`).join('');
  openSheet(`<div class="exercise-form">
    <span class="eyebrow">Biblioteca personal</span>
    <h2>${existing ? 'Editar ejercicio' : 'Nuevo ejercicio'}</h2>
    <p>Esta ficha es privada y no cambia ejercicios ni marcas anteriores. Para otra máquina usa un nombre que la distinga; no necesitas indicar kg o lb.</p>
    <form id="exercise-form">
      <div class="field"><label for="exercise-name">Nombre</label><input id="exercise-name" maxlength="100" autocomplete="off" required value="${esc(base.name || '')}" placeholder="Ej. Press de pecho · máquina A"></div>
      <div class="field-grid">
        <div class="field"><label for="exercise-group">Enfoque</label><select id="exercise-group"><option value="" ${!base.muscleGroup ? 'selected' : ''}>Automático</option>${groupOptions}</select></div>
        <div class="field"><label for="exercise-kind">Registro</label><select id="exercise-kind"><option value="weight" ${base.kind !== 'check' ? 'selected' : ''}>Peso</option><option value="check" ${base.kind === 'check' ? 'selected' : ''}>Marca / tiempo</option></select></div>
      </div>
      <div class="field"><label for="exercise-equipment">Equipo</label><input id="exercise-equipment" maxlength="60" autocomplete="off" value="${esc(base.equipment || '')}" placeholder="Ej. Mancuernas, polea o peso corporal"></div>
      <details class="exercise-organization-fields"><summary>Mi gym y etiquetas · opcional</summary><div class="field-grid">
        <div class="field"><label for="exercise-gym">Mi lugar o colección</label><input id="exercise-gym" maxlength="60" value="${esc(base.gym || '')}" placeholder="Ej. Mi gym"></div>
        <div class="field"><label for="exercise-zone">Zona o piso</label><input id="exercise-zone" maxlength="60" value="${esc(base.zone || '')}" placeholder="Ej. Planta baja"></div></div>
        <div class="field"><label for="exercise-tags">Etiquetas separadas por comas</label><input id="exercise-tags" maxlength="200" value="${esc(Array.isArray(base.tags) ? base.tags.join(', ') : base.tags || '')}" placeholder="Ej. pierna, movilidad"></div>
        <label class="preference-check"><input id="exercise-favorite" type="checkbox" ${base.favorite ? 'checked' : ''}><span>Favorito · mostrar primero</span></label></details>
      <p id="exercise-error" class="correction-error" role="alert"></p>
      <div class="sheet-form-actions"><button class="btn btn-primary" type="submit" id="exercise-save">${existing ? 'Guardar cambios' : 'Guardar ejercicio'}</button><button class="btn btn-ghost" type="button" id="exercise-cancel">Cancelar</button></div>
    </form>
  </div>`);
  $('#exercise-cancel').onclick = closeSheet;
  const form = $('#exercise-form');
  let saving = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    const name = $('#exercise-name').value.trim();
    if (!name) return toast('Escribe un nombre para el ejercicio');
    const errorLabel = $('#exercise-error');
    const controls = [...form.querySelectorAll('button, input, select'), $('#sheet .sheet-dismiss')];
    let committed = false;
    let restoreControls;
    try {
      const now = Date.now();
      const record = {
        ...(existing || {}),
        id: existing?.id || `exercise-${uid()}`,
        name,
        muscleGroup: $('#exercise-group').value,
        kind: $('#exercise-kind').value,
        equipment: $('#exercise-equipment').value.trim(),
        gym: $('#exercise-gym').value.trim(),
        zone: $('#exercise-zone').value.trim(),
        tags: [...new Set($('#exercise-tags').value.split(',').map(tag => tag.trim()).filter(Boolean))],
        favorite: $('#exercise-favorite').checked,
        ...(preset ? { catalogId: preset.id } : {}),
        source: existing?.source || 'private',
        sources: existing?.sources || [existing?.source || 'private'],
        nameKey: exerciseNameKey(name),
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      saving = sheetBusy = true;
      restoreControls = freezeControls(controls);
      await db.updateRoutineLibrary(({ exercises }) => {
        const current = exercises.find(item => item.id === record.id);
        if ((current ? JSON.stringify(current) : null) !== expected) throw new Error('Esta ficha cambió en otra ventana. Vuelve a abrirla antes de guardar.');
        if ((!existing || exerciseNameKey(existing.name) !== record.nameKey) &&
            exercises.some(item => !item.deletedAt && item.id !== record.id && exerciseNameKey(item.name) === record.nameKey)) {
          throw new Error('Ese ejercicio ya está en tu biblioteca. Usa un nombre distinto para identificar otro equipo.');
        }
        return { exercises: [record] };
      });
      committed = true;
      state.exercises = (await db.allExercises()).filter(record => !record.deletedAt);
      await renderSettings();
      sheetBusy = false;
      openExerciseLibrary();
      toast(existing ? 'Ejercicio actualizado' : 'Ejercicio guardado');
    } catch (error) {
      console.error('No se pudo guardar la ficha personal.', error);
      errorLabel.textContent = committed ? 'La ficha se guardó, pero no se pudo actualizar la pantalla. Vuelve a abrir la app.' : error.message || 'No se pudo guardar el ejercicio.';
    } finally {
      saving = sheetBusy = false;
      restoreControls?.();
    }
  };
}

function openImportRoutine() {
  openSheet(`
    <div class="grabber"></div>
    <h2>Importar rutina</h2>
    <button class="btn btn-primary" id="btn-routine-pdf"><img class="trophy-icon" src="icons/clipboard-check.svg" alt="" width="20" height="20">Cargar PDF</button>
    <input id="routine-pdf-file" type="file" accept="application/pdf,.pdf" hidden>
    <p id="routine-import-status" role="status">PDF con texto · Hasta 20 MB. Se revisa antes de guardar.</p>
    <label for="routine-paste">O pega el texto de tu rutina</label>
    <textarea class="paste-area" id="routine-paste" placeholder="Piso: DIA 1 Fuerza y potencia (tren inferior)&#10;1  Sentadilla en Smith  4  5 a 6&#10;2  Prensa + Goblet  3  8+12+15_7"></textarea>
    <button class="btn btn-ghost" id="btn-parse-routine">Interpretar texto</button>
    <button class="btn btn-ghost" id="btn-cancel-routine">Cancelar</button>
  `);
  const token = sheetToken;
  const controller = new AbortController();
  sheetDismiss = () => controller.abort();
  $('#btn-cancel-routine').onclick = closeSheet;
  const review = (extraWarnings = []) => {
    const { days, warnings } = parseRoutineText($('#routine-paste').value);
    if (!days.length) {
      $('#routine-import-status').textContent = 'No se reconocieron días de rutina. Revisa el texto; los encabezados deben indicar Día 1, Día 2…';
      return;
    }
    closeSheet();
    openEditor(days, [...extraWarnings, ...warnings], { name: 'Rutina importada', activate: true, source: 'import' });
    edTouch();  // lo interpretado todavía no existe en disco: salir sin guardar debe avisar
    toast(`${days.length} días interpretados · revísalos`);
  };
  $('#btn-parse-routine').onclick = () => review();
  $('#btn-routine-pdf').onclick = () => $('#routine-pdf-file').click();
  $('#routine-pdf-file').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    const button = $('#btn-routine-pdf'), parse = $('#btn-parse-routine'), paste = $('#routine-paste');
    button.disabled = parse.disabled = true;
    paste.readOnly = true;
    $('#routine-import-status').textContent = 'Leyendo PDF en este dispositivo…';
    try {
      const result = await extractRoutinePdf(file, { signal: controller.signal });
      if (token !== sheetToken) return;
      paste.value = result.text;
      review([...result.warnings, ...(result.emptyPages.length ? [`Páginas sin texto: ${result.emptyPages.join(', ')}. Revisa si falta parte del plan.`] : [])]);
    } catch (error) {
      if (token === sheetToken && error.name !== 'AbortError') $('#routine-import-status').textContent = error.message || 'No se pudo leer el PDF. Prueba pegar su texto.';
    } finally {
      if (token === sheetToken) {
        button.disabled = parse.disabled = false;
        paste.readOnly = false;
        event.target.value = '';
      }
    }
  };
}

function openEditor(days, warnings = [], options = {}) {
  $('#ed-new-cycle').checked = options.newCycle === true;
  state.draftRoutineId = options.routineId || `routine-${uid()}`;
  state.draftBaseline = { id: state.draftRoutineId, revision: state.routineRevisions.get(state.draftRoutineId) || null };
  state.draftRoutineName = options.name || 'Nueva rutina';
  state.draftActivate = options.activate !== false;
  state.draftSource = options.source || 'manual';
  state.draftGeneration = options.generation || null;
  state.draft = JSON.parse(JSON.stringify(days));
  state.draftWarnings = warnings;
  state.edDay = 0;
  state.edDirty = false;
  renderEditor();
  setView('editor');
}

const ED_ICON = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.7L3 8"/><path d="M3 3v5h5"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13M6 12l6 6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5h4v2M6.5 7l.9 12.1A1 1 0 008.4 20h7.2a1 1 0 001-.9L17.5 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>'
};

/** Día que se está editando ahora mismo. */
const edDay = () => state.draft[state.edDay];

function edTotals() {
  let movements = 0, sets = 0;
  for (const d of state.draft) {
    for (const b of d.blocks) {
      movements += b.movements.length;
      sets += b.movements.length * (b.sets || 0);
    }
  }
  return { movements, sets };
}

function edTouch() {
  state.edDirty = true;
  $('#ed-save').classList.remove('clean');
  // Un cambio nuevo invalida el "deshacer" pendiente.
  const t = $('#toast');
  if (t.classList.contains('has-action')) { t.classList.remove('show'); clearTimeout(t._t); }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderEditor() {
  state.edDay = Math.min(Math.max(state.edDay || 0, 0), Math.max(state.draft.length - 1, 0));
  $('#ed-routine-name').value = state.draftRoutineName;
  $('#ed-activate-routine').checked = state.draftActivate;
  renderEdHeader();
  renderEdTabs();
  renderEdDay();
}

function renderEdHeader() {
  const t = edTotals();
  $('#ed-sub').textContent = `${plural(state.draft.length, 'día', 'días')} · ${plural(t.movements, 'ejercicio', 'ejercicios')} · ${plural(t.sets, 'serie', 'series')}`;
  $('#ed-save').classList.toggle('clean', !state.edDirty);
}

function renderEdTabs() {
  $('#ed-tabs').innerHTML = state.draft.map((d, i) => `
    <button class="ed-tab ${i === state.edDay ? 'on' : ''}" data-day-tab="${i}" role="tab" aria-selected="${i === state.edDay}">
      ${esc(d.label || `Día ${i + 1}`)}
    </button>`).join('') +
    `<button class="ed-tab ed-tab-add" data-add-day aria-label="Agregar día">${ED_ICON.plus}</button>`;
}

function openExerciseInfo(movement) {
  if (!movement) return;
  const group = exerciseFocus(movement);
  const secondary = exerciseGroups(movement).filter(key => key !== group);
  openSheet(`<div class="exercise-info">
    <div class="eyebrow">${movement.muscleGroup && movement.muscleGroup !== 'none' ? 'Enfoque asignado' : 'Enfoque orientativo'}</div>
    <h2>${esc(movement.name)}</h2>
    <div class="anatomy-stage">${muscleAtlas(exerciseGroups(movement))}</div>
    <h3>${MUSCLE_GROUPS[group]}</h3>
    ${secondary.length ? `<p>También: ${secondary.map(key => MUSCLE_GROUPS[key]).join(' · ')}</p>` : ''}
    <p>${group === 'none' ? 'No hay un grupo muscular asignado a este ejercicio.' : group === 'cardio' ? 'Trabajo cardiovascular; no se destaca un músculo aislado.' : 'Zona de énfasis, no un mapa de activación medido. La variante y la técnica pueden cambiar los músculos implicados.'}</p>
    <a class="btn btn-primary exercise-image-link" href="${esc(imageSearchUrl(movement.name))}" target="_blank" rel="noopener noreferrer">Google Imágenes <span aria-hidden="true">↗</span></a>
  </div>`);
}

function edMovementHtml(bi, mi, m, count) {
  const p = `${bi}.${mi}`;
  const hasNote = !!(m.note && m.note.trim());
  return `
    <article class="ed-mv" data-mv="${p}" data-movement-id="${esc(m.id)}">
      <div class="ed-mv-top">
        <span class="ed-mvnum">${mi + 1}</span>
        <input class="ed-name" data-path="m.${p}.name" value="${esc(m.name)}" placeholder="Nombre del ejercicio" aria-label="Nombre del ejercicio ${mi + 1}" />
        <button class="ed-picker-trigger" data-pick-mv="${p}" type="button" aria-label="Elegir ejercicio ${mi + 1}" title="Elegir de la biblioteca">${ED_ICON.library}</button>
      </div>
      <div class="ed-mv-row">
        <label class="ed-field ed-field-reps"><span>Reps del plan</span>
          <input data-path="m.${p}.reps" value="${esc(m.reps)}" placeholder="10" />
        </label>
        <div class="ed-seg" data-kind="${p}">
          <button data-k="weight" aria-pressed="${m.kind === 'weight'}" class="${m.kind === 'weight' ? 'on' : ''}">Peso</button>
          <button data-k="check" aria-pressed="${m.kind === 'check' && !m.timer}" class="${m.kind === 'check' && !m.timer ? 'on' : ''}">Check</button>
          <button data-k="time" aria-pressed="${!!m.timer}" class="${m.timer ? 'on' : ''}">Tiempo</button>
        </div>
        <div class="ed-tools">
          <button class="ed-icon" data-move-mv="${p}" data-dir="-1" ${mi === 0 ? 'disabled' : ''} aria-label="Subir ejercicio">${ED_ICON.up}</button>
          <button class="ed-icon" data-move-mv="${p}" data-dir="1" ${mi === count - 1 ? 'disabled' : ''} aria-label="Bajar ejercicio">${ED_ICON.down}</button>
          <button class="ed-icon danger" data-del-mv="${p}" aria-label="Eliminar ejercicio">${ED_ICON.trash}</button>
        </div>
      </div>
      <label class="ed-field ed-timing" ${m.timer ? '' : 'hidden'}><span>Duración · segundos</span>
        <input data-path="m.${p}.timer" value="${m.timer || 20}" inputmode="numeric" aria-label="Duración del ejercicio en segundos" />
      </label>
      <input class="ed-note ${hasNote ? '' : 'ed-hide'}" data-path="m.${p}.note" value="${esc(m.note || '')}" placeholder="Nota para este ejercicio" />
      <label class="ed-field ed-muscle"><span>Grupo muscular</span><select data-path="m.${p}.muscleGroup" aria-label="Grupo muscular de ${esc(m.name)}"><option value="">Automático por nombre</option>${Object.entries(MUSCLE_GROUPS).map(([key, label]) => `<option value="${key}"${m.muscleGroup === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <button class="ed-note-add ${hasNote ? 'ed-hide' : ''}" data-note="${p}">+ Nota</button>
    </article>`;
}

function renderEdDay() {
  const day = edDay();
  const body = $('#ed-body');

  const warn = state.draftWarnings?.length
    ? `<div class="notice warn ed-warn">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v5M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg>
         <div>${state.draftWarnings.map(w => esc(w)).join('<br>')}</div>
         <button class="ed-warn-x" data-drop-warn aria-label="Ocultar aviso">✕</button>
       </div>`
    : '';

  if (!day) {
    body.innerHTML = warn + `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        <p>Tu rutina quedó vacía.<br />Agrega un día para empezar.</p>
      </div>`;
    return;
  }

  const mvCount = day.blocks.reduce((a, b) => a + b.movements.length, 0);
  const setCount = day.blocks.reduce((a, b) => a + b.movements.length * (b.sets || 0), 0);

  const blocks = day.blocks.map((b, bi) => `
    <section class="ed-block" data-b="${bi}">
      <header class="ed-block-head">
        <span class="ed-bnum">Bloque ${bi + 1}</span>
        <span class="ed-bmeta">${plural(b.movements.length, 'ejercicio', 'ejercicios')} · ${plural(b.sets, 'serie', 'series')}</span>
        <div class="ed-tools">
          <button class="ed-icon" data-copy-block="${bi}" aria-label="Duplicar bloque" title="Duplicar bloque">${ED_ICON.duplicate}</button>
          <button class="ed-icon" data-move-block="${bi}" data-dir="-1" ${bi === 0 ? 'disabled' : ''} aria-label="Subir bloque">${ED_ICON.up}</button>
          <button class="ed-icon" data-move-block="${bi}" data-dir="1" ${bi === day.blocks.length - 1 ? 'disabled' : ''} aria-label="Bajar bloque">${ED_ICON.down}</button>
          <button class="ed-icon danger" data-del-block="${bi}" aria-label="Eliminar bloque">${ED_ICON.trash}</button>
        </div>
      </header>

      <div class="ed-fields3">
        <label class="ed-field"><span>Piso</span>
          <input data-path="b.${bi}.floor" value="${esc(b.floor || '')}" placeholder="—" />
        </label>
        <label class="ed-field num"><span>Series</span>
          <input data-path="b.${bi}.sets" value="${b.sets}" inputmode="numeric" placeholder="3" />
        </label>
        <label class="ed-field num"><span>Descanso</span>
          <input data-path="b.${bi}.rest" value="${b.rest ?? ''}" inputmode="numeric" placeholder="seg" />
        </label>
      </div>

      <div class="ed-mvs">${b.movements.map((m, mi) => edMovementHtml(bi, mi, m, b.movements.length)).join('')}</div>

      <button class="ed-add" data-add-mv="${bi}">${ED_ICON.plus} Ejercicio</button>
    </section>`).join('');

  body.innerHTML = warn + `
    <div class="ed-day" key="${state.edDay}">
      <div class="ed-card ed-day-card">
        <div class="ed-daychip">${esc(day.label || `Día ${state.edDay + 1}`)}</div>
        <label class="ed-field lg"><span>Nombre del día</span>
          <input data-path="d.title" value="${esc(day.title)}" placeholder="Entrenamiento" />
        </label>
        <label class="ed-field"><span>Grupo muscular</span>
          <input data-path="d.subtitle" value="${esc(day.subtitle || '')}" placeholder="Tren inferior, espalda…" />
        </label>
        <div class="ed-daystats">
          <span><b>${day.blocks.length}</b> ${day.blocks.length === 1 ? 'bloque' : 'bloques'}</span>
          <span><b>${mvCount}</b> ${mvCount === 1 ? 'ejercicio' : 'ejercicios'}</span>
          <span><b>${setCount}</b> ${setCount === 1 ? 'serie' : 'series'}</span>
        </div>
      </div>

      ${blocks}

      <button class="ed-add ed-add-block" data-add-block>${ED_ICON.plus} Bloque</button>
      <button class="ed-day-del" data-del-day>Eliminar este día</button>
    </div>`;
}

/** Vuelve a pintar el día conservando el scroll: evita el salto al agregar o borrar. */
function refreshEdDay() {
  const y = window.scrollY;
  renderEdHeader();
  renderEdDay();
  window.scrollTo({ top: y });
}

function edGoToDay(i) {
  state.edDay = i;
  renderEdTabs();
  renderEdDay();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Borrado con deshacer: nada del editor se pierde de un solo toque. */
function edRemove(label, restore, remove) {
  remove();
  edTouch();
  refreshEdDay();
  toast(label, {
    label: 'Deshacer',
    fn: () => { restore(); edTouch(); refreshEdDay(); }
  });
}

const newMovement = () => ({ id: uid(), name: '', reps: '10', kind: 'weight' });

const newRoutineDay = number => ({
  id: uid(), label: `Día ${number}`, title: '', subtitle: '',
  accent: DAY_ACCENTS[(number - 1) % DAY_ACCENTS.length],
  blocks: [{ id: uid(), floor: null, sets: 3, movements: [newMovement()] }]
});

function openBlankRoutine() {
  openEditor([newRoutineDay(1)], [], { name: 'Nueva rutina', activate: true, source: 'manual' });
  edTouch();
  toast('Rutina nueva · agrega tu primer ejercicio');
}

function bindEditor() {
  const body = $('#ed-body');

  const resolve = (path) => {
    const p = path.split('.');
    const day = edDay();
    if (p[0] === 'd') return { obj: day, key: p[1] };
    if (p[0] === 'b') return { obj: day.blocks[+p[1]], key: p[2] };
    return { obj: day.blocks[+p[1]].movements[+p[2]], key: p[3] };
  };

  body.addEventListener('input', (e) => {
    const path = e.target.dataset?.path;
    if (!path) return;
    const { obj, key } = resolve(path);

    if (key === 'sets') {
      const n = parseInt(e.target.value, 10);
      obj.sets = Number.isFinite(n) ? Math.min(12, Math.max(1, n)) : 1;
    } else if (key === 'rest' || key === 'timer') {
      const n = parseInt(e.target.value, 10);
      obj[key] = Number.isFinite(n) ? Math.min(7200, Math.max(key === 'timer' ? 1 : 0, n)) : undefined;
    } else if (key === 'floor') {
      obj.floor = e.target.value.trim() || null;
    } else {
      obj[key] = e.target.value;
      if (key === 'name') e.target.closest('.ed-mv')?.classList.remove('invalid');
    }
    edTouch();

    // Los contadores dependen de series y ejercicios: se refrescan sin repintar.
    if (key === 'sets') {
      const block = e.target.closest('.ed-block');
      const b = obj;
      block.querySelector('.ed-bmeta').textContent =
        `${plural(b.movements.length, 'ejercicio', 'ejercicios')} · ${plural(b.sets, 'serie', 'series')}`;
      renderEdHeader();
      updateEdDayStats();
    }
  });

  body.addEventListener('click', (e) => {
    const day = edDay();
    const hit = (attr) => e.target.closest(`[${attr}]`);
    let el;

    if ((el = hit('data-drop-warn'))) {
      state.draftWarnings = [];
      $('.ed-warn')?.remove();
      return;
    }
    if ((el = e.target.closest('.ed-seg button'))) {
      const p = el.parentElement.dataset.kind.split('.');
      const mv = day.blocks[+p[0]].movements[+p[1]];
      mv.kind = el.dataset.k === 'weight' ? 'weight' : 'check';
      if (el.dataset.k === 'time') mv.timer = mv.timer || 20;
      else delete mv.timer;
      el.parentElement.querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b === el);
        b.setAttribute('aria-pressed', String(b === el));
      });
      el.closest('.ed-mv').querySelector('.ed-timing').hidden = el.dataset.k !== 'time';
      edTouch(); haptic();
      return;
    }
    if ((el = hit('data-pick-mv'))) {
      const [blockIndex, movementIndex] = el.dataset.pickMv.split('.').map(Number);
      openExercisePicker(blockIndex, movementIndex);
      return;
    }
    if ((el = hit('data-note'))) {
      const input = el.closest('.ed-mv').querySelector('.ed-note');
      el.classList.add('ed-hide');
      input.classList.remove('ed-hide');
      input.focus();
      return;
    }
    if ((el = hit('data-move-mv'))) {
      const p = el.dataset.moveMv.split('.');
      const list = day.blocks[+p[0]].movements;
      const from = +p[1], to = from + Number(el.dataset.dir);
      if (to < 0 || to >= list.length) return;
      list.splice(to, 0, list.splice(from, 1)[0]);
      edTouch(); haptic(); refreshEdDay();
      return;
    }
    if ((el = hit('data-copy-block'))) {
      const index = Number(el.dataset.copyBlock);
      const copy = JSON.parse(JSON.stringify(day.blocks[index]));
      copy.id = uid();
      copy.movements.forEach(movement => { movement.id = uid(); });
      day.blocks.splice(index + 1, 0, copy);
      edTouch(); haptic(); refreshEdDay();
      toast('Bloque duplicado');
      return;
    }
    if ((el = hit('data-move-block'))) {
      const from = +el.dataset.moveBlock, to = from + Number(el.dataset.dir);
      if (to < 0 || to >= day.blocks.length) return;
      day.blocks.splice(to, 0, day.blocks.splice(from, 1)[0]);
      edTouch(); haptic(); refreshEdDay();
      return;
    }
    if ((el = hit('data-del-mv'))) {
      const p = el.dataset.delMv.split('.');
      const list = day.blocks[+p[0]].movements;
      const i = +p[1];
      const item = list[i];
      edRemove('Ejercicio eliminado', () => list.splice(i, 0, item), () => list.splice(i, 1));
      return;
    }
    if ((el = hit('data-del-block'))) {
      const i = +el.dataset.delBlock;
      const item = day.blocks[i];
      edRemove('Bloque eliminado', () => day.blocks.splice(i, 0, item), () => day.blocks.splice(i, 1));
      return;
    }
    if (hit('data-del-day')) {
      const i = state.edDay;
      const item = state.draft[i];
      state.draft.splice(i, 1);
      state.edDay = Math.max(0, Math.min(i, state.draft.length - 1));
      edTouch();
      renderEditor();
      window.scrollTo({ top: 0 });
      toast('Día eliminado', {
        label: 'Deshacer',
        fn: () => { state.draft.splice(i, 0, item); state.edDay = i; edTouch(); renderEditor(); }
      });
      return;
    }
    if ((el = hit('data-add-mv'))) {
      day.blocks[+el.dataset.addMv].movements.push(newMovement());
      edTouch(); haptic(); refreshEdDay();
      const mvs = $$(`.ed-block[data-b="${el.dataset.addMv}"] .ed-name`);
      mvs.at(-1)?.focus();
      return;
    }
    if (hit('data-add-block')) {
      day.blocks.push({ id: uid(), floor: null, sets: 3, movements: [newMovement()] });
      edTouch(); haptic(); refreshEdDay();
      $$('.ed-block').at(-1)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  $('#ed-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-day-tab]');
    if (tab) { haptic(); edGoToDay(+tab.dataset.dayTab); return; }
    if (e.target.closest('[data-add-day]')) {
      const n = Math.max(state.draft.length, ...state.draft.map(day => Number(day.label.match(/\d+/)?.[0]) || 0)) + 1;
      state.draft.push(newRoutineDay(n));
      state.edDay = state.draft.length - 1;
      edTouch(); haptic();
      renderEditor();
      window.scrollTo({ top: 0 });
      $('.ed-day-card input')?.focus();
    }
  });
}

function updateEdDayStats() {
  const day = edDay();
  if (!day) return;
  const stats = $('.ed-daystats');
  if (!stats) return;
  const mv = day.blocks.reduce((a, b) => a + b.movements.length, 0);
  const sets = day.blocks.reduce((a, b) => a + b.movements.length * (b.sets || 0), 0);
  stats.innerHTML = `<span><b>${day.blocks.length}</b> ${day.blocks.length === 1 ? 'bloque' : 'bloques'}</span>` +
    `<span><b>${mv}</b> ${mv === 1 ? 'ejercicio' : 'ejercicios'}</span>` +
    `<span><b>${sets}</b> ${sets === 1 ? 'serie' : 'series'}</span>`;
}

/** Marca los ejercicios sin nombre y salta al primero. Devuelve true si todo está bien. */
function edValidate() {
  const ids = new Set();
  for (const day of state.draft) {
    for (const item of [day, ...day.blocks, ...day.blocks.flatMap(block => block.movements)]) {
      if (ids.has(item.id)) { toast('Hay elementos repetidos en la rutina. Revisa la importación.'); return false; }
      ids.add(item.id);
    }
  }
  for (let di = 0; di < state.draft.length; di++) {
    for (const b of state.draft[di].blocks) {
      if (b.movements.some(m => !m.name.trim())) {
        if (state.edDay !== di) edGoToDay(di); else renderEdDay();
        $$('#ed-body .ed-mv').forEach(el => {
          const [bi, mi] = el.dataset.mv.split('.').map(Number);
          if (!state.draft[di].blocks[bi].movements[mi].name.trim()) el.classList.add('invalid');
        });
        $('#ed-body .ed-mv.invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast('Ponle nombre a los ejercicios marcados');
        return false;
      }
    }
  }
  return true;
}

/* ---------- Stats / InBody ---------- */

/** Atributos que se muestran como barras, medidos contra tu propio histórico. */
const ATTRS = [
  { key: 'smm', label: 'Músculo · kg' },
  { key: 'pbf', label: 'Grasa corporal' },
  { key: 'tbw', label: 'Agua · L' },
  { key: 'protein', label: 'Proteína · kg' },
  { key: 'bmr', label: 'Metabolismo · kcal' }
];

function renderBody() {
  renderInBodyReminder();
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
  const score = latest.values.score;
  const weeklySessions = state.sessions.filter(session => session.finishedAt && session.startedAt >= weekStart(Date.now())).length;
  const weekProgress = Math.min(100, Math.round(weeklySessions / state.profile.daysPerWeek * 100));
  const scoreDelta = Number.isFinite(score) && Number.isFinite(prev?.values.score) ? score - prev.values.score : null;
  const profileHtml = `<section class="player-status" aria-label="Estado físico y actividad">
    <div class="player-heading"><div><span class="eyebrow">Perfil de entrenamiento</span><h2>${esc(state.profile.name.split(/\s+/)[0])}</h2></div><div class="player-emblem" aria-label="Puntuación InBody ${Number.isFinite(score) ? score : 'sin datos'}"><span>INBODY</span><strong>${Number.isFinite(score) ? score : '—'}</strong><small>PUNTOS</small></div></div>
    <div class="player-reading"><span>${fmtDate(latest.at, { day: 'numeric', month: 'short', year: 'numeric' })}</span><span>${scoreDelta === null ? 'Sin comparación anterior' : `${scoreDelta > 0 ? '+' : ''}${scoreDelta} puntos vs. anterior`}</span></div>
    <div class="weekly-mission"><div><h3>Objetivo semanal</h3><strong>${weeklySessions}<span> / ${state.profile.daysPerWeek} sesiones</span></strong></div><div class="mission-track" style="--mission-step:${100 / state.profile.daysPerWeek}%" role="progressbar" aria-label="Objetivo semanal de sesiones" aria-valuemin="0" aria-valuemax="${state.profile.daysPerWeek}" aria-valuenow="${Math.min(weeklySessions, state.profile.daysPerWeek)}"><span style="width:${weekProgress}%"></span></div></div>
  </section>`;

  const heroHtml = INBODY_FIELDS.filter(f => f.primary).map(f => {
    const v = latest.values[f.key];
    const p = prev?.values[f.key];
    let delta = '<div class="md flat">—</div>';
    if (v !== undefined && p !== undefined) {
      const d = +(v - p).toFixed(1);
      const cls = d === 0 || f.key === 'weight' ? 'flat' : (f.better === 'down' ? (d < 0 ? 'good' : 'bad') : (d > 0 ? 'good' : 'bad'));
      delta = `<div class="md ${cls}">${d > 0 ? '↑' : d < 0 ? '↓' : ''} ${Math.abs(d).toFixed(1)}${f.percent ? ' pp' : ''}</div>`;
    }
    return `<div class="metric">
        <div class="mv">${esc(formatValue(f.key, v))}</div>
        <div class="ml">${esc(f.label)}${f.key === 'weight' || f.key === 'smm' ? ' · kg' : ''}</div>
        ${delta}
      </div>`;
  }).join('');

  const attrsHtml = ATTRS.map(a => {
    const vals = list.map(m => m.values[a.key]).filter(Number.isFinite);
    const v = latest.values[a.key];
    if (v === undefined || vals.length < 2) return '';
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min;
    const raw = span ? (v - min) / span : 0.5;
    const pct = Math.round(raw * 100);
    const p = prev?.values[a.key];
    const d = p !== undefined ? +(v - p).toFixed(1) : null;
    const color = a.key === 'smm' ? 'var(--green)' : a.key === 'pbf' ? 'var(--orange)' : 'var(--cyan)';
    return `<div class="attr">
        <div class="attr-head">
          <span class="an">${esc(a.label)}</span>
          <span class="av">${esc(formatValue(a.key, v))}</span>
          ${d !== null ? `<span class="ad md flat">${d > 0 ? '+' : ''}${d}${a.key === 'pbf' ? ' pp' : ''}</span>` : ''}
        </div>
        <div class="attr-track" ${span ? `role="meter" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${v}"` : 'role="img"'} aria-label="${esc(a.label)}: ${span ? 'posición en tu histórico' : 'sin variación'}"><div class="attr-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="attr-range"><span>Mín. ${esc(formatValue(a.key, min))}</span><span>${span ? `Máx. ${esc(formatValue(a.key, max))}` : 'Sin variación'}</span></div>
      </div>`;
  }).join('');

  const rest = INBODY_FIELDS.filter(f => !f.primary && latest.values[f.key] !== undefined).map(f =>
    `<div class="measure-row"><span class="mr-body"><strong style="text-transform:none">${esc(f.label)}</strong></span>
      <span style="font-size:16px;font-weight:700;font-variant-numeric:tabular-nums">${esc(formatValue(f.key, latest.values[f.key]))}</span></div>`
  ).join('');

  slot.innerHTML = `
    ${profileHtml}
    <h2 class="section-title">Composición corporal</h2>
    <div class="metric-hero">${heroHtml}</div>

    ${attrsHtml ? `<section class="attribute-panel"><h2 class="section-title">Atributos · Histórico personal</h2><div class="attrs">${attrsHtml}</div></section>` : ''}

    <h2 class="section-title">Evolución</h2>
    <div class="card chart-card">
      <div class="chart-chips">
        ${INBODY_FIELDS.filter(f => list.some(m => m.values[f.key] !== undefined)).slice(0, 6)
          .map(f => `<button class="chip${state.chartMetric === f.key ? ' on' : ''}" data-metric="${f.key}">${esc(f.label)}</button>`).join('')}
      </div>
      ${sparkline(state.chartMetric)}
    </div>

    <details class="stats-details"><summary>Datos de la última medición <span>${fmtDate(latest.at, { day: 'numeric', month: 'short' })}</span></summary><div class="list-card">${rest || '<div class="measure-row"><span class="mr-body"><small>Sin datos adicionales</small></span></div>'}</div></details>

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
    c.onclick = () => {
      state.chartMetric = c.dataset.metric;
      $$('.chip[data-metric]').forEach(button => {
        button.classList.toggle('on', button === c);
        button.setAttribute('aria-pressed', String(button === c));
      });
      const chart = $('.chart-card .spark');
      if (chart) chart.outerHTML = sparkline(state.chartMetric);
      else renderBody();
    };
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

  const W = 360, H = 150, PAD_X = 30, PAD_TOP = 24, PAD_BOT = 28;
  const ys = pts.map(p => p.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = (max - min) || 1;
  const timeSpan = pts.at(-1).x - pts[0].x || 1;
  const sx = i => PAD_X + ((pts[i].x - pts[0].x) / timeSpan) * (W - PAD_X * 2);
  const sy = v => PAD_TOP + (1 - (v - min) / span) * (H - PAD_TOP - PAD_BOT);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(pts.length - 1).toFixed(1)},${H - PAD_BOT} L${PAD_X},${H - PAD_BOT} Z`;

  const dots = pts.map((p, i) => `
    <circle class="dot" cx="${sx(i).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3"><title>${esc(fmtDate(p.x))}: ${esc(formatValue(key, p.y))}</title></circle>
    ${pts.length <= 5 || i === 0 || i === pts.length - 1 ? `<text class="val" x="${sx(i).toFixed(1)}" y="${(sy(p.y) - 10).toFixed(1)}" text-anchor="middle">${esc(formatValue(key, p.y))}</text>
    <text class="lbl" x="${sx(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${new Date(p.x).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</text>` : ''}`).join('');

  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(fieldMeta(key).label)}: ${esc(formatValue(key, pts[0].y))} a ${esc(formatValue(key, pts.at(-1).y))}">
      <defs><linearGradient id="sparkgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      ${dots}
    </svg>`;
}

function measureFieldsHtml(values, parsedKeys = [], fixedKeys = [], fields = INBODY_FIELDS) {
  return `<div class="field-grid">${fields.map(f => {
    const cls = fixedKeys.includes(f.key) ? ' fixed' : (parsedKeys.includes(f.key) ? ' parsed' : '');
    return `
    <div class="field${cls}">
      <label for="fld-${f.key}">${esc(f.label)}${f.percent ? ' (%)' : ''}${fixedKeys.includes(f.key) ? ' · corregido' : ''}</label>
      <input id="fld-${f.key}" data-field="${f.key}" inputmode="decimal" autocomplete="off"
             value="${esc(values[f.key] ?? '')}" placeholder="—" />
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
    const lastHeight = state.measures.at(-1)?.values.height;
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
    ${parsedKeys.length ? `<p>${parsedKeys.length} datos detectados${fixedKeys.length ? ` · ${fixedKeys.length} por revisar` : ''}</p>` : ''}
    <div id="checks-slot">${checksHtml(measure.values)}</div>
    <div class="field" style="margin-bottom:14px">
      <label for="fld-date">Fecha de la prueba</label>
      <input id="fld-date" type="date" value="${dateStr}" style="font-size:17px" />
    </div>
    ${measureFieldsHtml(measure.values, parsedKeys, fixedKeys, INBODY_FIELDS.filter(field => field.primary))}
    <details class="measure-details" ${fixedKeys.some(key => !fieldMeta(key).primary) ? 'open' : ''}><summary>Datos adicionales</summary>${measureFieldsHtml(measure.values, parsedKeys, fixedKeys, INBODY_FIELDS.filter(field => !field.primary))}</details>
    <div class="sheet-form-actions"><button class="btn btn-primary" id="btn-save-measure">Guardar medición</button><button class="btn btn-ghost" id="btn-cancel-measure">Cancelar</button></div>
    ${measure.id ? '<button class="session-delete" id="btn-del-measure">Eliminar medición</button>' : ''}
  `);

  const readValues = () => {
    const values = {};
    $$('#sheet input[data-field]').forEach(inp => {
      const raw = inp.value.replace(',', '.').trim();
      if (raw === '') return;
      const n = Number(raw);
      if (Number.isFinite(n)) values[inp.dataset.field] = n;
    });
    return values;
  };

  $$('#sheet input[data-field]').forEach(inp => {
    inp.addEventListener('input', () => { inp.removeAttribute('aria-invalid'); $('#checks-slot').innerHTML = checksHtml(readValues()); });
  });

  $('#btn-cancel-measure').onclick = closeSheet;

  let savingMeasure = false;
  $('#btn-save-measure').onclick = async () => {
    if (savingMeasure) return;
    const invalid = $$('#sheet input[data-field]').find(input => {
      const raw = input.value.replace(',', '.').trim();
      const meta = fieldMeta(input.dataset.field);
      const value = Number(raw);
      return raw && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(value) || (meta.range && (value < meta.range[0] || value > meta.range[1])));
    });
    if (invalid) {
      const details = invalid.closest('details');
      if (details) details.open = true;
      invalid.setAttribute('aria-invalid', 'true');
      invalid.focus();
      toast(`Revisa ${fieldMeta(invalid.dataset.field).label.toLowerCase()}`);
      return;
    }
    const values = readValues();
    if (!Object.keys(values).length) return toast('Captura al menos un dato');

    const d = $('#fld-date').value;
    if (!d || !Number.isFinite(new Date(`${d}T12:00:00`).getTime())) { $('#fld-date').focus(); return toast('Selecciona una fecha válida'); }
    const at = d ? new Date(`${d}T12:00:00`).getTime() : measure.at;
    const sameDay = state.measures.find(m => m.id !== measure.id &&
      new Date(m.at).toDateString() === new Date(at).toDateString());
    const saveButton = $('#btn-save-measure');
    savingMeasure = true;
    saveButton.disabled = true;
    try {
    if (sameDay) {
      const ok = await confirmSheet({
        title: 'Ya hay una medición ese día',
        body: 'Se reemplazará la que ya tenías con esa fecha.',
        confirm: 'Reemplazar', cancel: 'Cancelar'
      });
      if (!ok) return;
    }

    const rec = { id: sameDay?.id || measure.id || uid(), at, values };
    await db.putMeasure(rec);
    if (sameDay && measure.id && measure.id !== sameDay.id) await db.deleteMeasure(measure.id);
    state.measures = state.measures.filter(m => m.id !== rec.id && m.id !== measure.id).concat(rec).sort((a, b) => a.at - b.at);
    closeSheet();
    renderBody();
    toast('Medición guardada');
    sync.syncQuietly();
    } catch {
      toast('No se pudo guardar la medición. Revisa el almacenamiento.');
    } finally {
      savingMeasure = false;
      saveButton.disabled = false;
    }
  };

  if (measure.id) {
    $('#btn-del-measure').onclick = async () => {
      const accepted = await confirmSheet({ title: 'Eliminar medición', body: 'Se eliminará este InBody. El cambio también se enviará a tus dispositivos al sincronizar.', confirm: 'Eliminar', cancel: 'Conservar', danger: true });
      if (!accepted) return;
      await db.deleteMeasure(measure.id);
      state.measures = state.measures.filter(m => m.id !== measure.id);
      closeSheet();
      renderBody();
      toast('Medición eliminada', { label: 'Deshacer', fn: async () => {
        const restored = { ...measure };
        delete restored.deletedAt;
        await db.putMeasure(restored);
        state.measures.push(restored);
        state.measures.sort((first, second) => first.at - second.at);
        renderBody();
      } });
    };
  }
}

function openMeasureSheet(measure) {
  if (!measure) return;
  const units = { weight: 'kg', smm: 'kg', bfm: 'kg', ffm: 'kg', tbw: 'L', protein: 'kg', minerals: 'kg', bmr: 'kcal', intake: 'kcal', idealWeight: 'kg', weightCtrl: 'kg', fatCtrl: 'kg', muscleCtrl: 'kg', height: 'cm' };
  openSheet(`<h2>Medición InBody</h2><p>${fmtDate(measure.at, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
    <dl class="measurement-summary">${INBODY_FIELDS.filter(field => measure.values[field.key] !== undefined).map(field => `<div><dt>${esc(field.label)}</dt><dd>${esc(formatValue(field.key, measure.values[field.key]))}${units[field.key] ? ` <small>${units[field.key]}</small>` : ''}</dd></div>`).join('')}</dl>
    <div class="sheet-form-actions"><button class="btn btn-primary" id="measure-edit">Editar medición</button><button class="btn btn-ghost" id="measure-close">Cerrar</button></div>`);
  $('#measure-edit').onclick = () => openMeasureForm(measure, []);
  $('#measure-close').onclick = closeSheet;
}

/* ---------- Terminar sesión ---------- */

function achievementState() {
  return trainingAchievements(state.sessions, session => {
    if (sessionDay(session)) return sessionProgress(session);
    return { done: Object.values(session.entries || {}).filter(Array.isArray).flat().filter(recordedSet).length, total: 0 };
  }, state.profile.daysPerWeek);
}

function openFunctions() {
  const topics = [
    ['Crear rutina con mis ejercicios', 'De tus planes del gym a un borrador propio', 'Importa el PDF o texto del gym, revísalo y guarda la rutina. Después, en Mis rutinas, puedes crear una propuesta usando por defecto solo los ejercicios de tus planes guardados. Incluir fichas personales o catálogo requiere elegir esa fuente. El borrador se revisa en el editor y se guarda como una rutina nueva, inicialmente inactiva.', 'No usa IA ni prescribe cargas. Conserva series, reps y descansos de las fuentes y avisa si faltan opciones. Las rutinas sincronizadas incluyen sus ejercicios; los favoritos y demás detalles de las fichas solo están en este dispositivo y en el respaldo JSON.', null],
    ['Descanso y pantalla', 'Tus preferencias, sin tocar el plan', 'Desde Ajustes o el menú del entrenamiento puedes guardar 30, 45, 60 segundos o un valor personalizado. El descanso del bloque tiene prioridad; cambiar la preferencia no reinicia el contador actual. La pantalla puede mantenerse despierta durante la vista de entrenamiento si activas la opción y el navegador lo permite.', 'El descanso sigue siendo silencioso. El sistema puede liberar la pantalla y no se garantiza en segundo plano. Estas preferencias se conservan en respaldos, pero todavía no se sincronizan con Supabase.', null],
    ['Mi gym y favoritos', 'Fichas privadas y fáciles de encontrar', 'En Ejercicios puedes crear una ficha personal desde el catálogo o editar una tuya. Lugar o colección, zona, etiquetas y favoritos son opcionales. Los favoritos aparecen primero en el selector; puedes buscar por estos campos y filtrar por lugar. El último registro se obtiene del historial con ese nombre.', 'No modifica rutinas ni marcas anteriores, no adivina unidades ni confirma disponibilidad de equipo. Usa nombres diferentes para distinguir máquinas; las fichas se conservan en el respaldo, no se sincronizan todavía.', null],
    ['Actividad anual', 'Tu constancia en doce meses', 'En Historial, Tu año de entrenamiento reúne las sesiones finalizadas por mes. Elige otro año o toca un mes para abrir sus fechas y registros. Varias sesiones el mismo día cuentan por separado, pero ese día cuenta una sola vez como activo.', 'Es actividad registrada, no intensidad ni cumplimiento de objetivos. No borra ni reinicia el historial al cambiar de año.', null],
    ['Progreso por ejercicio', 'Tus cargas a lo largo del tiempo', 'Desde Historial abre Tu progreso por ejercicio, busca un movimiento y consulta su curva y sus sesiones. Cada punto es la mayor carga registrada en una sesión con las mismas reps y contexto. Al terminar también verás los PR superados, con marca anterior y nueva; solo se muestra el mejor de cada contexto. No necesitas identificar kg o lb para seguir el número de tu equipo habitual.', 'No es un nivel de fuerza ni una estimación de 1RM. No puede detectar un cambio de máquina o unidad que no registraste; tampoco inventa metadatos de sesiones antiguas. Corregir o borrar registros recalcula estas referencias sin repetir celebraciones.', null],
    ['Corregir pesos anteriores', 'Una serie, sin rehacer el entrenamiento', 'Abre una fecha en Historial, entra a la sesión y toca Corregir debajo del peso. Revisa el valor anterior, escribe el correcto y guarda. La fecha, las reps, las notas, el resto de las series y los datos del equipo se conservan. Los récords y la curva vuelven a calcularse desde el historial corregido.', 'Cancelar no guarda. Si otro dispositivo o ventana cambió el registro local, debes volver a abrirlo; un error conserva el valor escrito para reintentar. Guardado local no significa sincronización remota confirmada.', null],
    ['Rutina desde PDF', 'Del documento a un plan editable', 'Carga el PDF de tu coach: la app extrae los días, ejercicios, series y reps en este dispositivo. Revisa los avisos y corrige el resultado antes de guardar. Un nuevo ciclo separa el balance del plan anterior sin cambiar tus sesiones pasadas.', 'Necesita un PDF con texto; para un escaneo usa Live Text y pega el contenido. No interpreta todos los diseños ni sustituye la revisión.', 'guide-pdf.png'],
    ['Sugerencias de carga', 'Subir, mantener o bajar; sin cifras', 'Puede sugerir subir tras tres entrenamientos completos en días distintos, con todas las series en las reps altas del plan y la misma carga registrada. Busca en las últimas seis semanas y exige un registro en las últimas dos. Si la última serie quedó por debajo del objetivo, sugiere bajar; en ejercicios asistidos habla de más o menos ayuda.', 'No convierte kg y lb ni cambia el peso anterior del campo. Comprueba que sigues usando el mismo equipo y unidad: no puede detectar un cambio que no quedó registrado. Las reps precargadas no demuestran facilidad; sube solo si mantienes una técnica cómoda.', 'guide-load.png'],
    ['Muscle Battery', 'La carga reciente de cada grupo muscular', 'En Tu balance, Muscle Battery reúne las series de fuerza de tus sesiones finalizadas durante los últimos 14 días. Distribuye el trabajo entre músculos principales y secundarios y reduce su peso con el tiempo. Muestra tres estados: carga reciente elevada, recuperación en curso o menor carga reciente.', 'Es una estimación, no una batería real ni permiso para volver a entrenar. No conoce tu sueño, alimentación, dolor o fatiga; sin registros suficientes no puede valorar una zona. El registro sencillo no mide esfuerzo.', null],
    ['Lo que noté', 'Cambios sostenidos, con su historial detrás', 'En Tu balance aparecen observaciones cuando la primera serie de un ejercicio reúne seis sesiones comparables en seis días distintos, a lo largo de al menos dos semanas. Compara las tres anteriores con las tres recientes y busca un cambio de carga de al menos un 5%, sin solapamiento entre grupos. Puedes abrir las sesiones que sustentan cada observación.', 'Separa equipo, unidad, reps y su origen: precargadas o ajustadas. No analiza ejercicios asistidos ni demuestra que ganaste o perdiste fuerza. Puede no mostrar nada si falta historial o no hay un cambio claro; no inventa una conclusión.', null],
    ['Tu balance', 'Tu entrenamiento por día, semana, mes o ciclo', 'Reúne sesiones, tiempo registrado, series realizadas y participación muscular del periodo. También muestra las reps que ajustaste frente al plan. Si esos ajustes se repiten, puede sugerir revisar el objetivo con tu coach.', 'El cumplimiento cuenta series registradas, no mide técnica ni intensidad. Dejar las reps precargadas no activa la revisión semanal; la app no cambia el plan automáticamente.', null],
    ['Mapa muscular', 'Los músculos de cada ejercicio', 'La ficha del ejercicio señala las zonas principales y secundarias y ofrece un enlace a Google Imágenes. El mapa de cada día reúne los grupos musculares de tu rutina para mostrar su enfoque.', 'Es orientativo: la técnica y la variante influyen. Identificar los músculos de un ejercicio no indica si están recuperados ni sustituye una valoración profesional.', null],
    ['Evolución InBody', 'Mediciones que puedes comparar', 'Pega el texto de tu hoja InBody para revisar y guardar sus mediciones. Stats reúne peso, músculo, grasa y puntuación, y dibuja su evolución entre fechas. Puedes comprobar el resumen antes de confirmar los datos.', 'La lectura depende del texto disponible y puede necesitar correcciones. Las tendencias reflejan mediciones, no resultados atribuibles a una sola sesión.', 'guide-inbody.png'],
    ['Trofeos y etapas', 'Tu colección crece contigo', 'Ocho etapas reúnen tus insignias de entrenamiento. Cuatro medallas de una etapa abren la siguiente. Cada insignia guarda su requisito y tu avance; al terminar una sesión aparecen los nuevos logros que ganaste.', 'Se calculan desde tu historial: no necesitas registrar marcas máximas ni entrenar todos los días. Si eliminas sesiones, el progreso se recalcula.', null]
  ];
  openSheet(`<h2>Funciones especiales</h2><div class="functions-guide">${topics.map(([title, subtitle, description, limitation, image]) => `<details><summary><span>${esc(title)}<small>${esc(subtitle)}</small></span></summary>${image ? `<figure class="function-example"><img src="data/${image}" width="440" height="320" loading="lazy" alt="Ejemplo de ${esc(title)} con datos ficticios"><figcaption>Ejemplo · Datos ficticios</figcaption></figure>` : ''}<p>${esc(description)}</p><p class="function-limit">${esc(limitation)}</p></details>`).join('')}</div>`);
}

function openAchievements() {
  const { stages, current } = achievementState();
  const categories = ['Sesiones', 'Días', 'Series', 'Planes', 'Semanas', 'Constancia'];
  openSheet(`<div class="trophy-room"><div class="trophy-room-heading"><h2>Trofeos</h2><span class="eyebrow">Etapa ${current.index + 1} · ${esc(current.title)}</span></div>
    <nav class="trophy-path" aria-label="Etapas de la colección">${stages.map(stage => `<button type="button" data-stage="${stage.index}" class="path-node${stage.completed ? ' cleared' : ''}${stage.available ? '' : ' locked'}" aria-label="${esc(stage.title)}: ${stage.completed ? 'superada' : stage.available ? 'actual' : 'bloqueada'}" aria-pressed="${stage.index === current.index}" ${stage.index === current.index ? 'aria-current="step"' : ''} title="${esc(stage.title)}"><span>${stage.index + 1}</span></button>`).join('')}</nav>
    <div id="trophy-stage"></div></div>`);
  const renderStage = index => {
    const stage = stages[index];
    const stageStatus = stage.completed ? 'Etapa superada' : stage.available ? `${stage.count} / 4 medallas para ${index === stages.length - 1 ? 'completar Legado' : 'avanzar'}` : `Se abre al superar ${stages[index - 1].title}`;
    $('#trophy-stage').innerHTML = `<section class="trophy-world" data-rank="${index}">
      <header class="trophy-world-header"><span class="eyebrow">${stage.available ? 'Colección' : 'Etapa bloqueada'} ${String(index + 1).padStart(2, '0')}</span><h3>${esc(stage.title)}</h3><div class="stage-gems" aria-hidden="true">${Array.from({ length: 4 }, (_, gem) => `<i class="${gem < stage.count ? 'earned' : ''}"></i>`).join('')}</div><p>${esc(stageStatus)}</p></header>
      <div class="medal-grid">${stage.badges.map((badge, badgeIndex) => `<button type="button" class="medal${badge.unlocked ? ' earned' : ''}" data-badge="${badgeIndex}" aria-expanded="false" aria-controls="medal-detail" aria-label="${esc(badge.title)}: ${badge.unlocked ? 'conseguido' : stage.available ? 'pendiente' : 'bloqueado'}" style="--medal-order:${badgeIndex}"><span class="medal-art" data-medal="${badgeIndex}" aria-hidden="true"><img class="trophy-icon" src="icons/${badgeIndex === 3 ? 'clipboard-check' : 'trophy'}.svg" alt="" width="30" height="30"><b>${badge.target}</b>${badge.unlocked ? '<span class="medal-check">✓</span>' : ''}</span><strong>${esc(badge.title)}</strong><small>${categories[badgeIndex]}</small></button>`).join('')}</div>
      <div id="medal-detail" class="medal-reveal" hidden></div></section>`;
    $$('.path-node').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.stage) === index)));
    $$('.medal').forEach(button => {
      button.onclick = () => {
        const expanded = button.getAttribute('aria-expanded') === 'true';
        $$('.medal').forEach(item => item.setAttribute('aria-expanded', 'false'));
        const detail = $('#medal-detail');
        if (expanded) {
          disclose(detail, false);
          return;
        }
        button.setAttribute('aria-expanded', 'true');
        const badge = stage.badges[Number(button.dataset.badge)];
        disclose(detail, true, () => {
          detail.innerHTML = `<div class="medal-detail"><span class="eyebrow">${badge.unlocked ? 'Conseguido' : stage.available ? 'En progreso' : 'Bloqueado'}</span><h4>${esc(badge.title)}</h4><p>${esc(badge.description)}</p><div><progress value="${badge.value}" max="${badge.target}" aria-label="${esc(badge.title)}"></progress><b>${badge.value} / ${badge.target}</b></div>${!stage.available ? `<small>${esc(stageStatus)}</small>` : ''}</div>`;
        }, () => {
          if (button.getAttribute('aria-expanded') !== 'true' || !$('#sheet-backdrop').classList.contains('show')) return;
          const sheet = $('#sheet');
          const bounds = detail.getBoundingClientRect();
          const visibleTop = $('.sheet-toolbar').getBoundingClientRect().bottom + 12;
          const overflow = bounds.bottom - sheet.getBoundingClientRect().bottom + 20;
          const distance = Math.min(overflow, bounds.top - visibleTop);
          if (distance > 1) sheet.scrollBy({ top: distance, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        });
        enterView(detail.firstElementChild, 0);
      };
    });
  };
  $$('.path-node').forEach(button => {
    button.onclick = () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      resizeContent($('#trophy-stage'), () => renderStage(Number(button.dataset.stage)));
      enterView($('.trophy-world-header'));
      button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    };
  });
  renderStage(current.index);
  $('.path-node[aria-pressed="true"]').scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
}

async function sessionForCorrection(id) {
  const original = await db.getSession(id);
  if (!original || original.deletedAt || !original.finishedAt) {
    throw new Error('Este entrenamiento ya no está disponible para corregirlo.');
  }
  return original;
}

function bindSessionCorrection(form, original, update, onSaved) {
  const errorText = form.querySelector('[role="alert"]');
  let saving = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    errorText.textContent = '';
    let corrected;
    try {
      corrected = update(original);
    } catch (error) {
      errorText.textContent = error.message;
      return;
    }
    const controls = [...form.querySelectorAll('button, input'), $('#sheet .sheet-dismiss')];
    saving = true;
    sheetBusy = true;
    form.setAttribute('aria-busy', 'true');
    const restoreControls = freezeControls(controls);
    const submit = form.querySelector('[type="submit"]');
    const label = submit.textContent;
    submit.textContent = 'Guardando…';
    let saved;
    try {
      saved = await db.updateSession(original, () => corrected);
    } catch (error) {
      console.error('No se pudo guardar la corrección del entrenamiento.', error);
      errorText.textContent = error.name === 'SessionConflictError' ? error.message : 'No se pudo guardar. El valor sigue aquí; vuelve a intentarlo.';
    } finally {
      saving = false;
      sheetBusy = false;
      form.removeAttribute('aria-busy');
      restoreControls();
      submit.textContent = label;
    }
    if (!saved) return;
    state.sessions = state.sessions.map(item => item.id === saved.id ? saved : item);
    renderHistory();
    renderHome();
    if (state.session && state.view === 'workout') {
      const scroll = window.scrollY;
      renderBlocks(sessionDay(state.session));
      updateWorkoutHeader();
      window.scrollTo(0, scroll);
    }
    onSaved(saved);
    toast('Corrección guardada · En este dispositivo.');
    sync.syncQuietly();
  };
}

async function openHistoryWeightEditor(id, movement, index, onSaved) {
  const token = sheetToken;
  let original;
  try {
    original = await sessionForCorrection(id);
    correctSessionWeight(original, movement.id, index, original.entries?.[movement.id]?.[index]);
  } catch (error) {
    console.error('No se pudo abrir la corrección de peso.', error);
    toast(error.message || 'No se pudo leer el entrenamiento. Intenta de nuevo.');
    return;
  }
  if (token !== sheetToken) return;
  const value = original.entries[movement.id][index];
  const originalMovement = original.routineSnapshot?.blocks.flatMap(block => block.movements).find(item => item.id === movement.id) || movement;
  openSheet(`<span class="eyebrow">Corregir una serie</span><h2>${esc(originalMovement.name)}</h2><p class="training-caption">${fmtDate(original.startedAt, { day: 'numeric', month: 'long', year: 'numeric' })} · Serie ${index + 1}</p><form id="history-weight-form" novalidate>
    <div class="weight-before"><span>Peso anterior</span><b>${esc(value)}</b></div>
    <label class="weight-correction-field" for="history-weight"><span>Peso correcto</span><input id="history-weight" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" required value="${esc(value)}" aria-describedby="history-weight-help history-weight-error"></label>
    <p class="training-caption" id="history-weight-help">Usa el número de tu equipo, sin convertir kg o lb. Solo cambia este peso; conservamos fecha, reps y el resto del entrenamiento.</p>
    <p class="correction-error" id="history-weight-error" role="alert"></p>
    <div class="sheet-form-actions"><button class="btn btn-primary" type="submit">Guardar peso</button><button class="btn btn-ghost" id="history-weight-cancel" type="button">Cancelar</button></div></form>`);
  $('#history-weight-cancel').onclick = onSaved;
  bindSessionCorrection($('#history-weight-form'), original, current => correctSessionWeight(current, movement.id, index, $('#history-weight').value), onSaved);
}

async function openDurationEditor(session, onSaved) {
  const token = sheetToken;
  let original;
  try {
    original = await sessionForCorrection(session.id);
  } catch (error) {
    console.error('No se pudo abrir la corrección de duración.', error);
    toast(error.message || 'No se pudo leer el entrenamiento. Intenta de nuevo.');
    return;
  }
  if (token !== sheetToken) return;
  const totalMinutes = Math.min(1440, Math.max(1, Math.round(sessionDuration(original) / 60000)));
  openSheet(`<h2>Duración del entrenamiento</h2><form id="duration-form" novalidate><div class="result-fields"><div class="field"><label for="duration-hours">Horas</label><input id="duration-hours" type="number" inputmode="numeric" min="0" max="24" step="1" required value="${Math.floor(totalMinutes / 60)}"></div><div class="field"><label for="duration-minutes">Minutos</label><input id="duration-minutes" type="number" inputmode="numeric" min="0" max="59" step="1" required value="${totalMinutes % 60}"></div></div><p id="duration-error" role="alert"></p><div class="sheet-form-actions"><button class="btn btn-primary" type="submit">Guardar duración</button><button class="btn btn-ghost" id="duration-cancel" type="button">Cancelar</button></div></form>`);
  $('#duration-cancel').onclick = onSaved;
  bindSessionCorrection($('#duration-form'), original, current => {
    const hoursInput = $('#duration-hours'), minutesInput = $('#duration-minutes');
    const hours = Number(hoursInput.value), remainder = Number(minutesInput.value);
    const minutes = hours * 60 + remainder;
    if (!hoursInput.validity.valid || !minutesInput.validity.valid || !Number.isInteger(hours) || !Number.isInteger(remainder) || minutes < 1 || minutes > 1440) {
      throw new Error('Introduce una duración entre 1 minuto y 24 horas.');
    }
    return { ...current, entries: { ...current.entries, _durationMinutes: minutes } };
  }, updated => {
    Object.assign(session, updated);
    onSaved();
  });
}

function personalRecordsHtml(session) {
  const records = sessionPersonalRecords(session, state.sessions);
  if (!records.length) return '';
  return `<section class="session-records"><span class="eyebrow">PR de esta sesión · ${records.length}</span><h3>Marcas que superaste</h3>${records.map(record => `<button class="record-highlight" data-record-movement="${esc(record.movementId)}" data-record-session="${esc(session.id)}"><span><strong>${esc(record.name)}</strong><small>${record.reps} reps · serie ${record.index + 1}${record.label !== 'Habitual' ? ` · ${esc(record.label)}` : ''}</small></span><span><b>${record.load}${record.unit === 'escala' ? '' : ` ${esc(record.unit)}`}</b><small>Antes: ${record.previous}</small></span></button>`).join('')}<p class="training-caption">Mismas reps y contexto registrado. Se recalcula si corriges o eliminas sesiones.</p></section>`;
}

function bindRecordLinks() {
  $$('[data-record-movement]').forEach(button => {
    button.onclick = () => openMovementHistory(button.dataset.recordMovement, button.dataset.recordSession);
  });
}

function showWorkoutSummary(session, newlyUnlocked = [], celebrate = true) {
  const day = sessionDay(session);
  const progress = sessionProgress(session);
  const previous = state.sessions.filter(item => item.id !== session.id && item.finishedAt && item.routineSnapshot && item.startedAt < session.startedAt && item.dayId === session.dayId && JSON.stringify(item.routineSnapshot) === JSON.stringify(day)).sort((first, second) => second.startedAt - first.startedAt)[0];
  const change = previous ? progress.pct - sessionProgress(previous).pct : null;
  const completedBlocks = day.blocks.filter(block => block.movements.every(movement => (session.entries[movement.id] || []).slice(0, block.sets).filter(recordedSet).length === block.sets)).length;
  openSheet(`<span class="eyebrow">Sesión finalizada</span><h2>${esc(day.title)}</h2>
    ${newlyUnlocked.length ? `<section class="trophy-celebration${celebrate ? ' celebrating' : ''}" role="status"><div class="trophy-confetti" aria-hidden="true">${Array.from({ length: 12 }, (_, index) => `<i style="--piece:${index}"></i>`).join('')}</div><img class="trophy-icon celebration-emblem" src="icons/trophy.svg" alt="" width="56" height="56"><span class="eyebrow">${newlyUnlocked.length === 1 ? 'Trofeo desbloqueado' : `${newlyUnlocked.length} trofeos desbloqueados`}</span><h3>${esc(newlyUnlocked[0].title)}</h3>${newlyUnlocked.length > 1 ? `<p>${newlyUnlocked.slice(1, 3).map(badge => esc(badge.title)).join(' · ')}</p>` : ''}${newlyUnlocked.length > 3 ? `<details><summary>Ver los otros ${newlyUnlocked.length - 3} trofeos</summary><p>${newlyUnlocked.slice(3).map(badge => esc(badge.title)).join(' · ')}</p></details>` : ''}</section>` : ''}
    <div class="session-score"><div><span>Progress score</span><strong>${progress.pct}<small>/100</small></strong></div><div class="score-context"><b>${progress.pct === 100 ? 'Plan completado' : 'Trabajo registrado'}</b><span>${progress.done} de ${progress.total} series</span>${change !== null ? `<small>${change > 0 ? '+' : ''}${change} puntos vs. sesión anterior</small>` : ''}</div></div>
    <div class="summary-grid"><div><b>${progress.done}</b><span>Series</span></div><div><b>${completedBlocks}/${day.blocks.length}</b><span>Bloques</span></div><div><b>${Math.round(sessionDuration(session) / 60000)}</b><span>Minutos</span></div></div>
    <p class="training-caption" id="summary-save-status" role="status">Guardado en este dispositivo.</p>
    ${personalRecordsHtml(session)}
    <button class="btn btn-ghost duration-edit" id="summary-duration">Editar duración</button>
    ${trainingUI.repChangesHtml([session])}
    <button class="btn btn-primary" id="sheet-ok">Listo</button><button class="btn btn-ghost" id="summary-achievements">Ver logros</button><button class="btn btn-ghost" id="summary-progress">Balance de la semana</button>`);
  $('#summary-duration').onclick = () => openDurationEditor(session, () => showWorkoutSummary(session, newlyUnlocked, false));
  bindRecordLinks();
  updateSaveStatus();
  $('#summary-achievements').onclick = openAchievements;
  $('#summary-progress').onclick = () => trainingUI.openProgress('week', session.startedAt);
  $('#sheet-ok').onclick = () => { closeSheet(); checkBackupReminder(); };
}

async function finishWorkout() {
  if (!state.session || state.session.finishedAt || state.session.id === discardingSessionId) return;
  const s = state.session;
  const before = new Set(achievementState().badges.filter(badge => badge.unlocked).map(badge => badge.id));
  $('#btn-finish').disabled = true;
  s.finishedAt = Date.now();
  try {
    await saveSession(true);
  } catch {
    s.finishedAt = null;
    toast('No se pudo finalizar. Tus series siguen abiertas; intenta de nuevo.');
    return;
  } finally {
    $('#btn-finish').disabled = false;
  }
  hideRest();
  state.session = null;
  setView('home');
  renderHome();
  renderHistory();
  showWorkoutSummary(s, achievementState().badges.filter(badge => badge.unlocked && !before.has(badge.id)));
  sync.syncQuietly();
}

/* ---------- Hojas modales ---------- */

let sheetToken = 0;
let sheetDismiss = null;
let sheetFocus = null;
let sheetBusy = false;

function openSheet(html) {
  sheetToken++;
  const replacing = $('#sheet-backdrop').classList.contains('show');
  const previousHeight = $('#sheet').getBoundingClientRect().height;
  if (!$('#sheet-backdrop').classList.contains('show')) sheetFocus = document.activeElement;
  $('#sheet').innerHTML = html;
  $('#sheet .grabber')?.remove();
  const toolbar = document.createElement('div');
  toolbar.className = 'sheet-toolbar';
  toolbar.innerHTML = '<span class="grabber" aria-hidden="true"></span><button class="icon-btn sheet-dismiss" aria-label="Cerrar ventana" title="Cerrar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M6 18 18 6"/></svg></button>';
  $('#sheet').prepend(toolbar);
  toolbar.querySelector('button').onclick = () => closeSheet();
  $('#sheet').scrollTop = 0;
  const heading = $('#sheet h2');
  if (heading) heading.id = 'sheet-title';
  const backdrop = $('#sheet-backdrop');
  backdrop.inert = false;
  backdrop.classList.add('show');
  $('#app').inert = true;
  $('#tabbar').inert = true;
  $('#rest-timer').inert = true;
  document.body.classList.add('sheet-open');
  $('#sheet').focus({ preventScroll: true });
  if (replacing) {
    const sheet = $('#sheet');
    sheet.style.height = `${previousHeight}px`;
    resizeContent(sheet, () => { sheet.style.height = ''; });
  }
}

function closeSheet(accepted = false) {
  if (sheetBusy) return;
  const backdrop = $('#sheet-backdrop');
  if (!backdrop.classList.contains('show')) return;
  // Soltar el foco antes de ocultar: si no, queda atrapado en contenido invisible.
  if (backdrop.contains(document.activeElement)) document.activeElement.blur();
  backdrop.classList.remove('show');
  backdrop.inert = true;
  $('#app').inert = false;
  $('#tabbar').inert = false;
  $('#rest-timer').inert = !$('#rest-timer').classList.contains('show');
  document.body.classList.remove('sheet-open');
  if (sheetFocus?.isConnected) sheetFocus.focus({ preventScroll: true });
  // Se vacía al terminar la animación: si no, los botones siguen en el DOM fuera de pantalla.
  const token = ++sheetToken;
  const closingAnimations = $('#sheet').getAnimations();
  Promise.allSettled(closingAnimations.map(animation => animation.finished)).then(() => {
    if (token === sheetToken) $('#sheet').replaceChildren();
  });
  const dismiss = sheetDismiss;
  sheetDismiss = null;
  dismiss?.(accepted === true);
}

function confirmSheet({ title, body, confirm, cancel, danger }) {
  const previous = $('#sheet-backdrop').classList.contains('show') ? [...$('#sheet').childNodes] : null;
  const previousScroll = $('#sheet').scrollTop;
  return new Promise(resolve => {
    openSheet(`
      <div class="grabber"></div>
      <h2>${esc(title)}</h2>
      <p>${esc(body)}</p>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cf-yes">${esc(confirm)}</button>
      <button class="btn btn-ghost" id="cf-no">${esc(cancel)}</button>
    `);
    sheetDismiss = accepted => {
      if (!accepted && previous) {
        openSheet('');
        $('#sheet').replaceChildren(...previous);
        $('#sheet').scrollTop = previousScroll;
      }
      resolve(accepted);
    };
    $('#cf-yes').onclick = () => closeSheet(true);
    $('#cf-no').onclick = () => closeSheet();
  });
}

/* ============================== Respaldo ============================== */

async function buildBackup() {
  const personalProfile = await db.getMeta('personalProfile');
  return {
    app: 'gymtrack',
    version: 4,
    exportedAt: new Date().toISOString(),
    profile: state.profile.name,
    sessions: state.session ? [...state.sessions.filter(session => session.id !== state.session.id), structuredClone(state.session)] : state.sessions,
    measures: state.measures,
    routines: await db.allRoutines(),
    exercises: await db.allExercises(),
    preferences: trainingPreferences(await db.getMeta('trainingPreferences')),
    ...(personalProfile ? { personalProfile } : {})
  };
}

async function exportBackup() {
  try {
    const data = JSON.stringify(await buildBackup(), null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `reawaken-respaldo-${stamp}.json`;
    const file = new File([data], filename, { type: 'application/json' });
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
    if (err?.name !== 'AbortError') {
      console.error('No se pudo exportar el respaldo.', err);
      toast('No se pudo exportar. Tus registros siguen aquí; vuelve a intentarlo.');
    }
  }
}

let importingBackup = false;
function chooseBackupRoutine(candidates) {
  return new Promise(resolve => {
    let selected = null;
    openSheet(`<h2>Una rutina activa</h2><p>Al fusionar el respaldo quedarían varias activas. Elige cuál usar; todas las demás se conservan guardadas junto con tu historial.</p><form id="backup-routine-form"><div class="field"><label for="backup-active-routine">Rutina que quedará activa</label><select id="backup-active-routine" required><option value="">Elige una rutina</option>${candidates.map(record => `<option value="${esc(record.id)}">${esc(record.name || 'Rutina sin nombre')}</option>`).join('')}</select></div><div class="sheet-form-actions"><button class="btn btn-primary" type="submit">Continuar</button><button class="btn btn-ghost" id="backup-choice-cancel" type="button">Cancelar</button></div></form>`);
    sheetDismiss = () => resolve(selected);
    $('#backup-choice-cancel').onclick = () => closeSheet();
    $('#backup-routine-form').onsubmit = event => {
      event.preventDefault();
      selected = $('#backup-active-routine').value;
      closeSheet(true);
    };
  });
}

async function importBackup(file) {
  if (importingBackup) return toast('Ya hay una importación en curso.');
  const editing = () => state.session || state.edDirty || state.draft;
  if (editing()) return toast('Termina la sesión o guarda los cambios del editor antes de importar.');
  importingBackup = true;
  let committed = false;
  try {
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { return toast('Archivo no válido. No se importó nada.'); }
    const prepared = prepareBackup(parsed);
    const [expectedRoutines, sessions, measures, exercises, preferences, personalProfile] = await Promise.all([
      db.allRoutines(), db.allSessions(), db.allMeasures(), db.allExercises(), db.getMeta('trainingPreferences'), db.getMeta('personalProfile')
    ]);
    const expectedState = { sessions, measures, exercises, preferences, personalProfile };
    const candidates = backupActiveRoutines(expectedRoutines, prepared.routines);
    const activeRoutineId = candidates.length > 1 ? await chooseBackupRoutine(candidates) : null;
    if (candidates.length > 1 && !activeRoutineId) return;
    const ok = await confirmSheet({
      title: 'Importar respaldo',
      body: `Se fusionarán ${prepared.sessions.length} sesiones, ${prepared.measures.length} mediciones, ${prepared.routines.length} rutinas y ${prepared.exercises.length} ejercicios. Los registros con el mismo ID se sobrescriben; los demás se conservan.${prepared.personalProfile ? ' También se restaurará el perfil y se aplicará a tu rutina activa sin cambiar sus ejercicios.' : ''}${prepared.preferences ? ' Se restaurarán las preferencias de entrenamiento incluidas.' : ''} No se importan credenciales.`,
      confirm: 'Importar',
      cancel: 'Cancelar'
    });
    if (!ok) return;
    if (editing()) return toast('Termina la sesión o guarda los cambios del editor antes de importar.');
    await db.restoreBackup(prepared, { activeRoutineId, expectedRoutines, expectedState });
    committed = true;
    await loadAll();
    await loadRoutine();
    await loadTrainingPreferences();
    renderHome(); renderBody(); renderHistory();
    await renderSettings();
    toast('Respaldo importado');
  } catch (error) {
    toast(committed ? 'El respaldo se guardó, pero no se pudo actualizar la pantalla. Vuelve a abrir la app.' :
      `No se importó nada. ${error?.message || 'Revisa el almacenamiento e inténtalo de nuevo.'}`);
  } finally {
    importingBackup = false;
  }
}

async function checkBackupReminder() {
  const finished = state.sessions.filter(s => Number.isFinite(s.finishedAt));
  if (finished.length < 3) return;
  const [lastBackup, lastReminder] = await Promise.all([
    db.getMeta('lastBackup'), db.getMeta('lastBackupReminder')
  ]);
  const baseline = Math.max(Number(lastBackup) || 0, Number(lastReminder) || 0,
    Math.min(...finished.map(session => session.finishedAt)));
  const now = Date.now();
  if (now - baseline < 90 * 86400000) return;
  await db.setMeta('lastBackupReminder', now);
  toast('Respaldo pendiente', { label: 'Respaldar', fn: exportBackup }, 10000, true);
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
    <button class="list-row" id="btn-sync-now" ${st.syncing ? 'disabled' : ''}>
      <div class="lr-icon" style="background:color-mix(in srgb, #30D158 22%, transparent);color:#30D158">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 01-9 9 9 9 0 01-7.6-4.2M3 12a9 9 0 019-9 9 9 0 017.6 4.2"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>
      </div>
      <div class="lr-body"><strong>${st.syncing ? 'Sincronizando…' : 'Sincronizar ahora'}</strong><small>${last ? `Última vez: ${fmtDate(last, { day: 'numeric', month: 'short' })} ${new Date(last).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}` : 'Pendiente de primera sincronización'}</small></div>
      <svg class="chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l6 6-6 6"/></svg>
    </button>
    <div class="list-row">
      <div class="lr-body"><strong>Sesión</strong><small>${esc(st.email || '')}</small></div>
    </div>
    <button class="list-row" id="btn-sync-logout">
      <div class="lr-body"><strong style="color:#FF453A">Cerrar sesión</strong><small>Los datos locales se quedan en el teléfono</small></div>
    </button>
  </div>`;

  if (st.error) slot.insertAdjacentHTML('beforeend', `<div class="notice warn" role="status">${esc(st.error)}. Los datos locales se conservan.</div>`);
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
    <p>En tu proyecto existente: <b>Project Settings → Data API</b> para la URL y <b>API Keys</b> para la clave pública. Si lo compartes con otra app, revisa primero sus tablas y permisos; no ejecutes el esquema completo para conectar un dispositivo.</p>
    <div class="field" style="margin-bottom:10px">
      <label for="sb-url">Project URL</label>
      <input id="sb-url" placeholder="https://xxxxx.supabase.co" autocapitalize="off" autocorrect="off" spellcheck="false" style="font-size:16px" />
    </div>
    <div class="field" style="margin-bottom:16px">
      <label for="sb-key">Publishable key</label>
      <input id="sb-key" placeholder="sb_publishable_…" autocapitalize="off" autocorrect="off" spellcheck="false" style="font-size:16px" />
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
        await renderSettings();
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

function renderInBodyReminder() {
  const hasUserData = state.profile.name.trim() || state.routines.length || state.sessions.length || state.measures.length;
  if (!hasUserData) {
    $('#inbody-reminder').innerHTML = '';
    $('#inbody-schedule').textContent = 'Disponible después de configurar tu perfil';
    return;
  }
  const reminder = monthlyInBody(state.measures);
  $('#inbody-reminder').innerHTML = reminder.due ? `<button class="routine-alert due" id="btn-inbody-reminder"><div><strong>Nuevo InBody · ${esc(fmtDate(reminder.next, { month: 'long' }))}</strong><small>Pendiente de este mes</small></div><span aria-hidden="true">+</span></button>` : '';
  if ($('#btn-inbody-reminder')) $('#btn-inbody-reminder').onclick = openNewMeasure;
  $('#inbody-schedule').textContent = reminder.due ? 'Cada día 1 · Pendiente este mes' : `Este mes registrado · Próximo: ${fmtDate(reminder.next, { day: 'numeric', month: 'long' })}`;
}

async function openProfile(focusDate = false) {
  const token = sheetToken;
  try {
    await loadRoutine();
  } catch (error) {
    console.error('No se pudo leer el perfil.', error);
    toast('No se pudo leer el perfil. Tus datos se conservan; vuelve a intentar.');
    return;
  }
  if (token !== sheetToken) return;
  const profile = state.profile;
  const routineId = state.routineRevisions.has(state.activeRoutineId) ? state.activeRoutineId : null;
  const expectedRoutine = state.routineRevisions.get(routineId) || null;
  const expectedProfile = structuredClone(state.personalProfile);
  openSheet(`<h2>Editar perfil</h2>${!routineId ? '<p class="training-caption">Sin rutina activa, el perfil se guarda aquí y en tu respaldo. No crearemos un plan ni cambiaremos tus rutinas.</p>' : ''}<form id="profile-form">
    <div class="field-grid profile-fields">
      <div class="field profile-wide"><label for="profile-name">Nombre</label><input id="profile-name" autocomplete="name" maxlength="80" required value="${esc(profile.name)}"></div>
      <div class="field"><label for="profile-sport">Deporte</label><input id="profile-sport" maxlength="60" value="${esc(profile.sport)}"></div>
      <div class="field"><label for="profile-coach">Entrenador</label><input id="profile-coach" maxlength="80" value="${esc(profile.coach)}"></div>
      <div class="field"><label for="profile-days">Días por semana</label><input id="profile-days" type="number" inputmode="numeric" min="1" max="7" step="1" required value="${profile.daysPerWeek}"></div>
      <div class="field"><label for="profile-date">Cambio de rutina</label><input id="profile-date" type="date" min="1900-01-01" max="2100-12-31" value="${profile.routineChangeDate}"></div>
    </div><p id="profile-error" class="profile-error" role="alert"></p>
    <div class="sheet-form-actions"><button type="submit" class="btn btn-primary" id="profile-save">Guardar</button><button type="button" class="btn btn-ghost" id="profile-cancel">Cancelar</button></div>
  </form>`);
  $('#profile-cancel').onclick = closeSheet;
  const form = $('#profile-form');
  const errorLabel = $('#profile-error');
  let saving = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    const values = { name: $('#profile-name').value.trim(), sport: $('#profile-sport').value.trim(), coach: $('#profile-coach').value.trim(), daysPerWeek: Number($('#profile-days').value), routineChangeDate: $('#profile-date').value };
    if (!values.name || !Number.isInteger(values.daysPerWeek) || values.daysPerWeek < 1 || values.daysPerWeek > 7 || (values.routineChangeDate && !validProfileDate(values.routineChangeDate))) {
      errorLabel.textContent = 'Revisa el nombre, los días (1 a 7) y la fecha.';
      return;
    }
    saving = sheetBusy = true;
    const restoreControls = freezeControls([...form.querySelectorAll('button, input'), $('#sheet .sheet-dismiss')]);
    let committed = false;
    try {
      await db.savePersonalProfile(values, { routineId, expectedRoutine, expectedProfile });
      committed = true;
      await loadRoutine();
      sheetBusy = false;
      if ($('#profile-form') === form) closeSheet();
      renderHome(); renderBody(); renderSettings();
      toast('Perfil guardado');
      sync.syncQuietly();
    } catch (error) {
      console.error('No se pudo guardar el perfil personal.', error);
      errorLabel.textContent = committed ? 'El perfil se guardó, pero no se pudo actualizar la pantalla. Vuelve a abrir la app.' : error.message || 'No se pudo guardar el perfil';
    } finally {
      saving = sheetBusy = false;
      restoreControls();
    }
  };
  if (focusDate) $('#profile-date').focus();
}

async function loadTrainingPreferences() {
  const preferences = trainingPreferences(await db.getMeta('trainingPreferences'));
  state.restSeconds = preferences.restSeconds;
  state.keepScreenAwake = preferences.keepScreenAwake;
  screenWakeLock.update();
}

function wakeLockDescription() {
  if (!navigator.wakeLock) return 'Este navegador no permite mantener la pantalla activa.';
  if (state.wakeLockStatus === 'active') return 'Pantalla activa mientras entrenas en esta vista.';
  if (state.wakeLockStatus === 'requesting') return 'Solicitando permiso al navegador…';
  if (state.wakeLockStatus === 'unavailable') return 'El navegador no lo permitió ahora. El entrenamiento sigue guardado.';
  return 'Opcional durante el entrenamiento. El sistema puede liberarla; no funciona con la app en segundo plano.';
}

function openTrainingPreferences() {
  openSheet(`<span class="eyebrow">A tu manera</span><h2>Descanso y pantalla</h2><form id="training-preferences-form" novalidate>
    <p class="training-caption">El descanso del coach tiene prioridad. Esta preferencia se usa cuando el bloque no indica uno y no cambia un temporizador en curso.</p>
    <div class="seg" role="group" aria-label="Descansos habituales">${[30, 45, 60].map(value => `<button type="button" data-preferred-rest="${value}" aria-pressed="${state.restSeconds === value}" class="${state.restSeconds === value ? 'on' : ''}">${value} s</button>`).join('')}</div>
    <div class="field"><label for="preferred-rest">Personalizado · segundos (1–3600)</label><input id="preferred-rest" type="number" inputmode="numeric" min="1" max="3600" step="1" required value="${state.restSeconds}"></div>
    <label class="preference-check"><input id="keep-screen-awake" type="checkbox" ${state.keepScreenAwake ? 'checked' : ''} ${navigator.wakeLock ? '' : 'disabled'}><span>Mantener la pantalla despierta</span></label>
    <p id="wake-support" class="training-caption">${esc(wakeLockDescription())}</p><p class="training-caption">Se guarda aquí y en tu respaldo. Las preferencias todavía no se sincronizan con Supabase.</p>
    <p id="preferences-error" class="correction-error" role="alert"></p><div class="sheet-form-actions"><button class="btn btn-primary" type="submit">Guardar preferencias</button><button class="btn btn-ghost" id="preferences-cancel" type="button">Cancelar</button></div></form>`);
  const form = $('#training-preferences-form');
  const input = $('#preferred-rest');
  const updateSelection = () => $$('[data-preferred-rest]').forEach(button => {
    const selected = Number(input.value) === Number(button.dataset.preferredRest);
    button.classList.toggle('on', selected); button.setAttribute('aria-pressed', String(selected));
  });
  $$('[data-preferred-rest]').forEach(button => { button.onclick = () => { input.value = button.dataset.preferredRest; updateSelection(); }; });
  input.oninput = updateSelection;
  $('#preferences-cancel').onclick = () => closeSheet();
  let saving = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    const errorLabel = $('#preferences-error');
    const controls = [...form.querySelectorAll('button, input, select'), $('#sheet .sheet-dismiss')];
    let restoreControls;
    try {
      const preferences = trainingPreferences({ restSeconds: Number(input.value), keepScreenAwake: $('#keep-screen-awake').checked });
      saving = sheetBusy = true;
      restoreControls = freezeControls(controls);
      await db.setMeta('trainingPreferences', preferences);
      state.restSeconds = preferences.restSeconds;
      state.keepScreenAwake = preferences.keepScreenAwake;
      screenWakeLock.update();
      sheetBusy = false;
      closeSheet();
      $('#training-preferences-summary').textContent = `${state.restSeconds} s por defecto${state.keepScreenAwake ? ' · Pantalla activa solicitada' : ''}`;
      toast('Preferencias guardadas · El temporizador en curso no cambió.');
    } catch (error) {
      console.error('No se pudieron guardar las preferencias.', error);
      errorLabel.textContent = error.message || 'No se pudo guardar. Vuelve a intentar.';
    } finally {
      saving = sheetBusy = false;
      restoreControls?.();
    }
  };
}

function openPersonalSetup() {
  const hasData = state.sessions.length || state.measures.length || state.exercises.length || state.routines.length || state.profile.name;
  openSheet(`<span class="eyebrow">Perfil y preferencias</span><h2>Configurar entrenamiento</h2><p>${hasData ? 'Tus rutinas e historial se conservan. Cambia únicamente lo que necesites.' : 'Empieza importando el plan de tu gym. El perfil y los descansos se pueden ajustar cuando quieras.'}</p>
    <div class="list-card"><button class="list-row" id="setup-profile"><span class="lr-body"><strong>Tu perfil</strong><small>${esc(state.profile.name || 'Opcional: nombre y objetivo semanal')}</small></span><span aria-hidden="true">›</span></button>
    <button class="list-row" id="setup-preferences"><span class="lr-body"><strong>Descanso y pantalla</strong><small>${state.restSeconds} s por defecto</small></span><span aria-hidden="true">›</span></button>
    <button class="list-row" id="setup-routines"><span class="lr-body"><strong>Mis rutinas</strong><small>${plural(state.routines.length, 'plan guardado', 'planes guardados')} · importar PDF o texto</small></span><span aria-hidden="true">›</span></button>
    <button class="list-row" id="setup-generate"><span class="lr-body"><strong>Crear rutina con mis ejercicios</strong><small>Usa los ejercicios de tus planes guardados</small></span><span aria-hidden="true">›</span></button>
    <button class="list-row" id="setup-restore"><span class="lr-body"><strong>Recuperar un respaldo</strong><small>Revisar antes de fusionar. No se vacía el dispositivo.</small></span><span aria-hidden="true">›</span></button></div>
    <button class="btn btn-primary" id="setup-done">Listo</button>`);
  $('#setup-profile').onclick = () => openProfile();
  $('#setup-preferences').onclick = openTrainingPreferences;
  $('#setup-routines').onclick = openRoutineCatalog;
  $('#setup-generate').onclick = () => openRoutineGenerator();
  $('#setup-restore').onclick = () => $('#file-input').click();
  $('#setup-done').onclick = () => closeSheet();
}

function openRoutineGenerator(previous = {}) {
  const choices = (values, selected) => values.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  const savedRoutines = state.routines.filter(record => state.routineRevisions.has(record.id));
  const savedNames = new Set(savedRoutines.flatMap(record => record.days.flatMap(day => day.blocks.flatMap(block => block.movements.map(movement => exerciseNameKey(movement.name))))));
  openSheet(`<span class="eyebrow">Tu biblioteca de ejercicios</span><h2>Crear una rutina personalizada</h2><p class="training-caption">Por defecto usamos los ejercicios que ya aparecen en tus rutinas guardadas, incluidas las del gym. Obtendrás un borrador para revisar con tu coach; el plan actual no se reemplaza.</p><form id="generator-form">
    <div class="field"><label for="generator-source">Ejercicios de</label><select id="generator-source" required>${choices([['routines', 'Mis rutinas guardadas'], ['personal', 'Mis rutinas y fichas personales'], ['catalog', 'Catálogo de ejemplo'], ['both', 'Guardados y catálogo']], previous.source || 'routines')}</select></div>
    <p class="training-caption" id="generator-source-summary">Planes disponibles aquí: ${plural(savedRoutines.length, 'rutina guardada', 'rutinas guardadas')} · ${plural(savedNames.size, 'nombre de ejercicio', 'nombres de ejercicio')}. La propuesta depende del enfoque y de las indicaciones compatibles.</p>
    <div class="field-grid"><div class="field"><label for="generator-days">Días por semana</label><input id="generator-days" type="number" min="1" max="7" required value="${previous.days || state.profile.daysPerWeek}"></div><div class="field"><label for="generator-minutes">Minutos disponibles</label><input id="generator-minutes" type="number" min="15" max="120" step="1" required value="${previous.minutes || 45}"></div>
    <div class="field"><label for="generator-goal">Objetivo</label><select id="generator-goal">${choices([['consistency', 'Constancia'], ['strength', 'Fuerza general'], ['muscle', 'Desarrollo muscular']], previous.goal || 'consistency')}</select></div>
    <div class="field"><label for="generator-experience">Experiencia</label><select id="generator-experience">${choices([['returning', 'Empezando o retomando'], ['regular', 'Entreno habitualmente']], previous.experience || 'returning')}</select></div>
    <div class="field"><label for="generator-focus">Enfoque</label><select id="generator-focus">${choices([['full', 'Cuerpo completo'], ['upper', 'Tren superior'], ['lower', 'Tren inferior']], previous.focus || 'full')}</select></div>
    <div class="field"><label for="generator-rest">Descanso por defecto (s)</label><input id="generator-rest" type="number" min="1" max="3600" required value="${previous.restSeconds || state.restSeconds}"></div></div>
    <div class="field"><label for="generator-equipment">Equipo · opcional</label><select id="generator-equipment"><option value="">Sin filtro: verificar disponibilidad</option>${exerciseEquipmentValues().map(value => `<option value="${esc(value)}" ${value === previous.equipment ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select></div>
    <p class="training-caption">En fuentes personales se conservan las series, reps y descansos indicados. Si no hay opciones suficientes, avisamos; no completamos con otra fuente.</p>
    <p id="generator-error" class="correction-error" role="alert"></p><div class="sheet-form-actions"><button class="btn btn-primary" type="submit">Ver propuesta</button><button class="btn btn-ghost" type="button" id="generator-cancel">Cancelar</button></div></form>`);
  $('#generator-cancel').onclick = () => closeSheet();
  $('#generator-form').onsubmit = event => {
    event.preventDefault();
    const options = {
      source: $('#generator-source').value, days: Number($('#generator-days').value),
      minutes: Number($('#generator-minutes').value), goal: $('#generator-goal').value,
      experience: $('#generator-experience').value, focus: $('#generator-focus').value,
      restSeconds: Number($('#generator-rest').value), equipment: $('#generator-equipment').value, idPrefix: `generated-${uid()}`
    };
    try {
      const proposal = generateRoutine(options, { catalog: EXERCISE_CATALOG,
        routines: state.routines.filter(record => state.routineRevisions.has(record.id)), exercises: state.exercises });
      openSheet(`<span class="eyebrow">Borrador sin guardar</span><h2>Vista previa de la rutina</h2><p class="training-caption">Revisa y ajusta el resultado antes de guardarlo. Tu rutina actual y sus registros se conservan.</p><div class="generator-preview">${proposal.days.map(day => `<section><h3>${esc(day.label)} <small>~${day.estimatedMinutes} min</small></h3>${day.blocks.map(block => `<p><strong>${esc(block.movements[0].name)}</strong><small>${block.sets} series · ${esc(block.movements[0].reps)} · descanso ${block.rest} s</small></p>`).join('')}</section>`).join('')}</div>${proposal.warnings.map(warning => `<p class="training-caption">${esc(warning)}</p>`).join('')}<div class="sheet-form-actions"><button class="btn btn-primary" id="generator-edit">Revisar y editar</button><button class="btn btn-ghost" id="generator-back">Cambiar opciones</button></div>`);
      $('#generator-back').onclick = () => openRoutineGenerator(options);
      $('#generator-edit').onclick = () => openEditor(proposal.days, proposal.warnings, {
        name: 'Rutina personalizada', activate: false, source: 'generated', generation: proposal.provenance
      });
    } catch (error) {
      console.error('No se pudo preparar la propuesta.', error);
      $('#generator-error').textContent = error.message;
    }
  };
}

async function renderSettings() {
  const profile = state.profile;
  $('#settings-profile').innerHTML = `<span class="settings-monogram" aria-hidden="true">${esc(profile.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('') || 'R')}</span><span class="settings-profile-copy"><strong>${esc(profile.name || 'Tu perfil')}</strong><small>${esc([profile.sport, profile.coach ? `Coach ${profile.coach}` : ''].filter(Boolean).join(' · '))}</small></span><strong>${profile.daysPerWeek}<small>días/sem.</small></strong><svg class="profile-edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>`;
  renderInBodyReminder();
  const notice = $('#storage-notice');
  $('#multimedia-audio').checked = state.multimediaAudio;
  $('#multimedia-audio').disabled = !navigator.audioSession;
  $('#audio-support').textContent = navigator.audioSession ? 'Experimental · Puede interrumpir tu música. No garantiza alarmas en segundo plano.' : 'Este navegador no ofrece Audio Session. Se mantiene el audio normal.';
  $('#training-preferences-summary').textContent = `${state.restSeconds} s por defecto${state.keepScreenAwake ? ' · Pantalla activa solicitada' : ''}`;
  const standalone = isStandalone();
  const { persisted } = await requestPersistence();

  if (!standalone) {
    notice.innerHTML = `<div class="notice warn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v5M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg>
      <div><b>Disponible para instalar.</b> Conserva un respaldo de tus registros aunque uses la app instalada.</div>
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

  $('#routine-change').textContent = profile.routineChangeDate ? fmtDate(new Date(profile.routineChangeDate + 'T12:00:00'), { day: 'numeric', month: 'long', year: 'numeric' }) : 'Sin fecha programada';

  const mv = state.routine.reduce((a, d) => a + d.blocks.reduce((b, bl) => b + bl.movements.length, 0), 0);
  const activeName = activeRoutineRecord()?.name;
  $('#routine-summary').textContent = state.routine.length ? `${activeName ? `${activeName} · ` : ''}${state.routine.length} días · ${mv} ejercicios` : 'Sin rutina activa';
  const personalCount = personalExerciseViews().length;
  $('#exercise-summary').textContent = `${personalCount} ${personalCount === 1 ? 'ejercicio guardado aquí' : 'ejercicios guardados aquí'} · ${EXERCISE_CATALOG.length} de catálogo`;

  applyTheme(state.theme);
  await renderSync();
}

/* ============================== Arranque ============================== */

async function loadAll({ preserveSession = false } = {}) {
  const liveSession = preserveSession ? state.session : null;
  // Los registros con `deletedAt` son lápidas para sincronizar: no se muestran.
  state.sessions = ((await db.allSessions()) || []).filter(s => !s.deletedAt);
  state.measures = ((await db.allMeasures()) || []).filter(m => !m.deletedAt).sort((a, b) => a.at - b.at);
  state.exercises = ((await db.allExercises()) || []).filter(exercise => !exercise.deletedAt).map(exercise => ({
    ...exercise,
    sources: Array.isArray(exercise.sources) && exercise.sources.length ? exercise.sources : [exercise.source].filter(Boolean),
    nameKey: exercise.nameKey || exerciseNameKey(exercise.name)
  }));
  state.session = state.sessions.find(s => !s.finishedAt) || null;
  if (liveSession && state.session?.id === liveSession.id) {
    liveSession.routineSnapshot ||= state.session.routineSnapshot;
    state.session = liveSession;
    state.sessions = state.sessions.map(session => session.id === liveSession.id ? liveSession : session);
  }
}

function bindGlobal() {
  const updateNavigationInset = () => {
    const height = $('#tabbar').getBoundingClientRect().height;
    if (height > 0) document.documentElement.style.setProperty('--nav-height', `${Math.ceil(height)}px`);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateNavigationInset).observe($('#tabbar'));
  window.addEventListener('resize', updateNavigationInset);
  updateNavigationInset();
  $$('.open-training-progress').forEach(button => { button.onclick = () => trainingUI.openProgress('week', Date.now()); });
  $('#btn-achievements').onclick = openAchievements;
  $('#btn-functions').onclick = openFunctions;
  $('#btn-training-preferences').onclick = openTrainingPreferences;
  $('#btn-personal-setup').onclick = openPersonalSetup;
  $('#retry-session-save').onclick = () => saveSession(true)?.catch(warnSessionSave);
  sync.onSyncChange(updateSaveStatus);
  window.addEventListener('online', updateSaveStatus);
  window.addEventListener('offline', updateSaveStatus);
  $('#settings-profile').onclick = () => openProfile();
  $('#btn-routine-date').onclick = () => openProfile(true);
  $('#btn-settings-inbody').onclick = openNewMeasure;
  $('#multimedia-audio').onchange = async event => {
    const enabled = event.target.checked;
    try {
      await db.setMeta('multimediaAudio', enabled);
      state.multimediaAudio = enabled;
      if (!enabled) stopCountdownSound();
    } catch {
      event.target.checked = state.multimediaAudio;
      toast('No se pudo guardar la opción de audio');
    }
  };
  $('#btn-test-audio').onclick = async () => {
    const button = $('#btn-test-audio');
    button.disabled = true;
    stopCountdownSound();
    await prepareCountdownAudio();
    if (countdownAudio?.state === 'running') playCountdownSound();
    else toast('El navegador no permitió reproducir audio');
    button.disabled = false;
  };
  if (window.visualViewport) {
    const resizeSheet = () => {
      const viewport = window.visualViewport;
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
    };
    window.visualViewport.addEventListener('resize', resizeSheet);
    window.visualViewport.addEventListener('scroll', resizeSheet);
    resizeSheet();
  }
  $('#app-version').textContent = `REAWAKEN · ${APP_VERSION}`;
  bindDisclosures(document);
  $('#btn-check-update').onclick = checkForUpdate;
  sync.onSyncChange(() => { if (state.view === 'settings') renderSync(); });
  window.addEventListener('online', () => { if (!state.session && !state.draft) sync.syncQuietly(); });
  $$('.tab').forEach(t => {
    t.onclick = () => {
      const v = t.dataset.view;
      setView(v);
      if (v === 'home') renderHome();
      if (v === 'body') renderBody();
      if (v === 'history') renderHistory();
      if (v === 'settings') renderSettings();
      window.scrollTo({ top: state.viewScroll[v] || 0 });
    };
  });

  $('#btn-back').onclick = () => { setView('home'); renderHome(); };

  $('#btn-workout-menu').onclick = openWorkoutMenu;
  $('#rt-close').onclick = hideRest;
  $('#rt-toggle').onclick = toggleCountdown;
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
    if (!state.session || discardingSessionId) return;
    const session = state.session;
    const ok = await confirmSheet({
      title: 'Descartar sesión',
      body: 'Se borrará todo lo que registraste en esta sesión. No se puede deshacer.',
      confirm: 'Descartar', cancel: 'Cancelar', danger: true
    });
    if (!ok || state.session?.id !== session.id || discardingSessionId) return;
    const pendingWeight = state.sessionSaveStatus === 'saving';
    discardingSessionId = session.id;
    const restoreControls = freezeControls($$('#view-workout button, #view-workout input, #view-workout textarea'));
    try {
      clearTimeout(saveTimer);
      await saveQueue;
      await db.deleteSession(session.id);
      state.sessions = state.sessions.filter(item => item.id !== session.id);
      state.session = null;
      setView('home'); renderHome();
      toast('Sesión descartada');
    } catch (error) {
      console.error('No se pudo descartar la sesión.', error);
      toast('No se pudo descartar. Tu sesión sigue abierta; vuelve a intentarlo.');
    } finally {
      discardingSessionId = null;
      restoreControls();
      if (pendingWeight && state.session?.id === session.id) saveSession();
    }
  };

  $('#btn-export').onclick = exportBackup;
  $('#btn-import').onclick = () => $('#file-input').click();

  $('#btn-edit-routine').onclick = openRoutineCatalog;
  $('#btn-exercise-library').onclick = openExerciseLibrary;

  $('#ed-cancel').onclick = async () => {
    if (state.edDirty) {
      const ok = await confirmSheet({
        title: 'Salir sin guardar', body: 'Se pierden los cambios de la rutina.',
        confirm: 'Descartar cambios', cancel: 'Seguir editando', danger: true
      });
      if (!ok) return;
    }
    state.draft = null;
    state.draftRoutineId = null;
    state.draftBaseline = state.draftGeneration = null;
    state.draftRoutineName = '';
    setView('settings'); renderSettings();
  };

  let savingRoutine = false;
  $('#ed-save').onclick = async () => {
    if (savingRoutine) return;
    if (!edValidate()) return;
    const controls = $$('#view-editor button, #view-editor input, #view-editor select, #view-editor textarea');
    savingRoutine = true;
    const restoreControls = freezeControls(controls);
    try {
      state.draftRoutineName = $('#ed-routine-name').value.trim() || 'Nueva rutina';
      state.draftActivate = $('#ed-activate-routine').checked;
      const endedCycle = await saveRoutine(state.draft, state.draftRoutineName, $('#ed-new-cycle').checked);
      state.draft = null;
      state.draftRoutineId = null;
      state.draftBaseline = state.draftGeneration = null;
      state.edDirty = false;
      setView('home'); renderHome(); renderSettings();
      sync.syncQuietly();
      toast('Rutina guardada');
      if (endedCycle) trainingUI.openProgress('cycle', Date.now(), endedCycle);
    } catch (e) {
      toast(e.message);
    } finally {
      savingRoutine = false;
      restoreControls();
    }
  };
  bindEditor();
  $('#ed-routine-name').oninput = () => { state.draftRoutineName = $('#ed-routine-name').value; edTouch(); };
  $('#ed-activate-routine').onchange = () => { state.draftActivate = $('#ed-activate-routine').checked; edTouch(); };
  $('#file-input').onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importBackup(f);
  };

  $('#btn-wipe').onclick = async () => {
    const ok = await confirmSheet({
      title: 'Borrar todo',
      body: 'Se eliminarán tus sesiones y mediciones. Si usas sincronización, el borrado se enviará también a tus otros dispositivos. Exporta un respaldo antes de continuar.',
      confirm: 'Sí, borrar todo', cancel: 'Cancelar', danger: true
    });
    if (!ok) return;
    clearTimeout(saveTimer);
    await saveQueue;
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
  document.addEventListener('keydown', event => {
    if (!$('#sheet-backdrop').classList.contains('show')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeSheet(); }
    if (event.key !== 'Tab') return;
    const controls = $$('#sheet button, #sheet input, #sheet textarea, #sheet select, #sheet a[href]').filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === $('#sheet'))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === $('#sheet'))) {
      event.preventDefault(); first.focus();
    }
  });

  // Guardado defensivo al salir de la app (iOS puede matarla en segundo plano)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSession(true)?.catch(warnSessionSave);
    else { tickCountdown(); renderInBodyReminder(); renderRoutineAlert(); }
  });
  window.addEventListener('pagehide', () => saveSession(true)?.catch(warnSessionSave));

  let reminderDate = dateKey(Date.now());
  setInterval(() => {
    if (state.view === 'workout' && state.session) updateWorkoutHeader();
    if (reminderDate !== dateKey(Date.now())) {
      reminderDate = dateKey(Date.now());
      renderInBodyReminder(); renderRoutineAlert();
    }
  }, 30000);
}

function finishLaunch(failed = false) {
  if (document.documentElement.dataset.bootAssetError === 'true') return;
  document.documentElement.dataset.boot = failed ? 'failed' : 'ready';
  $('#app').inert = false;
  $('#app').hidden = false;
  $('#app').removeAttribute('aria-busy');
  $('#tabbar').inert = failed;
  $('#tabbar').hidden = failed;
  const launch = $('#launch-screen');
  if (launch) {
    launch.inert = true;
    launch.setAttribute('aria-hidden', 'true');
    Promise.allSettled((launch.getAnimations?.() || []).map(animation => animation.finished)).then(() => { launch.hidden = true; });
  }
  document.dispatchEvent(new Event('reawaken-boot-complete'));
}

async function init() {
  if (document.documentElement.dataset.bootAssetError === 'true') return;
  try {
    await loadAll();
    await loadRoutine();
    await loadTrainingPreferences();
    state.multimediaAudio = (await db.getMeta('multimediaAudio')) === true;
    applyTheme((await db.getMeta('theme')) || 'auto');
    confirmedTheme = state.theme;
    renderHome();
    bindGlobal();
    finishLaunch();
  } catch (error) {
    console.error('No se pudo iniciar la vista con los datos locales.', error);
    $('#app').innerHTML = '<section class="page startup-error"><div class="notice warn" role="alert"><h1>No pudimos abrir tus datos</h1><p>No se borró el almacenamiento. No iniciaremos una configuración nueva sobre tus registros.</p></div><button class="btn btn-primary" id="startup-retry">Reintentar</button></section>';
    $('#tabbar').inert = true;
    $('#startup-retry').onclick = () => window.location.reload();
    finishLaunch(true);
    return;
  }
  requestPersistence().catch(error => console.warn('No se pudo solicitar almacenamiento persistente.', error));
  checkBackupReminder().catch(error => console.warn('No se pudo comprobar el recordatorio de respaldo.', error));

  sync.loadConfig().then(() => sync.syncQuietly().then(async r => {
    if (!r || (!r.pulled && !r.pushed) || state.session || state.draft) return;
    await loadAll();
    await loadRoutine();
    renderHome();
  })).catch(error => {
    console.warn('No se pudo preparar la sincronización.', error);
    toast('No se pudo preparar la nube. Tus registros locales se conservan; revisa Ajustes.');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(error => {
      console.warn('No se pudieron preparar los archivos sin conexión.', error);
      $('#update-status').textContent = 'No se pudo preparar la actualización offline. Conecta y vuelve a intentarlo.';
    });
  }
}

async function checkForUpdate() {
  const button = $('#btn-check-update');
  const label = $('#update-status');
  button.disabled = true;
  label.textContent = 'Comprobando versión…';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    if (state.session) throw new Error('Termina el entrenamiento antes de actualizar. No interrumpiremos tu sesión.');
    if (state.draft || state.edDirty) throw new Error('Guarda o cancela el editor antes de actualizar.');
    if (!navigator.onLine) throw new Error('Sin conexión. Tus datos siguen guardados aquí.');
    const response = await fetch(`index.html?update=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('No se pudo consultar la actualización');
    const remote = new DOMParser().parseFromString(await response.text(), 'text/html').documentElement.dataset.build;
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
    label.textContent = remote === APP_VERSION ? `Versión ${APP_VERSION} instalada` : `Versión ${remote || 'nueva'} disponible`;
    const accepted = await confirmSheet({
      title: remote === APP_VERSION ? 'Recargar la app' : 'Actualizar REAWAKEN',
      body: 'Se recargarán los archivos de la app. Tu rutina, tus registros y tu sesión de cuenta se conservan.',
      confirm: 'Recargar', cancel: 'Ahora no'
    });
    if (accepted) {
      const worker = registration?.installing || registration?.waiting || registration?.active;
      if (worker && worker.state !== 'activated') {
        label.textContent = 'Preparando los archivos para usar sin conexión…';
        await new Promise((resolve, reject) => {
          const finish = () => {
            if (worker.state === 'activated' || worker.state === 'redundant') {
              clearTimeout(timer);
              worker.removeEventListener('statechange', finish);
              if (worker.state === 'activated') resolve();
              else reject(new Error('La actualización no se pudo preparar. Tus datos siguen aquí.'));
            }
          };
          const timer = setTimeout(() => {
            worker.removeEventListener('statechange', finish);
            reject(new Error('La actualización está tardando. Intenta de nuevo cuando tengas conexión.'));
          }, 30000);
          worker.addEventListener('statechange', finish);
          finish();
        });
      }
      if (state.session || state.draft || state.edDirty) throw new Error('Hay cambios en curso. No se recargó la app.');
      window.location.reload();
    }
  } catch (error) {
    label.textContent = error.name === 'AbortError' ? 'La conexión tardó demasiado. Vuelve a intentar.' : error.message;
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
}

init();
