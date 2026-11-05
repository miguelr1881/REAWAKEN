import { db } from '../js/db.js';
import { prepareBackup } from '../js/backup.js';
import { exerciseRatingKey } from '../js/exercise-ratings.js';

export async function runBackupRestoreTests() {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const snapshot = async () => JSON.stringify([await db.allSessions(), await db.allMeasures(), await db.allRoutines(), await db.allExercises()]);
  const original = { id: 'restore-session', dayId: 'day', startedAt: 100, finishedAt: 200, entries: {}, updatedAt: 10 };
  await db.putSessionRaw(original);
  await db.putMeasureRaw({ id: 'keep-measure', at: 100, values: { weight: 70 }, updatedAt: 10 });
  const before = await snapshot();
  const legacy = prepareBackup({ app: 'gymtrack', sessions: [original] });
  assert(legacy.sessions[0].notes === '' && legacy.exercises.length === 0, 'legacy backup without optional stores accepted');
  for (const invalidBackup of [
    { app: 'gymtrack', sessions: [original, null] },
    { app: 'gymtrack', sessions: [original, original] },
    { app: 'gymtrack', sessions: [{ ...original, entries: [] }] },
    { app: 'gymtrack', sessions: [original], measures: {} },
    { app: 'gymtrack', sessions: [original], version: 6 },
    { app: 'gymtrack', sessions: [original], routines: [{ id: 'broken', days: [null] }] }
  ]) {
    let invalidRejected = false;
    try { prepareBackup(invalidBackup); } catch { invalidRejected = true; }
    assert(invalidRejected && await snapshot() === before, 'invalid file rejected entirely without writes');
  }
  const batch = { sessions: [{ ...original, notes: 'restored' }], measures: [{ id: 'new-measure', at: 200, values: { weight: 71 } }],
    routines: [{ id: 'new-routine', days: [], active: false }], exercises: [{ id: 'new-exercise', name: 'Press' }] };
  const invalid = { ...batch, exercises: [{ id: 'invalid', name: 'Invalid', cannotClone: () => {} }] };
  let rejected = false;
  try { await db.restoreBackup(invalid); } catch { rejected = true; }
  assert(rejected, 'uncloneable final record rejects');
  assert(await snapshot() === before, 'synchronous failure rolls back earlier stores and overwritten session');

  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(record) {
    const request = put.call(this, record);
    if (this.name === 'exercises') request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  rejected = false;
  try { await db.restoreBackup(batch); } catch { rejected = true; } finally { IDBObjectStore.prototype.put = put; }
  assert(rejected, 'asynchronous transaction abort rejects');
  assert(await snapshot() === before, 'asynchronous abort rolls back every store');

  for (const failureType of ['quota', 'request']) {
    IDBObjectStore.prototype.put = function(record) {
      if (this.name === 'exercises' && failureType === 'quota') throw new DOMException('Simulated storage full', 'QuotaExceededError');
      if (this.name === 'exercises' && failureType === 'request') return this.transaction.objectStore('sessions').add(original);
      return put.call(this, record);
    };
    rejected = false;
    try { await db.restoreBackup(batch); } catch { rejected = true; } finally { IDBObjectStore.prototype.put = put; }
    assert(rejected && await snapshot() === before, `${failureType} failure rolls back entire merge`);
  }

  await db.restoreBackup(batch);
  assert((await db.getSession(original.id)).notes === 'restored', 'successful merge overwrites matching id');
  assert((await db.allMeasures()).length === 2, 'successful merge preserves unrelated rows');
  assert((await db.allRoutines()).length === 1 && (await db.allExercises()).length === 1, 'all stores committed');
  const rated = { name: 'Rated press', kind: 'weight', equipment: 'Machine A' };
  const otherRated = { name: 'Rated row', kind: 'weight', equipment: 'Machine B' };
  const ratingKey = exerciseRatingKey(rated);
  await Promise.all([db.updateExerciseRating(rated, 4), db.updateExerciseRating(otherRated, 5)]);
  const savedRatings = await db.getMeta('exerciseRatings');
  assert(savedRatings[ratingKey] === 4 && savedRatings[exerciseRatingKey(otherRated)] === 5, 'Concurrent changes to distinct ratings preserve both values');
  rejected = false;
  try { await db.updateExerciseRating(rated, 2, null); } catch { rejected = true; }
  assert(rejected && (await db.getMeta('exerciseRatings'))[ratingKey] === 4, 'Stale rating writes cannot overwrite another window');
  const ratedBackup = prepareBackup({ app: 'gymtrack', version: 5, sessions: [], exerciseRatings: { [ratingKey]: 3 } });
  await db.restoreBackup(ratedBackup);
  assert((await db.getMeta('exerciseRatings'))[ratingKey] === 3 && (await db.getMeta('exerciseRatings'))[exerciseRatingKey(otherRated)] === 5, 'Ratings backup merges atomically without deleting unrelated preferences');
  await db.updateExerciseRating(rated, null, 3);
  assert(!(ratingKey in await db.getMeta('exerciseRatings')), 'A rating can be cleared without deleting its exercise');
  const protectedRatings = JSON.stringify(await db.getMeta('exerciseRatings'));
  IDBObjectStore.prototype.put = function(record) {
    if (this.name === 'meta' && record.key === 'exerciseRatings') throw new DOMException('Synthetic quota', 'QuotaExceededError');
    return put.call(this, record);
  };
  rejected = false;
  try { await db.restoreBackup({ sessions: [{ ...original, notes: 'must roll back' }], exerciseRatings: { [ratingKey]: 5 } }); }
  catch { rejected = true; } finally { IDBObjectStore.prototype.put = put; }
  assert(rejected && (await db.getSession(original.id)).notes === 'restored' && JSON.stringify(await db.getMeta('exerciseRatings')) === protectedRatings, 'A failed ratings write rolls back the entire backup');
  const open = { ...original, id: 'open-session', finishedAt: null };
  await db.putSessionRaw(open);
  const withOpen = await snapshot();
  rejected = false;
  try { await db.restoreBackup(batch); } catch { rejected = true; }
  assert(rejected && await snapshot() === withOpen, 'open session blocks restoration without changes');
  return { checks, result: 'PASS' };
}