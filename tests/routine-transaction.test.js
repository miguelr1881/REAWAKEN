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
  return { checks, result: 'PASS' };
}