import { assisted, comparisonKey, isComparableSetRecord, normalizeExercise, repTarget, setRecord } from './intelligence.js';
import { validAutoFinishMinutes } from './training-preferences.js';

const POUNDS_TO_KG = 0.45359237;
const poundsToWholeKg = value => Math.round(value * POUNDS_TO_KG);

export function autoFinishSession(session, now = Date.now()) {
  const minutes = session?.entries?._autoFinish?.limitMinutes;
  if (!session || session.finishedAt || session.deletedAt || !Number.isFinite(session.startedAt) || session.startedAt <= 0 ||
      !Number.isFinite(now) || session.entries?._autoFinish?.version !== 1 || !validAutoFinishMinutes(minutes) || minutes === 0) return null;
  const deadline = session.startedAt + minutes * 60000;
  if (now < deadline) return null;
  const updated = structuredClone(session);
  updated.finishedAt = deadline;
  updated.entries._autoFinish = { ...updated.entries._autoFinish, closedAt: now, reviewedAt: null };
  return updated;
}

export function bodyWeightReference(record, at, measures) {
  if (!['kg', 'lb'].includes(record?.unit) || !Number.isFinite(record.load) || record.load < 0 || !Number.isFinite(at)) return null;
  const measurement = measures.filter(item => !item.deletedAt && Number.isFinite(item.at) && item.at > 0 && item.at <= at &&
    Number.isFinite(item.values?.weight) && item.values.weight > 0).sort((first, second) => second.at - first.at)[0];
  if (!measurement) return null;
  const loadKg = record.unit === 'lb' ? record.load * POUNDS_TO_KG : record.load;
  return { weight: measurement.values.weight, at: measurement.at, loadKg,
    percent: Math.round(loadKg / measurement.values.weight * 100),
    ageDays: Math.floor((at - measurement.at) / 86400000) };
}

export function convertSessionLoadsToKg(session, sourceUnits, at = Date.now()) {
  return reviewSessionLoadUnits(session, sourceUnits, {}, at);
}

export function reviewSessionLoadUnits(session, sourceUnits, targetUnits = {}, at = Date.now()) {
  if (!session.finishedAt || session.deletedAt || !session.routineSnapshot || !Number.isFinite(at) || at <= 0 ||
      !sourceUnits || typeof sourceUnits !== 'object' || Array.isArray(sourceUnits)) {
    throw new Error('La conversion requiere una sesion finalizada, su plan original y unidades revisadas.');
  }
  if (!targetUnits || typeof targetUnits !== 'object' || Array.isArray(targetUnits) ||
      Object.entries(targetUnits).some(([id, unit]) => !Object.hasOwn(sourceUnits, id) || !['kg', 'lb'].includes(unit))) {
    throw new Error('Cada unidad de registro debe corresponder a un ejercicio revisado.');
  }
  const updated = structuredClone(session);
  const movements = session.routineSnapshot.blocks.flatMap(block => block.movements);
  const existing = updated.entries?._unitConversion;
  if (existing && (existing.version !== 1 || !['kg', 'lb', 'mixed'].includes(existing.target) || !existing.movements)) {
    throw new Error('Este registro tiene una conversion que necesita revision.');
  }
  let audit = existing || { version: 1, target: 'kg', at, movements: {} };
  for (const [movementId, sourceUnit] of Object.entries(sourceUnits)) {
    const targetUnit = targetUnits[movementId] || 'kg';
    const matches = movements.filter(movement => movement.id === movementId);
    if (!['kg', 'lb'].includes(sourceUnit) || matches.length !== 1 || matches[0].kind !== 'weight') {
      throw new Error('Cada unidad debe corresponder a un ejercicio de peso identificado sin ambiguedad.');
    }
    if (Object.hasOwn(audit.movements, movementId)) {
      if (audit.movements[movementId].sourceUnit !== sourceUnit) throw new Error('La unidad original no coincide con la conversion guardada.');
      if ((audit.movements[movementId].targetUnit || 'kg') !== targetUnit) throw new Error('Para cambiar la unidad de registro, usa el respaldo original; no reconviertas valores redondeados.');
      continue;
    }
    if (sourceUnit === 'kg' && targetUnit === 'lb') throw new Error('Para conservar lb usa los valores originales en lb, no una conversion previa redondeada.');
    const values = updated.entries?.[movementId];
    if (!Array.isArray(values)) continue;
    const choice = updated.entries._training?.choices?.[movementId];
    const records = updated.entries._training?.sets?.[movementId];
    const contradicts = unit => ['kg', 'lb'].includes(unit) && unit !== sourceUnit;
    if (contradicts(choice?.unit)) throw new Error('La unidad elegida contradice la referencia guardada del equipo.');
    const converted = values.map((value, index) => {
      if (value === '' || value === null || value === undefined || value === false) return value;
      if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) || !Number.isFinite(Number(value))) {
        throw new Error('Hay una carga que no se puede convertir sin revisarla.');
      }
      const record = records?.[index];
      if (record && (Number(record.load) !== Number(value) || contradicts(record.unit))) {
        throw new Error('La carga o unidad de la serie no coincide con sus metadatos.');
      }
      return sourceUnit === targetUnit ? value : String(poundsToWholeKg(Number(value)));
    });
    if (!values.some(value => typeof value === 'string' && value.trim() !== '')) continue;
    audit = { ...audit, movements: { ...audit.movements, [movementId]: {
      sourceUnit, targetUnit, values: structuredClone(values), choice: choice ? structuredClone(choice) : null,
      records: records ? structuredClone(records) : null,
      ...(sourceUnit !== targetUnit ? { rounding: 'nearest-kg' } : {})
    } } };
    updated.entries[movementId] = converted;
    if (choice) { choice.unit = targetUnit; if (sourceUnit !== targetUnit && Number.isFinite(choice.step)) choice.step = poundsToWholeKg(choice.step); }
    converted.forEach((value, index) => {
      const record = records?.[index];
      if (!record || typeof value !== 'string' || value.trim() === '') return;
      record.load = Number(value); record.unit = targetUnit;
      if (sourceUnit !== targetUnit && Number.isFinite(record.step)) record.step = poundsToWholeKg(record.step);
    });
  }
  if (Object.keys(audit.movements).length) {
    const units = new Set(Object.values(audit.movements).map(item => item.targetUnit || 'kg'));
    audit.target = units.size === 1 ? [...units][0] : 'mixed';
    updated.entries._unitConversion = audit;
  }
  return updated;
}

