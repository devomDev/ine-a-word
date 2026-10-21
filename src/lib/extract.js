import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";
import { parseIne, nameHints, pickNameLine, nombreCompleto, findClave, pickClave } from "./ineParser.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_PAGES = 4;
const BASE = import.meta.env.BASE_URL;

// Recursos de OCR servidos desde /public/tesseract (copiados en postinstall)
const OCR_OPTS = {
  workerPath: `${BASE}tesseract/worker.min.js`,
  corePath: `${BASE}tesseract/core`,
  langPath: `${BASE}tesseract/lang`,
  gzip: true,
};

const LETTERS = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZÁÉÍÓÚÜ ";

async function pageToCanvas(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, 2600 / base.width);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

// Copia una región del canvas, opcionalmente transformando sus píxeles
function region(src, [x, y, w, h], fn) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(src.width - x, Math.round(w)); h = Math.min(src.height - y, Math.round(h));
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
  if (fn) {
    const img = ctx.getImageData(0, 0, w, h);
    fn(img.data);
    ctx.putImageData(img, 0, 0);
  }
  return out;
}

// Recorta el margen blanco de la página: la credencial suele ocupar solo una parte
function cropToContent(c) {
  const { data } = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  const rows = new Uint32Array(c.height), cols = new Uint32Array(c.width);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 225) { rows[y]++; cols[x]++; }
    }
  }
  const span = (arr, min) => {
    let a = 0, b = arr.length - 1;
    while (a < b && arr[a] < min) a++;
    while (b > a && arr[b] < min) b--;
    return [a, b];
  };
  const [y0, y1] = span(rows, c.width * 0.05);
  const [x0, x1] = span(cols, c.height * 0.05);
  if (x1 - x0 < c.width * 0.2 || y1 - y0 < c.height * 0.1) return c;
  const pad = 20;
  return region(c, [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad]);
}

function gray(d) {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
}

// Binarización Otsu; `shift` < 0 conserva solo los trazos más oscuros (quita holograma)
const otsu = (shift = 0) => (d) => {
  gray(d);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i] | 0]++;
  const total = d.length / 4;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sB += i * hist[i];
    const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > best) { best = v; th = i; }
  }
  th += shift;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] < th ? 0 : 255;
};

const VARIANTS = [null, gray, otsu(), otsu(-20)];

const wordsOf = (data) =>
  (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));

// Ubica las 3 líneas del nombre: debajo de la etiqueta NOMBRE o, si el OCR no la leyó,
// encima de DOMICILIO. Las líneas que la lectura omitió se infieren por el espaciado.
function nameLines(words) {
  const label = words.find((w) => /^N[O0]MBR/i.test(w.text));
  const dom = words.find((w) => /^D[O0]M[I1L]C/i.test(w.text));
  const ref = label || dom;
  if (!ref) return null;
  const refH = ref.bbox.y1 - ref.bbox.y0;
  const top = label ? label.bbox.y0 + refH / 2 : -Infinity;
  // Límite inferior: DOMICILIO, o CLAVE DE ELECTOR / CURP si no se leyó
  const below = words.filter((w) => /^D[O0]M[I1L]C|CLAVE|ELECTOR|^CURP/i.test(w.text) && w.bbox.y0 > top);
  const bottom = below.length ? Math.min(...below.map((w) => w.bbox.y0)) - refH / 3 : Infinity;
  const firsts = words
    .filter((w) => w !== ref && Math.abs(w.bbox.x0 - ref.bbox.x0) < refH && w.bbox.y0 > top && w.bbox.y0 < bottom
      && /[A-ZÑ]{3}/i.test(w.text))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0);

  // Varias pasadas repiten palabras: se agrupan por renglón y se usa la caja más ajustada
  let rows = [];
  for (const w of firsts) {
    const last = rows[rows.length - 1];
    const wh = w.bbox.y1 - w.bbox.y0;
    if (last && w.bbox.y0 - last.y0 < refH / 3) {
      if (wh < last.h) Object.assign(last, { y: w.bbox.y0, h: wh });
      last.y0 = w.bbox.y0;
    } else rows.push({ y: w.bbox.y0, y0: w.bbox.y0, h: wh });
  }
  rows = label ? rows.slice(0, 3) : rows.slice(-3);
  if (!rows.length) return null;
  const hs = rows.map((r) => r.h).sort((a, b) => a - b);
  const h = hs[hs.length >> 1];
  const gaps = rows.slice(1).map((r, i) => r.y - rows[i].y).filter((g) => g > h / 2);
  const pitch = Math.min(...gaps, 1.15 * h);

  const lines = [];
  let prev = label ? label.bbox.y0 : rows[0].y - pitch;
  for (const { y } of rows) {
    const gap = y - prev;
    if (lines.length >= 3 || gap > 3.5 * pitch) break;
    // La etiqueta NOMBRE deja más aire que el interlineado normal
    const k = Math.max(1, Math.round(gap / pitch - (lines.length ? 0 : 0.4)));
    for (let j = 1; j < k; j++) lines.push(prev + (j * gap) / k);
    lines.push(y);
    prev = y;
  }
  while (lines.length < 3 && lines[lines.length - 1] + pitch < bottom - pitch / 3) {
    lines.push(lines[lines.length - 1] + pitch);
  }
  return {
    lines: lines.slice(0, 3).map((y) => [ref.bbox.x0 - h / 2, y - 0.15 * pitch, 25 * h, 1.1 * pitch]),
    gap: 1.5 * h,
  };
}

