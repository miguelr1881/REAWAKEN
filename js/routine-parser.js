/**
 * Parser del plan de entrenamiento que entrega el coach.
 *
 * No pretende acertar el 100%: su trabajo es ahorrarte teclear. Lo que salga
 * pasa siempre por el editor, donde confirmas cada bloque antes de guardar.
 *
 * Formato de la tabla del coach:
 *   Piso: DIA1 Fuerza y potencia (tren inferior)   Se.  Reps
 *   1     Tuck jumps + extensión de rodilla         4    10_10+12+15
 *   1 o 2 Sentadillas EN SMITH : [fuerza]           4    5 a 6 rps
 *
 * Convención de la columna Reps:
 *   "_"  separa ejercicios distintos del mismo bloque (superserie)
 *   "+"  repeticiones distintas dentro de la misma serie (10+12+15)
 */

const ACCENTS = /[\u0300-\u036f]/g;
const norm = (s) => String(s).normalize('NFD').replace(ACCENTS, '').toLowerCase().trim();

/** Ejercicios sin peso: se registran con palomita en vez de casilla de kilos. */
const BODYWEIGHT = [
  'salto', 'jump', 'plancha', 'burpee', 'abs', 'abdominal', 'dead bug', 'tijeras',
  'in and out', 'bicicleta', 'toque de talon', 'punta de pie', 'movilidad', 'estiramiento',
  'escaleras', 'caminadora', 'cardio', 'sin peso', 'liga', 'copenhague', 'pliometric',
  'battle rope', 'soga', 'zancadas en caminata', 'dominadas agarre prono con liga'
];

const CARDIO = ['cardio', 'escaleras', 'caminadora', 'eliptica', 'movilidad', 'estiramiento', 'movi articular'];

const DAY_ACCENTS = ['#FF453A', '#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158', '#5E5CE6', '#FF375F'];

function guessKind(name) {
  const n = norm(name);
  return BODYWEIGHT.some(k => n.includes(k)) ? 'check' : 'weight';
}

function isCardio(name) {
  const n = norm(name);
  return CARDIO.some(k => n.includes(k));
}

/** Limpia adornos del PDF sin perder las notas entre corchetes. */
function cleanName(raw) {
  return String(raw)
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*$/, '')
    .replace(/^[\s:.\-–—]+/, '')
    .trim();
}

/** Separa "Nombre [nota aclaratoria]" en nombre y nota. */
function splitNote(raw) {
  const notes = [];
  const name = raw.replace(/[[({]([^\])}]{6,})[\])}]?/g, (_, note) => {
    notes.push(note.trim());
    return ' ';
  });
  return cleanName(name) ? { name: cleanName(name), note: notes.join(' · ') || undefined } : { name: cleanName(notes.join(' · ')), note: undefined };
}

const DAY_RE = /^(?:piso\s*:?\s*)?d[ií]a\s*([0-9]+)\s*[:.\-]?\s*(.*)$/i;
const REPS_TOKEN = /^(?:f|\d+[a-z]?(?:[+_]\d+[a-z]?)*[a-z%]*)$/i;
const REST_RE = /rest\s*(\d+)\s*s/i;
const DURATION_RE = /(\d+\s*(?:a\s*\d+\s*)?m(?:in|i)?\b|\d+\s*s(?:eg)?\b)/i;

function durationSeconds(text) {
  const match = String(text || '').trim().match(/^(\d+)\s*(m(?:in|i)?|s(?:eg)?)$/i);
  return match ? Number(match[1]) * (/^m/i.test(match[2]) ? 60 : 1) : null;
}

/**
 * Busca la cola "<series> <reps>" al final de la fila. Se prueba de la cola más
 * larga a la más corta porque "4 5 a 6" tiene que leerse como 4 series de 5 a 6.
 * @returns {{ name: string, sets: number, reps: string }|null}
 */
function matchTail(text) {
  const cells = text.split('\t');
  if (cells.length === 3 && /^(?:[1-9]|1[0-2])$/.test(cells[1].trim())) {
    return { name: cells[0].trim(), sets: Number(cells[1]), reps: cells[2].trim() || '—' };
  }
  const duration = text.match(/^(.+?)\s+([1-9]|1[0-2])\s+(\d+\s*(?:min|mi|m|seg|s)(?:\s+abs)?)$/i);
  if (duration) return { name: duration[1], sets: Number(duration[2]), reps: duration[3] };
  const tokens = text.replace(/\s*(rps|reps|rep)\b/gi, '').trim().split(/\s+/);
  const isRep = (t) => REPS_TOKEN.test(t.replace(/[.,;]$/, '')) || /^\d{1,2}[-–]\d{1,2}$/.test(t);

  for (let n = Math.min(4, tokens.length - 1); n >= 1; n--) {
    const suffix = tokens.slice(-n);
    if (!isRep(suffix[suffix.length - 1])) continue;
    if (!suffix.every(t => isRep(t) || /^(?:a|[-–])$/i.test(t))) continue;

    const before = tokens[tokens.length - n - 1];
    if (!/^(?:[1-9]|1[0-2])$/.test(before || '')) continue;

    return {
      name: tokens.slice(0, tokens.length - n - 1).join(' ').trim(),
      sets: parseInt(before, 10),
      reps: suffix.join(' ')
    };
  }
  return null;
}

