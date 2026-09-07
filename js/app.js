import { DEFAULT_ROUTINE, PROFILE, totalSets } from './routine.js';
import { db, requestPersistence, storageEstimate } from './db.js';
import { INBODY_FIELDS, parseInBody, formatValue, consistency, fieldMeta } from './inbody.js';
import { parseRoutineText, sanitizeRoutine, DAY_ACCENTS } from './routine-parser.js';
import * as sync from './sync.js';
import { MUSCLE_GROUPS, exerciseFocus, exerciseGroups, imageSearchUrl, muscleAtlas, dayFocus } from './exercise-info.js';
import { normalizeProfile, validProfileDate, monthlyInBody } from './profile.js';

const APP_VERSION = '2.4.0';

/* ============================== Estado ============================== */

const state = {
  view: 'home',
  routine: DEFAULT_ROUTINE,   // rutina activa
  routineId: null,
  profile: normalizeProfile(),
  session: null,              // sesión activa (finishedAt === null)
  sessions: [],               // historial completo
  measures: [],               // mediciones InBody
  draft: null,                // rutina en edición
  edDay: 0,                   // día visible en el editor
  edDirty: false,             // el borrador tiene cambios sin guardar
  theme: 'auto',
  chartMetric: 'pbf',
  viewScroll: {},
  restSeconds: 45,
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

/* ============================== Utilidades ============================== */

function fmtDate(ts, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Date(ts).toLocaleDateString('es-MX', opts);
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** `action` opcional: `{ label, fn }` pinta un botón dentro del toast (deshacer). */
function toast(msg, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { el.classList.remove('show'); clearTimeout(el._t); action.fn(); };
    el.append(btn);
  }
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2600);
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
  $('#meta-theme-color').setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
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
  state.workoutScroll = 0;
  const day = dayById(dayId);
  const entries = {};
  for (const block of day.blocks) {
    for (const mv of block.movements) {
      entries[mv.id] = Array.from({ length: block.sets }, () => (mv.kind === 'weight' ? '' : false));
    }
  }
  return { id: uid(), dayId, routineSnapshot: JSON.parse(JSON.stringify(day)), startedAt: Date.now(), finishedAt: null, notes: '', entries };
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
function saveSession(immediate = false) {
  if (!state.session) return;
  clearTimeout(saveTimer);
  const session = state.session;
  const doSave = async () => {
    await db.putSession(session);
    const i = state.sessions.findIndex(s => s.id === session.id);
    if (i >= 0) state.sessions[i] = { ...session };
    else state.sessions.push({ ...session });
  };
  if (immediate) return doSave();
  saveTimer = setTimeout(() => doSave().catch(() => toast('No se pudo guardar. Revisa el almacenamiento.')), 350);
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
  state.viewScroll[state.view] = window.scrollY;
  if (state.view === 'workout' && name !== 'workout') state.workoutScroll = window.scrollY;
  state.view = name;
  const fullscreen = name === 'workout' || name === 'editor';
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $('#tabbar').style.display = fullscreen ? 'none' : 'flex';
  document.body.classList.toggle('in-workout', fullscreen);
  closeSheet();
  if (name !== 'workout') hideRest();
  window.scrollTo({ top: name === 'workout' ? state.workoutScroll || 0 : state.viewScroll[name] || 0 });
}

/* ---------- Home ---------- */

function renderHome() {
  $('#today-date').textContent = fmtDate(Date.now());

  const h = new Date().getHours();
  $('#greeting').textContent = `${h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'}, ${state.profile.name.split(/\s+/)[0]}`;
  $('#coach-credit').textContent = [state.profile.sport, state.profile.coach ? `Coach: ${state.profile.coach}` : ''].filter(Boolean).join(' · ');
  renderInBodyReminder();

  const finished = state.sessions.filter(s => s.finishedAt);
  $('#stat-week').textContent = `${finished.filter(s => s.startedAt >= weekStart(Date.now())).length}/${state.profile.daysPerWeek}`;
  $('#stat-total').textContent = finished.length;
  $('#stat-streak').textContent = calcWeekStreak(finished);
  $('#stat-streak').parentElement.title = `Racha: semanas con al menos ${state.profile.daysPerWeek} sesiones`;
  $('#routine-heading').textContent = `Tu rutina · ${state.routine.length} días`;
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
    </section>` : '';
  if ($('#btn-start-next')) $('#btn-start-next').onclick = () => startOrOpen(nextDayId);

  renderRoutineAlert();

  $('#day-list').innerHTML = state.routine.map((day, dayIndex) => {
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
  if (ensureEntries(state.session, day)) saveSession(true);
  $('#wh-name').textContent = `${day.label} · ${day.title}`;
  renderBlocks(day);
  updateWorkoutHeader();
  updateNotesButton();
  setView('workout');
}

function renderBlocks(day) {
  const s = state.session;
  const focus = dayFocus(day);
  const unassigned = day.blocks.flatMap(block => block.movements).filter(movement => exerciseFocus(movement) === 'none').length;
  $('#blocks').innerHTML = `<section class="workout-focus" aria-label="Enfoque orientativo de esta sesión"><div><span class="eyebrow">${esc(day.label)} · Enfoque</span><h2>${esc(day.subtitle || day.title)}</h2><p>${focus.map(group => MUSCLE_GROUPS[group]).join(' · ') || 'Sin grupos asignados'}${unassigned ? `<br><span class="focus-unassigned">${unassigned} sin clasificar</span>` : ''}</p></div><div class="workout-atlas">${muscleAtlas(focus)}</div></section>` + day.blocks.map(block => {
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
          ${last ? `<div class="mv-last">Última vez: <b>${esc(last.values.join(' · '))}</b></div>` : ''}
          <div class="sets">${setsHtml}</div>
          ${mv.kind === 'weight' && (block.rest ?? state.restSeconds) > 0 ? `<button class="mv-rest" data-seconds="${block.rest ?? state.restSeconds}" aria-label="Descansar después de ${esc(mv.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 8v5l3 2M9 2h6"/></svg>Descansar ${block.rest ?? state.restSeconds} s</button>` : ''}
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
      saveSession(true);
    });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !recordedSet(input.value)) return;
      event.preventDefault();
      input.blur();
      startRest(currentRestFor(day, cell.dataset.mid));
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
}

function updateWorkoutHeader() {
  const p = sessionProgress(state.session);
  $('#wh-progress').style.width = `${p.pct}%`;
  const mins = fmtDuration(Date.now() - state.session.startedAt);
  $('#wh-sub').textContent = `${p.done}/${p.total} series · ${p.pct}% · ${mins}`;
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
  $('#rt-num').textContent = Math.max(0, state.rest.left);
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

function renderHistory() {
  const finished = state.sessions.filter(s => s.finishedAt).sort((a, b) => b.startedAt - a.startedAt);
  $('#history-sub').textContent = finished.length
    ? `${finished.length} ${finished.length === 1 ? 'sesión completada' : 'sesiones completadas'}`
    : 'Aún sin entrenamientos';

  const slot = $('#history-slot');
  const calendar = historyState.mode === 'calendar';
  const period = calendar ? finished.filter(session => dateKey(session.startedAt).slice(0, 7) === dateKey(historyState.month).slice(0, 7)) : finished;
  const minutes = Math.round(period.reduce((total, session) => total + Math.max(0, session.finishedAt - session.startedAt), 0) / 60000);
  const summary = `<div class="history-totals" aria-label="${calendar ? 'Resumen del mes' : 'Resumen completo'}"><div><strong>${period.length}</strong><span>Sesiones${calendar ? ' del mes' : ''}</span></div><div><strong>${new Set(period.map(session => dateKey(session.startedAt))).size}</strong><span>Días activos</span></div><div><strong>${minutes}</strong><span>Minutos</span></div></div>`;
  const visible = calendar ? finished.filter(session => dateKey(session.startedAt) === historyState.selected) : finished;
  slot.innerHTML = `${summary}<div class="history-switch seg" role="group" aria-label="Vista del historial"><button data-history-mode="calendar" class="${calendar ? 'on' : ''}" aria-pressed="${calendar}">Calendario</button><button data-history-mode="list" class="${calendar ? '' : 'on'}" aria-pressed="${!calendar}">Todas las sesiones</button></div>
    ${calendar ? historyCalendar(finished) : ''}
    <h2 class="section-title history-date" id="history-date-title">${calendar ? esc(fmtDate(new Date(`${historyState.selected}T12:00:00`), { weekday: 'long', day: 'numeric', month: 'long' })) : 'Sesiones completadas'}</h2>
    <div aria-labelledby="history-date-title">${visible.length ? `<div class="list-card">${visible.map(s => {
    const day = sessionDay(s);
    const p = sessionProgress(s);
    const dur = s.finishedAt ? fmtDuration(s.finishedAt - s.startedAt) : '';
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
      return `<div class="session-set${done ? ' done' : ''}"><small>Serie ${setIndex + 1}</small><b>${mv.kind === 'weight' ? done ? esc(value) : '—' : done ? '✓' : '—'}</b><span>${done ? 'Registrada' : 'Sin registrar'}</span></div>`;
    }).join('');
    return `<div class="session-movement"><h4>${esc(mv.name)}</h4><p>${esc(mv.reps || '')}${mv.timer ? ` · ${mv.timer} s` : ''}</p>${mv.note ? `<p class="session-note">${esc(mv.note)}</p>` : ''}<div class="session-sets">${sets}</div></div>`;
  }).join('')}</section>`).join('');

  openSheet(`
    <div class="grabber"></div>
    <h2>${esc(day?.title || 'Entrenamiento anterior')}</h2>
    <p>${fmtDate(s.startedAt)} · ${fmtDuration(s.finishedAt - s.startedAt)}</p>
    ${!s.routineSnapshot ? '<p class="session-legacy">Esta sesión no conserva una copia original de su rutina. Los datos disponibles pueden no reflejar el plan de ese día.</p>' : ''}
    <div class="summary-grid">
      <div><b>${day ? p.done : Object.values(s.entries || {}).filter(Array.isArray).flat().filter(recordedSet).length}</b><span>Series</span></div>
      <div><b>${day ? `${p.pct}%` : '—'}</b><span>Completado</span></div>
      <div><b>${esc(day?.label?.replace('Día ', 'D') || '—')}</b><span>Rutina</span></div>
    </div>
    ${s.notes ? `<div class="block-note" style="margin-bottom:16px">${esc(s.notes)}</div>` : ''}
    <div style="margin-bottom:18px">${rows}</div>
    <button class="btn btn-ghost" id="sheet-close">Cerrar</button>
    <button class="session-delete" id="sheet-delete">Eliminar sesión</button>
  `);

  $('#sheet-close').onclick = closeSheet;
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
  state.profile = normalizeProfile(saved?.profile);
  state.routineUpdatedAt = saved?.updatedAt || null;
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
  await saveSession(true);
  for (const session of state.sessions) {
    const original = dayById(session.dayId);
    if (!session.routineSnapshot && original) {
      session.routineSnapshot = JSON.parse(JSON.stringify(original));
      await db.putSession(session);
    }
  }
  const saved = (await db.allRoutines()).find(r => r.id === ROUTINE_ID);
  await db.putRoutine({ id: ROUTINE_ID, name: name || 'Mi rutina', days: clean, active: true, ...(saved?.profile ? { profile: saved.profile } : {}) });
  state.routineUpdatedAt = Date.now();
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
    edTouch();  // lo interpretado todavía no existe en disco: salir sin guardar debe avisar
    toast(`${days.length} días interpretados · revísalos`);
  };
}

