export function pdfTextLines(items, viewport, warnings = []) {
  const fragments = items.filter(item => typeof item.str === 'string' && item.str.trim() && item.transform).map(item => {
    const [left, top] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return { text: item.str, left, top, width: item.width, height: Math.abs(item.height) || 10 };
  }).sort((first, second) => first.top - second.top || first.left - second.left);
  const lines = [];
  for (const fragment of fragments) {
    const line = lines.at(-1);
    if (line && Math.abs(fragment.top - line.top) <= Math.min(3, fragment.height * 0.25)) line.fragments.push(fragment);
    else lines.push({ top: fragment.top, fragments: [fragment] });
  }
  const join = fragments => {
    const sorted = fragments.sort((first, second) => first.left - second.left);
    return sorted.map((fragment, index) => {
      const previous = sorted[index - 1];
      const gap = previous ? fragment.left - previous.left - previous.width : 0;
      const separator = previous && gap > Math.min(fragment.height, previous.height) * 0.12 ? ' ' : '';
      return separator + fragment.text;
    }).join('').trim();
  };
  const output = [];
  let columns, pending;
  const flush = () => {
    if (!pending) return;
    const name = pending.names.join(' '), series = pending.series.join(' '), reps = pending.reps.join(' ');
    if (reps) {
      const sets = series.match(/^\d{1,2}\b/)?.[0];
      if (!sets) warnings.push(`No se indicaron series para "${name.slice(0, 60)}". Se proponen 3; revísalas.`);
      const rest = series.match(/REST\s*(\d+)\s*S/i);
      output.push(`${name}${rest ? ` REST ${rest[1]}s` : ''} ${sets || 3} ${reps}`);
    } else output.push(name);
    pending = null;
  };
  for (const line of lines) {
    const text = join(line.fragments);
    const seriesHeader = line.fragments.find(fragment => /^se\.?$/i.test(fragment.text.trim()));
    const repsHeader = line.fragments.find(fragment => /^reps?$/i.test(fragment.text.trim()));
    if (seriesHeader && repsHeader) {
      flush();
      columns = { series: seriesHeader.left - 4, reps: repsHeader.left - 4 };
      output.push(text);
      continue;
    }
    if (!columns || /^(?:piso\s*:\s*)?d[ií]a\s*\d/i.test(text)) { flush(); output.push(text); continue; }
    const name = join(line.fragments.filter(fragment => fragment.left < columns.series));
    const series = join(line.fragments.filter(fragment => fragment.left >= columns.series && fragment.left < columns.reps));
    const reps = join(line.fragments.filter(fragment => fragment.left >= columns.reps));
    const cardio = /^(?:(?:1\s*o\s*2|[12])\s+)?(?:\d+\s*(?:min|m)\s+)?(?:card\b|cardio\b|movilidad|estiramiento|escaleras|caminadora)/i.test(name);
    if (cardio) {
      flush();
      output.push(`${name}${/^\d+$/.test(series) && reps ? ` ${series} ${reps}` : ''}`);
      continue;
    }
    const startsRow = /^(?:1\s*o\s*2|[12])\s+/i.test(name) || /^\d{1,2}(?:\s|$)/.test(series) || Boolean(reps && name);
    if (startsRow) flush();
    pending ||= { names: [], series: [], reps: [] };
    if (name) pending.names.push(name);
    if (series) pending.series.push(series);
    if (reps) pending.reps.push(reps);
  }
  flush();
  return output.join('\n');
}

export async function extractRoutinePdf(file, { signal } = {}) {
  if (!file || !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('Selecciona un archivo PDF.');
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('El PDF debe tener contenido y pesar como máximo 20 MB.');
  let task;
  let stopped = false;
  let timer;
  let cancel;
  const cancelled = new Promise((_, reject) => { cancel = reject; });
  const abort = () => cancel(new DOMException('Lectura cancelada', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => cancel(new Error('El PDF tardó demasiado. Prueba copiar su texto o usar un archivo más pequeño.')), 30000);
  try {
    if (signal?.aborted) throw new DOMException('Lectura cancelada', 'AbortError');
    const read = async () => {
      const pdfjs = await import('./vendor/pdfjs/build/pdf.mjs');
      const data = new Uint8Array(await file.arrayBuffer());
      if (stopped || signal?.aborted) throw new DOMException('Lectura cancelada', 'AbortError');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.mjs', import.meta.url).href;
      task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, disableFontFace: true });
      const document = await task.promise;
      if (document.numPages > 40) throw new Error('El PDF tiene más de 40 páginas. Selecciona solo las páginas de la rutina.');
      const pages = [], emptyPages = [], warnings = [];
      let length = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = pdfTextLines(content.items, page.getViewport({ scale: 1 }), warnings);
        if (!text.trim()) emptyPages.push(pageNumber);
        length += text.length;
        if (length > 300000) throw new Error('El PDF contiene demasiado texto. Selecciona solo las páginas de la rutina.');
        pages.push(text);
        page.cleanup();
      }
      const text = pages.join('\n');
      if (!text.trim()) throw new Error('Este PDF no tiene texto extraíble. Usa Live Text en una foto o captura y pega el texto de la rutina.');
      return { text, pages: document.numPages, emptyPages, warnings };
    };
    return await Promise.race([read(), cancelled]);
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('El PDF tiene contraseña. Usa una copia sin protección o pega su texto.');
    if (error.name === 'InvalidPDFException') throw new Error('No se pudo leer este PDF. Puede estar dañado; prueba otra copia.');
    throw error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await task?.destroy().catch(() => {});
  }
}