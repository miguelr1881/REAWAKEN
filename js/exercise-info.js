export const MUSCLE_GROUPS = {
  chest: 'Pecho', back: 'Espalda', shoulders: 'Hombros', biceps: 'Bíceps',
  triceps: 'Tríceps', core: 'Abdomen', quads: 'Cuádriceps', hamstrings: 'Isquios',
  glutes: 'Glúteos', adductors: 'Aductores', calves: 'Pantorrillas',
  full: 'Cuerpo completo', cardio: 'Cardio', none: 'Sin asignar'
};

const rules = [
  ['full', /\b(burpees?|thrusters?|battle ropes?)\b/],
  ['core', /\b(plancha|plank|abdominal(?:es)?|abs|tijeras|in and outs|toque de talones|toque punta de pies|dead bug|russian twist|slam ball lateral|side swing|crunch(?:es)?)\b/],
  ['cardio', /\b(caminadora|escaleras|eliptica|treadmill|bicicleta estatica|stationary bike|running|correr)\b/],
  ['triceps', /\b(triceps|tricep|pushdown|press cerrado)\b/], ['biceps', /\b(biceps|bicep|curl (?:de )?martillo|hammer curl)\b/],
  ['hamstrings', /\b(rumano|romanian|rdl|curl femoral|curl de piernas|leg curl|flexion de rodilla)\b/],
  ['glutes', /\b(hip thrust|gluteo|gluteos|glute bridge|abduccion|peso muerto sumo|sumo deadlift|swing)\b/],
  ['adductors', /\b(aductor|aductores|aduccion)\b/],
  ['calves', /\b(pantorrilla|pantorrillas|gemelos|calf)\b/],
  ['shoulders', /\b(hombro|hombros|press militar|press arnold|arnold press|shoulder|overhead press|lateral raise|face pull)\b/],
  ['chest', /\b(pecho|press (?:de )?banca|bench press|pectoral|aperturas|pe[ck]k? fly|pec deck|chest fly|push ups?|flexiones)\b/],
  ['back', /\b(dominadas|jalon|remo|pull ups?|chin ups?|lat pulldown|rows?)\b/],
  ['quads', /\b(sentadillas?|squats?|prensa|leg press|extension de rodilla|leg extension|desplantes?|zancadas?|lunges?|step ups?|tuck jumps)\b/]
];

const normalizedName = name => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ');

const secondaryRules = [
  ['glutes', /\b(sentadillas?|squats?|prensa|leg press|desplantes?|zancadas?|lunges?|step ups?|rumano|romanian|rdl)\b/],
  ['hamstrings', /\b(peso muerto sumo|sumo deadlift|swing)\b/],
  ['chest', /\b(press cerrado|puente de gluteo con press)\b/],
  ['shoulders', /\b(russian twist.*press)\b/],
  ['core', /\b(copenhague|copenhagen|rotacion de torso)\b/]
];

export function exerciseFocus(movement) {
  if (Object.hasOwn(MUSCLE_GROUPS, movement.muscleGroup || '')) return movement.muscleGroup;
  const name = normalizedName(movement.name);
  return rules.find(([, pattern]) => pattern.test(name))?.[0] || 'none';
}

export function exerciseGroups(movement) {
  const primary = exerciseFocus(movement);
  if (Object.hasOwn(MUSCLE_GROUPS, movement.muscleGroup || '') || ['none', 'cardio', 'full'].includes(primary)) return [primary];
  const name = normalizedName(movement.name);
  return [...new Set([primary, ...secondaryRules.filter(([, pattern]) => pattern.test(name)).map(([group]) => group)])];
}

export function imageSearchUrl(name) {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('tbm', 'isch');
  url.searchParams.set('q', `${name} ejercicio ilustración técnica`);
  return url.href;
}

export function dayFocus(day) {
  const counts = new Map();
  for (const block of day.blocks) for (const movement of block.movements) {
    for (const group of exerciseGroups(movement)) {
      if (group !== 'none' && group !== 'cardio') counts.set(group, (counts.get(group) || 0) + block.sets);
    }
  }
  if (counts.has('full')) return ['full'];
  return [...counts].sort((first, second) => second[1] - first[1]).map(([group]) => group);
}

export function muscleAtlas(groups) {
  const active = new Set(Array.isArray(groups) ? groups : [groups]);
  const region = (group, path) => `<path data-region="${group}" class="anatomy-region${active.has(group) || active.has('full') ? ' active' : ''}" d="${path}"/>`;
  const outline = '<circle cx="60" cy="22" r="12"/><path d="M51 36 49 43 31 49 22 78 15 110 22 115 34 86 39 72 41 112 34 142 38 180 42 211 34 222 51 222 55 181 60 148 65 181 69 222 86 222 78 211 82 180 86 142 79 112 81 72 86 86 98 115 105 110 98 78 89 49 71 43 69 36"/>';
  return `<svg class="muscle-atlas" viewBox="0 0 260 250" role="img" aria-label="Mapa muscular esquemático, vista frontal y posterior">
    <g transform="translate(5 0)"><g class="anatomy-outline">${outline}</g>
      ${region('shoulders', 'M31 51 44 47 41 64 28 73Z M76 47 89 51 92 73 79 64Z')}
      ${region('chest', 'M46 50 58 53 58 76 42 70Z M62 53 74 50 78 70 62 76Z')}
      ${region('biceps', 'M28 77 38 70 33 92 23 99Z M82 70 92 77 97 99 87 92Z')}
      ${region('core', 'M44 79 58 82 58 109 47 115Z M62 82 76 79 73 115 62 109Z')}
      ${region('quads', 'M40 123 50 126 52 147 47 173 40 173 38 145Z M70 126 80 123 82 145 80 173 73 173 68 147Z')}
      ${region('adductors', 'M52 120 59 124 57 151 53 161 54 143Z M61 124 68 120 66 143 67 161 63 151Z')}
      ${region('calves', 'M41 180 50 180 48 205 44 205Z M70 180 79 180 76 205 72 205Z')}
      <text x="60" y="245">Frente</text>
    </g>
    <g transform="translate(135 0)"><g class="anatomy-outline">${outline}</g>
      ${region('shoulders', 'M31 51 44 47 41 64 28 73Z M76 47 89 51 92 73 79 64Z')}
      ${region('back', 'M48 46 58 42 58 111 46 106 42 70Z M62 42 72 46 78 70 74 106 62 111Z')}
      ${region('triceps', 'M28 77 38 70 33 92 23 99Z M82 70 92 77 97 99 87 92Z')}
      ${region('glutes', 'M43 114 58 116 58 133 39 135Z M62 116 77 114 81 135 62 133Z')}
      ${region('hamstrings', 'M39 139 56 137 50 174 41 174Z M64 137 81 139 79 174 70 174Z')}
      ${region('calves', 'M41 180 51 178 48 205 44 208Z M69 178 79 180 76 208 72 205Z')}
      <text x="60" y="245">Espalda</text>
    </g>
  </svg>`;
}