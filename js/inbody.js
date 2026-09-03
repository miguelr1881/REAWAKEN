/**
 * Parser de hojas de resultados InBody (probado con InBody270, hoja en español).
 *
 * Flujo pensado para iPhone: abres la foto en Fotos, tocas el icono de Live Text,
 * «Seleccionar todo» → «Copiar», y pegas ese texto aquí. El OCR de iOS es mucho
 * más preciso que cualquier OCR corriendo en el navegador.
 *
 * La hoja tiene tres trampas que hay que limpiar antes de leer números:
 *   1. Rangos de referencia entre paréntesis:  47,2 ( 41,4~50,6 )
 *   2. Escalas de los gráficos de barras:      PGC (%) 0,0 5,0 10,0 ... 50,0  22,7
 *   3. La miniatura de "Historial de Composición Corporal" al pie de la hoja.
 * Después se hace una pasada de reparación con las relaciones físicas de la hoja
 * (peso = agua + proteína + minerales + grasa, etc.) que corrige lo que el OCR
 * haya leído mal.
 */

export const INBODY_FIELDS = [
  {
    key: 'weight', label: 'Peso', primary: true, better: 'down', range: [25, 300],
    labels: ['peso corporal', 'peso']
  },
  {
    key: 'smm', label: 'Músculo esquelético', primary: true, better: 'up', range: [10, 90],
    labels: ['masa de musculo esqueletico', 'masa muscular esqueletica', 'mme', 'skeletal muscle mass', 'smm']
  },
  {
    key: 'pbf', label: 'Grasa corporal', percent: true, primary: true, better: 'down', range: [2, 70],
    labels: ['porcentaje de grasa corporal', 'pgc', 'percent body fat', 'pbf']
  },
  {
    key: 'bfm', label: 'Masa grasa', better: 'down', range: [1, 120],
    labels: ['masa grasa corporal', 'masa de grasa corporal', 'masa grasa', 'body fat mass', 'bfm']
  },
  {
    key: 'ffm', label: 'Masa libre de grasa', better: 'up', range: [15, 150],
    labels: ['masa libre de grasa', 'fat free mass', 'ffm']
  },
  {
    key: 'bmi', label: 'IMC', better: 'down', range: [8, 70],
    labels: ['indice de masa corporal', 'imc', 'body mass index', 'bmi']
  },
  {
    key: 'tbw', label: 'Agua corporal total', range: [10, 100],
    labels: ['agua corporal total', 'total body water', 'tbw']
  },
  {
    key: 'protein', label: 'Proteína', better: 'up', range: [2, 40],
    labels: ['proteinas', 'proteina', 'protein']
  },
  {
    key: 'minerals', label: 'Minerales', range: [0.5, 15], decimals: 2,
    labels: ['minerales', 'mineral']
  },
  {
    key: 'visceral', label: 'Grasa visceral', better: 'down', range: [1, 40], pick: 'last', preferAfter: 'nivel',
    labels: ['nivel de grasa visceral', 'grasa visceral', 'visceral fat level']
  },
  {
    key: 'whr', label: 'Índice cintura-cadera', better: 'down', range: [0.4, 1.6], pick: 'last', decimals: 2,
    labels: ['relacion cintura-cadera', 'relacion cintura cadera', 'indice cintura-cadera', 'icc', 'whr']
  },
  {
    key: 'bmr', label: 'Metabolismo basal', better: 'up', range: [700, 4500],
    labels: ['tasa metabolica basal', 'metabolismo basal', 'basal metabolic rate', 'tmb', 'bmr']
  },
  {
    key: 'smi', label: 'IME', better: 'up', range: [3, 20],
    labels: ['indice de masa esqueletica', 'ime', 'smi']
  },
  {
    key: 'score', label: 'Puntuación InBody', better: 'up', range: [20, 110],
    labels: ['puntuacion inbody', 'puntaje inbody', 'inbody score']
  },
  {
    key: 'intake', label: 'Ingesta recomendada', range: [800, 6000],
    labels: ['ingesta calorica recomendada', 'ingesta recomendada', 'recommended calorie intake']
  },
  {
    key: 'idealWeight', label: 'Peso ideal', range: [30, 200],
    labels: ['peso ideal', 'target weight']
  },
  {
    key: 'weightCtrl', label: 'Control de peso', range: [-60, 60],
    labels: ['control de peso', 'weight control']
  },
  {
    key: 'fatCtrl', label: 'Control de grasa', range: [-60, 60],
    labels: ['control de grasa', 'fat control']
  },
  {
    key: 'muscleCtrl', label: 'Control de músculo', range: [-40, 40],
    labels: ['control de musculo', 'muscle control']
  },
  {
    key: 'height', label: 'Altura', range: [120, 230],
    labels: ['altura', 'estatura', 'height']
  }
];

