// Rutina extraída del plan de entrenamiento (Entrenador: Anderson).
// Notación original de la columna "Reps":
//   "_"  separa ejercicios distintos dentro del mismo bloque (superserie)
//   "+"  indica repeticiones distintas dentro de la misma serie (ej. 10+12+15)

export const PROFILE = {
  name: 'Miguel J Tung',
  coach: 'Anderson',
  height: 183,
  // El Día 3 se hizo el 03/09/2026 fuera de la app, así que la rotación arranca en el 4.
  firstDayId: 'd4',
  startDate: '2026-05-04',
  reviewDate: '2026-08-16',
  routineChangeDate: '2026-10-20',
  daysPerWeek: 5,
  goals: 'Bajar % de grasa, mantener músculo, rapidez y potencia',
  sport: 'Fútbol',
  weeklyNote: 'Cada semana subir pesos y aumentar 3 min al cardio.'
};

/**
 * kind: 'weight' -> input de peso por serie | 'check' -> palomita por serie
 * Esta es la rutina de arranque (la del PDF del coach). La rutina activa se
 * guarda en IndexedDB y se puede editar o reemplazar desde Ajustes.
 */
export const DEFAULT_ROUTINE = [
  {
    id: 'd1',
    label: 'Día 1',
    title: 'Fuerza y Potencia',
    subtitle: 'Tren inferior',
    accent: '#FF453A',
    blocks: [
      {
        id: 'd1b0', floor: null, tag: 'Cardio', sets: 1,
        movements: [{ id: 'd1b0m0', name: 'Caminadora', reps: '10 min', kind: 'check' }]
      },
      {
        id: 'd1b1', floor: '1', sets: 4, repsRaw: '10_10+12+15',
        movements: [
          { id: 'd1b1m0', name: 'Tuck jumps', reps: '10', kind: 'check', note: '2 saltos pequeños y al 3.º una sentadilla con salto' },
          { id: 'd1b1m1', name: 'Extensión de rodilla', reps: '10+12+15', kind: 'weight', note: '10 lentas y 10 rápidas' }
        ]
      },
      {
        id: 'd1b2', floor: '1 o 2', sets: 4, repsRaw: '5 a 6',
        movements: [{ id: 'd1b2m0', name: 'Sentadilla en Smith', reps: '5-6', kind: 'weight', note: 'Enfoque fuerza' }]
      },
      {
        id: 'd1b3', floor: '1', sets: 3, repsRaw: '8 a 10',
        movements: [{ id: 'd1b3m0', name: 'Peso muerto rumano', reps: '8-10', kind: 'weight' }]
      },
      {
        id: 'd1b4', floor: '1', sets: 3, repsRaw: '8+12+15_7',
        movements: [
          { id: 'd1b4m0', name: 'Prensa', reps: '8+12+15', kind: 'weight', note: '8 reps mantén 8 s · 12 reps mantén 12 s · 15 reps mantén 15 s' },
          { id: 'd1b4m1', name: 'Sentadilla goblet + desplante estático', reps: '7', kind: 'weight', note: 'Con elevación de talón' }
        ]
      },
      {
        id: 'd1b5', floor: '2', sets: 3, repsRaw: '15+20_20S_8',
        movements: [
          { id: 'd1b5m0', name: 'Aductor en máquina', reps: '10', kind: 'weight' },
          { id: 'd1b5m1', name: 'Sentadilla isométrica', reps: '20 s', kind: 'weight' },
          { id: 'd1b5m2', name: 'Slam ball lateral', reps: '8', kind: 'weight' }
        ]
      }
    ]
  },

  {
    id: 'd2',
    label: 'Día 2',
    title: 'Upper Body & Core',
    subtitle: 'Espalda, hombro, brazo y abdomen',
    accent: '#0A84FF',
    blocks: [
      {
        id: 'd2b0', floor: null, tag: 'Cardio', sets: 1,
        movements: [{ id: 'd2b0m0', name: 'Escaleras', reps: '15 min', kind: 'check' }]
      },
      {
        id: 'd2b1', floor: '1', sets: 3, repsRaw: '10_10',
        movements: [
          { id: 'd2b1m0', name: 'Dominadas asistidas', reps: '10', kind: 'weight', note: 'Agarre prono y neutro' },
          { id: 'd2b1m1', name: 'Remo en polea baja con mecate', reps: '10', kind: 'weight' }
        ]
      },
      {
        id: 'd2b2', floor: '1 o 2', sets: 3, repsRaw: '10_10',
        movements: [
          { id: 'd2b2m0', name: 'Jalón convergente', reps: '10', kind: 'weight' },
          { id: 'd2b2m1', name: 'Remo agarre ancho en supinación', reps: '10', kind: 'weight' }
        ]
      },
      {
        id: 'd2b3', floor: '2', sets: 3, rest: 45, repsRaw: '12+15+20_10',
        movements: [
          { id: 'd2b3m0', name: 'Elevación lateral de hombro', reps: '12+15+20', kind: 'weight', note: 'Bajando peso en cada tramo' },
          { id: 'd2b3m1', name: 'Curl bíceps martillo simultáneo', reps: '10', kind: 'weight', note: 'Manteniendo el brazo izq., 3 con el derecho; después manteniendo el derecho, 3 con el izq. Así 3 veces' }
        ]
      },
      {
        id: 'd2b4', floor: '2', sets: 3, repsRaw: '8+12+15',
        movements: [{ id: 'd2b4m0', name: 'Extensión de tríceps en polea', reps: '8+12+15', kind: 'weight' }]
      },
      {
        id: 'd2b5', floor: '1', tag: 'Circuito abdominal · 6 min', sets: 3, rest: 45,
        note: 'Hacer el circuito completo una vez, descansar 45 s y repetirlo. 3 vueltas en total.',
        movements: [
          { id: 'd2b5m0', name: 'Tijeras', reps: '20 s', kind: 'check', timer: 20 },
          { id: 'd2b5m1', name: 'In and outs', reps: '20 s', kind: 'check', timer: 20 },
          { id: 'd2b5m2', name: 'Toque de talones', reps: '20 s', kind: 'check', timer: 20 },
          { id: 'd2b5m3', name: 'Toque punta de pies', reps: '20 s', kind: 'check', timer: 20 },
          { id: 'd2b5m4', name: 'Bicicleta abs', reps: '20 s', kind: 'check', timer: 20 },
          { id: 'd2b5m5', name: 'Plancha', reps: '25 s', kind: 'check', timer: 25 }
        ]
      }
    ]
  },

  {
    id: 'd3',
    label: 'Día 3',
    title: 'Glúteo e Isquios',
    subtitle: 'Cadena posterior',
    accent: '#BF5AF2',
    blocks: [
      {
        id: 'd3b0', floor: null, tag: 'Cardio', sets: 1,
        movements: [{ id: 'd3b0m0', name: 'Caminadora', reps: '15 min', kind: 'check' }]
      },
      {
        id: 'd3b1', floor: '1', sets: 3, repsRaw: '10_12',
        movements: [
          { id: 'd3b1m0', name: 'Hip thrust libre', reps: '10', kind: 'weight' },
          { id: 'd3b1m1', name: 'Hip thrust unilateral', reps: '12', kind: 'weight', note: 'Mancuerna sobre el cuádriceps' }
        ]
      },
      {
        id: 'd3b2', floor: '1 o 2', sets: 3, repsRaw: '12_12',
        movements: [
          { id: 'd3b2m0', name: 'Patada de glúteo en polea', reps: '12', kind: 'weight' },
          { id: 'd3b2m1', name: 'Abducción en polea', reps: '12', kind: 'weight' }
        ]
      },
      {
        id: 'd3b3', floor: '1', sets: 3, repsRaw: '12_8_8',
        movements: [
          { id: 'd3b3m0', name: 'Peso muerto sumo (barra)', reps: '12', kind: 'weight' },
          { id: 'd3b3m1', name: 'Zancada inversa con mancuerna', reps: '8', kind: 'weight' },
          { id: 'd3b3m2', name: 'Sentadilla lateral con peso', reps: '8', kind: 'weight', note: 'Una pierna en step' }
        ]
      },
      {
        id: 'd3b4', floor: '1 o 2', sets: 3, repsRaw: '10',
        movements: [
          { id: 'd3b4m0', name: 'Desplante estático con salto', reps: '10', kind: 'check', note: 'Pliométrico: desplante, salta y cambia de pierna' }
        ]
      },
      {
        id: 'd3b5', floor: '2', sets: 3, repsRaw: '7+7+7',
        movements: [{ id: 'd3b5m0', name: 'Curl de piernas sentado', reps: '7+7+7', kind: 'weight', note: '7 de abajo a la mitad · 7 de la mitad a arriba · 7 completos' }]
      },
      {
        id: 'd3b6', floor: null, tag: 'Cardio final', sets: 1,
        movements: [{ id: 'd3b6m0', name: 'Escaleras', reps: '10 min', kind: 'check' }]
      }
    ]
  },

  {
    id: 'd4',
    label: 'Día 4',
    title: 'Full Body Metabólico',
    subtitle: 'Potencia y acondicionamiento',
    accent: '#FF9F0A',
    blocks: [
      {
        id: 'd4b0', floor: null, tag: 'Cardio', sets: 1,
        movements: [{ id: 'd4b0m0', name: 'Escaleras', reps: '15 min', kind: 'check' }]
      },
      {
        id: 'd4b1', floor: '1', sets: 3, repsRaw: 'F',
        movements: [{ id: 'd4b1m0', name: 'Dominadas agarre prono asistida', reps: 'Al fallo', kind: 'weight', note: 'Mantener arriba y bajar lento' }]
      },
      {
        id: 'd4b2', floor: '2', sets: 3, repsRaw: '25s_15',
        movements: [
          { id: 'd4b2m0', name: 'Battle rope + sentadilla con salto', reps: '25 s', kind: 'check' },
          { id: 'd4b2m1', name: 'Swing', reps: '15', kind: 'weight' }
        ]
      },
      {
        id: 'd4b3', floor: '2', sets: 3, repsRaw: '8_15s',
        movements: [
          { id: 'd4b3m0', name: 'Dead bug', reps: '8', kind: 'check', note: 'Mano y pie contrario' },
          { id: 'd4b3m1', name: 'Aducción copenhague', reps: '15 s', kind: 'check', note: 'Plancha lateral con elevación de pierna' }
        ]
      },
      {
        id: 'd4b4', floor: '2', sets: 3, repsRaw: '8_8_8',
        movements: [
          { id: 'd4b4m0', name: 'Press Arnold', reps: '8', kind: 'weight' },
          { id: 'd4b4m1', name: 'Peck fly', reps: '8', kind: 'weight' },
          { id: 'd4b4m2', name: 'Extensión de tríceps en polea', reps: '8', kind: 'weight' }
        ]
      },
      {
        id: 'd4b5', floor: '2', sets: 3, repsRaw: '8_10_8_15',
        movements: [
          { id: 'd4b5m0', name: 'Burpees', reps: '8', kind: 'check' },
          { id: 'd4b5m1', name: 'Side swing', reps: '10', kind: 'weight' },
          { id: 'd4b5m2', name: 'Russian twist con balón + press', reps: '8', kind: 'weight' },
          { id: 'd4b5m3', name: 'Thruster', reps: '15', kind: 'weight' }
        ]
      },
      {
        id: 'd4b6', floor: null, tag: 'Cardio final', sets: 1,
        movements: [{ id: 'd4b6m0', name: 'Escaleras', reps: '15-20 min', kind: 'check' }]
      }
    ]
  },

  {
    id: 'd5',
    label: 'Día 5',
    title: 'Pierna y Empuje',
    subtitle: 'Cuádriceps, glúteo y pecho',
    accent: '#30D158',
    blocks: [
      {
        id: 'd5b0', floor: null, tag: 'Cardio', sets: 1,
        movements: [{ id: 'd5b0m0', name: 'Escaleras', reps: '15 min', kind: 'check' }]
      },
      {
        id: 'd5b1', floor: '1', sets: 4, repsRaw: '8_10_12',
        movements: [{ id: 'd5b1m0', name: 'Sentadilla Hack', reps: '8 / 10 / 12', kind: 'weight', note: 'Peso exigente · peso medio · peso máximo' }]
      },
      {
        id: 'd5b2', floor: '2', sets: 4, repsRaw: '18P',
        movements: [{ id: 'd5b2m0', name: 'Zancadas en caminata doble', reps: '18 pasos', kind: 'check', note: 'Sin peso' }]
      },
      {
        id: 'd5b3', floor: '2', sets: 4, repsRaw: '8',
        movements: [
          { id: 'd5b3m0', name: 'Step up en polea', reps: '8', kind: 'weight' },
          { id: 'd5b3m1', name: 'Jalón con rotación de torso', reps: '8', kind: 'weight' }
        ]
      },
      {
        id: 'd5b4', floor: '2', sets: 4, repsRaw: '10_10',
        movements: [
          { id: 'd5b4m0', name: 'Puente de glúteo con press', reps: '10', kind: 'weight' },
          { id: 'd5b4m1', name: 'Press cerrado con mancuerna', reps: '10', kind: 'weight' }
        ]
      },
      {
        id: 'd5b5', floor: null, tag: 'Cardio final', sets: 1,
        movements: [{ id: 'd5b5m0', name: 'Escaleras', reps: '25 min', kind: 'check' }]
      }
    ]
  }
];

export function totalSets(day) {
  return day.blocks.reduce((acc, b) => acc + b.sets * b.movements.length, 0);
}
