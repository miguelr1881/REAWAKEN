import { exerciseFocus } from './exercise-info.js';
import { normalizeExercise, repTarget } from './intelligence.js';
import { validateTrainingPreferences } from './training-preferences.js';

const goals = ['consistency', 'strength', 'muscle'];
const focuses = {
  full: [['quads', 'hamstrings', 'glutes'], ['chest', 'shoulders'], ['back']],
  upper: [['chest', 'shoulders'], ['back'], ['shoulders', 'biceps', 'triceps']],
  lower: [['quads'], ['hamstrings', 'glutes'], ['calves', 'core', 'adductors']]
};
const simpleCatalog = new Set([
  'catalog-chest-dumbbell-press', 'catalog-chest-machine-press', 'catalog-chest-push-ups',
  'catalog-back-lat-pulldown', 'catalog-back-seated-cable-row', 'catalog-back-dumbbell-row',
  'catalog-shoulders-dumbbell-press', 'catalog-shoulders-lateral-dumbbell',
  'catalog-quads-goblet-squat', 'catalog-quads-leg-press', 'catalog-quads-lunge',
  'catalog-hamstrings-seated-curl', 'catalog-hamstrings-lying-curl', 'catalog-glutes-glute-bridge',
  'catalog-calves-standing', 'catalog-core-dead-bug', 'catalog-biceps-hammer-curl', 'catalog-triceps-pushdown-bar'
]);

export function generateRoutine(options, { catalog, routines, exercises }) {
  const { source, days, minutes, goal, focus, experience, restSeconds, equipment = '', idPrefix } = options;
  if (!['routines', 'catalog', 'personal', 'both'].includes(source)) throw new Error('Elige de dónde tomar los ejercicios.');
  if (!Number.isInteger(days) || days < 1 || days > 7 || !Number.isInteger(minutes) || minutes < 15 || minutes > 120) {
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
          pool.push({ ...movement, source: 'personal', sourceId: routine.id,
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
    for (const exercise of catalog.filter(item => simpleCatalog.has(item.id))) {
      pool.push({ ...exercise, source: 'catalog', sourceId: exercise.id });
    }
  }
  if (source === 'routines' && !pool.length) throw new Error('Importa y guarda una rutina del gym primero. Así podremos reutilizar sus ejercicios.');
  const unique = new Map();
  let excluded = 0;
  for (const candidate of pool) {
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
  const buckets = focuses[focus];
  const required = focus === 'full' ? buckets : buckets.slice(0, 2);
  if (required.some(groups => !candidates.some(item => groups.includes(item.muscleGroup)))) {
    throw new Error('Las fuentes elegidas no cubren los grupos necesarios. Añade ejercicios propios o cambia el enfoque/equipo; no completamos con otra fuente.');
  }
  const result = [], selectedSources = new Map();
  let minimumCount = Infinity;
  let combinedSource = false;
  for (let index = 0; index < days; index++) {
    const chosen = [], used = new Set();
    const take = groups => {
      const matches = candidates.filter(item => groups.includes(item.muscleGroup) && !used.has(normalizeExercise(item.name)));
      if (!matches.length) return;
      const item = matches[index % matches.length];
      chosen.push(item); used.add(normalizeExercise(item.name));
    };
    buckets.forEach(take);
    const extraGroups = focus === 'full' ? ['core', 'shoulders', 'calves', 'biceps', 'triceps'] :
      focus === 'upper' ? ['core', 'biceps', 'triceps'] : ['glutes', 'calves', 'core'];
    extraGroups.forEach(group => take([group]));
    let seconds = 300;
    const blocks = [];
    for (const candidate of chosen) {
      const sets = Number.isInteger(candidate.plannedSets) ? candidate.plannedSets : experience === 'returning' ? 2 : 3;
      const rest = Number.isFinite(candidate.plannedRest) ? candidate.plannedRest : restSeconds;
      if (sets < 1 || sets > 12 || rest < 0 || rest > 3600) throw new Error('Una fuente contiene series o descansos fuera del rango admitido. Revísala antes de generar.');
      const reps = repTarget(candidate)?.max || Number(candidate.reps) || 10;
      const estimate = sets * (candidate.timer || reps * 3) + Math.max(0, sets - 1) * rest + 60;
      if (seconds + estimate > minutes * 60) {
        if (blocks.length < required.length) throw new Error('Las series y descansos de las fuentes no caben en ese tiempo. Amplía la duración o revisa el plan; no recortamos indicaciones del coach.');
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
    result.push({ id: `${idPrefix}-d${index + 1}`, label: `Día ${index + 1}`, title: `Sesión ${index + 1}`,
      subtitle: 'Propuesta personal · revisar con tu coach', blocks, estimatedMinutes: Math.ceil(seconds / 60) });
  }
  return {
    days: result,
    provenance: { version: 1, source, goal, focus, experience, days, minutes, restSeconds, equipment, sources: [...selectedSources.values()] },
    warnings: [
      'Propuesta orientativa, sin cargas sugeridas. Revisa técnica, descansos y disponibilidad con tu coach antes de activarla.',
      'El tiempo es aproximado e incluye 5 minutos de preparación; no mide la duración real de tus series.',
      ...(combinedSource ? ['El borrador separa ejercicios de bloques combinados. Revisa el orden y las superseries con tu coach; las notas de origen se conservan en el editor.'] : []),
      ...(excluded ? [`${excluded} opciones sin contexto suficiente o con prescripciones especiales quedaron fuera.`] : []),
      ...(minimumCount < 4 ? ['La propuesta es corta por las fuentes o el tiempo elegidos; no añadimos ejercicios de otros orígenes.'] : [])
    ]
  };
}