const FIELD_BY_KEY = Object.fromEntries(INBODY_FIELDS.map(f => [f.key, f]));

/* ============================ Limpieza ============================ */

function normalize(text) {
  return String(text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Live Text devuelve paréntesis, tildes y guiones de ancho completo.
    .replace(/[（｟]/g, '(').replace(/[）｠]/g, ')')
    .replace(/[～〜]/g, '~')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[，、]/g, ',')
    .replace(/[｜|¦•·■□▪●○]/g, ' ')
    .replace(/\s+/g, ' ');
}

const NUM_SRC = '(?:-\\s?)?\\d{1,4}(?:[.,]\\d{1,3})?';

/**
 * Escalas de los gráficos de barras. El valor real viene pegado al final de la
 * escala ("0,0 5,0 ... 50,0  22,7"), así que solo se borra el prefijo creciente.
 */
function stripAxes(text) {
  const run = new RegExp(`(?:${NUM_SRC}\\s+){3,}${NUM_SRC}`, 'g');
  return text.replace(run, match => {
    const tokens = match.trim().split(/\s+/);
    const nums = tokens.map(t => parseFloat(t.replace(',', '.')));
    let n = 1;
    while (n < nums.length && nums[n] > nums[n - 1]) n++;
    return n >= 4 ? ' ' + tokens.slice(n).join(' ') : match;
  });
}

function clean(text) {
  let t = normalize(text);
  // Rangos de referencia. A veces el paréntesis de cierre se pierde en el OCR
  // y el separador puede ser ~ o guion: ( 0,80-0,90 ).
  t = t.replace(new RegExp(`\\(\\s*${NUM_SRC}\\s*[~-]\\s*${NUM_SRC}\\s*\\)?`, 'g'), ' ');
  t = t.replace(new RegExp(`${NUM_SRC}\\s*~\\s*${NUM_SRC}`, 'g'), ' ');
  t = t.replace(/\/\s*100/g, ' ');
  t = t.replace(/\b(kg\s*\/\s*m\s*2?|kg|kcal|cm|khz|puntos|lbs?)\b/g, ' ');
  t = t.replace(/[²³*]/g, ' ');
  t = t.replace(/\(\s*(l|%)\s*\)/g, ' ');
  t = t.replace(/\s+/g, ' ');
  return stripAxes(t).replace(/\s+/g, ' ');
}

function numbersIn(str) {
  const out = [];
  const re = new RegExp(NUM_SRC, 'g');
  let m;
  while ((m = re.exec(str))) {
    const neg = m[0].trimStart().startsWith('-');
    const v = parseFloat(m[0].replace(/[-\s]/g, '').replace(',', '.')) * (neg ? -1 : 1);
    if (Number.isFinite(v)) out.push({ v, i: m.index });
  }
  return out;
}

function labelIndices(text, label) {
  const out = [];
  // Las siglas (imc, pgc, mme…) solo cuentan como palabra completa.
  const pattern = label.length <= 4
    ? new RegExp(`(?:^|[^a-z])(${label})(?:[^a-z]|$)`, 'g')
    : new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  let m;
  while ((m = pattern.exec(text))) {
    out.push(m.index + m[0].indexOf(label));
    pattern.lastIndex = m.index + 1;
  }
  return out;
}

/* ============================ Parseo ============================ */

const WINDOW = 42;

function extract(text, field) {
  for (const label of field.labels) {
    for (const idx of labelIndices(text, label)) {
      const from = idx + label.length;
      const window = text.slice(from, from + WINDOW);

      // "Nivel de Grasa Visceral  Bajo 10 Alto  Nivel 8" -> nos interesa el que sigue a "nivel".
      if (field.preferAfter) {
        const m = window.match(new RegExp(`${field.preferAfter}\\s*(${NUM_SRC})`));
        if (m) {
          const v = parseFloat(m[1].replace(',', '.'));
          if (v >= field.range[0] && v <= field.range[1]) return v;
        }
      }

      const candidates = numbersIn(window)
        .filter(c => c.v >= field.range[0] && c.v <= field.range[1]);
      if (!candidates.length) continue;
      return field.pick === 'last' ? candidates[candidates.length - 1].v : candidates[0].v;
    }
  }
  return undefined;
}

