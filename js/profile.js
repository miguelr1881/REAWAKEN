import { PROFILE } from './routine.js';

export function validProfileDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && date.getFullYear() >= 1900 && date.getFullYear() <= 2100 &&
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === value;
}

export function normalizeProfile(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const text = (key, fallback, max) => typeof source[key] === 'string' ? source[key].trim().slice(0, max) : fallback;
  return {
    name: text('name', PROFILE.name, 80) || PROFILE.name,
    sport: text('sport', PROFILE.sport, 60),
    coach: text('coach', PROFILE.coach, 80),
    daysPerWeek: Number.isInteger(source.daysPerWeek) && source.daysPerWeek >= 1 && source.daysPerWeek <= 7 ? source.daysPerWeek : PROFILE.daysPerWeek,
    routineChangeDate: source.routineChangeDate === '' || validProfileDate(source.routineChangeDate) ? source.routineChangeDate : PROFILE.routineChangeDate
  };
}

export function monthlyInBody(measures, now = new Date()) {
  const recorded = measures.some(measure => {
    if (measure.deletedAt) return false;
    const date = new Date(measure.at);
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  });
  return { due: !recorded, next: new Date(now.getFullYear(), now.getMonth() + (recorded ? 1 : 0), 1, 12) };
}