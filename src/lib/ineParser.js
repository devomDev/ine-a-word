// Extracción de Nombre / CURP / Clave de elector desde texto de una credencial INE.
// JS puro: sin dependencias, testeable con `npm test`.

const DICT = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";
const ENTIDADES = ["AS","BC","BS","CC","CL","CM","CS","CH","DF","DG","GT","GR","HG","JC","MC","MN",
  "MS","NT","NL","OC","PL","QT","QR","SP","SL","SR","TC","TS","TL","VZ","YN","ZS","NE"];
const TO_LETTER = { 0: "O", 1: "I", 2: "Z", 5: "S", 8: "B", 6: "G", 4: "A" };
const TO_DIGIT = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6", A: "4", T: "7" };

export function curpCheckDigit(c17) {
  let s = 0;
  for (let i = 0; i < 17; i++) {
    const v = DICT.indexOf(c17[i]);
    if (v < 0) return -1;
    s += v * (18 - i);
  }
  return (10 - (s % 10)) % 10;
}

// Posición 17: dígito si nació en 1900–1999, letra si nació en 2000+.
// Si YY es mayor al año actual, solo puede ser 19YY → debe ser dígito.
const NOW_YY = new Date().getFullYear() % 100;
function centuryConsistent(c) {
  return Number(c.substr(4, 2)) <= NOW_YY || /\d/.test(c[16]);
}

export function validCurp(c) {
  return typeof c === "string"
    && /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HMX][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d$/.test(c)
    && ENTIDADES.includes(c.substr(11, 2))
    && centuryConsistent(c)
    && curpCheckDigit(c.substr(0, 17)) === Number(c[17]);
}

// Corrige confusiones típicas de OCR según la posición del carácter
function normalizeCurp(raw) {
  const c = raw.toUpperCase().split("");
  for (let i = 0; i < 18; i++) {
    const isDigit = (i >= 4 && i <= 9) || i === 17;
    const isLetter = i < 4 || (i >= 10 && i <= 15);
    if (isDigit && TO_DIGIT[c[i]]) c[i] = TO_DIGIT[c[i]];
    if (isLetter && TO_LETTER[c[i]]) c[i] = TO_LETTER[c[i]];
  }
  const yy = c.slice(4, 6).join("");
  if (/^\d\d$/.test(yy) && Number(yy) > NOW_YY && TO_DIGIT[c[16]]) c[16] = TO_DIGIT[c[16]];
  return c.join("");
}

// Fecha YYMMDD de la clave de elector (6 letras + fecha + 2 dígitos + H/M + 3)
function birthFromClave(up) {
  const m = up.replace(/\s/g, "").match(/[A-Z]{6}([0-9OIZSBGQD]{6})[0-9OIZSBGQD]{2}[HM][0-9OIZSBGQD]{3}/);
  if (!m) return null;
  const d = m[1].split("").map((ch) => TO_DIGIT[ch] || ch).join("");
  return /^\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d) ? d : null;
}

// Pares que el OCR confunde con frecuencia
const CONFUSE = {
  0: "O8", 1: "7I", 2: "Z7", 3: "8", 4: "A", 5: "S96", 6: "G58", 7: "1T", 8: "B03", 9: "5",
  O: "0QD", I: "1L", Z: "2", S: "5", B: "8", G: "6", Q: "O", D: "O", L: "I", T: "7",
};

// Busca la corrección mínima (1–2 sustituciones) que pase el dígito verificador
function repairCurp(c) {
  const ok = (x) => validCurp(x);
  const at = (s, i, ch) => s.slice(0, i) + ch + s.slice(i + 1);
  for (let i = 0; i < 18; i++) {
    for (const a of CONFUSE[c[i]] || "") {
      const x = at(c, i, a);
      if (ok(x)) return x;
    }
  }
  for (let i = 0; i < 18; i++) {
    for (const a of CONFUSE[c[i]] || "") {
      const x = at(c, i, a);
      for (let j = i + 1; j < 18; j++) {
        for (const b of CONFUSE[x[j]] || "") {
          const y = at(x, j, b);
          if (ok(y)) return y;
        }
      }
    }
  }
  return null;
}