// Texto de una línea leída con PSM 7, cortando lo que quede lejos a la derecha (holograma)
function lineText(data, gap) {
  const out = [];
  let prevX = null;
  for (const w of wordsOf(data)) {
    if (prevX !== null && w.bbox.x0 - prevX > gap) break;
    out.push(w.text);
    prevX = w.bbox.x1;
  }
  return out.join(" ");
}

// Lee una región con PSM 7 en todas las variantes de imagen
async function readLine(worker, canvas, box, whitelist, gap) {
  await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: whitelist, preserve_interword_spaces: "1" });
  const out = [];
  try {
    for (const fn of VARIANTS) {
      const { data } = await worker.recognize(region(canvas, box, fn), {}, { blocks: true });
      out.push(gap ? lineText(data, gap) : data.text.trim());
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: "3", tessedit_char_whitelist: "", preserve_interword_spaces: "0" });
  }
  return out;
}

async function refineName(worker, canvas, words, first) {
  const found = nameLines(words);
  if (!found) return null;
  const hints = nameHints(first.curp, first.clave);
  const parts = [];
  for (let i = 0; i < found.lines.length; i++) {
    const readings = await readLine(worker, canvas, found.lines[i], LETTERS, found.gap);
    const line = pickNameLine(readings, hints[parts.length]);
    if (/^D[O0]M/.test(line)) break;
    if (line) parts.push(line);
  }
  if (!parts.length) return null;
  const [paterno = "", materno = "", nombres = ""] = parts.length === 2 ? [parts[0], "", parts[1]] : parts;
  return { paterno, materno, nombres };
}

