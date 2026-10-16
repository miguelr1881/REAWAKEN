import { EXERCISE_CATALOG } from '../js/exercise-catalog.js';
import { sanitizeRoutine } from '../js/routine-parser.js';
import { MUSCLE_GROUPS, muscleAtlas } from '../js/exercise-info.js';

export function runExerciseLibraryTests() {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const ids = new Set(EXERCISE_CATALOG.map(exercise => exercise.id));
  const groups = new Set(EXERCISE_CATALOG.map(exercise => exercise.muscleGroup));
  const equipment = new Set(EXERCISE_CATALOG.map(exercise => exercise.equipment));
  assert(EXERCISE_CATALOG.length >= 100, 'catalog includes a broad base of exercises');
  assert(ids.size === EXERCISE_CATALOG.length, 'catalog ids are unique');
  assert(EXERCISE_CATALOG.every(exercise => exercise.name && groups.has(exercise.muscleGroup)), 'catalog records have names and muscle groups');
  assert(EXERCISE_CATALOG.every(exercise => ['weight', 'check'].includes(exercise.kind)), 'catalog records use supported tracking kinds');
  assert(equipment.size >= 8, 'catalog covers multiple equipment types');
  const routine = sanitizeRoutine([{ blocks: [{ sets: 3, movements: [{ name: 'Press de prueba', reps: '10', equipment: 'Mancuernas' }] }] }]);
  assert(routine[0].blocks[0].movements[0].equipment === 'Mancuernas', 'equipment survives routine normalization');
  const parseAtlas = groups => new DOMParser().parseFromString(muscleAtlas(groups), 'image/svg+xml');
  const regions = Object.keys(MUSCLE_GROUPS).filter(group => !['full', 'cardio', 'none'].includes(group));
  for (const group of regions) {
    const atlas = parseAtlas([group]);
    assert(!atlas.querySelector('parsererror'), 'Muscle atlas is valid SVG');
    const highlighted = [...atlas.querySelectorAll('.anatomy-region.active')];
    assert(highlighted.length >= 2 && highlighted.every(path => path.getAttribute('data-region') === group), 'Only the selected muscle is highlighted on both sides');
    assert(atlas.documentElement.getAttribute('aria-label').includes(MUSCLE_GROUPS[group]), 'Highlighted muscle is named for assistive technology');
  }
  const full = parseAtlas(['full']);
  assert(full.querySelectorAll('.anatomy-region.active').length === full.querySelectorAll('.anatomy-region').length, 'Full-body focus includes every region');
  for (const group of ['none', 'cardio']) assert(!parseAtlas([group]).querySelector('.active'), 'Unassigned and cardio do not invent muscle targets');
  const firstIds = [...full.querySelectorAll('[id]')].map(node => node.id);
  const nextIds = [...parseAtlas(['chest']).querySelectorAll('[id]')].map(node => node.id);
  assert(!firstIds.some(id => nextIds.includes(id)), 'Multiple maps do not share gradient IDs');
  return { checks, result: 'PASS' };
}