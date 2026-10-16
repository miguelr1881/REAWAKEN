import { assisted, comparisonKey, isComparableSetRecord, normalizeExercise, repTarget, setRecord } from './intelligence.js';

export function correctSessionWeight(session, movementId, index, value) {
  const values = session.entries?.[movementId];
  const movement = session.routineSnapshot?.blocks.flatMap(block => block.movements).find(item => item.id === movementId);
  if (!session.finishedAt || session.deletedAt || !Array.isArray(values) ||
      !Number.isInteger(index) || index < 0 || index >= values.length ||
      (movement && movement.kind !== 'weight') ||
      typeof values[index] !== 'string' || values[index].trim() === '' ||
      !Number.isFinite(Number(values[index])) || Number(values[index]) < 0) {
    throw new Error('Solo puedes corregir una serie de peso ya registrada en un entrenamiento finalizado.');
  }
  const weight = typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(weight) || !Number.isFinite(Number(weight))) {
    throw new Error('Introduce un peso válido, mayor o igual a cero. Puedes usar decimales.');
  }
  const updated = structuredClone(session);
  updated.entries[movementId][index] = weight;
  const record = updated.entries._training?.sets?.[movementId]?.[index];
  if (record && typeof record === 'object' && !Array.isArray(record)) record.load = Number(weight);
  return updated;
}

export function movementHistoryRows(movement, sessions, now = Date.now(), dayFor = session => session.routineSnapshot) {
  const rows = [];
  for (const session of sessions) {
    if (!session.finishedAt || session.deletedAt || !Number.isFinite(session.startedAt) || session.startedAt > now) continue;
    const matches = (dayFor(session)?.blocks || []).flatMap(block => block.movements)
      .filter(item => item.kind === movement.kind && normalizeExercise(item.name) === normalizeExercise(movement.name));
    const original = matches.find(item => item.id === movement.id) || (matches.length === 1 ? matches[0] : null);
    if (!original) continue;
    const values = session.entries?.[original.id];
    if (!Array.isArray(values)) continue;
    const sets = values.flatMap((value, index) => {
      const recorded = value === true || (typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value)));
      return recorded ? [{ value, index, record: setRecord(session, original.id, index) }] : [];
    });
    if (sets.length) rows.push({ session, movement: original, sets });
  }
  return rows.sort((first, second) => second.session.startedAt - first.session.startedAt);
}

export function movementLoadHistory(movement, sessions, now = Date.now()) {
  if (!repTarget(movement) || assisted(movement)) return [];
  const groups = new Map();
  for (const { session, movement: original, sets } of movementHistoryRows(movement, sessions, now)) {
    if (!repTarget(original) || assisted(original)) continue;
    for (const { index, record } of sets) {
      if (!isComparableSetRecord(record)) continue;
      const key = JSON.stringify([comparisonKey(original, record), record.reps]);
      if (!groups.has(key)) groups.set(key, { key, record, prescription: original.reps, note: original.note || '', points: new Map() });
      const group = groups.get(key);
      const previous = group.points.get(session.id);
      if (!previous || record.load > previous.load) {
        group.points.set(session.id, { sessionId: session.id, at: session.startedAt, load: record.load, index });
      }
    }
  }
  return [...groups.values()].map(group => ({
    ...group, points: [...group.points.values()].sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId))
  })).sort((a, b) => b.points.at(-1).at - a.points.at(-1).at || b.points.length - a.points.length);
}