// Relee la clave de elector en su propio renglón y vota entre variantes
async function refineClave(worker, canvas, words, curp) {
  const w = words.find((x) => findClave(x.text, curp).clave);
  if (!w) return null;
  const h = w.bbox.y1 - w.bbox.y0;
  const box = [w.bbox.x0 - 0.4 * h, w.bbox.y0 - 0.3 * h, w.bbox.x1 - w.bbox.x0 + 0.8 * h, 1.6 * h];
  const readings = await readLine(worker, canvas, box, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  return pickClave([w.text, ...readings], curp);
}

function rotate(src, deg) {
  const out = document.createElement("canvas");
  const swap = deg % 180 !== 0;
  out.width = swap ? src.height : src.width;
  out.height = swap ? src.width : src.height;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

const orientationScore = (text) => {
  const r = parseIne(text);
  return (r.curpValida ? 4 : 0) + (r.claveValida ? 2 : 0)
    + (/N[O0]MBRE/i.test(text) ? 1 : 0) + (/INSTITUTO|ELECTORAL|CREDENCIAL/i.test(text) ? 1 : 0);
};

function scaled(src, f) {
  const out = document.createElement("canvas");
  out.width = Math.round(src.width * f);
  out.height = Math.round(src.height * f);
  out.getContext("2d").drawImage(src, 0, 0, out.width, out.height);
  return out;
}

// La foto puede venir girada. Primero se lee derecha; si no parece una INE, se prueban
// las otras orientaciones en baja resolución y solo la mejor se lee completa.
async function orient(worker, page, onTry) {
  const { data } = await worker.recognize(page, {}, { blocks: true });
  const score = orientationScore(data.text);
  if (score >= 6) return { canvas: page, data };
  const small = scaled(page, 0.5);
  let best = { deg: 0, score };
  for (const deg of [90, 270, 180]) {
    onTry(deg);
    const s = orientationScore((await worker.recognize(rotate(small, deg))).data.text);
    if (s > best.score) best = { deg, score: s };
  }
  if (!best.deg) return { canvas: page, data };
  const canvas = rotate(page, best.deg);
  return { canvas, data: (await worker.recognize(canvas, {}, { blocks: true })).data };
}

const complete = (r) => r.curpValida && r.nombre && r.claveValida;

export async function extractFromPdf(file, onStep = () => {}) {
  onStep("Abriendo PDF…", 0.02);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const n = Math.min(pdf.numPages, MAX_PAGES);

  // 1) Capa de texto (PDF digital)
  let text = "";
  for (let p = 1; p <= n; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    text += tc.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n";
  }
  const fromText = parseIne(text);
  if (complete(fromText)) return { ...fromText, raw: text, via: "Texto del PDF" };

  // 2) OCR sobre la imagen
  onStep("Iniciando OCR…", 0.08);
  let pageIdx = 1;
  const worker = await createWorker("spa", 1, {
    ...OCR_OPTS,
    logger: (m) => {
      if (m.status === "recognizing text") {
        onStep(`Leyendo página ${pageIdx} de ${n}…`, 0.15 + 0.85 * ((pageIdx - 1 + m.progress) / n));
      }
    },
  });

  let ocr = "";
  let name = null;
  let clave = null;
  try {
    for (; pageIdx <= n; pageIdx++) {
      onStep(`Renderizando página ${pageIdx} de ${n}…`, 0.12);
      const page = cropToContent(await pageToCanvas(await pdf.getPage(pageIdx)));
      const { canvas, data } = await orient(worker, page, (deg) => onStep(`Probando orientación ${deg}° (página ${pageIdx})…`, 0.3));
      let words = wordsOf(data);
      ocr += data.text + "\n";
      let r = parseIne(ocr);
      // Fondo holográfico: si falta algún dato, más lecturas con otras variantes de imagen
      for (const fn of [otsu(-20), gray]) {
        if (r.curpValida && r.claveValida && words.some((w) => /^N[O0]MBR/i.test(w.text))) break;
        const extra = await worker.recognize(region(canvas, [0, 0, canvas.width, canvas.height], fn), {}, { blocks: true });
        ocr += extra.data.text + "\n";
        words = words.concat(wordsOf(extra.data));
        r = parseIne(ocr);
      }
      if (!clave) {
        onStep(`Leyendo clave de elector (página ${pageIdx})…`, 0.85);
        clave = await refineClave(worker, canvas, words, r.curp);
      }
      if (!name) {
        onStep(`Leyendo nombre (página ${pageIdx})…`, 0.9);
        name = await refineName(worker, canvas, words, { ...r, clave: clave?.clave || r.clave });
      }
      if (r.curpValida && name && clave) break;
    }
  } finally {
    await worker.terminate();
  }
  const r = parseIne(text + "\n" + ocr);
  const nm = name && nombreCompleto(name) ? name : r;
  const cl = clave || findClave(text + "\n" + ocr, r.curp);
  return {
    ...r, ...nm, nombre: nombreCompleto(nm),
    clave: cl.clave, claveValida: cl.valid, claveCorregida: cl.corrected,
    raw: ocr || text, via: "OCR",
  };
}