function openEditor(days, warnings = []) {
  state.draft = JSON.parse(JSON.stringify(days));
  state.draftWarnings = warnings;
  state.edDay = 0;
  state.edDirty = false;
  renderEditor();
  setView('editor');
}

const ED_ICON = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13M6 12l6 6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5h4v2M6.5 7l.9 12.1A1 1 0 008.4 20h7.2a1 1 0 001-.9L17.5 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
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
      </div>
      <div class="ed-mv-row">
        <label class="ed-field ed-field-reps"><span>Reps</span>
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
          <button class="ed-icon" data-copy-block="${bi}" aria-label="Duplicar bloque" title="Duplicar bloque">${ED_ICON.copy}</button>
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
    if ((el = hit('data-note'))) {
      const input = el.previousElementSibling;
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
      state.draft.push({
        id: uid(), label: `Día ${n}`, title: '', subtitle: '',
        accent: DAY_ACCENTS[(n - 1) % DAY_ACCENTS.length],
        blocks: [{ id: uid(), floor: null, sets: 3, movements: [newMovement()] }]
      });
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

async function finishWorkout() {
  if (!state.session || state.session.finishedAt) return;
  const s = state.session;
  const day = sessionDay(s);
  const p = sessionProgress(s);
  s.finishedAt = Date.now();
  await saveSession(true);
  state.session = null;
  setView('home');
  renderHome();
  renderHistory();

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
let sheetDismiss = null;
let sheetFocus = null;

function openSheet(html) {
  sheetToken++;
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
}

function closeSheet(accepted = false) {
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
  setTimeout(() => { if (token === sheetToken) $('#sheet').innerHTML = ''; }, 260);
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
  return {
    app: 'gymtrack',
    version: 3,
    exportedAt: new Date().toISOString(),
    profile: state.profile.name,
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
    <p>En tu proyecto: <b>Project Settings → Data API</b> para la URL, y <b>API Keys</b> para la clave. Antes corre el archivo <b>sql/schema.sql</b> en el SQL Editor.</p>
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
  const reminder = monthlyInBody(state.measures);
  $('#inbody-reminder').innerHTML = reminder.due ? `<button class="routine-alert due" id="btn-inbody-reminder"><div><strong>Nuevo InBody · ${esc(fmtDate(reminder.next, { month: 'long' }))}</strong><small>Pendiente de este mes</small></div><span aria-hidden="true">+</span></button>` : '';
  if ($('#btn-inbody-reminder')) $('#btn-inbody-reminder').onclick = openNewMeasure;
  $('#inbody-schedule').textContent = reminder.due ? 'Cada día 1 · Pendiente este mes' : `Este mes registrado · Próximo: ${fmtDate(reminder.next, { day: 'numeric', month: 'long' })}`;
}

function openProfile(focusDate = false) {
  const profile = state.profile;
  openSheet(`<h2>Editar perfil</h2><form id="profile-form">
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
  const saveButton = $('#profile-save');
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
    saving = true;
    saveButton.disabled = true;
    try {
      const saved = (await db.allRoutines()).find(routine => routine.id === ROUTINE_ID);
      const updated = normalizeProfile(values);
      await db.putRoutine({ ...(saved || { id: ROUTINE_ID, name: 'Mi rutina', days: state.routine, active: true }), profile: updated });
      state.profile = updated;
      state.routineUpdatedAt = Date.now();
      if ($('#profile-form') === form) closeSheet();
      renderHome(); renderBody(); renderSettings();
      toast('Perfil guardado');
      sync.syncQuietly();
    } catch (error) {
      errorLabel.textContent = error.message || 'No se pudo guardar el perfil';
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  };
  if (focusDate) $('#profile-date').focus();
}

async function renderSettings() {
  const profile = state.profile;
  $('#settings-profile').innerHTML = `<span class="settings-monogram" aria-hidden="true">${esc(profile.name.split(/\s+/).map(part => part[0]).slice(0, 2).join(''))}</span><span class="settings-profile-copy"><strong>${esc(profile.name)}</strong><small>${esc([profile.sport, profile.coach ? `Coach ${profile.coach}` : ''].filter(Boolean).join(' · '))}</small></span><strong>${profile.daysPerWeek}<small>días/sem.</small></strong><svg class="profile-edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>`;
  renderInBodyReminder();
  const notice = $('#storage-notice');
  $('#multimedia-audio').checked = state.multimediaAudio;
  $('#multimedia-audio').disabled = !navigator.audioSession;
  $('#audio-support').textContent = navigator.audioSession ? 'Experimental · Puede interrumpir tu música. No garantiza alarmas en segundo plano.' : 'Este navegador no ofrece Audio Session. Se mantiene el audio normal.';
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
  $('#routine-summary').textContent = `${state.routine.length} días · ${mv} ejercicios${state.routineUpdatedAt ? ` · Guardada ${fmtDate(state.routineUpdatedAt, { day: 'numeric', month: 'short' })}` : ' · Rutina inicial'}`;

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

  $('#btn-timer').onclick = () => startRest(state.restSeconds);
  $('#btn-notes').onclick = openNotes;
  $('#rt-close').onclick = hideRest;
  $('#rt-toggle').onclick = toggleCountdown;
  $$('.rt-chip[data-rest]').forEach(b => { b.onclick = () => { state.restSeconds = +b.dataset.rest; startRest(state.restSeconds); }; });
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
    if (state.edDirty) {
      const ok = await confirmSheet({
        title: 'Salir sin guardar', body: 'Se pierden los cambios de la rutina.',
        confirm: 'Descartar cambios', cancel: 'Seguir editando', danger: true
      });
      if (!ok) return;
    }
    state.draft = null;
    setView('settings'); renderSettings();
  };

  $('#ed-save').onclick = async () => {
    if (!edValidate()) return;
    try {
      await saveRoutine(state.draft, 'Mi rutina');
      state.draft = null;
      state.edDirty = false;
      setView('home'); renderHome();
      sync.syncQuietly();
      toast('Rutina guardada');
    } catch (e) {
      toast(e.message);
    }
  };
  bindEditor();
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
    if (document.visibilityState === 'hidden') saveSession(true);
    else { tickCountdown(); renderInBodyReminder(); renderRoutineAlert(); }
  });
  window.addEventListener('pagehide', () => saveSession(true));

  let reminderDate = dateKey(Date.now());
  setInterval(() => {
    if (state.view === 'workout' && state.session) updateWorkoutHeader();
    if (reminderDate !== dateKey(Date.now())) {
      reminderDate = dateKey(Date.now());
      renderInBodyReminder(); renderRoutineAlert();
    }
  }, 30000);
}

async function init() {
  await loadAll();
  await loadRoutine();
  state.multimediaAudio = (await db.getMeta('multimediaAudio')) === true;
  applyTheme((await db.getMeta('theme')) || 'auto');
  await seedMeasures();
  bindGlobal();
  renderHome();
  requestPersistence();
  checkBackupReminder();

  sync.loadConfig().then(() => sync.syncQuietly().then(async r => {
    if (!r || (!r.pulled && !r.pushed) || state.session || state.draft) return;
    await loadAll();
    await loadRoutine();
    renderHome();
  }));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
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
    if (accepted) { await saveSession(true); window.location.reload(); }
  } catch (error) {
    label.textContent = error.name === 'AbortError' ? 'La conexión tardó demasiado. Vuelve a intentar.' : error.message;
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
}

init();
