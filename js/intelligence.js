import { exerciseGroups } from './exercise-info.js';
import { sessionDuration, localDay } from './progress.js';

export const normalizeExercise = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const isRecorded = value => value === true || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
const median = values => { const sorted = [...values].sort((first, second) => first - second); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

export function repPrescription(movement) {
  if (movement.kind !== 'weight' || movement.timer) return null;
  const match = String(movement.reps).trim().match(/^(\d{1,2})(?:\s*(?:-|a)\s*(\d{1,2}))?$/i);
  if (!match) return null;
  const min = Number(match[1]), max = Number(match[2] || match[1]);
  return min >= 1 && max >= min && max <= 99 ? { min, max } : null;
}

export function repTarget(movement) {
  if (/fallo|lentas|rapidas|mant|tramo|parcial|isometr|bajando|unilateral|simultaneo|\+/.test(normalizeExercise(`${movement.name} ${movement.note || ''}`))) return null;
  const target = repPrescription(movement);
  return target?.max <= 30 ? target : null;
}

export function assisted(movement) { return /asistid/.test(normalizeExercise(movement.name)); }

export function machineAlternative(movement) {
  const name = normalizeExercise(movement.name);
  const machines = [
    [/extension de rodilla|leg extension/, 'Otra extensión de rodilla sentada', 'Mismo apoyo, recorrido y posición del rodillo.'],
    [/aductor.*maquina|aduccion.*maquina/, 'Otra máquina de aductores sentada', 'Misma posición sentada y recorrido de cierre.'],
    [/curl de piernas sentado|curl femoral sentado/, 'Otro curl femoral sentado', 'Mantén la posición sentada; no equivale al curl acostado.'],
    [/curl.*(?:acostado|tumbado)|lying leg curl/, 'Otro curl femoral acostado', 'Mismo apoyo acostado y recorrido; no equivale al sentado.'],
    [/abductor.*maquina|abduccion.*maquina/, 'Otra máquina de abductores sentada', 'Mismo apoyo y recorrido de apertura.'],
    [/press.*pecho.*maquina|chest press/, 'Otra máquina de press de pecho del mismo tipo', 'Mismo ángulo, agarre y trayectoria. No trasladar la carga.'],
    [/press.*hombro.*maquina|shoulder press.*machine/, 'Otra máquina de press de hombros', 'Mismo respaldo, agarre y trayectoria.'],
    [/pec deck|peck fly|apertura.*maquina/, 'Otra máquina de aperturas del mismo tipo', 'Mismo apoyo de brazos y recorrido.'],
    [/jalon convergente/, 'Otro jalón convergente', 'Mismo agarre y trayectoria convergente.'],
    [/dominada.*asistid/, 'Otra máquina de dominadas asistidas', 'Mismo agarre y sistema de apoyo. La carga indica ayuda.'],
    [/remo en polea baja/, 'Otra polea baja para remo', 'Mismo agarre, apoyo y trayectoria.'],
    [/extension de triceps en polea/, 'Otra polea alta para tríceps', 'Mismo accesorio, postura y recorrido.'],
    [/patada de gluteo en polea|abduccion en polea/, 'Otra polea baja con tobillera', 'Misma postura, accesorio y recorrido.'],
    [/sentadilla en smith/, 'Otra Smith de la misma inclinación', 'Misma inclinación y posición de pies. La barra puede pesar distinto.'],
    [/^prensa$/, 'Otra prensa del mismo tipo', 'Misma inclinación, apoyo y recorrido; no cambiar horizontal por inclinada.']
  ];
  const found = machines.find(([pattern]) => pattern.test(name));
  return found ? { title: found[1], detail: found[2] } : null;
}

export function setRecord(session, movementId, index) {
  const record = session.entries?._training?.sets?.[movementId]?.[index];
  return record && Number(record.load) === Number(session.entries?.[movementId]?.[index]) && isRecorded(session.entries?.[movementId]?.[index]) ? record : null;
}

export function equipmentChoice(session, movement) {
  return session.entries?._training?.choices?.[movement.id] || { variant: 'original', label: 'Habitual', unit: 'escala', step: 0 };
}

export function comparisonKey(movement, choice) {
  return JSON.stringify([normalizeExercise(movement.name), movement.reps, normalizeExercise(movement.note), choice.variant, normalizeExercise(choice.label), choice.unit, assisted(movement)]);
}

export function trackedSets(sessions, dayFor) {
  const rows = [];
  for (const session of sessions) {
    if (session.deletedAt || !session.finishedAt || session.startedAt > Date.now()) continue;
    const day = dayFor(session);
    if (!day) continue;
    for (const block of day.blocks) for (const movement of block.movements) {
      if (!repTarget(movement)) continue;
      for (let index = 0; index < block.sets; index++) {
        const record = setRecord(session, movement.id, index);
        if (!record || record.discomfort || !Number.isInteger(record.reps) || record.reps < 1 || !Number.isFinite(record.load)) continue;
        rows.push({ ...record, key: comparisonKey(movement, record), movement, session, index });
      }
    }
  }
  return rows;
}

export function nextSetAdvice(session, movement, index, sessions, dayFor) {
  const target = repTarget(movement);
  if (!target) return { text: 'Plan especial del coach', reason: 'Sin ajuste automático de carga.' };
  const choice = equipmentChoice(session, movement);
  const key = comparisonKey(movement, choice);
  const prior = trackedSets(sessions.filter(item => item.id !== session.id && item.startedAt < session.startedAt), dayFor).filter(row => row.key === key).sort((first, second) => second.session.startedAt - first.session.startedAt || second.index - first.index);
  const current = (session.entries?._training?.sets?.[movement.id] || []).slice(0, index).map((_, offset) => setRecord(session, movement.id, offset)).filter(record => record && (Number.isInteger(record.reps) || record.discomfort) && comparisonKey(movement, record) === key);
  const last = current.at(-1) || prior[0];
  if (!last) return { text: 'Primera referencia', reason: 'Elige una carga cómoda para este equipo; no copiamos cargas de otras máquinas.' };
  if (last.discomfort) return { text: 'Detén este ejercicio si hay dolor', reason: 'Sin recomendaciones de carga tras registrar molestia.' };
  let load = last.load;
  let reason = 'Mantén la referencia de este equipo y las reps del coach.';
  const step = Number(choice.step);
  const direction = assisted(movement) ? -1 : 1;
  const excessive = last.reps < target.min || last.rir === 0;
  const strong = last.reps >= target.max && last.rir >= 3;
  const supporting = prior.filter(row => row.reps >= target.max && row.rir >= 2 && row.load === last.load);
  const supportCount = new Set(supporting.map(row => row.session.id)).size;
  if (Number.isFinite(step) && step > 0 && step <= Math.max(load * 0.1, 0.5)) {
    if (excessive) { load -= direction * step; reason = assisted(movement) ? 'Más ayuda: la última serie quedó por debajo del objetivo o sin margen.' : 'Un paso menos: la última serie quedó por debajo del objetivo o sin margen.'; }
    else if (strong && supportCount >= 2 && !current.some(record => record.load !== current[0].load)) {
      load += direction * step;
      reason = assisted(movement) ? 'Un paso menos de ayuda, con margen repetido en sesiones anteriores.' : 'Un paso más, con margen en la última serie y apoyo de al menos dos sesiones.';
    }
  } else if (excessive) return { text: assisted(movement) ? 'Considera más asistencia' : 'Considera bajar la carga', reason: 'El salto disponible no está configurado o es demasiado grande para calcular un ajuste prudente.' };
  if (load < 0 || !Number.isFinite(load)) return { text: 'Mantén una carga cómoda', reason: 'Sin ajuste numérico adecuado para este equipo.' };
  return { load: Math.round(load * 100) / 100, text: `${Math.round(load * 100) / 100} · ${movement.reps} reps`, reason, unit: choice.unit, target };
}

export function muscleContributions(movement) {
  const groups = exerciseGroups(movement).filter(group => !['none', 'full', 'cardio'].includes(group));
  const name = normalizeExercise(movement.name);
  if (groups.includes('chest') && /press|flexion|push up/.test(name)) groups.push('triceps', 'shoulders');
  if (groups.includes('back') && /remo|jalon|dominada/.test(name)) groups.push('biceps');
  if (groups.includes('shoulders') && /press/.test(name)) groups.push('triceps');
  return [...new Set(groups)].map((group, index) => ({ group, share: index ? 0.5 : 1 }));
}

export function recoveryEstimate(sessions, dayFor, now = Date.now()) {
  const muscles = new Map();
  const loadHistory = trackedSets(sessions, dayFor);
  for (const session of sessions) {
    if (session.deletedAt || !session.finishedAt || session.startedAt > now || now - session.startedAt > 14 * 86400000) continue;
    const day = dayFor(session);
    if (!day) continue;
    for (const block of day.blocks) for (const movement of block.movements) {
      if (movement.kind !== 'weight') continue;
      const groups = muscleContributions(movement);
      for (let index = 0; index < block.sets; index++) {
        if (!isRecorded(session.entries?.[movement.id]?.[index])) continue;
        const record = setRecord(session, movement.id, index);
        const at = Number.isFinite(record?.recordedAt) && record.recordedAt >= session.startedAt && record.recordedAt <= session.finishedAt ? record.recordedAt : session.startedAt;
        const hours = Math.max(0, (now - at) / 3600000);
        const effort = record?.rir === 0 ? 1.3 : record?.rir === 1 ? 1.15 : record?.rir >= 3 ? 0.7 : 1;
        const comparable = record && !assisted(movement) ? loadHistory.filter(row => row.session.startedAt < session.startedAt && row.reps === record.reps && row.key === comparisonKey(movement, record)).map(row => row.load).filter(load => load > 0) : [];
        const relativeLoad = comparable.length >= 3 ? Math.min(1.1, Math.max(0.9, record.load / median(comparable))) : 1;
        for (const { group, share } of groups) {
          const value = muscles.get(group) || { group, load: 0, sets: 0, known: 0, latest: 0 };
          value.load += share * effort * relativeLoad * Math.exp(-hours / 36);
          value.sets += share;
          value.known += Number.isInteger(record?.rir) ? share : 0;
          value.latest = Math.max(value.latest, at);
          muscles.set(group, value);
        }
      }
    }
  }
  const declining = new Set(trainingInsights(sessions, dayFor).filter(insight => insight.effortKnown && insight.direction === 'down' && now - insight.sample.at(-1).session.startedAt < 7 * 86400000).flatMap(insight => muscleContributions(insight.sample.at(-1).movement).map(item => item.group)));
  return [...muscles.values()].map(value => {
    const performanceSignal = declining.has(value.group);
    const load = value.load * (performanceSignal ? 1.1 : 1);
    return { ...value, load, performanceSignal, level: load >= 6 ? 'high' : load >= 2 ? 'medium' : 'low', label: load >= 6 ? 'Carga reciente elevada' : load >= 2 ? 'Recuperación en curso' : 'Menor carga reciente', coverage: value.known / value.sets };
  });
}

export function periodBounds(mode, anchor = Date.now()) {
  const start = new Date(anchor); start.setHours(0, 0, 0, 0);
  if (mode === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (mode === 'month') start.setDate(1);
  const end = new Date(start);
  if (mode === 'month') end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (mode === 'week' ? 7 : 1));
  return { start: start.getTime(), end: end.getTime() };
}

export function periodSummary(sessions, dayFor, bounds, cycleId = null) {
  const selected = sessions.filter(session => session.finishedAt && !session.deletedAt && session.startedAt >= bounds.start && session.startedAt < bounds.end && (!cycleId || (session.entries?._cycle?.id || 'legacy') === cycleId));
  let done = 0, total = 0;
  const groups = new Map();
  for (const session of selected) {
    const day = dayFor(session);
    if (!day) continue;
    for (const block of day.blocks) for (const movement of block.movements) {
      const count = (session.entries[movement.id] || []).slice(0, block.sets).filter(isRecorded).length;
      total += block.sets; done += count;
      if (movement.kind === 'weight') for (const { group, share } of muscleContributions(movement)) groups.set(group, (groups.get(group) || 0) + count * share);
    }
  }
  const weeks = new Map();
  for (const session of selected) {
    const start = periodBounds('week', session.startedAt).start;
    if (!weeks.has(start)) weeks.set(start, { start, days: new Set(), sessions: 0 });
    weeks.get(start).days.add(localDay(session.startedAt));
    weeks.get(start).sessions++;
  }
  return { sessions: selected, weeks: [...weeks.values()].sort((first, second) => first.start - second.start).map(week => ({ ...week, days: week.days.size })), days: new Set(selected.map(session => localDay(session.startedAt))).size, minutes: Math.round(selected.reduce((sum, session) => sum + sessionDuration(session), 0) / 60000), done, total, score: total ? Math.round(done / total * 100) : null, groups: [...groups].sort((first, second) => second[1] - first[1]), approximate: selected.some(session => !session.routineSnapshot) };
}

export function repChanges(sessions, dayFor) {
  const changes = [];
  for (const session of sessions) {
    if (!session.finishedAt || session.deletedAt || session.startedAt > Date.now()) continue;
    for (const block of dayFor(session)?.blocks || []) for (const movement of block.movements) {
      const target = repPrescription(movement);
      if (!target) continue;
      for (let index = 0; index < block.sets; index++) {
        const record = setRecord(session, movement.id, index);
        if (record?.repsSource === 'edited' && Number.isInteger(record.reps) && record.reps >= 1 && record.reps <= 99 && record.reps !== target.max) changes.push({ ...record, movement, session, index });
      }
    }
  }
  return changes;
}

export function weeklyRepAdvice(session, movement, sessions, dayFor, anchor = Date.now()) {
  const target = repTarget(movement);
  if (!target) return null;
  const end = periodBounds('week', anchor).start;
  const previousWeek = new Date(end);
  previousWeek.setDate(previousWeek.getDate() - 7);
  const recentStart = new Date(end);
  recentStart.setDate(recentStart.getDate() - 28);
  const key = comparisonKey(movement, equipmentChoice(session, movement));
  const cycle = session.entries?._cycle?.id || 'legacy';
  const rows = trackedSets(sessions, dayFor).filter(row => row.session.id !== session.id && row.session.startedAt >= recentStart.getTime() && row.session.startedAt < end && row.key === key && (row.session.entries?._cycle?.id || 'legacy') === cycle);
  const edited = rows.filter(row => row.repsSource === 'edited' && (row.reps < target.min || row.reps > target.max));
  if (!edited.some(row => row.session.startedAt >= previousWeek.getTime()) || new Set(edited.map(row => localDay(row.session.startedAt))).size < 2 || edited.length <= rows.length / 2) return null;
  const reps = median(edited.map(row => row.reps));
  if (reps >= target.min && reps <= target.max) return null;
  return { reps, days: new Set(edited.map(row => localDay(row.session.startedAt))).size, text: `En las semanas recientes registraste habitualmente ${reps} reps frente a ${movement.reps} del plan. Considera revisar ese objetivo con tu coach; el plan sigue igual.` };
}

export function trainingInsights(sessions, dayFor) {
  const buckets = new Map();
  for (const row of trackedSets(sessions, dayFor)) {
    if (row.index !== 0 || row.load <= 0 || assisted(row.movement)) continue;
    const basis = Number.isInteger(row.rir) ? `effort-${row.rir}` : ['plan', 'edited'].includes(row.repsSource) ? row.repsSource : null;
    if (!basis) continue;
    const key = `${row.key}:${row.reps}:${basis}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const insights = [];
  const used = new Set();
  for (const [key, rows] of buckets) {
    const bySession = new Map();
    for (const row of rows) if (!bySession.has(row.session.id) || row.index < bySession.get(row.session.id).index) bySession.set(row.session.id, row);
    const sample = [...bySession.values()].sort((first, second) => first.session.startedAt - second.session.startedAt).slice(-6);
    if (sample.length < 6 || new Set(sample.map(row => localDay(row.session.startedAt))).size < 6 || sample.at(-1).session.startedAt - sample[0].session.startedAt < 14 * 86400000) continue;
    const before = median(sample.slice(0, 3).map(row => row.load));
    const after = median(sample.slice(3).map(row => row.load));
    const delta = (after / before - 1) * 100;
    const separated = delta > 0 ? Math.min(...sample.slice(3).map(row => row.load)) > Math.max(...sample.slice(0, 3).map(row => row.load)) : Math.max(...sample.slice(3).map(row => row.load)) < Math.min(...sample.slice(0, 3).map(row => row.load));
    const latest = sample.at(-1);
    if (Math.abs(delta) < 5 || !separated || used.has(latest.movement.name)) continue;
    used.add(latest.movement.name);
    const effortKnown = Number.isInteger(latest.rir);
    const repsLabel = effortKnown ? `${latest.reps} reps y el mismo margen reportado` : `${latest.reps} reps ${latest.repsSource === 'plan' ? 'precargadas del plan' : 'ajustadas en el registro'}`;
    const effortDetail = effortKnown ? `${latest.rir === 3 ? '3+' : latest.rir} reps en reserva.` : 'Sin esfuerzo registrado: este cambio de carga no demuestra una mejora ni una pérdida de fuerza.';
    insights.push({ id: key, title: latest.movement.name, text: `La carga mediana registrada pasó de ${before} a ${after}, con ${repsLabel}.`, detail: `${latest.label} · ${latest.unit} · ${effortDetail} Primera serie del ejercicio: tres sesiones anteriores frente a tres recientes. Observación, no prueba de causa ni medida de fuerza máxima.`, sample, effortKnown, direction: delta > 0 ? 'up' : 'down' });
  }
  return insights.slice(0, 3);
}