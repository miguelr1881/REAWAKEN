import { backupActiveRoutines } from './backup.js';
import { trainingPreferences, validateTrainingPreferences } from './training-preferences.js';
import { validatePersonalProfile } from './profile.js';

// El identificador se mantiene desde la primera versión: cambiarlo borraría los datos guardados.
const DB_NAME = 'gymtrack';
const DB_VERSION = 4;
const STORE_SESSIONS = 'sessions';
const STORE_META = 'meta';
const STORE_MEASURES = 'measures';
const STORE_ROUTINES = 'routines';
const STORE_EXERCISES = 'exercises';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const s = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        s.createIndex('byDate', 'startedAt');
        s.createIndex('byDay', 'dayId');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_MEASURES)) {
        const m = db.createObjectStore(STORE_MEASURES, { keyPath: 'id' });
        m.createIndex('byDate', 'at');
      }
      if (!db.objectStoreNames.contains(STORE_ROUTINES)) {
        db.createObjectStore(STORE_ROUTINES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_EXERCISES)) {
        db.createObjectStore(STORE_EXERCISES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** Marca de tiempo de la última escritura: es lo que resuelve conflictos al sincronizar. */
function stamp(record) {
  return { ...record, updatedAt: Date.now() };
}

/**
 * Borrado lógico: se conserva la fila con `deletedAt` para que el borrado viaje
 * a los demás dispositivos. Si se borrara de verdad, la siguiente sincronización
 * la volvería a bajar del servidor.
 */
async function softDelete(store, id) {
  const rec = await tx(store, 'readonly', s => s.get(id));
  if (!rec || rec.deletedAt) return;
  return tx(store, 'readwrite', s => s.put(stamp({ ...rec, deletedAt: Date.now() })));
}

async function softDeleteAll(store) {
  const all = (await tx(store, 'readonly', s => s.getAll())) || [];
  for (const rec of all) {
    if (!rec.deletedAt) await tx(store, 'readwrite', s => s.put(stamp({ ...rec, deletedAt: Date.now() })));
  }
}

export const db = {
  savePersonalProfile: async (profile, { routineId, expectedRoutine, expectedProfile }) => {
    const updated = validatePersonalProfile(profile);
    const connection = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = connection.transaction([STORE_ROUTINES, STORE_META], 'readwrite');
      let failure, loaded = 0;
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure || transaction.error || new Error('No se pudo guardar el perfil.'));
      transaction.onerror = () => { failure ||= transaction.error; };
      const routines = transaction.objectStore(STORE_ROUTINES).getAll();
      const personal = transaction.objectStore(STORE_META).get('personalProfile');
      const commit = () => {
        if (++loaded !== 2) return;
        try {
          const active = backupActiveRoutines(routines.result, []);
          const target = active[0];
          if (active.length > 1 || (target?.id || null) !== routineId ||
              (target ? JSON.stringify(target) : null) !== expectedRoutine ||
              JSON.stringify(personal.result?.value) !== JSON.stringify(expectedProfile)) {
            throw new Error('El perfil o la rutina cambió en otra ventana. Vuelve a abrir el formulario.');
          }
          transaction.objectStore(STORE_META).put({ key: 'personalProfile', value: { ...personal.result?.value, ...updated } });
          if (target) transaction.objectStore(STORE_ROUTINES).put(stamp({ ...target, profile: { ...target.profile, ...updated } }));
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      routines.onsuccess = personal.onsuccess = commit;
    });
  },

  updateSession: async (expected, update) => {
    const connection = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = connection.transaction(STORE_SESSIONS, 'readwrite');
      const store = transaction.objectStore(STORE_SESSIONS);
      let failure;
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || transaction.error || new Error('No se pudo guardar el entrenamiento.'));
      transaction.onerror = () => { failure ||= transaction.error; };
      const request = store.get(expected.id);
      request.onsuccess = () => {
        try {
          const current = request.result;
          if (!current || current.deletedAt || !current.finishedAt || JSON.stringify(current) !== JSON.stringify(expected)) {
            const error = new Error('Este entrenamiento cambió en otra ventana o ya no está disponible. Vuelve a abrirlo antes de corregirlo.');
            error.name = 'SessionConflictError';
            throw error;
          }
          const updated = update(current);
          if (!updated || typeof updated.then === 'function' || updated.id !== current.id) {
            throw new Error('La corrección debe conservar el entrenamiento original.');
          }
          result = stamp(updated);
          store.put(result);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
    });
  },

  updateRoutineLibrary: async (update) => {
    const connection = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = connection.transaction([STORE_ROUTINES, STORE_SESSIONS, STORE_EXERCISES, STORE_META], 'readwrite');
      let failure;
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || transaction.error || new Error('No se pudo guardar la biblioteca.'));
      transaction.onerror = () => { failure ||= transaction.error; };
      const current = {};
      const stores = [STORE_ROUTINES, STORE_SESSIONS, STORE_EXERCISES];
      const sources = [...stores, 'personalProfile'];
      for (const store of sources) {
        const request = store === 'personalProfile' ? transaction.objectStore(STORE_META).get('personalProfile') : transaction.objectStore(store).getAll();
        request.onsuccess = () => {
          current[store] = store === 'personalProfile' ? request.result?.value : request.result;
          if (Object.keys(current).length !== sources.length) return;
          try {
            const changes = update(current);
            if (!changes || typeof changes.then === 'function') throw new Error('La actualizacion debe ser sincrona.');
            result = changes.result;
            const updatedAt = Date.now();
            for (const name of stores) {
              for (const record of changes[name] || []) transaction.objectStore(name).put({ ...record, updatedAt });
            }
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
      }
    });
  },

  restoreBackup: async ({ sessions = [], measures = [], routines = [], exercises = [], preferences, personalProfile }, { activeRoutineId = null, expectedRoutines, expectedState } = {}) => {
    if (preferences !== undefined) validateTrainingPreferences(preferences);
    if (personalProfile !== undefined) validatePersonalProfile(personalProfile);
    const connection = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = connection.transaction([STORE_SESSIONS, STORE_MEASURES, STORE_ROUTINES, STORE_EXERCISES, STORE_META], 'readwrite');
      let failure;
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure || transaction.error || new Error('No se pudo completar la restauracion'));
      transaction.onerror = () => { failure ||= transaction.error; };
      const existing = transaction.objectStore(STORE_SESSIONS).getAll();
      const library = transaction.objectStore(STORE_ROUTINES).getAll();
      const currentPreferences = transaction.objectStore(STORE_META).get('trainingPreferences');
      const currentProfile = transaction.objectStore(STORE_META).get('personalProfile');
      const currentMeasures = transaction.objectStore(STORE_MEASURES).getAll();
      const currentExercises = transaction.objectStore(STORE_EXERCISES).getAll();
      let loaded = 0;
      const commit = () => {
        if (++loaded !== 6) return;
        try {
          if (existing.result.some(session => !session.finishedAt && !session.deletedAt)) {
            throw new Error('Termina la sesion de entrenamiento antes de importar un respaldo.');
          }
          if (expectedRoutines && JSON.stringify(library.result) !== JSON.stringify(expectedRoutines)) {
            throw new Error('La biblioteca cambió mientras revisabas el respaldo. Vuelve a importarlo para revisar los cambios.');
          }
          if (expectedState && (JSON.stringify(existing.result) !== JSON.stringify(expectedState.sessions) ||
              JSON.stringify(currentMeasures.result) !== JSON.stringify(expectedState.measures) ||
              JSON.stringify(currentExercises.result) !== JSON.stringify(expectedState.exercises) ||
              JSON.stringify(currentPreferences.result?.value) !== JSON.stringify(expectedState.preferences) ||
              JSON.stringify(currentProfile.result?.value) !== JSON.stringify(expectedState.personalProfile))) {
            throw new Error('Los datos locales cambiaron mientras revisabas el respaldo. Vuelve a importarlo; no se sobrescribió nada.');
          }
          const candidates = backupActiveRoutines(library.result, routines);
          if (candidates.length > 1 && !activeRoutineId) {
            throw new Error('El respaldo dejaría varias rutinas activas. Elige cuál conservar activa antes de importar.');
          }
          if (activeRoutineId && !candidates.some(record => record.id === activeRoutineId)) {
            throw new Error('La rutina elegida ya no es una opción válida. Vuelve a revisar el respaldo.');
          }
          const routineChanges = new Map(routines.map(record => [record.id, record]));
          if (activeRoutineId) {
            for (const candidate of candidates) routineChanges.set(candidate.id, { ...candidate, active: candidate.id === activeRoutineId });
          }
          if (personalProfile !== undefined) {
            const active = backupActiveRoutines(library.result, [...routineChanges.values()]);
            if (active.length === 1) {
              const target = active[0];
              routineChanges.set(target.id, { ...target, profile: { ...target.profile, ...validatePersonalProfile(personalProfile) } });
            }
          }
          const updatedAt = Date.now();
          for (const [store, records] of [[STORE_SESSIONS, sessions], [STORE_MEASURES, measures], [STORE_ROUTINES, [...routineChanges.values()]], [STORE_EXERCISES, exercises]]) {
            for (const record of records) transaction.objectStore(store).put({ ...record, updatedAt });
          }
          if (preferences !== undefined) {
            transaction.objectStore(STORE_META).put({ key: 'trainingPreferences',
              value: trainingPreferences({ ...currentPreferences.result?.value, ...preferences }) });
          }
          if (personalProfile !== undefined) transaction.objectStore(STORE_META).put({ key: 'personalProfile', value: validatePersonalProfile(personalProfile) });
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      existing.onsuccess = library.onsuccess = currentPreferences.onsuccess = currentProfile.onsuccess = currentMeasures.onsuccess = currentExercises.onsuccess = commit;
    });
  },

  putSession: (s) => tx(STORE_SESSIONS, 'readwrite', st => st.put(stamp(s))),
  putSessionRaw: (s) => tx(STORE_SESSIONS, 'readwrite', st => st.put(s)),
  getSession: (id) => tx(STORE_SESSIONS, 'readonly', st => st.get(id)),
  deleteSession: (id) => softDelete(STORE_SESSIONS, id),
  allSessions: () => tx(STORE_SESSIONS, 'readonly', st => st.getAll()),
  clearSessions: () => softDeleteAll(STORE_SESSIONS),

  putMeasure: (m) => tx(STORE_MEASURES, 'readwrite', st => st.put(stamp(m))),
  putMeasureRaw: (m) => tx(STORE_MEASURES, 'readwrite', st => st.put(m)),
  deleteMeasure: (id) => softDelete(STORE_MEASURES, id),
  allMeasures: () => tx(STORE_MEASURES, 'readonly', st => st.getAll()),
  clearMeasures: () => softDeleteAll(STORE_MEASURES),

  putRoutine: (r) => tx(STORE_ROUTINES, 'readwrite', st => st.put(stamp(r))),
  putRoutineRaw: (r) => tx(STORE_ROUTINES, 'readwrite', st => st.put(r)),
  deleteRoutine: (id) => tx(STORE_ROUTINES, 'readwrite', st => st.delete(id)),
  allRoutines: () => tx(STORE_ROUTINES, 'readonly', st => st.getAll()),

  putExercise: (exercise) => tx(STORE_EXERCISES, 'readwrite', st => st.put(stamp(exercise))),
  putExerciseRaw: (exercise) => tx(STORE_EXERCISES, 'readwrite', st => st.put(exercise)),
  getExercise: (id) => tx(STORE_EXERCISES, 'readonly', st => st.get(id)),
  deleteExercise: (id) => softDelete(STORE_EXERCISES, id),
  allExercises: () => tx(STORE_EXERCISES, 'readonly', st => st.getAll()),

  getMeta: (key) => tx(STORE_META, 'readonly', st => st.get(key)).then(r => r?.value),
  setMeta: (key, value) => tx(STORE_META, 'readwrite', st => st.put({ key, value }))
};

/** Pide a iOS/Safari que marque el almacenamiento como persistente (no evictable). */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  const already = await navigator.storage.persisted?.();
  if (already) return { supported: true, persisted: true };
  const persisted = await navigator.storage.persist();
  return { supported: true, persisted };
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}
