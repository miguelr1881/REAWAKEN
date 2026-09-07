import { trainingAchievements, sessionDuration } from '../js/progress.js';

export function runProgressTests() {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const now = new Date(2026, 8, 7, 12).getTime();
  const progressFor = session => session.progress;
  const make = (index, done = 25, total = 25) => ({ id: `trophy-${index}`, startedAt: now - index * 4 * 86400000, finishedAt: now - index * 4 * 86400000 + 1000, entries: {}, progress: { done, total } });
  const empty = trainingAchievements([], progressFor, 5, now);
  assert(empty.badges.length === 48 && empty.stages.length === 8, '48 trophies across eight stages');
  assert(new Set(empty.badges.map(badge => badge.id)).size === 48, 'stable unique trophy ids');
  assert(empty.current.index === 0 && empty.stages.filter(stage => stage.available).length === 1, 'only first stage initially available');
  assert(empty.badges.every(badge => !badge.unlocked && badge.value === 0), 'empty history earns nothing');
  assert(['start', 'five', 'twenty', 'hundred', 'complete', 'week', 'four-weeks'].every(id => empty.badges.some(badge => badge.id === id)), 'existing trophy ids preserved');
  const first = trainingAchievements([make(0)], progressFor, 5, now);
  assert(first.stages[0].count >= 3 && first.current.index === 1, 'one complete session starts with achievable rewards');
  const partial = trainingAchievements([make(0, 2, 25)], progressFor, 5, now);
  assert(partial.current.index === 0 && partial.badges.find(badge => badge.id === 'start').unlocked, 'partial session counts without forcing completion');
  const manySameDay = Array.from({ length: 20 }, (_, index) => ({ ...make(0), id: `same-${index}` }));
  const same = trainingAchievements(manySameDay, progressFor, 5, now);
  assert(same.week.value === 1 && !same.badges.find(badge => badge.id === 'week').unlocked, 'extra sessions do not fake training days');
  const excluded = trainingAchievements([{ ...make(0), finishedAt: null }, { ...make(0), deletedAt: now }, { ...make(0), startedAt: now + 10000 }, make(0, 0)], progressFor, 5, now);
  assert(excluded.badges.every(badge => !badge.unlocked), 'unfinished deleted future and empty sessions excluded');
  const history = Array.from({ length: 260 }, (_, index) => make(index));
  const all = trainingAchievements(history, progressFor, 1, now);
  assert(all.badges.every(badge => badge.unlocked) && all.current.title === 'Legado', 'full campaign achievable from normal accumulated sessions');
  assert(all.stages.every(stage => stage.completed) && all.badges.every(badge => badge.value <= badge.target), 'completed progress is bounded');
  assert(trainingAchievements(history, progressFor, 7, now).current.index >= 6, 'weekly goal trophies not mandatory for advancing');
  assert(trainingAchievements(history.slice(0, 1), progressFor, 1, now).current.index < all.current.index, 'deleting history recalculates stages');
  assert(sessionDuration({ ...make(0), entries: { _durationMinutes: 42 } }) === 42 * 60000, 'corrected duration preserved');
  assert(empty.stages.map(stage => stage.title).join(',') === 'Inicio,Base,Ritmo,Constancia,Consolidación,Dominio,Maestría,Legado', 'stage names describe progression');
  assert(empty.nextBadge.id === 'start' && empty.nextBadge.remainingText === 'Falta 1 sesión finalizada.', 'first target has clear remaining requirement');
  assert(partial.nextBadge.stage === partial.current.index && !partial.nextBadge.unlocked && partial.nextBadge.remaining > 0, 'next trophy belongs to current stage and remains attainable');
  assert(first.nextBadge.stage === 1, 'next target follows stage advancement');
  assert(all.nextBadge === null, 'completed collection has no fake next target');
  assert(same.badges.find(badge => badge.id === 'week').remainingText === 'Falta 1 semana con 5 días entrenados.', 'weekly requirement retains distinct-day goal');
  return { checks, result: 'PASS' };
}