/** El "Piso" es la columna de la izquierda: 1, 2 o "1 o 2". */
function splitFloor(name) {
  const m = name.match(/^(1\s*o\s*2|[12])\s+(.*)$/i);
  if (!m) return { floor: null, rest: name };
  return { floor: m[1].replace(/\s+/g, ' ').toLowerCase(), rest: m[2] };
}

let seq = 0;
const nextId = (prefix) => `${prefix}${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;

/**
 * Separa los ejercicios de un bloque por "+", ignorando los que en realidad son
 * esquemas de repeticiones (12+15+20) o van dentro de una nota entre corchetes.
 */
function splitByPlus(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth = Math.max(0, depth - 1);

    if ((c === '+' || c === '_') && depth === 0) {
      const remainder = text.slice(i + 1).trimStart();
      const prescription = /^\d/.test(remainder) && !/^\d+\s*s\s*[[({]/i.test(remainder) || /^parciales?\b/i.test(remainder);
      if (!prescription) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map(p => cleanName(p)).filter(Boolean);
}

function buildMovements(name, reps) {
  const parts = splitByPlus(name);
  const repParts = String(reps || '').split('_').map(r => r.trim()).filter(Boolean);
  return parts.map((part, i) => {
    const namedDuration = part.replace(/^(\d+\s*s)\s*[\[({]([^\])}]+)[\])}]\s*$/i, '$2 $1').replace(/^[\[({]([^\])}]+)[\])}]\s*(\d+\s*s)$/i, '$1 $2');
    const { name: mvName, note } = splitNote(namedDuration);
    const localDurations = [...namedDuration.matchAll(/(\d+)\s*(?:s(?:eg)?|min|mi)\b/gi)].map(match => match[0]);
    const repsValue = parts.length === 1 && repParts.length > 1 ? reps : repParts[i] || (repParts.length === 1 ? repParts[0] : reps) || '—';
    const localTime = repParts.length === 1 && parts.length > 1 && /min|\babs\b|^\d+$/i.test(repsValue);
    const movementReps = localTime && localDurations.length ? localDurations.join(' + ') : repsValue;
    const seconds = localTime && !localDurations.length && /min|\babs\b/i.test(repsValue) ? null : durationSeconds(movementReps);
    const timer = seconds >= 1 && seconds <= 7200 ? seconds : undefined;
    return {
      id: nextId('m'),
      name: mvName,
      reps: movementReps,
      kind: timer ? 'check' : guessKind(mvName),
      timer,
      note
    };
  }).filter(m => m.name);
}

/**
 * @returns {{ days: Array, warnings: string[] }}
 */
export function parseRoutineText(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const days = [];
  const warnings = [];
  let day = null;
  let buffer = [];

  const pushBlock = (block) => { if (block.movements.length) day.blocks.push(block); };

  const flushLeftovers = () => {
    if (!buffer.length || !day) { buffer = []; return; }
    const raw = buffer.join(' ');
    buffer = [];
    const movements = buildMovements(splitFloor(raw).rest, '—');
    if (!movements.length) return;
    pushBlock({ id: nextId('b'), floor: null, sets: 3, movements });
    warnings.push(`${day.label}: no encontré series ni reps en "${movements[0].name.slice(0, 40)}…". Puse 3 series.`);
  };

  for (const line of lines) {
    // Encabezado de columnas de la tabla.
    if (/^se\.?\s*reps?$/i.test(line)) continue;

    const dayMatch = line.replace(/\s*se\.?\s*reps?\s*$/i, '').match(DAY_RE);
    if (dayMatch) {
      flushLeftovers();
      const [, num, rest] = dayMatch;
      const title = cleanName(rest.replace(/\(([^)]*)\)/, '')) || `Entrenamiento ${num}`;
      day = {
        id: `d${num}`,
        label: `Día ${num}`,
        title: title.charAt(0).toUpperCase() + title.slice(1),
        subtitle: (rest.match(/\(([^)]*)\)/)?.[1] || '').trim(),
        accent: DAY_ACCENTS[days.length % DAY_ACCENTS.length],
        blocks: []
      };
      days.push(day);
      continue;
    }

    if (/^(?:nota\b|(?:primera?|segunda?|tercera?|cuarta?|\d+)\s+semana\b)/i.test(line)) {
      flushLeftovers();
      warnings.push(`${day ? `${day.label}: ` : ''}nota del coach: "${line}". Revisa su alcance antes de aplicarla.`);
      continue;
    }

    if (!day) continue;

    // Cardio y movilidad no traen series ni reps: se cierran de inmediato para
    // que no se peguen a la fila siguiente.
    if (!buffer.length && isCardio(line)) {
      const tail = line.includes('\t') ? matchTail(line) : null;
      const { rest } = splitFloor(tail?.name || line);
      const { name, note } = splitNote(cleanName(rest));
      if (name) {
        const namedDuration = rest.match(DURATION_RE)?.[1]?.trim();
        const cellDuration = tail?.reps;
        const conflict = durationSeconds(namedDuration) !== null && durationSeconds(cellDuration) !== null && durationSeconds(namedDuration) !== durationSeconds(cellDuration);
        if (conflict) warnings.push(`${day.label}: "${name}" indica ${namedDuration} en el nombre y ${cellDuration} en la columna. Confirma la duración.`);
        pushBlock({
          id: nextId('b'), floor: null, tag: 'Cardio', sets: tail?.sets || 1,
          movements: [{ id: nextId('m'), name, reps: conflict ? `${namedDuration} / ${cellDuration} (PDF)` : cellDuration || namedDuration || '—', kind: 'check', note }]
        });
        continue;
      }
    }

    buffer.push(line);
    if (buffer.length > 8) flushLeftovers();

    let joined = buffer.join(' ');
    const restMatch = joined.match(REST_RE);
    if (restMatch) joined = joined.replace(REST_RE, ' ');

    const tail = matchTail(joined);
    if (!tail) continue;

    buffer = [];
    const { floor, rest } = splitFloor(tail.name);
    if ((rest.match(/\[/g) || []).length > (rest.match(/\]/g) || []).length) warnings.push(`${day.label}: corchete sin cerrar en "${rest.slice(0, 70)}". Revisa la separación entre ejercicios y notas.`);
    const movements = buildMovements(rest, tail.reps);
    if (!movements.length) continue;

    const repGroups = String(tail.reps).split('_').filter(Boolean).length;
    if (repGroups > 1 && repGroups !== movements.length) {
      warnings.push(`${day.label}: "${movements[0].name.slice(0, 34)}" tiene ${movements.length} ejercicios pero ${repGroups} grupos de reps.`);
    }

    pushBlock({
      id: nextId('b'),
      floor,
      sets: tail.sets,
      rest: restMatch ? parseInt(restMatch[1], 10) : undefined,
      movements
    });
  }

  flushLeftovers();

  if (!days.length) warnings.push('No encontré ningún "Día N". Revisa que el texto incluya los encabezados de cada día.');

  return { days, warnings };
}

/** Normaliza una rutina venida del editor o de un respaldo. */
export function sanitizeRoutine(days) {
  return (Array.isArray(days) ? days : []).map((d, di) => ({
    id: d.id || `d${di + 1}`,
    label: d.label || `Día ${di + 1}`,
    title: d.title || `Entrenamiento ${di + 1}`,
    subtitle: d.subtitle || '',
    cycleId: typeof d.cycleId === 'string' ? d.cycleId.slice(0, 100) : undefined,
    cycleName: typeof d.cycleName === 'string' ? d.cycleName.slice(0, 100) : undefined,
    cycleStartedAt: Number.isFinite(d.cycleStartedAt) ? d.cycleStartedAt : undefined,
    accent: d.accent || DAY_ACCENTS[di % DAY_ACCENTS.length],
    blocks: (d.blocks || []).map((b, bi) => ({
      id: b.id || `${d.id || 'd'}${bi}`,
      floor: b.floor || null,
      tag: b.tag || undefined,
      note: b.note || undefined,
      rest: Number.isFinite(b.rest) ? b.rest : undefined,
      sets: Math.min(12, Math.max(1, parseInt(b.sets, 10) || 1)),
      movements: (b.movements || []).map((m, mi) => ({
        id: m.id || `${d.id || 'd'}${bi}m${mi}`,
        name: String(m.name || 'Ejercicio').slice(0, 120),
        reps: String(m.reps || '—').slice(0, 40),
        kind: m.kind === 'check' ? 'check' : 'weight',
        muscleGroup: typeof m.muscleGroup === 'string' ? m.muscleGroup.slice(0, 40) : undefined,
        equipment: typeof m.equipment === 'string' ? m.equipment.slice(0, 60) : undefined,
        timer: Number.isFinite(m.timer) ? m.timer : undefined,
        note: m.note ? String(m.note).slice(0, 300) : undefined
      })).filter(m => m.name)
    })).filter(b => b.movements.length)
  })).filter(d => d.blocks.length);
}

export { DAY_ACCENTS };
