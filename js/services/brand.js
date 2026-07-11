// Branding centralizado para los documentos (OC, solicitud de cotización).
//
// El logo real se toma de assets/sogrub-logo.png (PNG con fondo transparente).
// Súbelo ahí y los PDFs lo usarán automáticamente — sin tocar código.
// Si el archivo no existe (o no carga), se dibuja un lockup vectorial SOGRUB
// nítido como respaldo, así el documento nunca queda sin marca.

const BLUE = [28, 160, 218];   // azul SOGRUB
const NAVY = [32, 33, 86];     // azul marino del wordmark

// Carga el logo una sola vez y lo cachea como dataURL PNG (para jsPDF/Word).
// Resuelve null si no hay archivo o no se puede leer (→ se usa el respaldo).
let _logoPromise = null;
export function getLogoDataURL() {
  if (_logoPromise) return _logoPromise;
  _logoPromise = new Promise((resolve) => {
    try {
      if (typeof document === 'undefined' || typeof Image === 'undefined') { resolve(null); return; }
      const url = new URL('../../assets/sogrub-logo.png?v=20260711f', import.meta.url).href;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          resolve({ dataURL: c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight });
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch (e) { resolve(null); }
  });
  return _logoPromise;
}

// Dibuja el encabezado de marca en un doc jsPDF. Devuelve la Y donde continuar.
// logo = resultado de getLogoDataURL() (o null → respaldo vectorial).
export function drawPdfBrandHeader(doc, W, { title, folio, fecha, logo }) {
  const top = 34;
  if (logo && logo.dataURL) {
    const maxH = 54, maxW = 156;
    let h = maxH, w = h * (logo.w / logo.h);
    if (w > maxW) { w = maxW; h = w * (logo.h / logo.w); }
    try { doc.addImage(logo.dataURL, 'PNG', 40, top, w, h); }
    catch (e) { drawVectorLockup(doc, top); }
  } else {
    drawVectorLockup(doc, top);
  }

  doc.setTextColor(NAVY[0], NAVY[1], NAVY[2]).setFont('helvetica', 'bold').setFontSize(15);
  doc.text(title || '', W - 40, top + 16, { align: 'right' });
  if (folio) {
    doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(90, 90, 90);
    doc.text(String(folio), W - 40, top + 33, { align: 'right' });
  }
  if (fecha) {
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
    doc.text(String(fecha), W - 40, top + 47, { align: 'right' });
  }

  doc.setDrawColor(BLUE[0], BLUE[1], BLUE[2]).setLineWidth(2);
  doc.line(40, top + 62, W - 40, top + 62);
  doc.setLineWidth(0.5);
  return top + 62 + 22;   // ≈ y 118
}

// Respaldo: lockup vectorial (icono de edificios + SOGRUB + subtítulo).
function drawVectorLockup(doc, top) {
  const base = top + 46, x0 = 42;
  doc.setDrawColor(BLUE[0], BLUE[1], BLUE[2]).setLineWidth(1.6);
  // Torre
  doc.line(x0, base, x0, base - 44);
  doc.line(x0, base - 44, x0 + 14, base - 44);
  doc.line(x0 + 14, base - 44, x0 + 14, base);
  // Casa con techo a dos aguas
  doc.line(x0 + 18, base, x0 + 18, base - 22);
  doc.line(x0 + 40, base, x0 + 40, base - 22);
  doc.line(x0 + 18, base - 22, x0 + 29, base - 36);
  doc.line(x0 + 29, base - 36, x0 + 40, base - 22);
  // Línea base
  doc.setLineWidth(1);
  doc.line(x0, base, x0 + 40, base);

  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(NAVY[0], NAVY[1], NAVY[2]);
  doc.text('SOGRUB', x0 + 54, base - 14);
  doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(NAVY[0], NAVY[1], NAVY[2]);
  const prev = (doc.getCharSpace && doc.getCharSpace()) || 0;
  if (doc.setCharSpace) doc.setCharSpace(1.6);
  doc.text('GRUPO CONSTRUCTOR', x0 + 55, base - 2);
  if (doc.setCharSpace) doc.setCharSpace(prev);
  doc.setLineWidth(0.5);
}

// Encabezado de marca para Word (.doc HTML). logo = getLogoDataURL() o null.
export function brandHeaderHTML(logo, { title, folio, fecha }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const left = (logo && logo.dataURL)
    ? `<img src="${logo.dataURL}" style="height:54px" alt="SOGRUB">`
    : `<div style="font-size:22pt;font-weight:bold;color:#202156;letter-spacing:-0.5px">SOGRUB</div>
       <div style="font-size:8pt;color:#202156;letter-spacing:2px">GRUPO CONSTRUCTOR</div>`;
  return `<table style="width:100%;border-bottom:3px solid #1ca0da"><tr>
    <td style="padding-bottom:8px">${left}</td>
    <td style="text-align:right;padding-bottom:8px">
      <div style="font-size:15pt;font-weight:bold;color:#202156">${esc(title)}</div>
      ${folio ? `<div style="color:#555">${esc(folio)}</div>` : ''}
      ${fecha ? `<div style="font-size:9pt;color:#888">${esc(fecha)}</div>` : ''}
    </td>
  </tr></table>`;
}
