import { PROFILE } from './routine.js';

export const EMPTY_PROFILE = {
  name: '',
  sport: '',
  coach: '',
  daysPerWeek: 3,
  routineChangeDate: ''
};

export function validProfileDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && date.getFullYear() >= 1900 && date.getFullYear() <= 2100 &&
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === value;
}

export function normalizeProfile(value = {}, fallback = PROFILE) {
  const source = value && typeof value === 'object' ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : PROFILE;
  const text = (key, defaultValue, max) => typeof source[key] === 'string' ? source[key].trim().slice(0, max) : defaultValue;
  return {
    name: text('name', base.name, 80),
    sport: text('sport', base.sport, 60),
    coach: text('coach', base.coach, 80),
    daysPerWeek: Number.isInteger(source.daysPerWeek) && source.daysPerWeek >= 1 && source.daysPerWeek <= 7 ? source.daysPerWeek : base.daysPerWeek,
    routineChangeDate: source.routineChangeDate === '' || validProfileDate(source.routineChangeDate) ? source.routineChangeDate : base.routineChangeDate
  };
}

export function validatePersonalProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 ||
      !Number.isInteger(value.daysPerWeek) || value.daysPerWeek < 1 || value.daysPerWeek > 7 ||
      (value.sport !== undefined && (typeof value.sport !== 'string' || value.sport.trim().length > 60)) ||
      (value.coach !== undefined && (typeof value.coach !== 'string' || value.coach.trim().length > 80)) ||
      (value.routineChangeDate !== undefined && (typeof value.routineChangeDate !== 'string' ||
        (value.routineChangeDate && !validProfileDate(value.routineChangeDate))))) {
    throw new Error('El perfil del respaldo no es válido. Revisa nombre, días y fecha.');
  }
  return { ...value, ...normalizeProfile(value, EMPTY_PROFILE) };
}

export function monthlyInBody(measures, now = new Date()) {
  const recorded = measures.some(measure => {
    if (measure.deletedAt) return false;
    const date = new Date(measure.at);
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  });
  return { due: !recorded, next: new Date(now.getFullYear(), now.getMonth() + (recorded ? 1 : 0), 1, 12) };
}