export function correctSessionWeight(session, movementId, index, value) {
  const values = session.entries?.[movementId];
  const movement = session.routineSnapshot?.blocks.flatMap(block => block.movements).find(item => item.id === movementId);
  if (!session.finishedAt || session.deletedAt || !Array.isArray(values) ||
      !Number.isInteger(index) || index < 0 || index >= values.length ||
      (movement && movement.kind !== 'weight') ||
      typeof values[index] !== 'string' || values[index].trim() === '' ||
      !Number.isFinite(Number(values[index])) || Number(values[index]) < 0) {
    throw new Error('Solo puedes corregir una serie de peso ya registrada en un entrenamiento finalizado.');
  }
  const weight = typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(weight) || !Number.isFinite(Number(weight))) {
    throw new Error('Introduce un peso válido, mayor o igual a cero. Puedes usar decimales.');
  }
  const updated = structuredClone(session);
  updated.entries[movementId][index] = weight;
  const record = updated.entries._training?.sets?.[movementId]?.[index];
  if (record && typeof record === 'object' && !Array.isArray(record)) record.load = Number(weight);
  return updated;
}

export function movementHistoryRows(movement, sessions, now = Date.now(), dayFor = session => session.routineSnapshot) {
  const rows = [];
  for (const session of sessions) {
    if (!session.finishedAt || session.deletedAt || !Number.isFinite(session.startedAt) || session.startedAt > now) continue;
    const matches = (dayFor(session)?.blocks || []).flatMap(block => block.movements)
      .filter(item => item.kind === movement.kind && normalizeExercise(item.name) === normalizeExercise(movement.name));
    const original = matches.find(item => item.id === movement.id) || (matches.length === 1 ? matches[0] : null);
    if (!original) continue;
    const values = session.entries?.[original.id];
    if (!Array.isArray(values)) continue;
    const sets = values.flatMap((value, index) => {
      const recorded = value === true || (typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value)));
      return recorded ? [{ value, index, record: setRecord(session, original.id, index) }] : [];
    });
    if (sets.length) rows.push({ session, movement: original, sets });
  }
  return rows.sort((first, second) => second.session.startedAt - first.session.startedAt);
}

export function movementLoadHistory(movement, sessions, now = Date.now()) {
  if (!repTarget(movement) || assisted(movement)) return [];
  const groups = new Map();
  for (const { session, movement: original, sets } of movementHistoryRows(movement, sessions, now)) {
    if (!repTarget(original) || assisted(original)) continue;
    for (const { index, record } of sets) {
      if (!isComparableSetRecord(record)) continue;
      const key = JSON.stringify([comparisonKey(original, record), record.reps]);
      if (!groups.has(key)) groups.set(key, { key, record, prescription: original.reps, note: original.note || '', points: new Map() });
      const group = groups.get(key);
      const previous = group.points.get(session.id);
      if (!previous || record.load > previous.load) {
        group.points.set(session.id, { sessionId: session.id, at: session.startedAt, load: record.load, index });
      }
    }
  }
  return [...groups.values()].map(group => ({
    ...group, points: [...group.points.values()].sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId))
  })).sort((a, b) => b.points.at(-1).at - a.points.at(-1).at || b.points.length - a.points.length);
}
