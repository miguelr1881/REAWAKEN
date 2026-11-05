import { exerciseFocus, MUSCLE_GROUPS } from './exercise-info.js';
import { normalizeExercise, repTarget } from './intelligence.js';
import { validateTrainingPreferences } from './training-preferences.js';
import { exerciseRatingKey, validateExerciseRatings } from './exercise-ratings.js';

const goals = ['consistency', 'strength', 'muscle'];
const focuses = {
  full: [['quads', 'hamstrings', 'glutes'], ['chest', 'shoulders'], ['back']],
  upper: [['chest', 'shoulders'], ['back'], ['shoulders', 'biceps', 'triceps']],
  lower: [['quads'], ['hamstrings', 'glutes'], ['calves', 'core', 'adductors']],
  arms: [['biceps'], ['triceps'], ['shoulders']]
};
const simpleCatalog = new Set([
  'catalog-chest-dumbbell-press', 'catalog-chest-machine-press', 'catalog-chest-push-ups',
  'catalog-back-lat-pulldown', 'catalog-back-seated-cable-row', 'catalog-back-dumbbell-row',
  'catalog-shoulders-dumbbell-press', 'catalog-shoulders-lateral-dumbbell',
  'catalog-quads-goblet-squat', 'catalog-quads-leg-press', 'catalog-quads-lunge',
  'catalog-hamstrings-seated-curl', 'catalog-hamstrings-lying-curl', 'catalog-glutes-glute-bridge',
  'catalog-calves-standing', 'catalog-core-dead-bug', 'catalog-biceps-hammer-curl', 'catalog-triceps-pushdown-bar'
]);

export function estimateRoutineTime(day, preparationMinutes = 0) {
  const timing = { warmupSeconds: preparationMinutes * 60, strengthSeconds: 0, restSeconds: 0, transitionSeconds: 0, cardioSeconds: 0 };
  for (const block of day.blocks || []) {
    const phase = normalizeExercise(block.tag);
    const work = block.sets * block.movements.reduce((total, movement) => {
      const reps = repTarget(movement)?.max || Number(movement.reps) || 10;
      return total + (Number.isFinite(movement.timer) ? movement.timer : reps * 3);
    }, 0);
    if (phase === 'calentamiento') timing.warmupSeconds += work;
    else if (phase === 'cardio' || phase === 'cardio inicial') timing.cardioSeconds += work;
    else timing.strengthSeconds += work;
    timing.restSeconds += Math.max(0, block.sets - 1) * (Number.isFinite(block.rest) ? block.rest : 0);
    timing.transitionSeconds += 60;
  }
  return { ...timing, totalSeconds: Object.values(timing).reduce((total, value) => total + value, 0) };
}

export function conditioningChoices(source, { catalog, routines, exercises }) {
  const choices = [];
  if (source !== 'catalog') {
    for (const routine of routines.filter(record => !record.deletedAt)) {
      for (const day of routine.days || []) for (const block of day.blocks || []) for (const movement of block.movements || []) {
        choices.push({ ...movement, sourceId: routine.id, sourceName: routine.name || 'Rutina guardada' });
      }
    }
    if (source !== 'routines') for (const exercise of exercises.filter(record => !record.deletedAt)) {
      choices.push({ ...exercise, sourceId: exercise.id, sourceName: 'Ficha personal' });
    }
  }
  if (source === 'catalog' || source === 'both') for (const exercise of catalog) {
    choices.push({ ...exercise, sourceId: exercise.id, sourceName: 'Catálogo' });
  }
  const unique = new Map();
  for (const choice of choices) {
    if (choice.kind !== 'check' || exerciseFocus(choice) !== 'cardio') continue;
    const key = JSON.stringify([choice.sourceId, choice.id]);
    if (!unique.has(key)) unique.set(key, { ...choice, key });
  }
  return [...unique.values()];
}

