import { normalizeExercise } from './intelligence.js';

export function exerciseRatingKey(exercise) {
  return JSON.stringify([normalizeExercise(exercise.name), exercise.kind || 'weight',
    normalizeExercise(exercise.note), normalizeExercise(exercise.equipment)]);
}

export function validateExerciseRatings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Las calificaciones no tienen un formato valido.');
  for (const [key, rating] of Object.entries(value)) {
    let identity;
    try { identity = JSON.parse(key); } catch { throw new Error('Una calificacion no identifica su ejercicio.'); }
    if (!Array.isArray(identity) || identity.length !== 4 || identity.some(part => typeof part !== 'string') ||
        !identity[0].trim() || !['weight', 'check'].includes(identity[1]) ||
        !Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error('Cada ejercicio debe tener entre 1 y 5 estrellas.');
    }
  }
  return { ...value };
}

export function exerciseRating(exercise, ratings = {}) {
  const value = ratings[exerciseRatingKey(exercise)];
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}