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

let atlasSequence = 0;

export function muscleAtlas(groups) {
  const active = new Set(Array.isArray(groups) ? groups : [groups]);
  const id = `muscle-atlas-${++atlasSequence}`;
  const region = (group, path) => `<path data-region="${group}" class="anatomy-region${active.has(group) || active.has('full') ? ' active' : ''}" d="${path}"/>`;
  const pair = (group, path) => `${region(group, path)}<g transform="translate(116 0) scale(-1 1)">${region(group, path)}</g>`;
  const outline = '<ellipse cx="58" cy="18" rx="11" ry="14"/><path d="M51 34C50 39 48 42 43 43L34 45C26 47 22 51 20 60L15 86 9 113C7 122 7 128 10 131C13 133 16 131 18 125L24 104 30 87 34 72C36 91 39 107 38 119L34 143C33 158 35 175 38 193L39 218C39 224 34 230 34 233L48 233C51 227 51 220 50 214L50 192 55 159 58 143 61 159 66 192 66 214C65 220 65 227 68 233L82 233C82 230 77 224 77 218L78 193C81 175 83 158 82 143L78 119C77 107 80 91 82 72L86 87 92 104 98 125C100 131 103 133 106 131C109 128 109 122 107 113L101 86 96 60C94 51 90 47 82 45L73 43C68 42 66 39 65 34C62 37 54 37 51 34Z"/>';
  const shoulders = 'M33 46C27 47 23 52 22 61L20 70C25 67 30 66 34 63L38 46Z';
  const calves = 'M39 192C42 190 46 191 49 194L46 214 41 216C39 207 38 199 39 192Z';
  const labels = [...active].filter(group => Object.hasOwn(MUSCLE_GROUPS, group)).map(group => MUSCLE_GROUPS[group]).join(', ');
  return `<svg class="muscle-atlas" viewBox="0 0 260 270" role="img" aria-label="Mapa muscular orientativo, frente y espalda${labels ? `. Zonas destacadas: ${labels}` : ''}" style="--atlas-body-fill:url(#${id}-body);--atlas-active-fill:url(#${id}-active)">
    <defs>
      <linearGradient id="${id}-body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="var(--atlas-body-hi)"/><stop offset="1" stop-color="var(--atlas-body-low)"/></linearGradient>
      <linearGradient id="${id}-active" x1="0" y1="0" x2="0.7" y2="1"><stop stop-color="var(--atlas-accent-hi)"/><stop offset="0.55" stop-color="var(--brand)"/><stop offset="1" stop-color="var(--atlas-accent-low)"/></linearGradient>
    </defs>
    <g transform="translate(7 4)">
      <ellipse class="atlas-ground" cx="58" cy="240" rx="30" ry="3"/>
      <g class="anatomy-outline">${outline}</g>
      ${pair('shoulders', shoulders)}
      ${pair('chest', 'M39 48C44 46 50 47 56 50L56 73C49 77 42 76 35 70L36 57Z')}
      ${pair('biceps', 'M23 73C26 69 30 68 33 68L29 89C26 95 22 100 18 101L20 86Z')}
      ${pair('core', 'M42 80C47 82 51 82 56 80L56 89 42 89Z M42 92H56V101H42Z M43 104H56V114C52 118 47 119 43 116Z')}
      ${pair('quads', 'M39 126C44 124 49 125 54 128L52 149C50 164 47 177 45 185L39 184C37 167 35 150 37 136Z')}
      ${pair('adductors', 'M53 125L57 127 56 144 51 163 50 143Z')}
      ${pair('calves', calves)}
      <path class="atlas-detail" d="M58 81v35M44 91h28M43 102h30M44 112h28M16 108l-4 16M100 108l4 16"/>
      <text class="atlas-view-label" x="58" y="262">Frente</text>
    </g>
    <g transform="translate(137 4)">
      <ellipse class="atlas-ground" cx="58" cy="240" rx="30" ry="3"/>
      <g class="anatomy-outline">${outline}</g>
      ${pair('back', 'M46 41C49 45 52 47 56 47L56 68 37 57 39 47Z M35 62L56 75V117L44 115C41 100 36 88 35 73Z')}
      ${pair('shoulders', shoulders)}
      ${pair('triceps', 'M23 72C27 68 30 68 33 69L29 92 18 103 20 88Z')}
      ${pair('glutes', 'M40 121C45 118 51 119 56 123L56 139C51 143 44 144 37 140L38 128Z')}
      ${pair('hamstrings', 'M37 145C43 148 49 147 54 143L50 170 46 185 39 185C37 169 36 155 37 145Z')}
      ${pair('calves', calves)}
      <path class="atlas-detail" d="M58 49v68M45 55l11 8M71 55 60 63M16 108l-4 16M100 108l4 16"/>
      <text class="atlas-view-label" x="58" y="262">Espalda</text>
    </g>
  </svg>`;
}