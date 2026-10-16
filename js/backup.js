const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim().length > 0;
const optionalTime = value => value == null || Number.isFinite(value);

export function backupActiveRoutines(existing, incoming) {
  const merged = new Map([...existing, ...incoming].map(record => [record.id, record]));
  return [...merged.values()].filter(record => !record.archived && !record.deletedAt &&
    (record.active === true || (record.active == null && record.id === 'active')));
}

function validDay(day) {
  return object(day) && identifier(day.id) && Array.isArray(day.blocks) && day.blocks.every(block =>
    object(block) && identifier(block.id) && Number.isInteger(block.sets) && block.sets >= 1 && block.sets <= 12 &&
    Array.isArray(block.movements) && block.movements.every(movement => object(movement) && identifier(movement.id) &&
      identifier(movement.name) && typeof movement.reps === 'string' && ['weight', 'check'].includes(movement.kind)));
}

export function prepareBackup(parsed) {
  if (!object(parsed) || parsed.app !== 'gymtrack' || !Array.isArray(parsed.sessions)) {
    throw new Error('Ese archivo no es un respaldo de REAWAKEN.');
  }
  if (parsed.version !== undefined && (!Number.isInteger(parsed.version) || parsed.version < 1 || parsed.version > 4)) {
    throw new Error('Version de respaldo no compatible. Actualiza la app antes de importarlo.');
  }
  const validators = {
    sessions: record => identifier(record.dayId) && Number.isFinite(record.startedAt) && optionalTime(record.finishedAt) &&
      object(record.entries) && Object.entries(record.entries).every(([key, value]) => key.startsWith('_') || Array.isArray(value)) &&
      (record.routineSnapshot == null || validDay(record.routineSnapshot)),
    measures: record => Number.isFinite(record.at) && object(record.values),
    routines: record => Array.isArray(record.days) && (record.days.length > 0 || (object(record.profile) && identifier(record.profile.name))) && record.days.every(validDay) &&
      (record.profile == null || object(record.profile)) && (record.active === undefined || typeof record.active === 'boolean'),
    exercises: record => identifier(record.name)
  };
  const labels = { sessions: 'sesiones', measures: 'mediciones', routines: 'rutinas', exercises: 'ejercicios' };
  const prepared = {};
  for (const [store, validate] of Object.entries(validators)) {
    const records = parsed[store] === undefined ? [] : parsed[store];
    if (!Array.isArray(records)) throw new Error(`La lista de ${labels[store]} no es valida. No se importo nada.`);
    const ids = new Set();
    prepared[store] = records.map((record, index) => {
      if (!object(record) || !identifier(record.id) || ids.has(record.id) || !optionalTime(record.updatedAt) ||
          !optionalTime(record.deletedAt) || !validate(record)) {
        throw new Error(`Registro ${index + 1} de ${labels[store]} invalido o duplicado. No se importo nada.`);
      }
      ids.add(record.id);
      return store === 'sessions' ? { ...record, notes: typeof record.notes === 'string' ? record.notes : '' } : { ...record };
    });
  }
  if (parsed.preferences !== undefined) prepared.preferences = validateTrainingPreferences(parsed.preferences);
  if (parsed.personalProfile !== undefined) prepared.personalProfile = validatePersonalProfile(parsed.personalProfile);
  if (!Object.values(prepared).some(records => Array.isArray(records) && records.length) && !Object.keys(prepared.preferences || {}).length && !prepared.personalProfile) throw new Error('El respaldo esta vacio.');
  return prepared;
}
import { validateTrainingPreferences } from './training-preferences.js';
import { validatePersonalProfile } from './profile.js';
