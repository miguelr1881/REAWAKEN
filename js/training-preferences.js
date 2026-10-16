export const DEFAULT_TRAINING_PREFERENCES = Object.freeze({ restSeconds: 45, keepScreenAwake: false });

export function validateTrainingPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Las preferencias de entrenamiento no son válidas.');
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_TRAINING_PREFERENCES, key))) {
    throw new Error('Estas preferencias requieren una versión más reciente de la app.');
  }
  if (Object.hasOwn(value, 'restSeconds') && (!Number.isInteger(value.restSeconds) || value.restSeconds < 1 || value.restSeconds > 3600)) {
    throw new Error('El descanso debe ser un número entero entre 1 y 3600 segundos.');
  }
  if (Object.hasOwn(value, 'keepScreenAwake') && typeof value.keepScreenAwake !== 'boolean') {
    throw new Error('La preferencia de pantalla no es válida.');
  }
  return { ...value };
}

export function trainingPreferences(value) {
  return { ...DEFAULT_TRAINING_PREFERENCES, ...validateTrainingPreferences(value ?? {}) };
}

export function createScreenWakeLock(wanted, onStatus) {
  let lock = null, pending = null, revision = 0;
  const needed = () => wanted() && document.visibilityState === 'visible';
  async function update() {
    if (!needed()) {
      revision++;
      const previous = lock;
      lock = null;
      if (previous && !previous.released) {
        try { await previous.release(); }
        catch (error) { console.warn('No se pudo liberar la pantalla activa.', error); }
      }
      onStatus('inactive');
      return;
    }
    if (!navigator.wakeLock) { onStatus('unsupported'); return; }
    if (lock && !lock.released) return;
    if (pending) return pending;
    const current = ++revision;
    onStatus('requesting');
    pending = navigator.wakeLock.request('screen').then(async acquired => {
      if (current !== revision || !needed()) { await acquired.release(); return; }
      lock = acquired;
      onStatus('active');
      acquired.addEventListener('release', () => {
        if (lock === acquired) { lock = null; onStatus('released'); }
      });
    }).catch(error => {
      console.warn('El navegador no permitió mantener la pantalla activa.', error);
      onStatus('unavailable');
    }).finally(() => {
      pending = null;
      if (current !== revision && needed()) update();
    });
    return pending;
  }
  document.addEventListener('visibilitychange', update);
  return { update };
}
