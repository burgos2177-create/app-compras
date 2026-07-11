// Documento formal "Solicitud de cotización" para mandar a un proveedor:
// lista de materiales con columna de precio en blanco para que el proveedor la
// llene. Branding SOGRUB. Lo usan la vista "Solicitar cotización" (armado manual
// desde catálogo) y el detalle de una cotización (materiales de esa cotización).
//
// Se genera con jsPDF (ya cargado en index.html) y se DESCARGA directo con
// doc.save() — igual que la OC. No usa window.open (que en Ferdium/Electron y
// con bloqueadores de popups no hace nada).
//
// payload = {
//   obra: { nombre, contratoNo }, destinatario: { nombre, rfc, contacto, email, telefono },
//   vigenciaDias, fechaEntrega, notas, incluirCantidades,
//   autor: { nombre, email },
//   items: [{ clave, descripcion, unidad, marca, familia, cantidad, notasItem }],
//   generadoAt
// }

import { getLogoDataURL, drawPdfBrandHeader } from './brand.js?v=20260711g';

const BRAND = { r: 32, g: 33, b: 86 };   // navy SOGRUB (encabezados de tabla / cajas)

function fecha(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
}
function safe(s) { return String(s || '').replace(/[^a-z0-9-_]/gi, '_').slice(0, 50); }

