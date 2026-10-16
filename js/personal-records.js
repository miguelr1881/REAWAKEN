import { comparisonKey, personalBestForSet, setRecord } from './intelligence.js';

export function sessionPersonalRecords(session, sessions) {
  if (!session?.finishedAt || session.deletedAt || !session.routineSnapshot) return [];
  const records = new Map();
  for (const block of session.routineSnapshot.blocks) {
    for (const movement of block.movements) {
      const values = session.entries?.[movement.id];
      if (!Array.isArray(values)) continue;
      for (let index = 0; index < values.length; index++) {
        const previous = personalBestForSet(session, movement, index, sessions, item => item.routineSnapshot);
        const record = setRecord(session, movement.id, index);
        if (previous === null || !record || record.load <= previous) continue;
        const key = JSON.stringify([movement.id, comparisonKey(movement, record), record.reps]);
        if (!records.has(key) || records.get(key).load < record.load) {
          records.set(key, { movementId: movement.id, name: movement.name, sessionId: session.id, index,
            load: record.load, reps: record.reps, unit: record.unit, label: record.label, previous });
        }
      }
    }
  }
  return [...records.values()];
}