export function generateRoutine(options, { catalog, routines, exercises, ratings: savedRatings = {} }) {
  const { source, days, minutes, mode = 'time', exerciseCount = 6, cardioCount, goal, focus, experience, restSeconds, equipment = '', minRating = 0, priorityGroup = '',
    warmupMinutes = 0, cardioMinutes = 0, cardioMode = 'fixed', conditioningExerciseId = '', conditioningSourceId = '', idPrefix } = options;
  const byCount = mode === 'count';
  const completeSession = byCount || Object.hasOwn(options, 'warmupMinutes') || Object.hasOwn(options, 'cardioMinutes') || Object.hasOwn(options, 'cardioMode');
  if (!['time', 'count'].includes(mode) || (byCount && (!Number.isInteger(exerciseCount) || exerciseCount < 1 || exerciseCount > 12))) {
    throw new Error('Elige tiempo o una cantidad de 1 a 12 ejercicios de trabajo. El cardio se cuenta aparte.');
  }
  if (byCount && (cardioMode !== 'fixed' || (cardioCount !== undefined &&
      (!Number.isInteger(cardioCount) || cardioCount < 0 || cardioCount > 2 || cardioCount !== Number(warmupMinutes > 0) + Number(cardioMinutes > 0))))) {
    throw new Error('Elige cero, uno o dos bloques de cardio con su duración. Por cantidad no se rellena tiempo automáticamente.');
  }
  const ratings = validateExerciseRatings(savedRatings);
  if (priorityGroup !== '' && (!Object.hasOwn(MUSCLE_GROUPS, priorityGroup) || ['none', 'full', 'cardio'].includes(priorityGroup))) {
    throw new Error('Elige una zona muscular valida para priorizar.');
  }
  if (!Number.isInteger(minRating) || minRating < 0 || minRating > 5) throw new Error('Elige un minimo de estrellas valido.');
  if (!Number.isInteger(warmupMinutes) || warmupMinutes < 0 || warmupMinutes > 30 ||
      !Number.isInteger(cardioMinutes) || cardioMinutes < 0 || cardioMinutes > 60 ||
      !['fixed', 'remaining'].includes(cardioMode) || typeof conditioningExerciseId !== 'string' || typeof conditioningSourceId !== 'string') {
    throw new Error('Revisa el tiempo de calentamiento (0-30 min) y cardio (0-60 min).');
  }
  if (!['routines', 'catalog', 'personal', 'both'].includes(source)) throw new Error('Elige de dónde tomar los ejercicios.');
  if (!Number.isInteger(days) || days < 1 || days > 7 || (!byCount && (!Number.isInteger(minutes) || minutes < 15 || minutes > 120))) {
    throw new Error('Elige entre 1 y 7 días y entre 15 y 120 minutos por sesión.');
  }
  if (!goals.includes(goal) || !Object.hasOwn(focuses, focus) || !['returning', 'regular'].includes(experience) ||
      typeof idPrefix !== 'string' || !idPrefix) throw new Error('Revisa las opciones de la propuesta.');
  validateTrainingPreferences({ restSeconds });
  const pool = [];
  if (source !== 'catalog') {
    for (const routine of routines.filter(item => !item.deletedAt)) {
      for (const day of routine.days || []) for (const block of day.blocks || []) {
        for (const movement of block.movements || []) {
          pool.push({ ...movement, source: 'personal', sourceId: routine.id, ratingKey: exerciseRatingKey(movement),
            sourceDayId: day.id, sourceBlockId: block.id, combined: block.movements.length > 1,
            note: [movement.note, block.note ? `Bloque de origen: ${block.note}` : ''].filter(Boolean).join(' · '),
            plannedSets: block.sets, plannedRest: block.rest });
        }
      }
    }
    if (source !== 'routines') {
      for (const exercise of exercises.filter(item => !item.deletedAt)) {
        pool.push({ ...exercise, source: 'personal', sourceId: exercise.id });
      }
    }
  }
  if (source === 'catalog' || source === 'both') {
    for (const exercise of catalog.filter(item => simpleCatalog.has(item.id) ||
      (item.id === conditioningExerciseId && exerciseFocus(item) === 'cardio' && item.kind === 'check'))) {
      pool.push({ ...exercise, source: 'catalog', sourceId: exercise.id });
    }
  }
  if (source === 'routines' && !pool.length) throw new Error('Importa y guarda una rutina del gym primero. Así podremos reutilizar sus ejercicios.');
  const conditioning = pool.find(candidate => candidate.id === conditioningExerciseId &&
    (!conditioningSourceId || candidate.sourceId === conditioningSourceId) &&
    candidate.kind === 'check' && exerciseFocus(candidate) === 'cardio');
  if (warmupMinutes + cardioMinutes > 0 || cardioMode === 'remaining') {
    if (!conditioning) throw new Error('Elige un ejercicio de cardio de las fuentes seleccionadas para el calentamiento y el cardio.');
    if ((ratings[conditioning.ratingKey || exerciseRatingKey(conditioning)] || 0) < minRating) {
      throw new Error('El ejercicio de calentamiento/cardio no alcanza el minimo de estrellas. Califica ese ejercicio o elige otro.');
    }
    if (!byCount && warmupMinutes + (cardioMode === 'fixed' ? cardioMinutes : 0) >= minutes) throw new Error('El calentamiento y el cardio no dejan tiempo para el trabajo muscular y sus descansos.');
  }
  const unique = new Map();
  let excluded = 0, ratingExcluded = 0;
  for (const candidate of pool) {
    if (exerciseFocus(candidate) === 'cardio') continue;
    const rating = ratings[candidate.ratingKey || exerciseRatingKey(candidate)] || 0;
    if (rating < minRating) { ratingExcluded++; continue; }
    const group = exerciseFocus(candidate);
    const reps = String(candidate.reps || (goal === 'strength' ? '8-10' : goal === 'muscle' ? '10-12' : '10'));
    const movement = { ...candidate, reps };
    if (!candidate.id || !candidate.name || !['weight', 'check'].includes(candidate.kind) || group === 'none' ||
        group === 'cardio' || (candidate.kind === 'weight' && !repTarget(movement)) ||
        (Number.isFinite(candidate.timer) && (candidate.timer < 1 || candidate.timer > 3600)) ||
        (candidate.kind === 'check' && (!/^\d{1,2}$/.test(reps) || Number(reps) < 1) && !Number.isFinite(candidate.timer))) {
      excluded++;
      continue;
    }
    if (equipment && !normalizeExercise(candidate.equipment).includes(normalizeExercise(equipment))) continue;
    const key = normalizeExercise(candidate.name);
    if (!unique.has(key)) unique.set(key, { ...movement, muscleGroup: group });
  }
  const candidates = [...unique.values()];
  if (priorityGroup && !candidates.some(item => item.muscleGroup === priorityGroup)) {
    throw new Error(`No hay ejercicios elegibles de ${MUSCLE_GROUPS[priorityGroup]} en tus fuentes y filtros. Revisa las estrellas o elige otra fuente; no sustituimos tu prioridad.`);
  }
  const buckets = focuses[focus];
  const required = focus === 'full' ? buckets : buckets.slice(0, 2);
  if (required.some(groups => !candidates.some(item => groups.includes(item.muscleGroup)))) {
    if (minRating) throw new Error(`No hay suficientes ejercicios con ${minRating} estrellas o mas para ese enfoque. Califica mas ejercicios o cambia el filtro; no lo relajamos automaticamente.`);
    throw new Error('Las fuentes elegidas no cubren los grupos necesarios. Añade ejercicios propios o cambia el enfoque/equipo; no completamos con otra fuente.');
  }
  const result = [], selectedSources = new Map();
  let minimumCount = Infinity;
  let combinedSource = false;
  for (let index = 0; index < days; index++) {
    const chosen = [], used = new Set();
    const take = groups => {
      if (byCount && chosen.length >= exerciseCount) return;
      const matches = candidates.filter(item => groups.includes(item.muscleGroup) && !used.has(normalizeExercise(item.name)));
      if (!matches.length) return;
      const item = matches[index % matches.length];
      chosen.push(item); used.add(normalizeExercise(item.name));
    };
    if (priorityGroup) take([priorityGroup]);
    required.forEach(groups => { if (!priorityGroup || !chosen.some(item => groups.includes(item.muscleGroup))) take(groups); });
    if (byCount && required.some(groups => !chosen.some(item => groups.includes(item.muscleGroup)))) {
      throw new Error('Esa cantidad no permite cubrir el enfoque y la prioridad elegidos. Aumenta los ejercicios o cambia el enfoque.');
    }
    buckets.slice(required.length).forEach(groups => { if (!priorityGroup || !chosen.some(item => groups.includes(item.muscleGroup))) take(groups); });
    const extraGroups = focus === 'full' ? ['core', 'shoulders', 'calves', 'biceps', 'triceps'] :
      focus === 'upper' ? ['core', 'biceps', 'triceps'] : focus === 'arms' ? ['back', 'chest', 'core'] : ['glutes', 'calves', 'core'];
    extraGroups.forEach(group => { if (group !== priorityGroup) take([group]); });
    if (byCount) {
      const allowed = new Set([...buckets.flat(), ...extraGroups, ...(priorityGroup ? [priorityGroup] : [])]);
      const remaining = candidates.filter(item => allowed.has(item.muscleGroup) && !used.has(normalizeExercise(item.name)));
      for (let offset = 0; offset < remaining.length && chosen.length < exerciseCount; offset++) {
        const item = remaining[(index + offset) % remaining.length];
        chosen.push(item); used.add(normalizeExercise(item.name));
      }
      if (chosen.length !== exerciseCount) throw new Error(`Solo hay ${chosen.length} ejercicios elegibles para este enfoque. Reduce la cantidad o revisa tus fuentes y estrellas; no repetimos ni añadimos otra fuente.`);
    }
    const reservedCardioMinutes = cardioMode === 'remaining' ? 5 : cardioMinutes;
    let seconds = completeSession ? (warmupMinutes + reservedCardioMinutes) * 60 +
      (Number(warmupMinutes > 0) + Number(reservedCardioMinutes > 0)) * 60 : 300;
    const blocks = [];
    for (const candidate of chosen) {
      const sets = Number.isInteger(candidate.plannedSets) ? candidate.plannedSets : experience === 'returning' ? 2 : 3;
      const rest = Number.isFinite(candidate.plannedRest) ? candidate.plannedRest : restSeconds;
      if (sets < 1 || sets > 12 || rest < 0 || rest > 3600) throw new Error('Una fuente contiene series o descansos fuera del rango admitido. Revísala antes de generar.');
      const reps = repTarget(candidate)?.max || Number(candidate.reps) || 10;
      const estimate = sets * (candidate.timer || reps * 3) + Math.max(0, sets - 1) * rest + 60;
      if (!byCount && seconds + estimate > minutes * 60) {
        if (candidate.muscleGroup === priorityGroup || required.some(groups => groups.includes(candidate.muscleGroup) && !blocks.some(block => groups.includes(block.movements[0].muscleGroup)))) {
          throw new Error('Las series y descansos de las fuentes no caben en ese tiempo. Amplía la duración o revisa el plan; no recortamos indicaciones del coach.');
        }
        continue;
      }
      seconds += estimate;
      const id = `${idPrefix}-d${index + 1}-b${blocks.length + 1}`;
      blocks.push({ id, sets, rest, movements: [{
        id: `${id}-m1`, name: candidate.name, kind: candidate.kind, reps: candidate.reps,
        muscleGroup: candidate.muscleGroup,
        ...(candidate.note ? { note: candidate.note } : {}),
        ...(candidate.equipment ? { equipment: candidate.equipment } : {}),
        ...(Number.isFinite(candidate.timer) ? { timer: candidate.timer } : {})
      }] });
      combinedSource ||= Boolean(candidate.combined);
      selectedSources.set(`${candidate.source}:${candidate.sourceId}:${candidate.id}`, {
        source: candidate.source, id: candidate.sourceId, movementId: candidate.id,
        ...(candidate.sourceDayId ? { dayId: candidate.sourceDayId, blockId: candidate.sourceBlockId } : {})
      });
    }
    minimumCount = Math.min(minimumCount, blocks.length);
    const cardioSeconds = cardioMode === 'remaining' ? minutes * 60 - seconds + reservedCardioMinutes * 60 : cardioMinutes * 60;
    if (cardioMode === 'remaining' && (cardioSeconds < 300 || cardioSeconds > 3600)) {
      throw new Error('Con estos ejercicios, completar el tiempo requeriría menos de 5 o más de 60 minutos de cardio. Cambia la duración total o elige un tiempo fijo; no alargamos el trabajo muscular automáticamente.');
    }
    const timedBlock = (phase, durationSeconds) => {
      const id = `${idPrefix}-d${index + 1}-${phase === 'Calentamiento' || phase === 'Cardio inicial' ? 'warmup' : 'cardio'}`;
      selectedSources.set(`${conditioning.source}:${conditioning.sourceId}:${conditioning.id}`, {
        source: conditioning.source, id: conditioning.sourceId, movementId: conditioning.id,
        ...(conditioning.sourceDayId ? { dayId: conditioning.sourceDayId, blockId: conditioning.sourceBlockId } : {})
      });
      return { id, tag: phase, sets: 1, rest: 0, note: 'Tiempo elegido para esta propuesta.', movements: [{
        id: `${id}-m1`, name: conditioning.name, kind: 'check', muscleGroup: 'cardio',
        reps: `${Math.floor(durationSeconds / 60)} min${durationSeconds % 60 ? ` ${durationSeconds % 60} s` : ''}`, timer: durationSeconds,
        ...(conditioning.note ? { note: conditioning.note } : {}),
        ...(conditioning.equipment ? { equipment: conditioning.equipment } : {})
      }] };
    };
    const plannedBlocks = [
      ...(warmupMinutes > 0 ? [timedBlock(byCount ? 'Cardio inicial' : 'Calentamiento', warmupMinutes * 60)] : []),
      ...blocks,
      ...(cardioSeconds > 0 ? [timedBlock('Cardio', cardioSeconds)] : [])
    ];
    const timing = estimateRoutineTime({ blocks: plannedBlocks }, completeSession ? 0 : 5);
    result.push({ id: `${idPrefix}-d${index + 1}`, label: `Día ${index + 1}`, title: `Sesión ${index + 1}`,
      subtitle: 'Propuesta personal · revisar con tu coach', blocks: plannedBlocks, timing, estimatedMinutes: Math.ceil(timing.totalSeconds / 60) });
  }
  return {
    days: result,
    provenance: { version: 1, source, goal, focus, experience, days, mode, ...(byCount ? { exerciseCount, cardioCount: Number(warmupMinutes > 0) + Number(cardioMinutes > 0) } : { minutes }), restSeconds, equipment, minRating, priorityGroup,
      ...(completeSession ? { warmupMinutes, cardioMinutes, cardioMode, conditioningExerciseId, conditioningSourceId } : {}), sources: [...selectedSources.values()] },
    warnings: [
      'Propuesta orientativa, sin cargas sugeridas. Revisa técnica, descansos y disponibilidad con tu coach antes de activarla.',
      completeSession ? 'El tiempo total es aproximado: calentamiento, trabajo muscular, descansos, un minuto de transición por bloque y cardio. No mide la duración real de tus series.' : 'El tiempo es aproximado e incluye 5 minutos de preparación; no mide la duración real de tus series.',
      ...(byCount ? ['La cantidad de trabajo no incluye cardio. El tiempo estimado es informativo: no cambia tus ejercicios ni las series de las fuentes.'] : []),
      ...(combinedSource ? ['El borrador separa ejercicios de bloques combinados. Revisa el orden y las superseries con tu coach; las notas de origen se conservan en el editor.'] : []),
      ...(excluded ? [`${excluded} opciones sin contexto suficiente o con prescripciones especiales quedaron fuera.`] : []),
      ...(ratingExcluded ? [`${ratingExcluded} opciones quedaron fuera por el minimo de estrellas, incluidas las que aun no has calificado.`] : []),
      ...(cardioMode === 'remaining' ? ['El cardio completa el objetivo de tiempo por tu elección. Su duración puede variar entre días; revisa que sea apropiada antes de guardar.'] : []),
      ...(!byCount && minimumCount >= 4 && result.every(day => day.estimatedMinutes < minutes * 0.65) ? ['El borrador ocupa menos tiempo del disponible. No añadimos series solo para alargar la sesión.'] : []),
      ...(minimumCount < 4 ? ['La propuesta es corta por las fuentes o el tiempo elegidos; no añadimos ejercicios de otros orígenes.'] : [])
    ]
  };
}