/** Ajusta los valores con las relaciones físicas que la propia hoja usa. */
function repair(v, fixed) {
  const set = (key, value, tol) => {
    const rounded = +value.toFixed(FIELD_BY_KEY[key].decimals ?? 1);
    if (v[key] === undefined) { v[key] = rounded; return; }
    if (Math.abs(v[key] - rounded) > tol) {
      fixed.push(key);
      v[key] = rounded;
    }
  };

  if (v.tbw && v.protein && v.minerals && v.bfm) set('weight', v.tbw + v.protein + v.minerals + v.bfm, 1.2);
  if (v.weight && v.ffm && v.bfm === undefined) v.bfm = +(v.weight - v.ffm).toFixed(1);
  if (v.weight && v.bfm) set('ffm', v.weight - v.bfm, 1);
  if (v.weight && v.bfm) set('pbf', (v.bfm / v.weight) * 100, 0.8);
  if (v.weight && v.pbf && v.bfm === undefined) v.bfm = +((v.pbf / 100) * v.weight).toFixed(1);
  if (v.weight && v.height) set('bmi', v.weight / Math.pow(v.height / 100, 2), 0.6);

  return v;
}

/**
 * Comprobaciones que se muestran en el formulario para que se vea de un vistazo
 * si los números cuadran entre sí.
 */
export function consistency(v) {
  const num = k => (v[k] === '' || v[k] === undefined || v[k] === null ? null : Number(v[k]));
  const out = [];
  const add = (label, actual, expected, tol) => {
    if (actual === null || expected === null || !Number.isFinite(expected)) return;
    out.push({ label, ok: Math.abs(actual - expected) <= tol, actual, expected: +expected.toFixed(1) });
  };

  const [w, bfm, ffm, pbf, bmi, h, tbw, pro, min] =
    ['weight', 'bfm', 'ffm', 'pbf', 'bmi', 'height', 'tbw', 'protein', 'minerals'].map(num);

  if (tbw && pro && min && bfm) add('Peso = agua + proteína + minerales + grasa', w, tbw + pro + min + bfm, 1.2);
  if (w && bfm) add('% grasa = masa grasa / peso', pbf, (bfm / w) * 100, 0.8);
  if (w && bfm) add('Masa libre de grasa = peso − masa grasa', ffm, w - bfm, 1);
  if (w && h) add('IMC = peso / altura²', bmi, w / Math.pow(h / 100, 2), 0.6);

  return out;
}

/**
 * @returns {{ values: Record<string, number>, at: number|null, missing: string[], fixed: string[] }}
 */
export function parseInBody(text, fallbackHeight) {
  const t = clean(text);
  const values = {};

  for (const field of INBODY_FIELDS) {
    const v = extract(t, field);
    if (v !== undefined) values[field.key] = v;
  }
  if (!values.height && fallbackHeight) values.height = fallbackHeight;

  const fixed = [];
  repair(values, fixed);

  return {
    values,
    at: parseDate(text),
    missing: INBODY_FIELDS.filter(f => values[f.key] === undefined).map(f => f.key),
    fixed
  };
}

/** Fecha de la prueba. La hoja la escribe como "12.05.2026. 07:32". */
export function parseDate(text) {
  const t = String(text);
  const patterns = [
    /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/,
    /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/,
    /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2})(?!\d)/
  ];
  for (const [i, re] of patterns.entries()) {
    const rx = new RegExp(re.source, 'g');
    const found = [];
    let m;
    while ((m = rx.exec(t))) {
      let y, mo, d;
      if (i === 0) [y, mo, d] = [+m[1], +m[2], +m[3]];
      else if (i === 1) [y, mo, d] = [+m[3], +m[2], +m[1]];
      else [y, mo, d] = [2000 + +m[3], +m[2], +m[1]];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const date = new Date(y, mo - 1, d, 12, 0, 0);
      if (date.getFullYear() >= 2015 && date.getTime() <= Date.now() + 86400000) found.push(date.getTime());
    }
    // La hoja repite las fechas anteriores en el historial del pie: nos quedamos con la más reciente.
    if (found.length) return Math.max(...found);
  }
  return null;
}

export function fieldMeta(key) {
  return FIELD_BY_KEY[key];
}

export function formatValue(key, value) {
  if (value === undefined || value === null || value === '') return '—';
  const f = FIELD_BY_KEY[key];
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const txt = Number.isInteger(n) ? String(n) : n.toFixed(f?.decimals ?? 1);
  return f?.percent ? `${txt}%` : txt;
}
