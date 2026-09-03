// El identificador se mantiene desde la primera versión: cambiarlo borraría los datos guardados.
const DB_NAME = 'gymtrack';
const DB_VERSION = 3;
const STORE_SESSIONS = 'sessions';
const STORE_META = 'meta';
const STORE_MEASURES = 'measures';
const STORE_ROUTINES = 'routines';

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