export function findCurp(text) {
  const up = text.toUpperCase();
  const cands = [];
  let m;
  const afterLabel = /CURP[\s:.]*([A-Z0-9 ]{18,24})/g;
  while ((m = afterLabel.exec(up))) cands.push(m[1].replace(/\s/g, "").substr(0, 18));
  const loose = /\b[A-Z0-9]{18}\b/g;
  while ((m = loose.exec(up))) cands.push(m[0]);

  const birth = birthFromClave(up);
  let fallback = null;
  for (const cand of cands) {
    if (cand.length < 18) continue;
    let n = normalizeCurp(cand);
    if (validCurp(n)) return { curp: n, valid: true, corrected: false };
    // La fecha de la clave de elector es una segunda lectura del mismo dato
    if (birth) {
      n = normalizeCurp(n.slice(0, 4) + birth + n.slice(10));
      if (validCurp(n)) return { curp: n, valid: true, corrected: true };
    }
    const fixed = repairCurp(n);
    if (fixed) return { curp: fixed, valid: true, corrected: true };
    if (!fallback && /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(n)) fallback = n;
  }
  return { curp: fallback || "", valid: false, corrected: false };
}

const STOP = /^(DOMICILIO|CLAVE|CURP|FECHA|SECCI|A[ÑN]O|VIGENCIA|EMISI|ESTADO|MUNICIPIO|LOCALIDAD|EDAD|REGISTRO)/;

