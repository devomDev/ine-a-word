import { useRef, useState } from "react";
import { extractFromPdf } from "./lib/extract.js";
import { buildDocx, downloadBlob } from "./lib/buildDocx.js";
import { validCurp, validClave } from "./lib/ineParser.js";

const EMPTY = { nombre: "", curp: "", clave: "" };

export default function App() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState({ msg: "", p: 0 });
  const [data, setData] = useState(null);
  const [raw, setRaw] = useState("");
  const [via, setVia] = useState("");
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const [fixed, setFixed] = useState({ curp: false, clave: false });
  const input = useRef(null);

  const pick = (f) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) {
      setErr("El archivo no es PDF. Selecciona un .pdf.");
      return;
    }
    setFile(f); setData(null); setErr(""); setRaw(""); setVia("");
  };

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const r = await extractFromPdf(file, (msg, p) => setStep({ msg, p }));
      setRaw(r.raw); setVia(r.via); setFixed({ curp: !!r.curpCorregida, clave: !!r.claveCorregida });
      setData({ nombre: r.nombre, curp: r.curp, clave: r.clave });
      if (!r.curp && !r.nombre && !r.clave) {
        setErr("No se detectó una INE legible. Captura los datos a mano o usa un PDF con mejor resolución.");
      }
    } catch (e) {
      console.error(e);
      setErr(`No se pudo procesar el PDF: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => {
    const v = e.target.value.toUpperCase();
    setData((d) => ({ ...d, [k]: v }));
  };

  const download = async () => {
    const blob = await buildDocx(data);
    const base = (data.curp || data.nombre || "datos").trim().replace(/\s+/g, "_");
    downloadBlob(blob, `INE_${base}.docx`);
  };

  const curpOk = data && validCurp(data.curp);
  const claveOk = data && validClave(data.clave);

  return (
    <main className="wrap">
      <header>
        <h1>INE a Word</h1>
        <p className="sub">Sube el PDF con la credencial, revisa los datos y descarga el .docx. Todo se procesa en este navegador; el archivo no sale de tu equipo.</p>
      </header>

      <section className="panel">
        <div
          className={`drop${over ? " on" : ""}`}
          tabIndex={0}
          role="button"
          onClick={() => input.current.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}
        >
          {file
            ? <><strong>{file.name}</strong><br />{(file.size / 1024).toFixed(0)} KB · clic para cambiar</>
            : <><strong>Selecciona tu PDF</strong><br />o arrástralo aquí</>}
        </div>
        <input id="pdf" ref={input} type="file" accept="application/pdf,.pdf" hidden
          onChange={(e) => { pick(e.target.files[0]); e.target.value = ""; }} />

        <div className="row">
          <button className="primary" disabled={!file || busy} onClick={run}>
            {busy ? "Extrayendo…" : "Extraer datos"}
          </button>
          {busy && <span className="status">{step.msg}</span>}
        </div>
        {busy && <div className="bar"><i style={{ width: `${Math.round(step.p * 100)}%` }} /></div>}
        {err && <p className="bad msg">{err}</p>}
      </section>

      {data && (
        <section className="panel">
          <div className="grid">
            <label className="f full">Nombre completo<input id="nombre" value={data.nombre} onChange={set("nombre")} /></label>
            <label className="f full">CURP<input id="curp" className="mono" maxLength={18} value={data.curp} onChange={set("curp")} /></label>
            <p className={`hint full ${curpOk ? "ok" : "bad"}`}>
              {curpOk ? "CURP válida (dígito verificador correcto)." : "CURP inválida o incompleta. Corrígela contra la credencial."}
              {curpOk && fixed.curp && <span className="warn"> Se corrigieron errores de lectura; confírmala contra la credencial.</span>}
            </p>
            <label className="f full">Clave de elector<input id="clave" className="mono" maxLength={18} value={data.clave} onChange={set("clave")} /></label>
            <p className={`hint full ${claveOk ? "ok" : "bad"}`}>
              {claveOk ? "Formato de clave de elector correcto." : "Clave de elector inválida o incompleta. Corrígela contra la credencial."}
              {claveOk && fixed.clave && <span className="warn"> Fecha/entidad/sexo se tomaron de la CURP; confírmala contra la credencial.</span>}
            </p>
          </div>
          <div className="row">
            <button className="primary" disabled={!data.curp && !data.nombre && !data.clave} onClick={download}>Descargar Word</button>
            <span className="status">Origen: {via}</span>
          </div>
          <details><summary>Texto reconocido</summary><pre>{raw}</pre></details>
        </section>
      )}

      <p className="foot">Sin servidor ni base de datos. OCR, PDF y Word se ejecutan localmente.</p>
    </main>
  );
}
