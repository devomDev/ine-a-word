import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIne, validCurp, curpCheckDigit, findClave, pickNameLine, pickClave, nameHints } from "./ineParser.js";

const base = "MAFO910712HDFRLM0";
const CURP = base + curpCheckDigit(base);
const CLAVE = "MRFLOM91071209H400";

test("valida dígito verificador", () => {
  assert.equal(validCurp(CURP), true);
  assert.equal(validCurp(base + ((curpCheckDigit(base) + 1) % 10)), false);
});

test("extrae nombre, CURP y clave de texto OCR con errores", () => {
  const ocr = `INSTITUTO NACIONAL ELECTORAL
MÉXICO CREDENCIAL PARA VOTAR
NOMBRE SEXO H
MARÍN
FLORES
OMAR AARON
DOMICILIO C SUR 12
CLAVE DE ELECTOR MRFLOM91071209H400
CURP ${CURP.replace("0712", "O712")} AÑO DE REGISTRO 2009 02`;
  const r = parseIne(ocr);
  assert.equal(r.nombre, "OMAR AARON MARIN FLORES");
  assert.equal(r.curp, CURP);
  assert.equal(r.curpValida, true);
  assert.equal(r.clave, CLAVE);
  assert.equal(r.claveValida, true);
});

test("repara CURP con 9→5 y 0→O usando la clave de elector", () => {
  const bad = CURP.replace("MAFO9", "MAFO5").replace(/0(\d)$/, "O$1");
  const r = parseIne(`NOMBRE\nMARIN\nFLORES\nOMAR\nCLAVE DE ELECTOR ${CLAVE}\nCURP ${bad}`);
  assert.equal(r.curp, CURP);
  assert.equal(r.curpCorregida, true);
});

test("corrige fecha/entidad/sexo de la clave con la CURP", () => {
  // Lectura real del OCR sobre la credencial de ejemplo
  const k = findClave("CLVEDEELECTOR MRFLOMOlO7I200H400", CURP);
  assert.equal(k.clave, CLAVE);
  assert.equal(k.valid, true);
  assert.equal(k.corrected, true);
});

test("vota la clave entre lecturas", () => {
  assert.equal(pickClave(["MRFLOM91071209H100", CLAVE, CLAVE, "basura"], CURP).clave, CLAVE);
});

test("elige la lectura de nombre coherente con CURP y clave", () => {
  const hints = nameHints(CURP, CLAVE);
  assert.equal(pickNameLine(["FEQRES EA", "FEQRES A LT", "FLORES UL", "FLORES"], hints[1]), "FLORES");
  assert.equal(pickNameLine(["OMARAARON", "OMARAARON", "OMAR AARÓN", "OMAR AARON"], hints[2]), "OMAR AARON");
  assert.equal(pickNameLine(["MARÍN", "MARIN", "ARÍN", "MARIN"], hints[0]), "MARIN");
});
