import { correctSessionWeight, movementLoadHistory } from '../js/session-history.js';
import { nextSetAdvice, personalBestForSet, setRecord } from '../js/intelligence.js';
import { prepareBackup } from '../js/backup.js';

export function runSessionHistoryTests() {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const rejects = (action, message) => {
    let failed = false;
    try { action(); } catch { failed = true; }
    assert(failed, message);
  };
  const now = Date.now();
  const movement = { id: 'press', name: 'Press de pecho', kind: 'weight', reps: '10' };
  const day = { id: 'day', blocks: [{ id: 'block', sets: 2, movements: [movement] }] };
  const choice = { variant: 'original', label: 'Habitual', unit: 'escala', step: 0 };
  const make = (id, daysAgo, load) => ({
    id, dayId: day.id, startedAt: now - daysAgo * 86400000,
    finishedAt: now - daysAgo * 86400000 + 3600000, updatedAt: now - daysAgo * 86400000,
    routineSnapshot: structuredClone(day), notes: 'Conservar nota',
    entries: { press: [String(load), ''], another: ['18'], _durationMinutes: 42,
      _cycle: { id: 'cycle' }, _training: { version: 1, choices: { press: { ...choice } },
        sets: { press: [{ ...choice, load, reps: 10, repsSource: 'edited', rir: 2, discomfort: false,
          recordedAt: now - daysAgo * 86400000, timeSource: 'registration', custom: 'preserve' }, null] } } }
  });
  const original = make('old', 5, 200);
  const before = JSON.stringify(original);
  const corrected = correctSessionWeight(original, movement.id, 0, ' 20,5 ');
  assert(JSON.stringify(original) === before, 'Correction must not mutate the source');
  assert(corrected.entries.press[0] === '20.5', 'Decimal comma accepted');
  assert(setRecord(corrected, movement.id, 0).load === 20.5, 'Linked load updated');
  const expected = structuredClone(original);
  expected.entries.press[0] = '20.5';
  expected.entries._training.sets.press[0].load = 20.5;
  assert(JSON.stringify(corrected) === JSON.stringify(expected), 'Only weight and linked load may change');
  assert(correctSessionWeight(original, movement.id, 0, '0').entries.press[0] === '0', 'Zero supported');
  for (const value of ['', '-1', 'Infinity', 'NaN', '20kg', '1e3', '2.5.5', '2,5,5', null, true]) {
    rejects(() => correctSessionWeight(original, movement.id, 0, value), 'Invalid weight rejected');
  }
  for (const index of [-1, 1, 2, 0.5, NaN]) {
    rejects(() => correctSessionWeight(original, movement.id, index, '10'), 'Missing/unrecorded set rejected');
  }
  for (const change of [
    session => { session.deletedAt = now; }, session => { session.finishedAt = null; },
    session => { session.entries.press[0] = true; },
    session => { session.routineSnapshot.blocks[0].movements[0].kind = 'check'; }
  ]) {
    const invalid = structuredClone(original); change(invalid);
    rejects(() => correctSessionWeight(invalid, movement.id, 0, '10'), 'Non-weight or inactive record rejected');
  }
  const legacy = structuredClone(original);
  delete legacy.routineSnapshot;
  delete legacy.entries._training;
  const legacyFixed = correctSessionWeight(legacy, movement.id, 0, '10');
  assert(!legacyFixed.entries._training && !legacyFixed.routineSnapshot, 'No invented legacy metadata');
  const restored = prepareBackup(JSON.parse(JSON.stringify({ app: 'gymtrack', version: 4, sessions: [corrected, { ...legacyFixed, id: 'legacy' }] })));
  assert(JSON.stringify(restored.sessions) === JSON.stringify([corrected, { ...legacyFixed, id: 'legacy' }]), 'Backup round trip preserves corrected modern and legacy records');
  const partial = structuredClone(legacy);
  partial.entries._training = { version: 1, choices: { press: choice } };
  assert(!correctSessionWeight(partial, movement.id, 0, '10').entries._training.sets, 'Partial metadata preserved');
  const history = [make('a', 20, 20), make('b', 10, 22), make('c', 2, 24)];
  const historyBefore = JSON.stringify(history);
  let groups = movementLoadHistory(movement, history, now);
  assert(groups.length === 1 && groups[0].points.length === 3, 'Comparable scale history without known kg/lb');
  assert(groups[0].points.map(point => point.load).join() === '20,22,24', 'Chronological points');
  assert(JSON.stringify(history) === historyBefore, 'Read-only calculation');
  const noted = structuredClone(history[0]);
  noted.routineSnapshot.blocks[0].movements[0].note = 'Agarre estrecho';
  assert(movementLoadHistory(movement, [noted], now)[0].note === 'Agarre estrecho', 'Comparison context remains visible');
  const multiple = structuredClone(history);
  multiple[2].entries.press[1] = '26';
  multiple[2].entries._training.sets.press[1] = { ...choice, load: 26, reps: 10 };
  groups = movementLoadHistory(movement, multiple, now);
  assert(groups[0].points.length === 3 && groups[0].points[2].load === 26, 'One maximum per session and context');
  for (const change of [
    session => { session.entries._training.sets.press[0].unit = 'kg'; },
    session => { session.entries._training.sets.press[0].unit = 'lb'; },
    session => { session.entries._training.sets.press[0].label = 'Otra máquina'; },
    session => { session.entries._training.sets.press[0].variant = 'alternative'; },
    session => { session.entries._training.sets.press[0].reps = 8; },
    session => { session.routineSnapshot.blocks[0].movements[0].reps = '8-10'; },
    session => { session.routineSnapshot.blocks[0].movements[0].note = 'Otro agarre'; }
  ]) {
    const changed = structuredClone(history); change(changed[2]);
    assert(movementLoadHistory(movement, changed, now).length === 2, 'Different contexts cannot share a curve');
  }
  for (const change of [
    session => { session.deletedAt = now; }, session => { session.finishedAt = null; },
    session => { session.startedAt = now + 86400000; }, session => { delete session.routineSnapshot; },
    session => { session.entries.press[0] = '999'; }, session => { delete session.entries._training; },
    session => { session.entries._training.sets.press[0].unit = 'unknown'; },
    session => { session.routineSnapshot.blocks[0].movements[0].reps = 'Al fallo'; },
    session => { session.routineSnapshot.blocks[0].movements[0].name = 'Otro ejercicio'; }
  ]) {
    const changed = structuredClone(history); change(changed[2]);
    assert(movementLoadHistory(movement, changed, now)[0].points.length === 2, 'Unknown, stale or non-comparable data excluded');
  }
  assert(movementLoadHistory({ ...movement, name: 'Dominada asistida' }, history, now).length === 0, 'No assistance strength curve');
  assert(movementLoadHistory({ ...movement, kind: 'check' }, history, now).length === 0, 'No check strength curve');
  assert(movementLoadHistory(movement, [legacy], now).length === 0, 'Legacy values are not inferred');
  const active = make('active', 0, 25); active.finishedAt = null;
  assert(personalBestForSet(active, movement, 0, [original], session => session.routineSnapshot) === 200, 'Original PR evidence');
  assert(personalBestForSet(active, movement, 0, [corrected], session => session.routineSnapshot) === 20.5, 'Corrected PR evidence');
  assert(nextSetAdvice(active, movement, 0, [corrected], session => session.routineSnapshot).direction === 'maintain', 'Advice reads corrected metadata');
  assert(movementLoadHistory(movement, [corrected], now)[0].points[0].load === 20.5, 'Curve reads correction');
  return { checks, result: 'PASS' };
}