function cleanLine(l) {
  return l.toUpperCase()
    .replace(/SEXO\s*[HMX]?/g, " ")
    .replace(/[^A-ZÁÉÍÓÚÜÑ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function findName(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /\bNOMBRE\b/i.test(l));
  if (start < 0) return { paterno: "", materno: "", nombres: "" };
  const out = [];
  const rest = cleanLine(lines[start].replace(/.*NOMBRE/i, ""));
  if (rest.length > 1) out.push(rest);
  for (let j = start + 1; j < lines.length && out.length < 3; j++) {
    const l = cleanLine(lines[j]);
    if (STOP.test(l)) break;
    if (l.replace(/ /g, "").length < 2) continue;
    out.push(l);
  }
  return { paterno: out[0] || "", materno: out[1] || "", nombres: out[2] || "" };
}

// Clave de elector: 6 letras + AAMMDD + entidad (2) + sexo + 3 dígitos.
// Fecha, entidad y sexo son los mismos datos de la CURP.
export function validClave(k) {
  return typeof k === "string" && /^[A-Z]{6}\d{6}\d{2}[HM]\d{3}$/.test(k);
}

const AMB = "0-9OIZSBGQDTL";
const CLAVE_RE = new RegExp(`[A-Z0-9]{6}[${AMB}]{8}[HM][${AMB}]{3}`, "g");

export function findClave(text, curp = "") {
  const up = text.toUpperCase();
  const lines = up.split(/\r?\n/).map((l) => l.replace(/[^A-Z0-9]/g, ""));
  for (const line of lines) {
    for (const m of line.matchAll(CLAVE_RE)) {
      const c = m[0].split("");
      for (let i = 0; i < 18; i++) {
        if (i < 6 && TO_LETTER[c[i]]) c[i] = TO_LETTER[c[i]];
        if ((i >= 6 && i <= 13) || i >= 15) c[i] = TO_DIGIT[c[i]] || c[i];
      }
      let k = c.join("");
      if (!/^[A-Z]{6}\d{8}[HM]\d{3}$/.test(k) || k === curp) continue;
      let corrected = false;
      if (validCurp(curp)) {
        const ent = ENTIDADES.indexOf(curp.substr(11, 2)) + 1;
        const fixed = k.slice(0, 6) + curp.substr(4, 6)
          + (ent >= 1 && ent <= 32 ? String(ent).padStart(2, "0") : k.substr(12, 2))
          + curp[10] + k.slice(15);
        corrected = fixed !== k;
        k = fixed;
      }
      return { clave: k, valid: validClave(k), corrected };
    }
  }
  return { clave: "", valid: false, corrected: false };
}

// Vota la clave entre varias lecturas de la misma línea
export function pickClave(readings, curp = "") {
  const votes = new Map();
  let best = null;
  for (const r of readings) {
    const k = findClave(r, curp);
    if (!k.valid) continue;
    const v = (votes.get(k.clave) || 0) + 1;
    votes.set(k.clave, v);
    if (!best || v > votes.get(best.clave)) best = k;
  }
  return best;
}

// ── Nombre ──
const noAccent = (s) => s.replace(/Ñ/g, "\0").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\0/g, "Ñ");
const PARTICLES = new Set(["DE", "LA", "LAS", "LOS", "DEL", "Y", "MA", "VAN", "VON", "DA", "DI", "MC"]);

// Limpia una lectura de línea: solo letras; descarta fragmentos de 1–2 letras que no sean partículas
export function cleanNameLine(s) {
  return noAccent((s || "").toUpperCase())
    .replace(/[^A-ZÑ ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 || PARTICLES.has(t))
    .join(" ")
    .replace(/^(DE|LA|LAS|LOS|DEL|Y)( (DE|LA|LAS|LOS|DEL|Y))*$/, "")
    .trim();
}

// Letra inicial + primera consonante interna (así forma la clave de elector cada par)
const pairOf = (s) => {
  const w = s.replace(/ /g, "");
  const m = w.slice(1).match(/[B-DF-HJ-NP-TV-ZÑ]/);
  return w[0] + (m ? m[0] : "");
};

const initialOk = (s, ch, isGiven) => {
  if (!ch || !s) return false;
  if (s[0] === ch) return true;
  return isGiven && /^(JOSE|MARIA|MA|J) \S/.test(s) && s.split(" ")[1][0] === ch;
};

// Elige la mejor lectura de una línea: votos entre variantes + coherencia con CURP y clave
export function pickNameLine(readings, { initial = "", pair = "", given = false } = {}) {
  // Se agrupa sin espacios ("OMARAARON" = "OMAR AARON") y se conserva la variante con más espacios
  const groups = new Map();
  for (const r of readings) {
    const c = cleanNameLine(r);
    const key = c.replace(/ /g, "");
    if (key.length < 2) continue;
    const g = groups.get(key) || { votes: 0, text: c };
    g.votes++;
    if (c.split(" ").length > g.text.split(" ").length) g.text = c;
    groups.set(key, g);
  }
  let best = "", bestScore = -1;
  for (const { votes, text } of groups.values()) {
    const s = votes + (initialOk(text, initial, given) ? 2 : 0) + (pair && pairOf(text) === pair ? 2 : 0);
    if (s > bestScore) { best = text; bestScore = s; }
  }
  return best;
}

export function nameHints(curp = "", clave = "") {
  const k = validClave(clave) ? clave : "";
  return [
    { initial: curp[0] || "", pair: k.slice(0, 2) },
    { initial: curp[2] && curp[2] !== "X" ? curp[2] : "", pair: k.slice(2, 4) },
    { initial: curp[3] || "", pair: k.slice(4, 6), given: true },
  ];
}

export function nombreCompleto(f) {
  return [f.nombres, f.paterno, f.materno].filter(Boolean).join(" ");
}

export function parseIne(text) {
  const cu = findCurp(text);
  const nm = findName(text);
  const cl = findClave(text, cu.curp);
  const clean = {
    paterno: cleanNameLine(nm.paterno),
    materno: cleanNameLine(nm.materno),
    nombres: cleanNameLine(nm.nombres),
  };
  return {
    ...clean,
    nombre: nombreCompleto(clean),
    curp: cu.curp, curpValida: cu.valid, curpCorregida: cu.corrected,
    clave: cl.clave, claveValida: cl.valid, claveCorregida: cl.corrected,
  };
}
