import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, HeadingLevel, ShadingType,
} from "docx";

const FONT = "Arial";
const border = { style: BorderStyle.SINGLE, size: 4, color: "C9D2D0" };
const borders = { top: border, bottom: border, left: border, right: border };
const margins = { top: 100, bottom: 100, left: 140, right: 140 };

const cell = (text, width, opts = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  borders, margins,
  shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR, color: "auto" } : undefined,
  children: [new Paragraph({ children: [new TextRun({ text: text || "—", font: FONT, size: 22, bold: !!opts.bold })] })],
});

const row = (k, v) => new TableRow({ children: [cell(k, 3000, { bold: true, fill: "EEF3F2" }), cell(v, 6360)] });

export async function buildDocx(f) {
  const doc = new Document({
    sections: [{
      properties: {
        page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
      },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 120 },
          children: [new TextRun({ text: "Datos de identificación", font: FONT, size: 32, bold: true })] }),
        new Paragraph({ spacing: { after: 240 },
          children: [new TextRun({ text: `Extraídos de credencial INE el ${new Date().toLocaleDateString("es-MX")}`,
            font: FONT, size: 20, color: "5B6866" })] }),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [3000, 6360],
          rows: [
            row("Nombre completo", f.nombre),
            row("CURP", f.curp),
            row("Clave de elector", f.clave),
          ],
        }),
      ],
    }],
  });
  return Packer.toBlob(doc);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
