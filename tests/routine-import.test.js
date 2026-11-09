import { pdfTextLines, extractRoutinePdf } from '../js/routine-pdf.js';
import { parseRoutineText, sanitizeRoutine } from '../js/routine-parser.js';

export function makePdfFixture(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [index, lines] of pages.entries()) {
    const stream = lines.length ? `BT /F1 12 Tf 40 750 Td ${lines.map((line, lineIndex) => `${lineIndex ? '0 -18 Td ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n')} ET` : 'q Q';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new File([pdf], 'routine.pdf', { type: 'application/pdf' });
}

export async function runRoutineImportTests() {
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const viewport = { convertToViewportPoint: (left, top) => [left, -top] };
  const item = (str, left, top, width = str.length * 5) => ({ str, transform: [1, 0, 0, 1, left, top], width, height: 10 });
  const items = [item('Piso: DIA 1 Pierna', 20, 700), item('Se.', 400, 700), item('Reps', 460, 700), item('1 Press', 20, 680), item('4', 400, 680), item('10_12', 460, 680), item('con mancuerna + remo', 40, 668), item('2 25 MIN ESCALERAS', 20, 645)];
  const text = pdfTextLines(items.reverse(), viewport);
  assert(text.includes('1 Press con mancuerna + remo\t4\t10_12'), 'PDF columns keep wrapped name before sets and reps');
  assert(text.endsWith('2 25 MIN ESCALERAS'), 'final cardio not merged with preceding exercise');
  const shiftedHeaders = pdfTextLines([item('DIA 1', 20, 700), item('Se.', 400, 700), item('Reps', 460, 700),
    item('1 Press', 20, 680), item('3', 406, 680), item('8_10', 452, 680),
    item('2 Remo', 20, 660), item('4', 406, 660), item('12', 452, 660)], viewport);
  assert(shiftedHeaders.includes('1 Press\t3\t8_10') && shiftedHeaders.includes('2 Remo\t4\t12'), 'Centered headers do not misclassify left-aligned reps as series');
  const blankRepsWarnings = [];
  const blankReps = parseRoutineText(pdfTextLines([item('DIA 1', 20, 700), item('Se.', 400, 700), item('Reps', 460, 700),
    item('1 Extension [8 pesadas + 10 parciales]', 20, 680), item('3', 406, 680),
    item('2 Press + remo', 20, 650), item('4', 406, 650), item('8 PESADAS_7', 452, 650)], viewport, blankRepsWarnings));
  assert(blankReps.days[0].blocks.length === 2 && blankReps.days[0].blocks[0].sets === 3 && blankReps.days[0].blocks[1].sets === 4, 'Empty reps cell preserves sets and does not consume the next row');
  assert(blankReps.days[0].blocks[0].movements[0].reps === '—' && blankRepsWarnings.length === 1, 'Empty reps remain unspecified with a review warning');
  assert(blankReps.days[0].blocks[1].movements.map(movement => movement.reps).join('|') === '8 PESADAS|7', 'Explicit columns preserve textual reps without borrowing sets from the name');
  const continued = parseRoutineText(pdfTextLines([item('DIA 1', 20, 700), item('Se.', 400, 700), item('Reps', 460, 700),
    item('2 Remo inclinado', 20, 680), item('4', 406, 680), item('10+8+12', 452, 680),
    item('+ remo con mecate', 40, 668), item('_8', 452, 668),
    item('1 Curl', 20, 640), item('3', 406, 640), item('10', 452, 640)], viewport));
  assert(continued.days[0].blocks.length === 2 && continued.days[0].blocks[0].sets === 4 && continued.days[0].blocks[0].movements.length === 2, 'Wrapped superset and reps continue the same table row');
  const cardioTable = parseRoutineText(pdfTextLines([item('DIA 1', 20, 700), item('Se.', 400, 700), item('Reps', 460, 700),
    item('1 Eliptica 15min', 20, 680), item('Time', 406, 680), item('10m', 452, 680),
    item('ESCALERAS 12 MIN NIVEL 4 A 6', 20, 650)], viewport));
  assert(cardioTable.days[0].blocks.every(block => block.sets === 1 && block.movements[0].kind === 'check'), 'Timed cardio and stair levels do not become weighted sets');
  assert(cardioTable.warnings.length === 1 && cardioTable.days[0].blocks[0].movements[0].reps === '15min / 10m (PDF)', 'Conflicting cardio durations are preserved and flagged rather than silently chosen');
  assert(cardioTable.days[0].blocks[1].movements[0].reps === '12 MIN', 'Stair level is not parsed as a sets and reps tail');
  const prescriptions = parseRoutineText('NOTA: Revisar progresion cada dos semanas\nDIA 1\n1 Sentadilla + prensa 8+8s12+12s+15+15s\t3\t8 a 12\n1 Cross over 7 alto + 7 medio + 7 bajo + lagartijas fallo\t4\t—\n2 Elevacion lateral 12+15+ parciales 7+7+7 sentado\t3\t—\n1 Extension triceps 30s+20s5v\t3\t—\n2 Slam ball con press + 10 _ gusanos 8+ abductor 10\t3\t8+10+10+15 15S\nTercer semana todo se hace al fallo');
  assert(prescriptions.days[0].blocks.map(block => block.movements.length).join(',') === '2,2,1,1,3', 'Embedded numeric prescriptions and partials do not create phantom exercises');
  assert(prescriptions.days[0].blocks[0].movements[1].name.includes('8+8s12+12s+15+15s'), 'Mixed reps and seconds remain intact in the exercise prescription');
  assert(prescriptions.warnings.length === 2 && prescriptions.days[0].blocks.length === 5, 'Global and weekly coach notes require review without becoming exercises');
  const mixedDuration = parseRoutineText('DIA 1\n1 Toque de step 1min + Step up\t3\t8');
  assert(mixedDuration.days[0].blocks[0].movements[0].timer === 60 && mixedDuration.days[0].blocks[0].movements[1].reps === '8', 'A timed exercise and rep exercise in the same row retain different prescriptions');
  const incompleteBracket = parseRoutineText('DIA 1\n1 Crunch 30s + [plancha spider 30s+plank hold 35s\t3\t13 MIN DE ABDOMEN');
  assert(incompleteBracket.days[0].blocks[0].movements[1].name.includes('plank hold'), 'An incomplete bracket never silently discards a named exercise');
  assert(incompleteBracket.warnings.length === 1 && !incompleteBracket.days[0].blocks[0].movements[1].timer && incompleteBracket.days[0].blocks[0].movements[1].reps === '30s + 35s', 'Unclosed circuit grouping warns and does not invent a single timer for multiple exercises');
  const circuitBudget = parseRoutineText('DIA 1\n1 Crunch + plancha\t3\t10 MIN ABS');
  assert(circuitBudget.days[0].blocks[0].movements.every(movement => !movement.timer), 'Total circuit minutes are not assigned as a separate timer to every untimed movement');
  const parsed = parseRoutineText(text);
  assert(parsed.days[0].blocks[0].movements.length === 2 && parsed.days[0].blocks[0].sets === 4, 'PDF supersets retain sets and exercise count');
  assert(parsed.days[0].blocks[1].movements[0].kind === 'check', 'cardio remains check');
  const flat = parseRoutineText('DIA 1\n1 Swing 4 15\n2 Press 3 8-12\n1 Hack 4 8_10_12\n2 Plancha 3 25s');
  const blocks = flat.days[0].blocks;
  assert(blocks[0].movements[0].reps === '15', 'plain text reps');
  assert(blocks[1].movements[0].reps === '8-12', 'hyphenated rep ranges');
  assert(blocks[2].movements[0].reps === '8_10_12' && flat.warnings.length === 1, 'ambiguous single exercise keeps full prescription and warns');
  assert(blocks[3].movements[0].timer === 25 && blocks[3].movements[0].kind === 'check', 'seconds become timer rather than numeric reps');
  const circuit = parseRoutineText('DIA 2\n20S [TIJERAS }+ [TOQUE DE TALONES]20S + PLANCHA 25S REST 45s 3 6MIN ABS\n1 Remo 3 10');
  assert(circuit.days[0].blocks.length === 2, 'minute circuit does not consume next row');
  assert(circuit.days[0].blocks[0].rest === 45 && circuit.days[0].blocks[0].movements[2].timer === 25, 'circuit local times and rest retained');
  assert(circuit.days[0].blocks[0].movements[0].name.includes('TIJERAS'), 'bracketed exercise name not discarded as note');
  assert(sanitizeRoutine(flat.days)[0].blocks[3].movements[0].timer === 25, 'timer survives editor normalization');
  const warnings = [];
  pdfTextLines([item('DIA 1', 20, 700), item('Se.', 400, 700), item('Reps', 460, 700), item('1 Swing', 20, 680), item('15', 460, 680)], viewport, warnings);
  assert(warnings.length === 1, 'PDF missing sets requires review warning');
  assert(pdfTextLines([item('Sw', 20, 600, 10), item('ing', 30, 600, 15)], viewport) === 'Swing', 'adjacent glyph fragments join without artificial spaces');
  for (const file of [new File(['text'], 'routine.txt'), new File([], 'empty.pdf', { type: 'application/pdf' }), { name: 'large.pdf', size: 21 * 1024 * 1024 }]) {
    let rejected = false;
    try { await extractRoutinePdf(file); } catch { rejected = true; }
    assert(rejected, 'invalid empty or oversized PDF rejected before parsing');
  }
  const controller = new AbortController(); controller.abort();
  let aborted = false;
  try { await extractRoutinePdf(new File(['%PDF'], 'cancel.pdf'), { signal: controller.signal }); } catch (error) { aborted = error.name === 'AbortError'; }
  assert(aborted, 'cancelled PDF read stops before loading worker');
  const document = await extractRoutinePdf(makePdfFixture([['DIA 1', '1 Swing 4 15'], ['DIA 2', '1 Remo 3 8-12']]));
  assert(document.pages === 2 && parseRoutineText(document.text).days.length === 2, 'real PDF.js extracts multiple pages into routine days');
  const partial = await extractRoutinePdf(makePdfFixture([['DIA 1', '1 Swing 4 15'], []]));
  assert(partial.emptyPages.join(',') === '2', 'partly scanned document reports missing text pages');
  let blank = false;
  try { await extractRoutinePdf(makePdfFixture([[]])); } catch (error) { blank = error.message.includes('Live Text'); }
  assert(blank, 'image-only or empty page explains Live Text fallback');
  let damaged = false;
  try { await extractRoutinePdf(new File(['not a pdf'], 'broken.pdf')); } catch (error) { damaged = error.message.includes('dañado'); }
  assert(damaged, 'damaged PDF has actionable error');
  const pendingController = new AbortController();
  let cancelledDuringRead = false;
  try { await extractRoutinePdf({ name: 'pending.pdf', size: 10, arrayBuffer: async () => { pendingController.abort(); return new ArrayBuffer(10); } }, { signal: pendingController.signal }); } catch (error) { cancelledDuringRead = error.name === 'AbortError'; }
  assert(cancelledDuringRead, 'cancellation during file read stops late worker creation');
  const maximum = parseRoutineText('DIA 1\n1 Swing 12 10');
  assert(maximum.days[0].blocks[0].sets === 12, 'parser supports editor maximum of twelve sets');
  return { checks, result: 'PASS' };
}