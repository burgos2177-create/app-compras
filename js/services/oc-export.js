// Export de la Orden de Compra en formato presentable para mandar al proveedor:
//   - exportOcPdf  → PDF elegante (jsPDF + autotable, ya cargados en index.html)
//   - exportOcDoc  → Word editable (.doc, HTML compatible con Word, sin dependencias)
// Incluye una leyenda amable solicitando la emisión de la factura (CFDI) con los
// datos fiscales de SOGRUB (configurables en la vista de OC).

import { getLogoDataURL, drawPdfBrandHeader, brandHeaderHTML } from './brand.js?v=20260711f';

const BRAND = { r: 40, g: 50, b: 65 };

function money(n) {
  return '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num2(n) {
  return (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fecha(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
}
function safe(s) { return String(s || '').replace(/[^a-z0-9-_]/gi, '_').slice(0, 50); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function itemsArr(oc) {
  return Object.values(oc.items || {}).map(it => ({
    clave: it.clave || it.conceptoClave || '',
    descripcion: it.descripcion || '',
    unidad: it.unidad || '',
    cantidad: Number(it.cantidad) || 0,
    costoUnitario: Number(it.costoUnitario) || 0,
    importe: Number(it.importe) || (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0)
  }));
}
function retArr(oc) {
  return (oc.retenciones || []).map(r => ({
    label: r.tipo || r.concepto || 'Retención',
    tasa: Number(r.tasa ?? r.pct) || 0,
    importe: Number(r.importe) || 0
  }));
}

// ===================== PDF =====================
export async function exportOcPdf(obra, oc, factur = {}) {
  const m = obra?.meta || {};
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.width;
  const folio = oc.folio || ('OC-' + String(oc.numero || 0).padStart(4, '0'));

  // Encabezado con logo SOGRUB
  const logo = await getLogoDataURL();
  let y = drawPdfBrandHeader(doc, W, { title: 'ORDEN DE COMPRA', folio, fecha: fecha(oc.fechaEmision), logo });
  doc.setTextColor(60).setFont('helvetica', 'bold').setFontSize(10);
  doc.text('Obra:', 40, y);
  doc.setFont('helvetica', 'normal');
  doc.text(`${m.nombre || ''}${m.contratoNo ? '  ·  Contrato ' + m.contratoNo : ''}`, 80, y);
  if (m.ubicacion || m.municipio) {
    y += 15; doc.setFont('helvetica', 'bold').text('Ubicación:', 40, y);
    doc.setFont('helvetica', 'normal').text(`${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`, 100, y);
  }

  // Caja proveedor
  y += 22;
  doc.setDrawColor(210).setFillColor(247, 249, 252);
  doc.roundedRect(40, y, W - 80, 74, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(90);
  doc.text('PROVEEDOR', 52, y + 16);
  doc.setTextColor(35).setFontSize(11).text(oc.proveedor?.nombre || '', 52, y + 33);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(70);
  const pdatos = [];
  if (oc.proveedor?.rfc) pdatos.push('RFC: ' + oc.proveedor.rfc);
  if (oc.proveedor?.contacto) pdatos.push('At\'n: ' + oc.proveedor.contacto);
  if (oc.proveedor?.telefono) pdatos.push('Tel: ' + oc.proveedor.telefono);
  if (oc.proveedor?.email) pdatos.push(oc.proveedor.email);
  doc.text(pdatos.join('   ·   '), 52, y + 49);
  if (oc.condicionesPago) doc.text('Condiciones de pago: ' + oc.condicionesPago, 52, y + 64);
  y += 90;

  // Tabla de conceptos
  doc.autoTable({
    startY: y,
    head: [['#', 'Clave', 'Descripción', 'Unidad', 'Cantidad', 'P. Unitario', 'Importe']],
    body: itemsArr(oc).map((it, i) => [
      String(i + 1), it.clave, it.descripcion, it.unidad,
      num2(it.cantidad), money(it.costoUnitario), money(it.importe)
    ]),
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 6, lineColor: [225, 230, 236], lineWidth: 0.5 },
    headStyles: { fillColor: [BRAND.r, BRAND.g, BRAND.b], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 22, halign: 'center' },
      1: { cellWidth: 62, font: 'courier', fontSize: 8 },
      2: { cellWidth: 190 },
      3: { cellWidth: 44, halign: 'center' },
      4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }
    },
    margin: { left: 40, right: 40 }
  });

  // Totales (bloque derecho)
  let ty = doc.lastAutoTable.finalY + 14;
  const rx = W - 40, lx = W - 230;
  const line = (label, val, strong) => {
    doc.setFont('helvetica', strong ? 'bold' : 'normal').setFontSize(strong ? 11 : 10)
      .setTextColor(strong ? 20 : 70);
    doc.text(label, lx, ty); doc.text(val, rx, ty, { align: 'right' }); ty += strong ? 18 : 15;
  };
  line('Subtotal', money(oc.subtotal));
  line(`IVA (${((oc.ivaPct ?? 0.16) * 100).toFixed(0)}%)`, money(oc.ivaImporte));
  for (const r of retArr(oc)) line(`Ret. ${r.label}`, '- ' + money(r.importe));
  doc.setDrawColor(200).line(lx, ty - 4, rx, ty - 4);
  line('TOTAL', money(oc.total), true);

  // Leyenda de factura
  let ly = Math.max(ty + 10, doc.lastAutoTable.finalY + 14);
  // Envolvemos cada línea al ancho de la caja para que el domicilio no se salga.
  doc.setFont('helvetica', 'normal').setFontSize(9);
  const wrapped = leyendaFactura(factur, folio, oc).flatMap(l => doc.splitTextToSize(l, W - 80 - 24));
  const boxH = 24 + wrapped.length * 12 + 8;
  if (ly + boxH > 720) { doc.addPage(); ly = 60; }
  doc.setDrawColor(BRAND.r, BRAND.g, BRAND.b).setFillColor(247, 249, 252);
  doc.roundedRect(40, ly, W - 80, boxH, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(BRAND.r, BRAND.g, BRAND.b);
  doc.text('SOLICITUD DE FACTURA (CFDI)', 52, ly + 17);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
  doc.text(wrapped, 52, ly + 33);
  ly += boxH + 40;

  // Firma
  if (ly > 700) { doc.addPage(); ly = 120; }
  doc.setDrawColor(120).line(70, ly, 250, ly);
  doc.setFontSize(9).setTextColor(90).text('Autoriza — Compras SOGRUB', 160, ly + 14, { align: 'center' });
  if (oc.autor?.displayName) doc.text(oc.autor.displayName, 160, ly + 27, { align: 'center' });

  // Pie
  doc.setFontSize(8).setTextColor(150);
  doc.text(`SOGRUB · ${folio} · ${new Date().toLocaleString('es-MX')}`, 40, doc.internal.pageSize.height - 24);

  doc.save(`${folio}_${safe(oc.proveedor?.nombre)}.pdf`);
}

// Compone el domicilio fiscal desde los campos individuales (con fallback al
// campo libre 'domicilio' de configuraciones anteriores).
function domicilioTexto(f) {
  if (f.calle || f.cp || f.colonia || f.municipio || f.estado) {
    let l1 = f.calle || '';
    if (f.numExt) l1 += ' No. ' + f.numExt;
    if (f.numInt) l1 += ' Int. ' + f.numInt;
    return [l1.trim(), f.colonia ? 'Col. ' + f.colonia : '', f.cp ? 'C.P. ' + f.cp : '', f.municipio, f.estado]
      .filter(Boolean).join(', ');
  }
  return f.domicilio || '';
}

// Uso del CFDI efectivo: el de la OC (si se sobrescribió) → global → default.
export function usoCfdiEfectivo(oc, f) {
  return (oc && oc.usoCfdi && String(oc.usoCfdi).trim()) || (f && f.usoCfdi && String(f.usoCfdi).trim()) || 'G03 Gastos en general';
}

function leyendaFactura(f, folio, oc) {
  const v = (x, ph) => (x && String(x).trim()) ? x : ph;
  const dom = domicilioTexto(f);
  return [
    'Le agradeceremos emitir su factura (CFDI) con los siguientes datos fiscales:',
    `Razón social: ${v(f.razonSocial, '(configurar)')}    RFC: ${v(f.rfc, '(configurar)')}`,
    `Régimen fiscal: ${v(f.regimen, '(configurar)')}    Uso del CFDI: ${usoCfdiEfectivo(oc, f)}`,
    dom ? `Domicilio fiscal: ${dom}` : '',
    `Favor de referir esta orden (${folio}) en el CFDI y enviar PDF y XML a: ${v(f.correoFacturas, '(configurar)')}.`,
    'Agradecemos su atención y su servicio.'
  ].filter(Boolean);
}

// ===================== WORD (.doc, HTML) =====================
export async function exportOcDoc(obra, oc, factur = {}) {
  const m = obra?.meta || {};
  const folio = oc.folio || ('OC-' + String(oc.numero || 0).padStart(4, '0'));
  const logo = await getLogoDataURL();
  const rows = itemsArr(oc).map((it, i) => `
    <tr>
      <td style="text-align:center">${i + 1}</td>
      <td style="font-family:Consolas,monospace;font-size:9pt">${esc(it.clave)}</td>
      <td>${esc(it.descripcion)}</td>
      <td style="text-align:center">${esc(it.unidad)}</td>
      <td style="text-align:right">${num2(it.cantidad)}</td>
      <td style="text-align:right">${money(it.costoUnitario)}</td>
      <td style="text-align:right">${money(it.importe)}</td>
    </tr>`).join('');

  const totRows = [
    ['Subtotal', money(oc.subtotal)],
    [`IVA (${((oc.ivaPct ?? 0.16) * 100).toFixed(0)}%)`, money(oc.ivaImporte)],
    ...retArr(oc).map(r => [`Ret. ${esc(r.label)}`, '- ' + money(r.importe)])
  ].map(([k, v]) => `<tr><td style="text-align:right;color:#555">${k}</td><td style="text-align:right;width:120px">${v}</td></tr>`).join('');

  const legend = leyendaFactura(factur, folio, oc).map(l => `<div>${esc(l)}</div>`).join('');
  const pdatos = [];
  if (oc.proveedor?.rfc) pdatos.push('RFC: ' + esc(oc.proveedor.rfc));
  if (oc.proveedor?.contacto) pdatos.push("At'n: " + esc(oc.proveedor.contacto));
  if (oc.proveedor?.telefono) pdatos.push('Tel: ' + esc(oc.proveedor.telefono));
  if (oc.proveedor?.email) pdatos.push(esc(oc.proveedor.email));

  const html = `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${folio}</title>
<style>
  @page { size: letter; margin: 2cm; }
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #222; }
  .band { background:#28323f; color:#fff; padding:14px 18px; }
  .band .t { font-size:20pt; font-weight:bold; }
  .band .r { text-align:right; }
  table.items { width:100%; border-collapse:collapse; margin-top:10px; }
  table.items th { background:#28323f; color:#fff; padding:6px; font-size:9pt; text-align:left; }
  table.items td { border:1px solid #dfe4ea; padding:6px; font-size:10pt; }
  .box { border:1px solid #cfd6de; background:#f7f9fc; padding:12px; margin-top:14px; }
  h4 { color:#28323f; margin:0 0 6px 0; }
</style></head>
<body>
  ${brandHeaderHTML(logo, { title: 'ORDEN DE COMPRA', folio, fecha: fecha(oc.fechaEmision) })}

  <p style="margin-top:12px"><b>Obra:</b> ${esc(m.nombre)}${m.contratoNo ? '  ·  Contrato ' + esc(m.contratoNo) : ''}
  ${(m.ubicacion || m.municipio) ? `<br><b>Ubicación:</b> ${esc(m.ubicacion)}${m.municipio ? ', ' + esc(m.municipio) : ''}` : ''}</p>

  <div class="box"><h4>PROVEEDOR</h4>
    <div style="font-size:12pt"><b>${esc(oc.proveedor?.nombre)}</b></div>
    <div style="color:#555;font-size:10pt">${pdatos.join('  ·  ')}</div>
    ${oc.condicionesPago ? `<div style="font-size:10pt;margin-top:4px"><b>Condiciones de pago:</b> ${esc(oc.condicionesPago)}</div>` : ''}
  </div>

  <table class="items">
    <thead><tr><th>#</th><th>Clave</th><th>Descripción</th><th>Unidad</th><th style="text-align:right">Cantidad</th><th style="text-align:right">P. Unitario</th><th style="text-align:right">Importe</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <table style="width:280px;margin-left:auto;margin-top:12px">${totRows}
    <tr><td style="text-align:right;font-weight:bold;font-size:12pt;border-top:1px solid #999">TOTAL</td>
        <td style="text-align:right;font-weight:bold;font-size:12pt;border-top:1px solid #999">${money(oc.total)}</td></tr>
  </table>

  <div class="box"><h4>SOLICITUD DE FACTURA (CFDI)</h4>${legend}</div>

  <p style="margin-top:48px">____________________________<br>Autoriza — Compras SOGRUB${oc.autor?.displayName ? '<br>' + esc(oc.autor.displayName) : ''}</p>
</body></html>`;

  const blob = new Blob(['﻿' + html], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${folio}_${safe(oc.proveedor?.nombre)}.doc`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}
