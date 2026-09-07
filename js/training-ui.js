import { repPrescription, repTarget, equipmentChoice, setRecord, nextSetAdvice, normalizeExercise, periodBounds, periodSummary, recoveryEstimate, trainingInsights, repChanges, weeklyRepAdvice } from './intelligence.js';
import { MUSCLE_GROUPS, muscleAtlas, dayFocus } from './exercise-info.js';

export function createTrainingUI({ state, dayFor, esc, openSheet, closeSheet, saveSession, redraw, showSession, onSaveError = () => {} }) {
  const select = selector => document.querySelector(selector);
  const selectAll = selector => [...document.querySelectorAll(selector)];
  let reportMode = 'week', reportAnchor = Date.now(), reportCycle = 'legacy';
  const date = timestamp => new Date(timestamp).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  const tracking = session => session.entries._training ||= { version: 1, sets: {}, choices: {} };
  const recordText = record => `${Number.isInteger(record.reps) ? `${record.reps} reps${record.repsSource === 'plan' ? ' del plan' : ''}` : 'Peso registrado'}${Number.isInteger(record.rir) ? ` · ${record.rir === 3 ? '3+' : record.rir} en reserva` : ''}${record.discomfort ? ' · Molestia' : ''} · ${record.label} (${record.unit})`;

  function repChangesHtml(sessions) {
    const changes = repChanges(sessions, dayFor);
    if (!changes.length) return '';
    return `<details class="report-details rep-changes" open><summary>Reps ajustadas · ${changes.length} ${changes.length === 1 ? 'serie' : 'series'}</summary>${changes.map(row => `<div class="report-session"><span>${esc(row.movement.name)}<small>${date(row.session.startedAt)} · Serie ${row.index + 1} · ${esc(row.label)}</small></span><b>${row.reps} reps<small>Plan: ${esc(row.movement.reps)}</small></b></div>`).join('')}</details>`;
  }

  function seedChoices(session, day) {
    for (const block of day.blocks) for (const movement of block.movements) {
      if (movement.kind !== 'weight' || session.entries?._training?.choices?.[movement.id]) continue;
      const history = state.sessions.filter(item => item.id !== session.id && item.startedAt < session.startedAt).sort((first, second) => second.startedAt - first.startedAt);
      for (const item of history) {
        const previous = dayFor(item)?.blocks.flatMap(entry => entry.movements).find(entry => normalizeExercise(entry.name) === normalizeExercise(movement.name));
        const choice = previous && item.entries?._training?.choices?.[previous.id];
        if (choice?.variant === 'original') { tracking(session).choices[movement.id] = { ...choice }; break; }
      }
    }
  }

  function repsInput(session, movement, index) {
    const target = repPrescription(movement);
    if (!target) return '';
    const saved = setRecord(session, movement.id, index);
    const reps = session.entries?._training?.repDrafts?.[movement.id]?.[index] ?? saved?.reps ?? target.max;
    return `<label class="set-reps"><input data-reps type="number" inputmode="numeric" enterkeyhint="done" min="1" max="99" step="1" value="${reps}" aria-label="Reps serie ${index + 1} de ${esc(movement.name)}"><span>reps</span></label>`;
  }

  function updateInlineRecord(session, movement, index, value) {
    const data = tracking(session);
    data.sets[movement.id] ||= [];
    const previous = data.sets[movement.id][index];
    const raw = session.entries[movement.id]?.[index];
    if (raw == null || String(raw).trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
      data.sets[movement.id][index] = null;
      return;
    }
    const target = repPrescription(movement);
    const reps = target && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 99 ? Number(value) : null;
    data.sets[movement.id][index] = { ...(previous || equipmentChoice(session, movement)), load: Number(raw), reps, repsSource: reps === null ? null : reps === target.max ? 'plan' : 'edited', rir: null, discomfort: previous?.discomfort || false, recordedAt: previous?.recordedAt || Date.now(), timeSource: 'registration' };
  }

  function extras(session, movement, block) {
    if (movement.kind !== 'weight') return '';
    const next = Array.from({ length: block.sets }, (_, index) => index).find(index => {
      const raw = session.entries[movement.id]?.[index];
      return typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0;
    });
    const candidate = next !== undefined && repTarget(movement) ? nextSetAdvice(session, movement, next, state.sessions, dayFor) : null;
    const advice = candidate?.text === 'Primera referencia' ? null : candidate;
    const weekly = weeklyRepAdvice(session, movement, state.sessions, dayFor);
    return `${advice ? `<div class="next-advice"><div><span class="eyebrow">Siguiente · Serie ${next + 1}</span><strong>${esc(advice.text)}</strong><small>${esc(advice.reason)}</small></div></div>` : ''}${weekly ? `<p class="training-caption weekly-reps">${esc(weekly.text)}</p>` : ''}`;
  }

  function workoutNote(day) {
    const focus = dayFocus(day);
    const muscle = recoveryEstimate(state.sessions, dayFor).filter(item => item.level === 'high' && (focus.includes(item.group) || focus.includes('full'))).sort((first, second) => second.load - first.load)[0];
    return muscle ? `<div class="training-note"><b>${MUSCLE_GROUPS[muscle.group]}: carga reciente elevada</b><span>Considera mantener ligero el trabajo directo hoy. Estimación del registro, no una medición de recuperación.</span></div>` : '';
  }

  function bind(day) {
    const movementFor = id => day.blocks.flatMap(block => block.movements).find(movement => movement.id === id);
    selectAll('#blocks [data-reps]').forEach(input => {
      const cell = input.closest('.set'), movement = movementFor(cell.dataset.mid), index = Number(cell.dataset.idx);
      const store = () => {
        const data = tracking(state.session);
        data.repDrafts ||= {};
        data.repDrafts[movement.id] ||= [];
        data.repDrafts[movement.id][index] = input.validity.valid && input.value !== '' ? Number(input.value) : null;
        updateInlineRecord(state.session, movement, index, input.value);
        saveSession();
      };
      input.oninput = store;
      input.onblur = () => {
        if (!input.validity.valid || input.value === '') input.value = repPrescription(movement).max;
        store();
        saveSession(true)?.catch(onSaveError);
        refreshAdvice(day, movement.id);
      };
      input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } };
    });
  }

  function refreshAdvice(day, movementId) {
    const block = day.blocks.find(item => item.movements.some(movement => movement.id === movementId));
    const slot = selectAll('[data-training-extra]').find(item => item.dataset.trainingExtra === movementId);
    if (slot && block) {
      const template = document.createElement('template');
      template.innerHTML = extras(state.session, block.movements.find(item => item.id === movementId), block);
      const incoming = template.content.querySelector('.next-advice');
      const existing = slot.querySelector('.next-advice');
      if (existing && incoming) {
        existing.firstElementChild.replaceChildren(...incoming.firstElementChild.childNodes);
      } else if (incoming) slot.append(incoming);
      else existing?.remove();
      bind(day);
    }
  }

  function openProgress(mode = reportMode, anchor = reportAnchor, cycleId = reportCycle) {
    reportMode = mode; reportAnchor = anchor; reportCycle = cycleId;
    const cycles = new Map([['legacy', 'Historial sin ciclo']]);
    for (const session of [...state.sessions].sort((first, second) => second.startedAt - first.startedAt)) if (session.entries?._cycle) cycles.set(session.entries._cycle.id, session.entries._cycle.name);
    for (const day of state.routine) if (day.cycleId) cycles.set(day.cycleId, day.cycleName || 'Rutina actual');
    const bounds = mode === 'cycle' ? { start: 0, end: Date.now() + 1 } : periodBounds(mode, anchor);
    const summary = periodSummary(state.sessions, dayFor, bounds, mode === 'cycle' ? cycleId : null);
    const recovery = recoveryEstimate(state.sessions, dayFor);
    const insights = trainingInsights(state.sessions, dayFor);
    const label = mode === 'cycle' ? cycles.get(cycleId) || 'Ciclo' : mode === 'day' ? date(bounds.start) : `${date(bounds.start)} · ${date(bounds.end - 1)}`;
    openSheet(`<span class="eyebrow">REAWAKEN · Progreso</span><h2>Tu balance</h2><div class="seg report-tabs" aria-label="Periodo">${[['day','Día'],['week','Semana'],['month','Mes'],['cycle','Ciclo']].map(([value,title]) => `<button data-report-mode="${value}" class="${mode === value ? 'on' : ''}" aria-pressed="${mode === value}">${title}</button>`).join('')}</div>${mode === 'cycle' ? `<div class="field"><label for="report-cycle">Ciclo de entrenamiento</label><select id="report-cycle">${[...cycles].map(([id,name]) => `<option value="${esc(id)}" ${id === cycleId ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></div>` : `<div class="report-navigation"><button class="icon-btn" data-period-step="-1" aria-label="Periodo anterior">‹</button><strong>${esc(label)}</strong><button class="icon-btn" data-period-step="1" aria-label="Periodo siguiente" ${bounds.end > Date.now() ? 'disabled' : ''}>›</button></div>`}<div class="history-totals report-totals"><div><strong>${summary.sessions.length}</strong><span>Sesiones</span></div><div><strong>${summary.days}</strong><span>Días activos${mode === 'week' && bounds.start === periodBounds('week').start ? ` / ${state.profile.daysPerWeek}` : ''}</span></div><div><strong>${summary.minutes}</strong><span>Minutos</span></div></div><div class="report-score"><b>${summary.score === null ? '—' : summary.score + '/100'}</b><span>Plan registrado · ${summary.done}/${summary.total} series${summary.approximate ? ' · Hay registros antiguos aproximados' : ''}${bounds.end > Date.now() && mode !== 'cycle' ? ' · Periodo en curso' : ''}</span></div>${!summary.sessions.length ? '<p class="report-empty">Sin sesiones finalizadas en este periodo.</p>' : `<details class="report-details"><summary>Sesiones del periodo</summary>${summary.sessions.map(session => `<button class="report-session" data-report-session="${esc(session.id)}"><span>${esc(dayFor(session)?.title || 'Sesión')}</span><small>${date(session.startedAt)}</small></button>`).join('')}</details>`}<h3 class="training-section-title">Trabajo por músculo</h3><div class="muscle-volume">${summary.groups.length ? summary.groups.map(([group,count]) => `<div><span>${MUSCLE_GROUPS[group]}</span><progress value="${count}" max="${summary.groups[0][1]}" aria-label="Trabajo de ${MUSCLE_GROUPS[group]}"></progress><b>${Math.round(count * 10) / 10}</b></div>`).join('') : '<p>Sin trabajo muscular clasificable.</p>'}</div><p class="training-caption">Series registradas; participación secundaria ponderada. No son mediciones de intensidad.</p><details class="report-details" id="recovery-detail"><summary>Muscle Battery · Ahora</summary><p class="training-caption">Estimación de carga reciente, no médica. No incluye sueño, comidas ni actividad fuera de la app.</p><div class="recovery-atlas">${muscleAtlas(recovery.map(item => item.group))}</div><div class="recovery-list">${Object.entries(MUSCLE_GROUPS).filter(([group]) => !['none','cardio','full'].includes(group)).map(([group,name]) => { const item = recovery.find(value => value.group === group); return `<div class="recovery-row" data-level="${item?.level || 'unknown'}"><span>${name}</span><b>${item?.label || 'Datos insuficientes'}</b>${item ? `<small>Último registro: ${date(item.latest)} · ${item.coverage >= 0.6 ? 'Con esfuerzo reportado' : 'Esfuerzo incompleto'}</small>` : ''}</div>`; }).join('')}</div></details><h3 class="training-section-title">Lo que noté</h3><p class="training-caption">Historial comparable · observaciones locales</p>${insights.length ? insights.map((insight,index) => `<button class="insight-row" data-insight="${index}"><span class="eyebrow">${insight.direction === 'up' ? 'Cambio sostenido' : 'Carga en descenso'}</span><strong>${esc(insight.title)}</strong><p>${esc(insight.text)}</p><small>Ver las ${insight.sample.length} sesiones</small></button>`).join('') : '<p class="report-empty">Todavía no hay evidencia suficiente para un patrón fiable.</p>'}`);
    select('.report-score').insertAdjacentHTML('afterend', repChangesHtml(summary.sessions));
    if (mode === 'month' || mode === 'cycle') {
      const weeksHtml = summary.weeks.length ? `<details class="report-details"><summary>Semanas del periodo · ${summary.weeks.length}</summary>${summary.weeks.map(week => `<div class="report-session"><span>Semana del ${date(week.start)}</span><small>${week.days} días · ${week.sessions} sesiones</small></div>`).join('')}</details>` : '';
      select('.report-score').insertAdjacentHTML('afterend', weeksHtml);
      if (mode === 'cycle' && summary.sessions.length) {
        const times = summary.sessions.map(session => session.startedAt);
        select('.report-score').insertAdjacentHTML('beforebegin', `<p class="training-caption">Registros: ${date(Math.min(...times))} · ${date(Math.max(...times))}</p>`);
      }
    }
    selectAll('[data-report-mode]').forEach(button => { button.onclick = () => openProgress(button.dataset.reportMode, reportAnchor, state.routine[0]?.cycleId || reportCycle); });
    selectAll('[data-period-step]').forEach(button => { button.onclick = () => {
      const target = new Date(bounds.start), step = Number(button.dataset.periodStep);
      if (mode === 'month') target.setMonth(target.getMonth() + step); else target.setDate(target.getDate() + step * (mode === 'week' ? 7 : 1));
      openProgress(mode, target.getTime());
    }; });
    if (select('#report-cycle')) select('#report-cycle').onchange = event => openProgress('cycle', anchor, event.target.value);
    selectAll('[data-report-session]').forEach(button => { button.onclick = () => showSession(button.dataset.reportSession); });
    selectAll('[data-insight]').forEach(button => { button.onclick = () => {
      const insight = insights[Number(button.dataset.insight)];
      openSheet(`<h2>${esc(insight.title)}</h2><p>${esc(insight.text)}</p><p>${esc(insight.detail)}</p>${insight.sample.map(row => `<button class="report-session" data-evidence-session="${esc(row.session.id)}"><span>${date(row.session.startedAt)}</span><b>${row.load} × ${row.reps}</b></button>`).join('')}<button class="btn btn-ghost" id="evidence-back">Volver al balance</button>`);
      select('#evidence-back').onclick = () => openProgress();
      selectAll('[data-evidence-session]').forEach(item => { item.onclick = () => showSession(item.dataset.evidenceSession); });
    }; });
    for (const item of recovery) selectAll(`.recovery-atlas [data-region="${item.group}"]`).forEach(region => { region.dataset.level = item.level; });
  }

  return { seedChoices, repsInput, updateInlineRecord, extras, bind, refreshAdvice, workoutNote, openProgress, recordText, repChangesHtml };
}