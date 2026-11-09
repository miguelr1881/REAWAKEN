import { db } from '../js/db.js';

export async function runRoutineTransactionTests(api) {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const snapshot = async () => JSON.stringify([await db.allRoutines(), await db.allSessions(), await db.allExercises()]);
  const day = { id: 'day-a', label: 'Dia A', title: 'Fuerza', blocks: [{ id: 'block-a', sets: 3, movements: [{ id: 'move-a', name: 'Press', reps: '10', kind: 'weight' }] }] };
  for (const id of ['plan-a', 'plan-b', 'plan-c']) {
    await db.putRoutineRaw({ id, name: id, active: id === 'plan-a', source: 'manual', days: [day], updatedAt: 100 });
  }
  await db.putSessionRaw({ id: 'history', dayId: day.id, startedAt: 100, finishedAt: 200, entries: {}, updatedAt: 100 });
  await api.loadAll(); await api.loadRoutine();
  const before = await snapshot();
  const put = IDBObjectStore.prototype.put;
  for (const asynchronous of [false, true]) {
    IDBObjectStore.prototype.put = function(record) {
      if (!asynchronous && this.name === 'routines' && record.id === 'plan-b') throw new DOMException('Simulated full storage', 'QuotaExceededError');
      const request = put.call(this, record);
      if (asynchronous && this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
    try { await api.activateRoutine('plan-b'); } finally { IDBObjectStore.prototype.put = put; }
    assert(await snapshot() === before, 'failed activation changed persistent data');
    assert(api.state.activeRoutineId === 'plan-a', 'failed activation changed UI state');
  }
  await api.activateRoutine('plan-b');
  assert((await db.allRoutines()).filter(record => record.active).map(record => record.id).join() === 'plan-b', 'activation not exclusive');
  assert(JSON.stringify((await db.getSession('history')).routineSnapshot) === JSON.stringify(day), 'history snapshot lost');
  await Promise.all([api.activateRoutine('plan-a'), api.activateRoutine('plan-c')]);
  assert((await db.allRoutines()).filter(record => record.active).length === 1, 'concurrent activation produced multiple active plans');
  await db.putSessionRaw({ id: 'open', dayId: day.id, startedAt: 300, finishedAt: null, entries: {}, updatedAt: 100 });
  const openBefore = await snapshot();
  await api.activateRoutine('plan-b');
  assert(await snapshot() === openBefore, 'persisted session unseen by UI did not block activation');
  await db.deleteSession('open');
  await db.putRoutine({ ...(await db.allRoutines()).find(record => record.id === 'plan-b'), archived: true, active: false });
  const archivedBefore = await snapshot();
  await api.activateRoutine('plan-b');
  assert(await snapshot() === archivedBefore, 'stale UI activated archived plan');
  await api.loadAll(); await api.loadRoutine();
  const saveBefore = await snapshot();
  const stateBefore = JSON.stringify([api.state.routine, api.state.sessions, api.state.exercises]);
  IDBObjectStore.prototype.put = function(record) {
    if (this.name === 'exercises') throw new DOMException('Simulated full storage', 'QuotaExceededError');
    return put.call(this, record);
  };
  let rejected = false;
  try { await api.saveRoutine([day], 'Nuevo ciclo', true); } catch { rejected = true; }
  finally { IDBObjectStore.prototype.put = put; }
  assert(rejected && await snapshot() === saveBefore, 'exercise failure left a partial cycle save');
  assert(JSON.stringify([api.state.routine, api.state.sessions, api.state.exercises]) === stateBefore, 'failed save changed memory');
  await api.saveRoutine([day], 'Nuevo ciclo', true);
  const saved = await db.allRoutines();
  assert(saved.filter(record => record.active).length === 1 && saved.find(record => record.active).name === 'Nuevo ciclo', 'successful cycle save lost activation');
  assert(saved.some(record => record.archived && record.source === 'cycle'), 'previous cycle not archived');
  assert((await db.allExercises()).some(record => record.name === 'Press'), 'exercise not saved with plan');
  const historic = JSON.stringify((await db.getSession('history')).routineSnapshot);
  await db.putSessionRaw({ id: 'live', dayId: day.id, startedAt: 500, finishedAt: null, entries: { 'move-a': ['30', '', ''] }, routineSnapshot: day, updatedAt: 100 });
  await api.loadAll();
  const liveBefore = JSON.stringify(await db.getSession('live'));
  api.state.session.entries['move-a'][0] = '35';
  await api.saveRoutine([{ ...day, title: 'Plan editado' }], 'Edicion actual');
  assert(api.state.session.entries['move-a'][0] === '35', 'refresh discarded pending in-memory weight');
  assert(JSON.stringify(await db.getSession('live')) === liveBefore, 'editing current plan modified open workout');
  assert(JSON.stringify((await db.getSession('history')).routineSnapshot) === historic, 'editing plan modified historical snapshot');
  const sharedBefore = (await db.allExercises()).find(record => record.name === 'Press');
  await db.putExerciseRaw({ ...sharedBefore, favorite: true, gym: 'Mi gym', tags: ['Conservar'], equipment: 'Maquina propia' });
  await db.putRoutineRaw({ id: 'plan-imported', name: 'Rutina #2', active: false, source: 'import', days: [day], updatedAt: 100 });
  const plansBeforeRebuild = JSON.stringify(await db.allRoutines());
  const sessionsBeforeRebuild = JSON.stringify(await db.allSessions());
  await api.loadRoutine();
  const sharedAfter = (await db.allExercises()).find(record => record.id === sharedBefore.id);
  assert(sharedAfter.importedRoutineIds.includes('plan-imported') && sharedAfter.createdRoutineIds.includes('plan-a'), 'shared exercise lost one of its routine origins');
  assert(sharedAfter.favorite && sharedAfter.gym === 'Mi gym' && sharedAfter.tags.join() === 'Conservar' && sharedAfter.equipment === 'Maquina propia', 'linking a second routine rewrote personal exercise details');
  assert(JSON.stringify(await db.allRoutines()) === plansBeforeRebuild && JSON.stringify(await db.allSessions()) === sessionsBeforeRebuild, 'library rebuild changed routine identity, activation or workout history');
  const rebuilt = await snapshot();
  await api.loadRoutine();
  assert(await snapshot() === rebuilt, 'routine provenance rebuild is not idempotent');
  const variantDay = structuredClone(day);
  variantDay.blocks[0].movements[0].equipment = 'Mancuernas';
  variantDay.blocks[0].movements[0].note = 'Variante inclinada';
  await db.putRoutineRaw({ id: 'plan-variant', name: 'Variante', active: false, source: 'import', days: [variantDay], updatedAt: 100 });
  await api.loadRoutine();
  const variants = (await db.allExercises()).filter(record => record.name === 'Press');
  assert(variants.length === 2 && variants.some(record => record.equipment === 'Mancuernas' && record.note === 'Variante inclinada' && record.importedRoutineIds.includes('plan-variant')), 'explicit equipment variant was merged into an incompatible card');
  assert(!(await db.getExercise(sharedBefore.id)).importedRoutineIds.includes('plan-variant'), 'incompatible equipment received a false routine origin');
  const variantsBefore = await snapshot();
  await api.loadRoutine();
  assert(await snapshot() === variantsBefore, 'rebuilding explicit variants creates duplicates');
  const personalCard = { id: 'shared-personal', name: 'Polea compartida', kind: 'weight', equipment: '', source: 'private', sources: ['private'], favorite: true, updatedAt: 100 };
  await db.putExerciseRaw(personalCard);
  const importedDay = { id: 'imported-day', label: 'Nuevo', blocks: [{ id: 'imported-block', sets: 3, movements: [{ id: 'imported-movement', name: personalCard.name, kind: 'weight', reps: '10', equipment: 'Polea', note: 'Indicacion solo del nuevo plan' }] }] };
  api.state.draft = [importedDay];
  api.state.draftRoutineId = 'new-import';
  api.state.draftBaseline = { id: 'new-import', revision: null };
  api.state.draftActivate = false;
  api.state.draftSource = 'import';
  const sessionsBeforeImport = JSON.stringify(await db.allSessions());
  const routinesBeforeImport = await db.allRoutines();
  await api.saveRoutine([importedDay], 'Rutina importada nueva');
  const linkedCard = await db.getExercise(personalCard.id);
  assert(linkedCard.equipment === '' && linkedCard.note === undefined && linkedCard.favorite, 'saving an imported routine enriched an existing personal card with plan-specific details');
  assert(linkedCard.importedRoutineIds.includes('new-import') && linkedCard.sources.includes('private'), 'imported routine lost shared-card provenance');
  assert(JSON.stringify(await db.allSessions()) === sessionsBeforeImport, 'inactive import changed workout history or pending session');
  const afterImport = await db.allRoutines();
  assert(routinesBeforeImport.every(record => JSON.stringify(afterImport.find(current => current.id === record.id)) === JSON.stringify(record)) && afterImport.find(record => record.id === 'new-import').active === false, 'inactive import changed existing plans or activation');
  return { checks, result: 'PASS' };
}