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
  assert(text.includes('1 Press con mancuerna + remo 4 10_12'), 'PDF columns keep wrapped name before sets and reps');
  assert(text.endsWith('2 25 MIN ESCALERAS'), 'final cardio not merged with preceding exercise');
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