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

// Ubica las 3 líneas del nombre debajo de la etiqueta NOMBRE. La primera lectura a veces
// omite una línea: se infiere por el espaciado entre renglones.
function nameLines(words) {
  const label = words.find((w) => /^N[O0]MBRE/i.test(w.text));
  if (!label) return null;
  const h = label.bbox.y1 - label.bbox.y0;
  const firsts = words
    .filter((w) => Math.abs(w.bbox.x0 - label.bbox.x0) < h && w.bbox.y0 > label.bbox.y0 + h / 2)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const pitch = firsts.length && firsts[0].bbox.y0 - label.bbox.y0 < 1.5 * h
    ? firsts[0].bbox.y0 - label.bbox.y0 : 0.85 * h;
  const ys = [];
  let prev = label.bbox.y0;
  for (const w of firsts) {
    const gap = w.bbox.y0 - prev;
    if (ys.length >= 3 || gap > 3.5 * pitch || /^D[O0]M/i.test(w.text)) break;
    const k = Math.max(1, Math.round(gap / pitch));
    for (let j = 1; j < k; j++) ys.push(prev + (j * gap) / k);
    ys.push(w.bbox.y0);
    prev = w.bbox.y0;
  }
  while (ys.length < 3) ys.push((ys.length ? ys[ys.length - 1] : label.bbox.y0) + pitch);
  return {
    lines: ys.slice(0, 3).map((y) => [label.bbox.x0 - h / 2, y - 0.12 * pitch, 16 * h, 1.05 * pitch]),
    gap: 1.2 * h,
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
      const canvas = cropToContent(await pageToCanvas(await pdf.getPage(pageIdx)));
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      ocr += data.text + "\n";
      let r = parseIne(ocr);
      // Fondo holográfico: si la CURP no salió, segunda lectura en escala de grises
      if (!r.curpValida) {
        const g = await worker.recognize(region(canvas, [0, 0, canvas.width, canvas.height], gray));
        ocr += g.data.text + "\n";
        r = parseIne(ocr);
      }
      if (!clave) {
        onStep(`Leyendo clave de elector (página ${pageIdx})…`, 0.85);
        clave = await refineClave(worker, canvas, wordsOf(data), r.curp);
      }
      if (!name) {
        onStep(`Leyendo nombre (página ${pageIdx})…`, 0.9);
        name = await refineName(worker, canvas, wordsOf(data), { ...r, clave: clave?.clave || r.clave });
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
