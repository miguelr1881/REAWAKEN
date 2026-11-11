import { autoFinishSession, bodyWeightReference, convertSessionLoadsToKg, reviewSessionLoadUnits, correctSessionDetails, correctSessionWeight, movementLoadHistory, movementHistoryRows } from '../js/session-history.js';
import { nextSetAdvice, personalBestForSet, setRecord, trainingCoverage } from '../js/intelligence.js';
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
  const bodyMeasures = [{ id: 'body-older', at: now - 7 * 86400000, values: { weight: 80 } },
    { id: 'body-latest', at: now - 86400000, values: { weight: 75 } },
    { id: 'body-future', at: now + 86400000, values: { weight: 70 } }];
  const bodyBefore = JSON.stringify(bodyMeasures);
  const bodyReference = bodyWeightReference({ load: 30, unit: 'kg' }, now, bodyMeasures);
  assert(bodyReference.percent === 40 && bodyReference.weight === 75 && bodyReference.ageDays === 1, 'Body comparison uses a real prior measurement with whole percentages');
  assert(bodyWeightReference({ load: 40, unit: 'kg' }, now - 2 * 86400000, bodyMeasures).weight === 80, 'Historical loads cannot use a later body measurement');
  assert(bodyWeightReference({ load: 90, unit: 'kg' }, now, bodyMeasures).percent === 120, 'Ratios above body weight are not capped or turned into a strength score');
  assert(bodyWeightReference({ load: 0, unit: 'kg' }, now, bodyMeasures).percent === 0, 'Zero load remains zero');
  const poundsRecord = { load: 25, unit: 'lb' };
  const poundsReference = bodyWeightReference(poundsRecord, now, bodyMeasures);
  assert(poundsReference.percent === 15 && Math.abs(poundsReference.loadKg - 11.33980925) < 0.00000001, 'Body reference converts pounds only for the ratio');
  assert(poundsRecord.load === 25 && poundsRecord.unit === 'lb', 'Body comparison preserves the native stored load and unit');
  assert(bodyWeightReference({ load: 66, unit: 'lb' }, now, bodyMeasures).percent === bodyReference.percent, 'Equivalent loads give the same rounded body reference');
  for (const unit of ['escala', undefined]) assert(bodyWeightReference({ load: 30, unit }, now, bodyMeasures) === null, 'Unknown units have no body-weight comparison');
  assert(bodyWeightReference({ load: 30, unit: 'kg' }, now, []) === null, 'No invented body weight without measurements');
  assert(bodyWeightReference({ load: 30, unit: 'kg' }, now, [{ at: now - 1, values: { weight: 0 } }, { ...bodyMeasures[1], deletedAt: now }]) === null, 'Invalid and deleted body measurements are excluded');
  assert(JSON.stringify(bodyMeasures) === bodyBefore, 'Body comparison does not mutate measurements');
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
  const incomplete = make('incomplete', 2, 20);
  incomplete.routineSnapshot.blocks[0].movements.push({ id: 'check', name: 'Movilidad', kind: 'check', reps: '30s', timer: 30 });
  incomplete.entries.check = [false, true];
  incomplete.entries._training.choices.press.unit = 'lb';
  const incompleteBefore = JSON.stringify(incomplete);
  const completed = correctSessionDetails(incomplete, { sets: [
    { movementId: 'press', index: 1, value: '25,5', reps: '12' },
    { movementId: 'check', index: 0, value: true },
    { movementId: 'check', index: 1, value: false }
  ], notes: ' Nota corregida ', durationMinutes: 75 }, now);
  assert(completed.entries.press[1] === '25.5' && completed.entries.check.join() === 'true,false', 'Full correction fills missing weights and toggles completed checks');
  assert(setRecord(completed, 'press', 1).unit === 'lb' && setRecord(completed, 'press', 1).reps === 12, 'Missing set uses only its own session choice and explicit reps');
  assert(setRecord(completed, 'press', 1).timeSource === 'correction' && setRecord(completed, 'press', 1).recordedAt === now, 'Retrospective entry does not fabricate an original set timestamp');
  assert(completed.notes === 'Nota corregida' && completed.entries._durationMinutes === 75, 'Full correction supports notes and total duration');
  assert(completed.startedAt === incomplete.startedAt && completed.finishedAt === incomplete.finishedAt && JSON.stringify(completed.routineSnapshot) === JSON.stringify(incomplete.routineSnapshot), 'Full correction preserves dates and original plan');
  assert(JSON.stringify(incomplete) === incompleteBefore && JSON.stringify(completed.entries.another) === JSON.stringify(incomplete.entries.another), 'Full correction leaves source and unrelated entries untouched');
  const cleared = correctSessionDetails(completed, { sets: [{ movementId: 'press', index: 1, value: '' }] }, now);
  assert(cleared.entries.press[1] === '' && cleared.entries._training.sets.press[1] === null, 'Clearing a weight removes linked metadata as well');
  const repsOnly = correctSessionDetails(original, { sets: [{ movementId: 'press', index: 0, value: '200', reps: 8 }] }, now);
  assert(setRecord(repsOnly, 'press', 0).reps === 8 && setRecord(repsOnly, 'press', 0).custom === 'preserve' && setRecord(repsOnly, 'press', 0).rir === 2, 'Rep correction preserves unrelated set metadata');
  const emptySession = { ...structuredClone(incomplete), entries: {} };
  const filled = correctSessionDetails(emptySession, { sets: [{ movementId: 'press', index: 1, value: '0', reps: 10 }] }, now);
  assert(filled.entries.press.join(',') === ',0' && setRecord(filled, 'press', 1).unit === 'escala', 'Entirely empty session can be filled from its own snapshot without invented units');
  for (const change of [
    { movementId: 'press', index: 2, value: '20' }, { movementId: 'unknown', index: 0, value: '20' },
    { movementId: '_cycle', index: 0, value: '20' }, { movementId: 'check', index: 0, value: '20' },
    { movementId: 'press', index: 0, value: '-1' }, { movementId: 'press', index: 0, value: '20', reps: 0 },
    { movementId: 'press', index: 0, value: '20', reps: 100 }, { movementId: 'press', index: 0, value: '20', reps: 2.5 }
  ]) rejects(() => correctSessionDetails(incomplete, { sets: [change] }, now), 'Invalid full-session correction is rejected');
  rejects(() => correctSessionDetails({ ...incomplete, finishedAt: null }, { sets: [] }), 'Full correction cannot edit a live workout');
  rejects(() => correctSessionDetails({ ...incomplete, deletedAt: now }, { sets: [] }), 'Full correction cannot resurrect a deleted workout');
  rejects(() => correctSessionDetails(incomplete, { durationMinutes: 0 }), 'Full correction validates duration');
  rejects(() => correctSessionDetails(incomplete, { sets: false }), 'Full correction rejects malformed changes');
  rejects(() => correctSessionDetails(incomplete, { sets: [{ movementId: 'press', index: 0, value: '20', reps: true }] }), 'Boolean reps are not silently converted to one');
  assert(JSON.stringify(prepareBackup(JSON.parse(JSON.stringify({ app: 'gymtrack', version: 5, sessions: [completed] }))).sessions[0]) === JSON.stringify(completed), 'Full correction and retrospective metadata survive backup round trip');
  const unfinished = { ...make('auto-close', 1, 25), startedAt: now - 120 * 60000, finishedAt: null };
  unfinished.entries._autoFinish = { version: 1, limitMinutes: 120 };
  const unfinishedBefore = JSON.stringify(unfinished);
  assert(autoFinishSession(unfinished, now - 1) === null, 'Automatic finish does not run before two hours');
  for (const minutes of [15, 60, 90, 150, 180, 195, 360]) {
    const custom = structuredClone(unfinished);
    custom.entries._autoFinish.limitMinutes = minutes;
    const deadline = custom.startedAt + minutes * 60000;
    assert(autoFinishSession(custom, deadline - 1) === null, 'Custom limit does not close early');
    assert(autoFinishSession(custom, deadline + 86400000).finishedAt === deadline, 'Custom limit controls the effective close time even after a later return');
  }
  for (const minutes of [0, 14, 361, 150.5, undefined]) {
    const invalid = structuredClone(unfinished);invalid.entries._autoFinish.limitMinutes = minutes;
    assert(autoFinishSession(invalid, now + 86400000) === null, 'Disabled or malformed policies never close a session');
  }
  const autoClosed = autoFinishSession(unfinished, now + 8 * 3600000);
  assert(autoClosed.finishedAt === now, 'Reopening much later closes at the two-hour deadline, not at reopening time');
  assert(autoClosed.entries.press[1] === '' && autoClosed.entries._autoFinish.reviewedAt === null, 'Unrecorded sets stay empty and review remains pending');
  assert(autoClosed.entries._autoFinish.closedAt === now + 8 * 3600000, 'Audit distinguishes processing time from the effective finish');
  assert(JSON.stringify(unfinished) === unfinishedBefore, 'Auto-finish never mutates its input before persistence');
  assert(autoFinishSession(autoClosed, now + 9 * 3600000) === null, 'Finished sessions cannot be closed again');
  assert(autoFinishSession({ ...unfinished, deletedAt: now }, now) === null, 'Deleted sessions are not resurrected');
  const unconfigured = structuredClone(unfinished); delete unconfigured.entries._autoFinish;
  assert(autoFinishSession(unconfigured, now) === null, 'Existing sessions without explicit policy are not retroactively closed');
  assert(autoFinishSession(unfinished, NaN) === null, 'Invalid clock cannot close a session');
  assert(prepareBackup({ app: 'gymtrack', version: 5, sessions: [autoClosed] }).sessions[0].entries._autoFinish.reviewedAt === null, 'Backup preserves the pending auto-close review');
  const coverageSessions = [original, { ...make('pending', 1, 25), finishedAt: null },
    { ...make('deleted', 2, 25), deletedAt: now }, make('too-old', 35, 25), make('future', -2, 25)];
  const coverageBefore = JSON.stringify({ day, coverageSessions });
  const coverage = trainingCoverage([day], coverageSessions, now);
  const chestCoverage = coverage.groups.find(item => item.group === 'chest');
  assert(chestCoverage.plannedDirect === 2 && chestCoverage.recordedDirect === 1, 'Full-plan coverage and 28-day recorded work stay separate');
  assert(coverage.groups.find(item => item.group === 'triceps').recordedSecondary === 1, 'Secondary work is shown separately instead of implying a missing muscle');
  assert(coverage.openSessions === 1, 'An unfinished session is flagged but not counted as completed work');
  const missingSnapshot = { ...original, id: 'without-snapshot', routineSnapshot: undefined };
  assert(trainingCoverage([day], [missingSnapshot], now).missingSnapshots === 1, 'Missing snapshots are explicit instead of mapped to the current plan');
  assert(trainingCoverage([], [], now).groups.length === 0, 'Empty data does not invent muscle deficits');
  assert(JSON.stringify({ day, coverageSessions }) === coverageBefore, 'Coverage does not mutate plan or history');
  const before = JSON.stringify(original);
  const pounds = make('pounds', 4, 66);
  pounds.entries._training.choices.press.step = 11;
  pounds.entries._training.sets.press[0].step = 11;
  const poundsBefore = JSON.stringify(pounds);
  const nativePounds = reviewSessionLoadUnits(pounds, { press: 'lb' }, { press: 'lb' }, now);
  assert(nativePounds.entries.press[0] === '66' && setRecord(nativePounds, 'press', 0).load === 66 && setRecord(nativePounds, 'press', 0).unit === 'lb', 'Native-pound review preserves original numbers and units');
  assert(nativePounds.entries._training.choices.press.step === 11 && setRecord(nativePounds, 'press', 0).step === 11, 'Native-pound equipment increments are not converted');
  assert(nativePounds.entries._unitConversion.target === 'lb' && !nativePounds.entries._unitConversion.movements.press.rounding, 'Native review records that no numeric conversion occurred');
  assert(JSON.stringify(reviewSessionLoadUnits(nativePounds, { press: 'lb' }, { press: 'lb' }, now + 1)) === JSON.stringify(nativePounds), 'Native-unit review is idempotent');
  rejects(() => convertSessionLoadsToKg(nativePounds, { press: 'lb' }, now), 'Changing an audited unit requires the original source');
  rejects(() => reviewSessionLoadUnits(pounds, { press: 'lb' }, { unknown: 'lb' }, now), 'Target units cannot apply to an unreviewed exercise');
  const nativeLegacy = structuredClone(pounds); delete nativeLegacy.entries._training;
  const legacyPounds = reviewSessionLoadUnits(nativeLegacy, { press: 'lb' }, { press: 'lb' }, now);
  assert(legacyPounds.entries.press[0] === '66' && !legacyPounds.entries._training, 'Native-unit review does not fabricate legacy metadata');
  const mixedSource = structuredClone(pounds);
  mixedSource.routineSnapshot.blocks[0].movements.push({ ...movement, id: 'machine', name: 'Remo en polea' });
  mixedSource.entries.machine = ['66'];
  mixedSource.entries._training.choices.machine = { ...mixedSource.entries._training.choices.press };
  mixedSource.entries._training.sets.machine = [{ ...mixedSource.entries._training.sets.press[0] }];
  const mixedBefore = JSON.stringify(mixedSource);
  const mixedReview = reviewSessionLoadUnits(mixedSource, { press: 'lb', machine: 'lb' }, { press: 'lb', machine: 'kg' }, now);
  assert(mixedReview.entries.press[0] === '66' && mixedReview.entries.machine[0] === '30', 'Each exercise independently keeps pounds or converts to kg');
  assert(mixedReview.entries._unitConversion.target === 'mixed' && setRecord(mixedReview, 'press', 0).unit === 'lb' && setRecord(mixedReview, 'machine', 0).unit === 'kg', 'Mixed-unit audit and records retain explicit target units');
  assert(JSON.stringify(mixedSource) === mixedBefore && prepareBackup({ app: 'gymtrack', version: 5, sessions: [mixedReview] }).sessions[0].entries._unitConversion.target === 'mixed', 'Mixed review preserves its source and backup audit');
  const kilograms = convertSessionLoadsToKg(pounds, { press: 'lb' }, now);
  rejects(() => reviewSessionLoadUnits(kilograms, { press: 'lb' }, { press: 'lb' }, now), 'Rounded kilograms cannot be used to recreate the original pounds');
  assert(kilograms.entries.press[0] === '30', 'Converted loads use whole kilograms matching the plate labels');
  assert(setRecord(kilograms, 'press', 0).load === 30 && setRecord(kilograms, 'press', 0).unit === 'kg', 'Raw and linked load stay consistent in whole kg');
  assert(kilograms.entries._training.choices.press.step === 5 && setRecord(kilograms, 'press', 0).step === 5, 'Plate increments use the same whole-kg rule');
  assert(kilograms.entries._unitConversion.movements.press.rounding === 'nearest-kg', 'Audit records the rounding rule');
  assert(kilograms.entries._unitConversion.movements.press.choice.step === 11 && kilograms.entries._unitConversion.movements.press.records[0].step === 11, 'Original plate increments remain available for reversal');
  for (const [poundLoad, kilogramLoad] of [[11, 5], [22, 10], [33, 15], [44, 20], [66, 30], [77, 35], [132, 60], [143, 65]]) {
    const convertedPlate = convertSessionLoadsToKg(make(`plate-${poundLoad}`, 4, poundLoad), { press: 'lb' }, now);
    assert(convertedPlate.entries.press[0] === String(kilogramLoad) && setRecord(convertedPlate, 'press', 0).load === kilogramLoad, 'Plate loads and linked records contain no conversion decimals');
    assert(movementLoadHistory(movement, [convertedPlate], now)[0].points[0].load === kilogramLoad, 'Strength curve uses the same whole-kg plate value');
  }
  assert(kilograms.entries._training.choices.press.unit === 'kg', 'Equipment reference follows the converted sets');
  assert(JSON.stringify(pounds) === poundsBefore, 'Conversion never mutates its source');
  assert(JSON.stringify(kilograms.routineSnapshot) === JSON.stringify(pounds.routineSnapshot) && kilograms.notes === pounds.notes && kilograms.finishedAt === pounds.finishedAt, 'Plan, notes and session dates are preserved');
  assert(kilograms.entries._unitConversion.movements.press.values[0] === '66' && kilograms.entries._unitConversion.movements.press.records[0].unit === 'escala', 'Original values and metadata remain available for reversal');
  assert(JSON.stringify(convertSessionLoadsToKg(kilograms, { press: 'lb' }, now + 1)) === JSON.stringify(kilograms), 'Conversion cannot run twice on the same exercise');
  assert(convertSessionLoadsToKg(pounds, { press: 'kg' }, now).entries.press[0] === '66', 'Confirmed kilograms are relabeled without changing their number');
  assert(JSON.stringify(convertSessionLoadsToKg(pounds, {}, now)) === poundsBefore, 'Unreviewed exercises remain untouched');
  rejects(() => convertSessionLoadsToKg(pounds, { press: 'unknown' }, now), 'Unknown units are not guessed');
  rejects(() => convertSessionLoadsToKg(pounds, { missing: 'lb' }, now), 'Unidentified exercise rejected');
  rejects(() => convertSessionLoadsToKg({ ...pounds, finishedAt: null }, { press: 'lb' }, now), 'Active sessions cannot be converted');
  const unitConflict = structuredClone(pounds);
  unitConflict.entries._training.sets.press[0].unit = 'kg';
  rejects(() => convertSessionLoadsToKg(unitConflict, { press: 'lb' }, now), 'Conflicting explicit unit rejected');
  const staleLoad = structuredClone(pounds);
  staleLoad.entries._training.sets.press[0].load = 77;
  rejects(() => convertSessionLoadsToKg(staleLoad, { press: 'lb' }, now), 'Stale linked load rejected before any write');
  const unitLegacy = structuredClone(pounds);
  delete unitLegacy.entries._training;
  const legacyKg = convertSessionLoadsToKg(unitLegacy, { press: 'lb' }, now);
  assert(legacyKg.entries.press[0] === '30' && !legacyKg.entries._training, 'Legacy conversion uses whole kg without inventing comparison metadata');
  assert(prepareBackup({ app: 'gymtrack', version: 5, sessions: [kilograms] }).sessions[0].entries._unitConversion.movements.press.values[0] === '66', 'Backup preserves the original conversion values');
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
  const reimportedMovement = { ...movement, id: 'press-reimported' };
  assert(movementLoadHistory(reimportedMovement, history, now)[0].points.length === 3, 'Unique matching exercise retains its curve after an ID change');
  assert(movementHistoryRows(reimportedMovement, history, now).length === 3, 'History rows and curve share the reimported identity');
  const ambiguous = structuredClone(history[0]);
  ambiguous.routineSnapshot.blocks[0].movements.push({ ...movement, id: 'another-press' });
  ambiguous.entries['another-press'] = ['100'];
  assert(movementHistoryRows(reimportedMovement, [ambiguous], now).length === 0, 'Ambiguous duplicate names are not matched by guesswork');
  assert(movementHistoryRows(movement, [ambiguous], now)[0].sets[0].value === '20', 'An exact ID keeps its own history without mixing duplicate names');
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
  const legacyRows = movementHistoryRows(movement, [legacy], now, () => day);
  assert(legacyRows.length === 1 && legacyRows[0].sets[0].record === null, 'Explicit legacy display retains raw values without inventing comparison metadata');
  assert(movementLoadHistory(movement, [legacy], now).length === 0, 'Legacy display does not enable a strength curve');
  const active = make('active', 0, 25); active.finishedAt = null;
  assert(personalBestForSet(active, movement, 0, [original], session => session.routineSnapshot) === 200, 'Original PR evidence');
  assert(personalBestForSet(active, movement, 0, [corrected], session => session.routineSnapshot) === 20.5, 'Corrected PR evidence');
  assert(nextSetAdvice(active, movement, 0, [corrected], session => session.routineSnapshot).direction === 'maintain', 'Advice reads corrected metadata');
  assert(movementLoadHistory(movement, [corrected], now)[0].points[0].load === 20.5, 'Curve reads correction');
  return { checks, result: 'PASS' };
}
