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

export function movementLoadHistory(movement, sessions, now = Date.now()) {
  if (!repTarget(movement) || assisted(movement)) return [];
  const groups = new Map();
  for (const session of sessions) {
    if (!session.finishedAt || session.deletedAt || !Number.isFinite(session.startedAt) || session.startedAt > now) continue;
    const original = session.routineSnapshot?.blocks.flatMap(block => block.movements)
      .find(item => item.id === movement.id && normalizeExercise(item.name) === normalizeExercise(movement.name));
    if (!original || !repTarget(original) || assisted(original)) continue;
    const values = session.entries?.[movement.id];
    if (!Array.isArray(values)) continue;
    for (let index = 0; index < values.length; index++) {
      const record = setRecord(session, movement.id, index);
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