export async function abrirSolicitudPDF(p) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('No se pudo cargar el generador de PDF. Revisa tu conexión y recarga.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.width;

  const gen = p.generadoAt || Date.now();
  const folioInterno = 'SC-' + new Date(gen).toISOString().slice(0, 10).replace(/-/g, '') + '-' +
    Math.random().toString(36).slice(2, 6).toUpperCase();
  const incluirCant = p.incluirCantidades !== false;

  // === Encabezado con logo SOGRUB ===
  const logo = await getLogoDataURL();
  let y = drawPdfBrandHeader(doc, W, { title: 'SOLICITUD DE COTIZACIÓN', folio: folioInterno, fecha: fecha(gen), logo });
  const m = p.obra || {};
  doc.setTextColor(60).setFont('helvetica', 'bold').setFontSize(10);
  doc.text('Obra:', 40, y);
  doc.setFont('helvetica', 'normal');
  doc.text(`${m.nombre || '—'}${m.contratoNo ? '  ·  Contrato ' + m.contratoNo : ''}`, 78, y);
  if (p.vigenciaDias) {
    doc.setFont('helvetica', 'bold').text('Vigencia solicitada:', W - 200, y);
    doc.setFont('helvetica', 'normal').text(`${p.vigenciaDias} días`, W - 90, y);
  }

  // === Caja "PARA" (proveedor) ===
  y += 20;
  const d = p.destinatario || {};
  doc.setDrawColor(210).setFillColor(247, 249, 252);
  doc.roundedRect(40, y, W - 80, 66, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(90);
  doc.text('PARA', 52, y + 16);
  doc.setTextColor(35).setFontSize(11).text(d.nombre || 'A quien corresponda', 52, y + 33);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(70);
  const pdatos = [];
  if (d.rfc) pdatos.push('RFC: ' + d.rfc);
  if (d.contacto) pdatos.push("At'n: " + d.contacto);
  if (d.telefono) pdatos.push('Tel: ' + d.telefono);
  if (d.email) pdatos.push(d.email);
  if (pdatos.length) doc.text(pdatos.join('   ·   '), 52, y + 49);
  if (p.fechaEntrega) doc.text('Entrega requerida: ' + p.fechaEntrega, 52, y + 61);
  y += 82;

  // === Tabla de materiales (precio en blanco para que el proveedor lo llene) ===
  // Agrupamos por familia con filas separadoras.
  const porFam = new Map();
  for (const it of (p.items || [])) {
    const fam = it.familia || '(General)';
    if (!porFam.has(fam)) porFam.set(fam, []);
    porFam.get(fam).push(it);
  }
  const fams = Array.from(porFam.keys()).sort();
  const multiFam = fams.length > 1 || (fams.length === 1 && fams[0] !== '(General)');

  const head = incluirCant
    ? [['#', 'Clave', 'Descripción', 'Unidad', 'Marca', 'Cantidad', 'Precio unitario']]
    : [['#', 'Clave', 'Descripción', 'Unidad', 'Marca', 'Precio unitario']];
  const nCols = head[0].length;

  const body = [];
  let idx = 0;
  for (const fam of fams) {
    if (multiFam) {
      body.push([{ content: fam, colSpan: nCols, styles: { fillColor: [238, 240, 245], textColor: [31, 37, 48], fontStyle: 'bold', halign: 'left' } }]);
    }
    for (const it of porFam.get(fam).sort((a, b) => (a.clave || '').localeCompare(b.clave || ''))) {
      idx++;
      const descFull = (it.descripcion || '') + (it.notasItem ? `\n${it.notasItem}` : '');
      const row = [String(idx), it.clave || '', descFull, it.unidad || '', it.marca || ''];
      if (incluirCant) row.push(it.cantidad != null && it.cantidad !== '' ? String(it.cantidad) : '');
      row.push(''); // Precio unitario — en blanco
      body.push(row);
    }
  }

  const priceCol = nCols - 1;
  const columnStyles = {
    0: { cellWidth: 22, halign: 'center' },
    1: { cellWidth: 66, font: 'courier', fontSize: 8 },
    2: { cellWidth: incluirCant ? 178 : 210 },
    3: { cellWidth: 40, halign: 'center' },
    4: { cellWidth: 66, fontSize: 8 },
    [priceCol]: { cellWidth: 74, fillColor: [250, 250, 250] }
  };
  if (incluirCant) columnStyles[5] = { cellWidth: 52, halign: 'right' };

  doc.autoTable({
    startY: y,
    head, body,
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, lineColor: [225, 230, 236], lineWidth: 0.5, valign: 'top' },
    headStyles: { fillColor: [BRAND.r, BRAND.g, BRAND.b], textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
    columnStyles,
    margin: { left: 40, right: 40 }
  });

  let ny = doc.lastAutoTable.finalY + 16;
  const bottom = doc.internal.pageSize.height;

  // === Observaciones (si hay) ===
  if (p.notas) {
    const wrapped = doc.splitTextToSize(p.notas, W - 80 - 24);
    const boxH = 22 + wrapped.length * 12 + 6;
    if (ny + boxH > bottom - 90) { doc.addPage(); ny = 60; }
    doc.setDrawColor(BRAND.r, BRAND.g, BRAND.b).setFillColor(247, 249, 252);
    doc.roundedRect(40, ny, W - 80, boxH, 4, 4, 'FD');
    doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(BRAND.r, BRAND.g, BRAND.b);
    doc.text('OBSERVACIONES', 52, ny + 16);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
    doc.text(wrapped, 52, ny + 31);
    ny += boxH + 14;
  }

  // === Leyenda RFQ ===
  const leyenda = doc.splitTextToSize(
    'Esta solicitud no constituye una orden de compra. Sirve únicamente para obtener su mejor cotización en los materiales listados. ' +
    'Por favor responda incluyendo precio unitario, tiempo de entrega y condiciones de pago.', W - 80);
  const lH = leyenda.length * 12 + 8;
  if (ny + lH > bottom - 80) { doc.addPage(); ny = 60; }
  doc.setFont('helvetica', 'italic').setFontSize(9).setTextColor(90);
  doc.text(leyenda, 40, ny + 4);
  ny += lH + 24;

  // === Firmas ===
  if (ny > bottom - 70) { doc.addPage(); ny = 90; }
  const c1 = 150, c2 = W - 150;
  doc.setDrawColor(120);
  doc.line(c1 - 80, ny, c1 + 80, ny);
  doc.line(c2 - 80, ny, c2 + 80, ny);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  doc.text(p.autor?.nombre || 'Solicita', c1, ny + 14, { align: 'center' });
  doc.setFontSize(8).setTextColor(130);
  doc.text('SOGRUB · Departamento de compras', c1, ny + 26, { align: 'center' });
  doc.setFontSize(9).setTextColor(90);
  doc.text(d.nombre || 'Proveedor', c2, ny + 14, { align: 'center' });
  doc.setFontSize(8).setTextColor(130);
  doc.text('Firma de recibido', c2, ny + 26, { align: 'center' });

  // === Pie ===
  doc.setFontSize(8).setTextColor(150);
  doc.text(`SOGRUB · ${folioInterno} · ${new Date().toLocaleString('es-MX')}`, 40, bottom - 24);

  doc.save(`Solicitud_cotizacion_${safe(d.nombre || 'proveedor')}.pdf`);
}
