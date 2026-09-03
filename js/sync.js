/**
 * Sincronización con Supabase vía REST (sin SDK, para no cargar dependencias
 * en una app que tiene que funcionar sin señal en el gym).
 *
 * Estrategia offline-first: IndexedDB manda. Al sincronizar se bajan todas las
 * filas remotas, se fusionan con las locales quedándose con el `updatedAt` más
 * reciente, y se suben las locales que van adelante. El volumen es de unas
 * cuantas decenas de filas, así que una pasada completa es más simple y segura
 * que llevar una cola de cambios.
 */

import { db } from './db.js';

const state = {
  url: null,
  anonKey: null,
  session: null   // { access_token, refresh_token, expires_at, user }
};

const listeners = new Set();
export const onSyncChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => fn(status()));

export function status() {
  return {
    configured: Boolean(state.url && state.anonKey),
    signedIn: Boolean(state.session?.access_token),
    email: state.session?.user?.email || null,
    online: navigator.onLine
  };
}

export async function loadConfig() {
  const cfg = await db.getMeta('supabase');
  if (cfg?.url && cfg?.anonKey) {
    state.url = cfg.url.replace(/\/+$/, '');
    state.anonKey = cfg.anonKey;
  }
  state.session = (await db.getMeta('supabaseSession')) || null;
  emit();
  return status();
}

export async function saveConfig(url, anonKey) {
  const raw = String(url || '').trim().replace(/\s+/g, '');
  if (!raw) throw new Error('Falta la URL del proyecto');

  // Se acepta la URL tal cual la muestra el dashboard, con o sin https, con o
  // sin "/rest/v1/". Solo interesa el dominio.
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).host;
  } catch {
    throw new Error(`No pude leer esa URL: "${raw.slice(0, 40)}"`);
  }
  if (!/\.supabase\.(co|in)$/i.test(host)) {
    throw new Error(`El dominio debe terminar en .supabase.co · recibí "${host}"`);
  }

  const key = String(anonKey || '').trim();
  if (!key) throw new Error('Falta la clave publishable');

  state.url = `https://${host.toLowerCase()}`;
  state.anonKey = key;
  await db.setMeta('supabase', { url: state.url, anonKey: state.anonKey });
  emit();
}

export async function forgetConfig() {
  state.url = state.anonKey = state.session = null;
  await db.setMeta('supabase', null);
  await db.setMeta('supabaseSession', null);
  emit();
}

/* ============================== Auth ============================== */

async function authFetch(path, body) {
  const res = await fetch(`${state.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: state.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || 'Error de autenticación');
  return data;
}

async function storeSession(data) {
  state.session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    user: data.user
  };
  await db.setMeta('supabaseSession', state.session);
  emit();
}

export async function signUp(email, password) {
  const data = await authFetch('signup', { email, password });
  if (data.access_token) await storeSession(data);
  return data;
}

export async function signIn(email, password) {
  await storeSession(await authFetch('token?grant_type=password', { email, password }));
}

export async function signOut() {
  state.session = null;
  await db.setMeta('supabaseSession', null);
  emit();
}

async function accessToken() {
  if (!state.session) throw new Error('Inicia sesión primero');
  if (Date.now() < state.session.expires_at - 60000) return state.session.access_token;
  await storeSession(await authFetch('token?grant_type=refresh_token', { refresh_token: state.session.refresh_token }));
  return state.session.access_token;
}

/* ============================== REST ============================== */

async function rest(table, { method = 'GET', query = '', body, prefer } = {}) {
  const token = await accessToken();
  const headers = {
    apikey: state.anonKey,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${state.url}/rest/v1/${table}${query}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Supabase respondió ${res.status}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/* ============================== Mapeo ============================== */

const toRemote = {
  sessions: (s, uid) => ({
    id: s.id, user_id: uid, day_id: s.dayId,
    started_at: s.startedAt, finished_at: s.finishedAt ?? null,
    entries: s.entries, notes: s.notes ?? null,
    deleted_at: s.deletedAt ?? null, updated_at: s.updatedAt || s.startedAt
  }),
  measures: (m, uid) => ({
    id: m.id, user_id: uid, at: m.at, values: m.values,
    deleted_at: m.deletedAt ?? null, updated_at: m.updatedAt || m.at
  }),
  routines: (r, uid) => ({
    id: r.id, user_id: uid, name: r.name, days: r.days,
    active: Boolean(r.active), updated_at: r.updatedAt || Date.now()
  })
};

const toLocal = {
  sessions: (r) => ({
    id: r.id, dayId: r.day_id, startedAt: Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    entries: r.entries || {}, notes: r.notes || '',
    deletedAt: r.deleted_at ? Number(r.deleted_at) : undefined,
    updatedAt: Number(r.updated_at)
  }),
  measures: (r) => ({
    id: r.id, at: Number(r.at), values: r.values || {},
    deletedAt: r.deleted_at ? Number(r.deleted_at) : undefined,
    updatedAt: Number(r.updated_at)
  }),
  routines: (r) => ({ id: r.id, name: r.name, days: r.days || [], active: r.active, updatedAt: Number(r.updated_at) })
};

const readers = {
  sessions: () => db.allSessions(),
  measures: () => db.allMeasures(),
  routines: () => db.allRoutines()
};

const writers = {
  sessions: (r) => db.putSessionRaw(r),
  measures: (r) => db.putMeasureRaw(r),
  routines: (r) => db.putRoutineRaw(r)
};

/* ============================== Sincronización ============================== */

async function syncTable(table, uid) {
  const remoteRows = (await rest(table, { query: `?select=*&user_id=eq.${uid}` })) || [];
  const remote = new Map(remoteRows.map(r => [r.id, toLocal[table](r)]));
  const local = new Map((await readers[table]()).map(r => [r.id, r]));

  let pulled = 0;
  for (const [id, rec] of remote) {
    const mine = local.get(id);
    if (!mine || (rec.updatedAt || 0) > (mine.updatedAt || 0)) {
      await writers[table](rec);
      local.set(id, rec);
      pulled++;
    }
  }

  const toPush = [];
  for (const [id, rec] of local) {
    const theirs = remote.get(id);
    if (!theirs || (rec.updatedAt || 0) > (theirs.updatedAt || 0)) toPush.push(toRemote[table](rec, uid));
  }
  if (toPush.length) {
    await rest(table, { method: 'POST', body: toPush, prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  return { pulled, pushed: toPush.length };
}

export async function syncAll() {
  if (!status().configured) throw new Error('Configura Supabase primero');
  if (!status().signedIn) throw new Error('Inicia sesión primero');
  if (!navigator.onLine) throw new Error('Sin conexión');

  const uid = state.session.user.id;
  const result = { pulled: 0, pushed: 0 };
  for (const table of ['routines', 'sessions', 'measures']) {
    const r = await syncTable(table, uid);
    result.pulled += r.pulled;
    result.pushed += r.pushed;
  }
  await db.setMeta('lastSync', Date.now());
  emit();
  return result;
}

/** Sincroniza sin ruido: los errores no deben interrumpir un entrenamiento. */
export async function syncQuietly() {
  try {
    if (status().configured && status().signedIn && navigator.onLine) return await syncAll();
  } catch {
    // Se reintenta en la siguiente apertura.
  }
  return null;
}
