import { DEFAULT_TRAINING_PREFERENCES, trainingPreferences } from '../js/training-preferences.js';
import { sessionPersonalRecords } from '../js/personal-records.js';
import { generateRoutine } from '../js/routine-generator.js';
import { backupActiveRoutines, prepareBackup } from '../js/backup.js';
import { EXERCISE_CATALOG } from '../js/exercise-catalog.js';
import { MUSCLE_GROUPS } from '../js/exercise-info.js';

export function runPersonalToolsTests() {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const rejects = (action, message) => {
    let failed = false;
    try { action(); } catch { failed = true; }
    assert(failed, message);
  };
  assert(trainingPreferences().restSeconds === 45 && !trainingPreferences().keepScreenAwake, 'Conservative defaults');
  for (const seconds of [1, 30, 45, 60, 75, 3600]) assert(trainingPreferences({ restSeconds: seconds }).restSeconds === seconds, 'Rest preference accepted');
  for (const value of [0, -1, 1.5, 3601, Infinity, '45', NaN]) rejects(() => trainingPreferences({ restSeconds: value }), 'Invalid rest rejected');
  rejects(() => trainingPreferences({ keepScreenAwake: 'true' }), 'Invalid wake preference rejected');
  rejects(() => trainingPreferences({ token: 'not-a-preference' }), 'Backup cannot inject account settings');
  assert(prepareBackup({ app: 'gymtrack', sessions: [], preferences: { restSeconds: 75 } }).preferences.restSeconds === 75, 'Preferences-only backup supported');
  rejects(() => prepareBackup({ app: 'gymtrack', sessions: [], preferences: { restSeconds: 0 } }), 'Invalid preference rejects backup');
  assert(Object.isFrozen(DEFAULT_TRAINING_PREFERENCES), 'Defaults cannot be mutated');
  const personalProfile = { name: 'Perfil de prueba', daysPerWeek: 4, sport: '', coach: '', routineChangeDate: '' };
  assert(prepareBackup({ app: 'gymtrack', sessions: [], personalProfile }).personalProfile.name === personalProfile.name, 'Profile-only backup supported without inventing a plan');
  rejects(() => prepareBackup({ app: 'gymtrack', sessions: [], personalProfile: { ...personalProfile, routineChangeDate: 0 } }), 'Invalid profile date rejected without coercion');
  assert(prepareBackup({ app: 'gymtrack', sessions: [], routines: [{ id: 'legacy-profile', days: [], active: true, profile: personalProfile }] }).routines[0].days.length === 0, 'Old profile-only routine preserved without inventing days');
  const existing = [{ id: 'one', active: true }, { id: 'two', active: false }];
  assert(backupActiveRoutines(existing, [{ id: 'two', active: true }]).length === 2, 'Merged active conflict detected');
  assert(backupActiveRoutines(existing, [{ id: 'one', active: false }]).length === 0, 'Incoming state replaces same id');
  assert(existing[0].active && !existing[1].active, 'Active preview is read-only');

  const now = Date.now();
  const movement = { id: 'press', name: 'Press de pecho', kind: 'weight', reps: '10' };
  const day = { id: 'day', blocks: [{ id: 'block', sets: 3, movements: [movement] }] };
  const make = (id, age, loads) => ({
    id, dayId: 'day', startedAt: now - age * 86400000, finishedAt: now - age * 86400000 + 1000,
    routineSnapshot: structuredClone(day), entries: { press: loads.map(String), _training: { version: 1, sets: {
      press: loads.map(load => ({ load, reps: 10, label: 'Habitual', variant: 'original', unit: 'escala' }))
    } } }
  });
  const previous = make('previous', 10, [20, 20, 20]);
  const current = make('current', 1, [22, 25, 24]);
  const summary = sessionPersonalRecords(current, [previous, current]);
  assert(summary.length === 1 && summary[0].load === 25 && summary[0].previous === 20 && summary[0].index === 1, 'One highest PR per context with traceable set');
  assert(sessionPersonalRecords(previous, [previous]).length === 0, 'First record is not a PR');
  assert(sessionPersonalRecords(make('equal', 1, [20]), [previous]).length === 0, 'Tie not a PR');
  assert(sessionPersonalRecords({ ...current, finishedAt: null }, [previous]).length === 0, 'Open session not a completed PR');
  assert(sessionPersonalRecords({ ...current, deletedAt: now }, [previous]).length === 0, 'Deleted session not a PR');
  assert(sessionPersonalRecords(current, [{ ...previous, deletedAt: now }]).length === 0, 'Deleted evidence ignored');
  assert(sessionPersonalRecords({ ...current, routineSnapshot: null }, [previous]).length === 0, 'No inferred snapshot');
  for (const change of [
    record => { record.unit = 'lb'; }, record => { record.reps = 8; },
    record => { record.label = 'Otra máquina'; }, record => { record.variant = 'alternative'; }
  ]) {
    const changed = structuredClone(current);
    changed.entries._training.sets.press.forEach(change);
    assert(sessionPersonalRecords(changed, [previous]).length === 0, 'PR contexts remain separated');
  }
  const corrected = make('current', 1, [18, 19, 20]);
  assert(sessionPersonalRecords(corrected, [previous]).length === 0, 'Corrected loads remove false PRs');
  for (const [value, load] of [[true, 1], ['0x20', 32], ['1e2', 100]]) {
    const invalid = make('invalid-value', 1, [load]);
    invalid.entries.press[0] = value;
    assert(sessionPersonalRecords(invalid, [make('zero-reference', 10, [0])]).length === 0, 'Boolean and non-decimal values are not load records');
  }
  assert(JSON.stringify(sessionPersonalRecords(current, [previous])) === JSON.stringify(summary), 'Reopening derives the same records without flags');

  assert(EXERCISE_CATALOG.length === new Set(EXERCISE_CATALOG.map(item => item.id)).size, 'Catalog IDs unique');
  assert(EXERCISE_CATALOG.every(item => Object.hasOwn(MUSCLE_GROUPS, item.muscleGroup) && ['weight', 'check'].includes(item.kind)), 'Catalog groups and registration kinds valid');
  assert(EXERCISE_CATALOG.find(item => item.id === 'catalog-hamstrings-hip-hinge').kind === 'check', 'Unloaded hip hinge does not require weight');
  const tibialis = EXERCISE_CATALOG.find(item => item.id === 'catalog-calves-tibialis');
  assert(tibialis.kind === 'check' && tibialis.muscleGroup !== 'calves', 'Bodyweight tibialis is not counted as calf loading');
  const options = { source: 'catalog', days: 3, minutes: 45, goal: 'consistency', focus: 'full',
    experience: 'returning', restSeconds: 45, equipment: '', idPrefix: 'proposal' };
  const source = { catalog: EXERCISE_CATALOG, routines: [], exercises: [] };
  const before = JSON.stringify(source);
  for (const focus of ['full', 'upper', 'lower']) {
    const proposal = generateRoutine({ ...options, focus }, source);
    assert(proposal.days.length === 3 && proposal.days.every(item => item.estimatedMinutes <= 45), 'Days and time budget respected');
    const ids = proposal.days.flatMap(item => [item.id, ...item.blocks.flatMap(block => [block.id, ...block.movements.map(mv => mv.id)])]);
    assert(new Set(ids).size === ids.length, 'Generated IDs unique');
    assert(proposal.provenance.sources.every(item => item.source === 'catalog'), 'Catalog source isolated');
    assert(proposal.days.every(item => item.blocks.every(block => block.rest === 45)), 'Preference used for new blocks');
  }
  const first = generateRoutine(options, source);
  assert(JSON.stringify(first) === JSON.stringify(generateRoutine(options, source)), 'Generation deterministic');
  assert(JSON.stringify(source) === before, 'Catalog not mutated');
  assert(first.days.every(item => item.blocks.every(block => block.movements.every(mv => !Object.hasOwn(mv, 'load')))), 'No prescribed loads');
  for (const changed of [{ source: '' }, { days: 0 }, { minutes: 14 }, { focus: 'unknown' }, { goal: 'medical' }, { restSeconds: 0 }]) {
    rejects(() => generateRoutine({ ...options, ...changed }, source), 'Invalid questionnaire rejected');
  }
  rejects(() => generateRoutine({ ...options, source: 'personal' }, source), 'Missing personal source never falls back to catalog');
  rejects(() => generateRoutine({ ...options, equipment: 'Equipo no disponible' }, source), 'Equipment filter not silently ignored');
  const owned = { id: 'owned', days: [{ id: 'owned-day', blocks: [{ id: 'owned-block', sets: 2, rest: 30, note: 'Alternar ejercicios del bloque',
    movements: [
      { id: 'owned-press', name: 'Press personal', kind: 'weight', muscleGroup: 'chest', reps: '8-10' },
      { id: 'owned-row', name: 'Remo personal', kind: 'weight', muscleGroup: 'back', reps: '12' },
      { id: 'owned-squat', name: 'Sentadilla personal', kind: 'weight', muscleGroup: 'quads', reps: '10' }
    ] }] }] };
  const ownedBefore = JSON.stringify(owned);
  const personal = generateRoutine({ ...options, source: 'personal', restSeconds: 60 }, { ...source, routines: [owned] });
  assert(personal.provenance.sources.every(item => item.source === 'personal' && item.id === 'owned'), 'Personal origin traceable');
  assert(personal.days.every(item => item.blocks.every(block => block.sets === 2 && block.rest === 30)), 'Coach sets and rests preserved');
  assert(personal.days[0].blocks.some(block => block.movements[0].reps === '8-10'), 'Coach reps preserved');
  assert(JSON.stringify(owned) === ownedBefore, 'Personal routine source unchanged');
  assert(!JSON.stringify(personal.days).includes('catalog-'), 'No catalog leak into personal proposal');
  assert(personal.days[0].blocks.every(block => block.movements[0].note.includes('Alternar ejercicios del bloque')) &&
    personal.warnings.some(warning => warning.includes('bloques combinados')), 'Combined-block context preserved and regrouping explained');
  assert(personal.provenance.sources.every(item => item.movementId && item.dayId === 'owned-day' && item.blockId === 'owned-block'), 'Origin traceable to the original movement and block');
  const fromRoutines = generateRoutine({ ...options, source: 'routines' }, { ...source, routines: [owned], exercises: [{ id: 'unused', name: 'Ejercicio nunca usado', kind: 'weight', muscleGroup: 'shoulders' }] });
  assert(fromRoutines.provenance.source === 'routines' && fromRoutines.provenance.sources.every(item => item.id === 'owned'), 'Routine mode uses saved plans only');
  assert(!JSON.stringify(fromRoutines.days).includes('Ejercicio nunca usado'), 'Unused personal cards do not leak into routine mode');
  rejects(() => generateRoutine({ ...options, source: 'routines' }, source), 'Routine mode needs a saved plan even when catalog is available');
  let emptyMessage = '';
  try { generateRoutine({ ...options, source: 'routines' }, source); } catch (error) { emptyMessage = error.message; }
  assert(emptyMessage.includes('Importa y guarda una rutina del gym primero'), 'Empty library explains the import-first workflow');
  rejects(() => generateRoutine({ ...options, source: 'routines' }, { ...source, routines: [{ ...owned, deletedAt: 100 }] }), 'Deleted routines cannot supply a proposal');
  const archived = generateRoutine({ ...options, source: 'routines' }, { ...source, routines: [{ ...owned, archived: true, active: false }] });
  assert(archived.provenance.sources.every(item => item.id === owned.id), 'Previous archived plans remain reusable without activation');
  const incompletePlan = structuredClone(owned);
  incompletePlan.days[0].blocks[0].movements = incompletePlan.days[0].blocks[0].movements.slice(0, 1);
  rejects(() => generateRoutine({ ...options, source: 'routines' }, { ...source, routines: [incompletePlan], exercises: owned.days[0].blocks[0].movements }), 'Routine mode never fills missing muscles from unused cards or catalog');
  return { checks, result: 'PASS' };
}
