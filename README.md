# INE a Word

Sube un PDF con la imagen de una INE, extrae Nombre completo, CURP y Clave de elector, y descarga un .docx.
100 % en el navegador: sin servidor, sin base de datos, sin CDNs.

## Requisitos
Node 18+.

## Uso
```bash
npm install      # también copia el OCR offline a public/tesseract
npm run dev      # http://localhost:5173
npm test         # pruebas del parser
npm run build    # genera dist/ (hosting estático)
```

## Estructura
- `src/lib/ineParser.js` — reglas de extracción, validación de CURP (dígito verificador) y clave de elector (fecha/entidad/sexo contra la CURP).
- `src/lib/extract.js` — pdf.js (capa de texto) → si falla, OCR con Tesseract (español): recorta la credencial y relee nombre y clave renglón por renglón con varias variantes de imagen.
- `src/lib/buildDocx.js` — genera el Word.
- `scripts/copy-ocr-assets.mjs` — copia worker, WASM y modelo `spa` a `public/tesseract`.

## Limitaciones
- Fotos borrosas o inclinadas degradan el OCR. Los campos son editables antes de descargar.
