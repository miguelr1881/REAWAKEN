import { DEFAULT_TRAINING_PREFERENCES, trainingPreferences } from '../js/training-preferences.js';
import { sessionPersonalRecords } from '../js/personal-records.js';
import { generateRoutine, estimateRoutineTime, conditioningChoices } from '../js/routine-generator.js';
import { backupActiveRoutines, prepareBackup } from '../js/backup.js';
import { EXERCISE_CATALOG } from '../js/exercise-catalog.js';
import { MUSCLE_GROUPS } from '../js/exercise-info.js';
import { exerciseRatingKey, exerciseRating, validateExerciseRatings } from '../js/exercise-ratings.js';
import { sanitizeRoutine } from '../js/routine-parser.js';

export function runPersonalToolsTests() {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const rejects = (action, message) => {
    let failed = false;
    try { action(); } catch { failed = true; }
    assert(failed, message);
  };
  assert(trainingPreferences().restSeconds === 45 && !trainingPreferences().keepScreenAwake, 'Conservative defaults');
  assert(trainingPreferences().autoFinishMinutes === 120, 'Auto-finish defaults to two hours for new sessions');
  for (const minutes of [0, 15, 60, 90, 120, 150, 180, 195, 360]) assert(trainingPreferences({ autoFinishMinutes: minutes }).autoFinishMinutes === minutes, 'Disabled, preset and custom finish limits are preserved');
  for (const minutes of [-1, 1, 14, 150.5, 361, '150', NaN]) rejects(() => trainingPreferences({ autoFinishMinutes: minutes }), 'Invalid finish limits are rejected');
  assert(prepareBackup({ app: 'gymtrack', sessions: [], preferences: { autoFinishMinutes: 150 } }).preferences.autoFinishMinutes === 150, 'Backup preserves the custom close limit');
  assert(trainingPreferences().muscleSuggestions === false, 'Muscle suggestions are disabled by default, including old preferences');
  assert(trainingPreferences({ muscleSuggestions: true }).muscleSuggestions === true, 'Suggestions require explicit opt-in');
  rejects(() => trainingPreferences({ muscleSuggestions: 'true' }), 'Suggestion preference must be a boolean');
  assert(prepareBackup({ app: 'gymtrack', sessions: [], preferences: { muscleSuggestions: true } }).preferences.muscleSuggestions === true, 'Backup preserves the optional suggestion setting');
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
  for (const focus of ['full', 'upper', 'lower', 'arms']) {
    const proposal = generateRoutine({ ...options, focus }, source);
    assert(proposal.days.length === 3 && proposal.days.every(item => item.estimatedMinutes <= 45), 'Days and time budget respected');
    const ids = proposal.days.flatMap(item => [item.id, ...item.blocks.flatMap(block => [block.id, ...block.movements.map(mv => mv.id)])]);
    assert(new Set(ids).size === ids.length, 'Generated IDs unique');
    assert(proposal.provenance.sources.every(item => item.source === 'catalog'), 'Catalog source isolated');
    assert(proposal.days.every(item => item.blocks.every(block => block.rest === 45)), 'Preference used for new blocks');
  }
  const first = generateRoutine(options, source);
  const counted = generateRoutine({ ...options, mode: 'count', exerciseCount: 6, minutes: 15 }, source);
  assert(counted.days.every(planDay => planDay.blocks.length === 6), 'Count mode keeps exactly six working exercises without trimming for time');
  assert(counted.days.every(planDay => planDay.estimatedMinutes > 15), 'Estimated minutes do not constrain count mode');
  assert(counted.provenance.mode === 'count' && counted.provenance.exerciseCount === 6 && !Object.hasOwn(counted.provenance, 'minutes'), 'Count provenance does not imply a time budget');
  for (const cardioCount of [0, 1, 2]) {
    const withCardio = generateRoutine({ ...options, mode: 'count', exerciseCount: 6, cardioCount,
      warmupMinutes: cardioCount === 2 ? 5 : 0, cardioMinutes: cardioCount ? 15 : 0,
      conditioningExerciseId: 'catalog-cardio-caminadora' }, source);
    assert(withCardio.days.every(planDay => planDay.blocks.filter(block => block.movements[0].muscleGroup !== 'cardio').length === 6), 'Cardio never occupies one of the six working slots');
    assert(withCardio.days.every(planDay => planDay.blocks.filter(block => block.movements[0].muscleGroup === 'cardio').length === cardioCount), 'Requested cardio block count is exact');
    assert(withCardio.days.every(planDay => new Set(planDay.blocks.map(block => block.id)).size === planDay.blocks.length), 'Cardio phases have distinct IDs');
  }
  rejects(() => generateRoutine({ ...options, mode: 'count', exerciseCount: 2 }, source), 'Too few exercises for full-body coverage are rejected');
  rejects(() => generateRoutine({ ...options, mode: 'count', exerciseCount: 6, minRating: 4 }, source), 'Exact count cannot bypass ratings');
  rejects(() => generateRoutine({ ...options, mode: 'count', exerciseCount: 6, cardioMode: 'remaining' }, source), 'Count mode cannot add cardio to fill an arbitrary time');
  rejects(() => generateRoutine({ ...options, mode: 'count', exerciseCount: 6, cardioCount: 2, cardioMinutes: 15, conditioningExerciseId: 'catalog-cardio-caminadora' }, source), 'Cardio count cannot silently drop a phase');
  const prioritized = generateRoutine({ ...options, priorityGroup: 'chest' }, source);
  assert(prioritized.days.every(planDay => planDay.blocks[0].movements[0].muscleGroup === 'chest'), 'Selected muscle is prioritized without replacing the training focus');
  assert(prioritized.days.every((planDay, index) => planDay.blocks.reduce((total, block) => total + block.sets, 0) === first.days[index].blocks.reduce((total, block) => total + block.sets, 0)), 'Priority does not inflate working sets');
  assert(prioritized.provenance.priorityGroup === 'chest', 'Exact muscle priority remains in provenance');
  rejects(() => generateRoutine({ ...options, priorityGroup: 'adductors' }, source), 'A missing eligible muscle is not silently replaced or sourced elsewhere');
  rejects(() => generateRoutine({ ...options, priorityGroup: 'cardio' }, source), 'Cardio cannot masquerade as a muscular priority');
  rejects(() => generateRoutine({ ...options, priorityGroup: 'chest', minRating: 4 }, source), 'Priority cannot bypass strict exercise ratings');
  const arms = generateRoutine({ ...options, focus: 'arms' }, source);
  assert(arms.days.every(planDay => planDay.blocks[0].movements[0].muscleGroup === 'biceps' && planDay.blocks[1].movements[0].muscleGroup === 'triceps'), 'Arm priority changes selection and exercise order');
  assert(JSON.stringify(first) === JSON.stringify(generateRoutine(options, source)), 'Generation deterministic');
  assert(JSON.stringify(source) === before, 'Catalog not mutated');
  assert(first.days.every(item => item.blocks.every(block => block.movements.every(mv => !Object.hasOwn(mv, 'load')))), 'No prescribed loads');
  const completeSession = generateRoutine({ ...options, minutes: 60, warmupMinutes: 5, cardioMinutes: 15,
    conditioningExerciseId: 'catalog-cardio-caminadora' }, source);
  assert(completeSession.days.every(planDay => planDay.blocks[0].tag === 'Calentamiento' && planDay.blocks.at(-1).tag === 'Cardio'), 'A complete session contains its requested warmup and cardio in the actual plan');
  for (const planDay of completeSession.days) {
    const timing = planDay.timing;
    assert(timing.warmupSeconds === 300 && timing.cardioSeconds === 900 && timing.strengthSeconds > 0 && timing.restSeconds > 0, 'All requested session phases are accounted for');
    assert(timing.totalSeconds === timing.warmupSeconds + timing.strengthSeconds + timing.restSeconds + timing.transitionSeconds + timing.cardioSeconds, 'Displayed total equals the sum of all session parts');
    assert(planDay.estimatedMinutes === Math.ceil(timing.totalSeconds / 60) && planDay.estimatedMinutes <= 60, 'Total duration respects the complete session budget');
    const savedDay = sanitizeRoutine([planDay])[0];
    assert(JSON.stringify(estimateRoutineTime(savedDay)) === JSON.stringify(timing), 'The editor preserves timed phases and their timing without stale metadata');
  }
  assert(completeSession.provenance.sources.some(reference => reference.id === 'catalog-cardio-caminadora'), 'Conditioning keeps its selected source');
  for (const minutes of [60, 90, 120]) {
    const fitted = generateRoutine({ ...options, minutes, restSeconds: 180, experience: 'regular', warmupMinutes: 5,
      cardioMode: 'remaining', conditioningExerciseId: 'catalog-cardio-caminadora' }, source);
    assert(fitted.days.every(planDay => planDay.timing.totalSeconds === minutes * 60), `Explicit cardio completion fits the ${minutes}-minute full-session target`);
    assert(fitted.days.every(planDay => planDay.timing.cardioSeconds >= 300 && planDay.timing.cardioSeconds <= 3600), 'Automatic cardio allocation stays within explicit bounds');
    assert(fitted.provenance.cardioMode === 'remaining', 'Cardio completion is an explicit recorded choice');
  }
  rejects(() => generateRoutine({ ...options, minutes: 120, warmupMinutes: 5, cardioMode: 'remaining',
    conditioningExerciseId: 'catalog-cardio-caminadora' }, source), 'Too much remaining cardio is rejected instead of inflating the session');
  for (const change of [{ warmupMinutes: -1 }, { warmupMinutes: 31 }, { cardioMinutes: 61 }, { cardioMinutes: 2.5 },
    { conditioningExerciseId: 'missing' }, { minutes: 20, warmupMinutes: 10, cardioMinutes: 10 }]) {
    rejects(() => generateRoutine({ ...options, minutes: 60, warmupMinutes: 5, cardioMinutes: 15,
      conditioningExerciseId: 'catalog-cardio-caminadora', ...change }, source), 'Invalid or impossible phase allocation is rejected');
  }
  for (const minutes of [60, 90, 120]) {
    const timed = generateRoutine({ ...options, minutes }, source);
    assert(timed.provenance.minutes === minutes && timed.days.every(planDay => planDay.estimatedMinutes <= minutes), `Available time of ${minutes} minutes is preserved without promising an exact duration`);
    assert(timed.warnings.some(warning => warning.includes('menos tiempo')), 'A short proposal explains unused available time');
    assert(timed.days.every(planDay => new Set(planDay.blocks.map(block => block.movements[0].name)).size === planDay.blocks.length), 'Longer time budgets do not duplicate exercises to fill time');
  }
  for (let days = 1; days <= 7; days++) {
    const flexible = generateRoutine({ ...options, days, idPrefix: `flexible-${days}` }, source);
    const identifiers = flexible.days.flatMap(planDay => [planDay.id, ...planDay.blocks.flatMap(block => [block.id, ...block.movements.map(exercise => exercise.id)])]);
    assert(flexible.days.length === days && flexible.provenance.days === days, `Generator preserves a ${days}-day request`);
    assert(new Set(identifiers).size === identifiers.length, `Generated identities remain unique across ${days} days`);
    assert(flexible.days.every(planDay => planDay.blocks.length > 0 && planDay.estimatedMinutes <= options.minutes), `Every generated day fits the ${days}-day proposal`);
    assert(JSON.stringify(source) === before, `Generating ${days} days does not overwrite its sources`);
  }
  for (const changed of [{ source: '' }, { days: 0 }, { minutes: 14 }, { focus: 'unknown' }, { goal: 'medical' }, { restSeconds: 0 }]) {
    rejects(() => generateRoutine({ ...options, ...changed }, source), 'Invalid questionnaire rejected');
  }
  rejects(() => generateRoutine({ ...options, source: 'personal' }, source), 'Missing personal source never falls back to catalog');
  rejects(() => generateRoutine({ ...options, equipment: 'Equipo no disponible' }, source), 'Equipment filter not silently ignored');
  rejects(() => generateRoutine({ ...options, minRating: 4 }, source), 'A strict rating minimum cannot silently include unrated exercises');
  const owned = { id: 'owned', days: [{ id: 'owned-day', blocks: [{ id: 'owned-block', sets: 2, rest: 30, note: 'Alternar ejercicios del bloque',
    movements: [
      { id: 'owned-press', name: 'Press personal', kind: 'weight', muscleGroup: 'chest', reps: '8-10' },
      { id: 'owned-row', name: 'Remo personal', kind: 'weight', muscleGroup: 'back', reps: '12' },
      { id: 'owned-squat', name: 'Sentadilla personal', kind: 'weight', muscleGroup: 'quads', reps: '10' }
    ] }] }] };
  const ownedBefore = JSON.stringify(owned);
  const ownedWithCardio = structuredClone(owned);
  const ownCardio = { id: 'own-bike', name: 'Bicicleta personal', kind: 'check', muscleGroup: 'cardio', reps: '10 min', timer: 600 };
  ownedWithCardio.days[0].blocks.push({ id: 'own-cardio-block', sets: 1, rest: 0, movements: [ownCardio] });
  const ownTimedSource = { ...source, routines: [ownedWithCardio] };
  const ownTimedBefore = JSON.stringify(ownedWithCardio);
  const ownTimed = generateRoutine({ ...options, source: 'routines', minutes: 60, warmupMinutes: 5, cardioMinutes: 15,
    conditioningExerciseId: ownCardio.id, conditioningSourceId: owned.id }, ownTimedSource);
  assert(ownTimed.provenance.sources.every(reference => reference.id === owned.id), 'Personal complete sessions never import catalog conditioning');
  assert(JSON.stringify(ownedWithCardio) === ownTimedBefore, 'Explicit duration choices only affect the new proposal, never the source routine');
  assert(conditioningChoices('routines', ownTimedSource).length === 1 && conditioningChoices('routines', ownTimedSource)[0].id === ownCardio.id, 'Cardio chooser respects routine-only sources');
  assert(conditioningChoices('routines', { ...source, routines: [owned] }).length === 0, 'No hidden catalog fallback in the cardio chooser');
  rejects(() => generateRoutine({ ...options, source: 'routines', warmupMinutes: 5,
    conditioningExerciseId: 'catalog-cardio-caminadora' }, ownTimedSource), 'A catalog cardio option cannot leak into routine-only generation');
  const ratedExercises = owned.days[0].blocks[0].movements;
  const ratings = Object.fromEntries(ratedExercises.map(exercise => [exerciseRatingKey(exercise), 4]));
  const ratedSource = { ...source, routines: [owned], ratings };
  const ratingsBefore = JSON.stringify(ratings);
  const ratedProposal = generateRoutine({ ...options, source: 'routines', minRating: 4 }, ratedSource);
  rejects(() => generateRoutine({ ...options, source: 'routines', minRating: 4, warmupMinutes: 5,
    conditioningExerciseId: ownCardio.id, conditioningSourceId: owned.id }, { ...ownTimedSource, ratings }), 'Unrated conditioning cannot bypass the stars filter');
  const allRated = { ...ratings, [exerciseRatingKey(ownCardio)]: 4 };
  assert(generateRoutine({ ...options, source: 'routines', minRating: 4, warmupMinutes: 5,
    conditioningExerciseId: ownCardio.id, conditioningSourceId: owned.id }, { ...ownTimedSource, ratings: allRated }).days.length === options.days, 'Rated conditioning is allowed with compatible strength exercises');
  assert(ratedProposal.provenance.minRating === 4 && ratedProposal.provenance.sources.every(reference => reference.id === owned.id), 'Four-star minimum uses only the explicitly rated routine exercises');
  assert(JSON.stringify(ratings) === ratingsBefore && JSON.stringify(owned) === ownedBefore, 'Rating filters do not mutate preferences or source routines');
  const limitedRatings = { ...ratings, [exerciseRatingKey(ratedExercises[0])]: 3 };
  rejects(() => generateRoutine({ ...options, source: 'routines', minRating: 4 }, { ...ratedSource, ratings: limitedRatings }), 'Three stars do not pass a four-star minimum');
  rejects(() => generateRoutine({ ...options, source: 'routines', minRating: 5 }, ratedSource), 'Four stars do not pass a five-star minimum');
  assert(exerciseRating({ ...ratedExercises[0], id: 'reimported' }, ratings) === 4, 'A preference survives an ID-only reimport');
  assert(exerciseRating({ ...ratedExercises[0], equipment: 'Another machine' }, ratings) === null, 'A preference does not cross equipment contexts');
  assert(exerciseRating({ ...ratedExercises[0], note: 'Different variation' }, ratings) === null, 'A preference does not cross movement variants');
  for (const minRating of [-1, 1.5, 6, '4']) rejects(() => generateRoutine({ ...options, minRating }, ratedSource), 'Invalid minimum rating rejected');
  for (const rating of [0, 6, 2.5, true, '4']) rejects(() => validateExerciseRatings({ [exerciseRatingKey(ratedExercises[0])]: rating }), 'Invalid saved stars rejected');
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
