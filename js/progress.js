export function sessionDuration(session) {
  const minutes = session.entries?._durationMinutes;
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
    ? minutes * 60000
    : Math.max(0, (session.finishedAt || Date.now()) - session.startedAt);
}

export function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function localWeek(timestamp) {
  const date = new Date(timestamp);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return localDay(date);
}

export function trainingAchievements(sessions, progressFor, weeklyGoal, now = Date.now()) {
  const finished = sessions.filter(session => session.finishedAt && !session.deletedAt && session.startedAt <= now)
    .map(session => ({ session, progress: progressFor(session) }))
    .filter(item => item.progress.done > 0);
  const weeks = new Map();
  for (const { session } of finished) {
    const key = localWeek(session.startedAt);
    if (!weeks.has(key)) weeks.set(key, new Set());
    weeks.get(key).add(localDay(session.startedAt));
  }
  const goal = Math.min(7, Math.max(1, Number(weeklyGoal) || 5));
  const completeWeeks = [...weeks.values()].filter(days => days.size >= goal).length;
  const series = finished.reduce((sum, item) => sum + item.progress.done, 0);
  const complete = finished.filter(item => item.progress.total > 0 && item.progress.done === item.progress.total).length;
  const days = new Set(finished.map(item => localDay(item.session.startedAt))).size;
  const names = ['Inicio', 'Base', 'Ritmo', 'Constancia', 'Consolidación', 'Dominio', 'Maestría', 'Legado'];
  const metrics = [
    { key: 'sessions', value: finished.length, targets: [1, 5, 20, 40, 75, 120, 180, 250], titles: ['Primer paso', 'Tomando ritmo', 'Base sólida', 'Cuarenta y contando', 'Ya es costumbre', 'Trayectoria propia', 'Veterano del gym', 'Un cuarto de mil'], description: target => `Finaliza ${target} ${target === 1 ? 'sesión' : 'sesiones'} con series registradas.` },
    { key: 'days', value: days, targets: [2, 5, 15, 30, 60, 100, 150, 200], titles: ['Volviste', 'Cinco días tuyos', 'Quince apariciones', 'Un mes de días', 'Sesenta motivos', 'Cien días presentes', 'Huella de constancia', 'Doscientos días'], description: target => `Entrena en ${target} días distintos, sin necesidad de que sean seguidos.` },
    { key: 'series', value: series, targets: [25, 100, 300, 750, 1500, 2500, 4000, 6000], titles: ['Serie a serie', 'Cada serie cuenta', 'Trescientas razones', 'Trabajo acumulado', 'Mil quinientas', 'Archivo de esfuerzo', 'Cuatro mil series', 'Colección de seis mil'], description: target => `Acumula ${target} series registradas en sesiones finalizadas.` },
    { key: 'complete', value: complete, targets: [1, 3, 8, 15, 25, 40, 65, 100], titles: ['De principio a fin', 'Tres planes completos', 'Ocho de ocho', 'Quince cierres', 'Plan tras plan', 'Cuarenta completos', 'Experiencia completa', 'Cien planes cerrados'], description: target => `Registra todas las series del plan en ${target} ${target === 1 ? 'sesión' : 'sesiones'}.` },
    { key: 'active-weeks', value: weeks.size, targets: [1, 2, 4, 8, 12, 20, 32, 52], titles: ['Esta semana cuenta', 'Otra semana más', 'Cuatro semanas presente', 'Ocho semanas tuyas', 'Doce semanas en marcha', 'Veinte capítulos', 'Treinta y dos semanas', 'Un año de semanas'], description: target => `Registra al menos una sesión en ${target} ${target === 1 ? 'semana' : 'semanas'}. No tienen que ser consecutivas.` },
    { key: 'goal-weeks', value: completeWeeks, targets: [1, 2, 4, 6, 10, 14, 20, 26], titles: ['Semana cumplida', 'Objetivo por dos', 'Constancia real', 'Seis semanas a tu ritmo', 'Diez objetivos', 'Catorce semanas logradas', 'Veinte semanas cumplidas', 'Medio año a tu ritmo'], description: target => `Cumple tu objetivo de ${goal} días en ${target} ${target === 1 ? 'semana' : 'semanas'}, no necesariamente seguidas.` }
  ];
  const legacyIds = { 'sessions-1': 'start', 'sessions-5': 'five', 'sessions-20': 'twenty', 'series-100': 'hundred', 'complete-1': 'complete', 'goal-weeks-1': 'week', 'goal-weeks-4': 'four-weeks' };
  const remainingUnits = { sessions: ['sesión finalizada', 'sesiones finalizadas'], days: ['día de entrenamiento distinto', 'días de entrenamiento distintos'], series: ['serie registrada', 'series registradas'], complete: ['sesión con todas las series', 'sesiones con todas las series'], 'active-weeks': ['semana con entrenamiento', 'semanas con entrenamiento'], 'goal-weeks': [`semana con ${goal} días entrenados`, `semanas con ${goal} días entrenados`] };
  const stages = [];
  for (const [index, title] of names.entries()) {
    const available = index === 0 || stages[index - 1].completed;
    const badges = metrics.map(metric => {
      const target = metric.targets[index], key = `${metric.key}-${target}`;
      const remaining = Math.max(0, target - metric.value);
      const remainingText = `${remaining === 1 ? 'Falta' : 'Faltan'} ${remaining} ${remainingUnits[metric.key][remaining === 1 ? 0 : 1]}.`;
      return { id: legacyIds[key] || key, stage: index, title: metric.titles[index], description: metric.description(target), value: Math.min(metric.value, target), target, remaining, remainingText, unlocked: available && metric.value >= target };
    });
    const count = badges.filter(badge => badge.unlocked).length;
    stages.push({ id: `stage-${index + 1}`, title, index, available, completed: available && count >= 4, count, target: 4, badges });
  }
  const current = stages.find(stage => !stage.completed) || stages.at(-1);
  const pending = (current.completed ? stages.flatMap(stage => stage.badges) : current.badges).filter(badge => !badge.unlocked);
  const nextBadge = [...pending].sort((first, second) => second.value / second.target - first.value / first.target)[0] || null;
  return {
    badges: stages.flatMap(stage => stage.badges), stages, current, nextBadge,
    week: { value: Math.min(weeks.get(localWeek(now))?.size || 0, goal), target: goal }
  };
}