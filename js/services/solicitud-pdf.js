// Documento formal "Solicitud de cotización" para mandar a un proveedor:
// lista de materiales con columna de precio en blanco para que el proveedor la
// llene. Branding SOGRUB. Lo usan la vista "Solicitar cotización" (armado manual
// desde catálogo) y el detalle de una cotización (materiales de esa cotización).
//
// Abre una ventana nueva con HTML + CSS @media print y dispara window.print().
// Sin dependencias (no jsPDF): el usuario elige "Guardar como PDF" o imprimir.
//
// payload = {
//   obra: { nombre, contratoNo }, destinatario: { nombre, rfc, contacto, email, telefono },
//   vigenciaDias, fechaEntrega, notas, incluirCantidades,
//   autor: { nombre, email },
//   items: [{ clave, descripcion, unidad, marca, familia, cantidad, notasItem }],
//   generadoAt
// }
export function abrirSolicitudPDF(p) {
  const w = window.open('', '_blank', 'width=900,height=1200');
  if (!w) { alert('El navegador bloqueó la ventana. Permite popups y vuelve a intentar.'); return; }

  const fechaStr = new Date(p.generadoAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
  const folioInterno = 'SC-' + new Date(p.generadoAt).toISOString().slice(0, 10).replace(/-/g, '') + '-' +
    Math.random().toString(36).slice(2, 6).toUpperCase();
  const obraNombre = p.obra?.nombre || '—';
  const obraContrato = p.obra?.contratoNo || '';

  // Agrupar items por familia para presentación más limpia
  const porFam = new Map();
  for (const it of p.items) {
    const fam = it.familia || '(General)';
    if (!porFam.has(fam)) porFam.set(fam, []);
    porFam.get(fam).push(it);
  }
  const fams = Array.from(porFam.keys()).sort();

  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const rowsHTML = fams.map(fam => {
    const items = porFam.get(fam).sort((a, b) => (a.clave || '').localeCompare(b.clave || ''));
    return `
      <tr class="fam-row"><td colspan="${p.incluirCantidades ? 6 : 5}">${esc(fam)}</td></tr>
      ${items.map((it, i) => `
        <tr>
          <td class="num">${i + 1}</td>
          <td class="mono">${esc(it.clave)}</td>
          <td>${esc(it.descripcion)}${it.notasItem ? `<div class="notas">${esc(it.notasItem)}</div>` : ''}</td>
          <td>${esc(it.unidad)}</td>
          <td>${esc(it.marca)}</td>
          ${p.incluirCantidades ? `<td class="num">${it.cantidad || ''}</td>` : ''}
          <td class="precio-cell"></td>
        </tr>
      `).join('')}
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Solicitud de cotización · ${esc(folioInterno)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px; color: #1f2530; margin: 0; padding: 24px;
      background: #fff;
    }
    h1 { font-size: 18px; margin: 0 0 4px; color: #1f2530; }
    h2 { font-size: 13px; margin: 18px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
    .header {
      display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
      border-bottom: 2px solid #1f2530; padding-bottom: 12px; margin-bottom: 16px;
    }
    .brand-block { }
    .brand-name { font-size: 20px; font-weight: 700; color: #1f2530; letter-spacing: -0.3px; }
    .brand-sub { font-size: 11px; color: #777; margin-top: 2px; }
    .meta-block { text-align: right; }
    .folio { font-family: ui-monospace, Consolas, monospace; font-size: 14px; font-weight: 600; color: #1f2530; }
    .meta-line { font-size: 11px; color: #555; margin-top: 2px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 12px 0; }
    .box {
      border: 1px solid #d4d8e0; border-radius: 6px; padding: 10px 12px;
      background: #fafbfc;
    }
    .box .lbl { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px; }
    .box .val { font-size: 12px; font-weight: 600; }
    .box .extra { font-size: 10px; color: #666; margin-top: 1px; }
    table.items { width: 100%; border-collapse: collapse; margin-top: 8px; }
    table.items th, table.items td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #e0e3ea; vertical-align: top; }
    table.items th { background: #1f2530; color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; font-weight: 600; }
    table.items td.num { text-align: right; font-family: ui-monospace, Consolas, monospace; }
    table.items tr.fam-row td {
      background: #eef0f5; font-weight: 600; font-size: 11px; color: #1f2530;
      border-bottom: 2px solid #1f2530; padding: 6px 8px;
    }
    table.items td.mono { font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: #555; }
    table.items .notas { font-size: 10px; color: #777; margin-top: 2px; font-style: italic; }
    table.items td.precio-cell {
      min-width: 80px; border-left: 1px dashed #d4d8e0;
      background: #fafbfc;
    }
    .footer-note {
      margin-top: 16px; padding: 10px 12px; background: #fafbfc;
      border-left: 3px solid #1f2530; font-size: 11px; color: #555;
    }
    .signature {
      margin-top: 32px; display: grid; grid-template-columns: 1fr 1fr; gap: 30px;
    }
    .signature .line {
      border-top: 1px solid #1f2530; padding-top: 4px; text-align: center;
      font-size: 10px; color: #555;
    }
    .toolbar {
      position: fixed; top: 12px; right: 12px; display: flex; gap: 8px;
      background: #fff; padding: 6px 10px; border-radius: 6px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    }
    .toolbar button {
      padding: 6px 12px; font-size: 12px; cursor: pointer;
      border: 1px solid #1f2530; background: #1f2530; color: #fff; border-radius: 4px;
    }
    .toolbar button.ghost { background: transparent; color: #1f2530; }
    @media print {
      .toolbar { display: none; }
      body { padding: 16px; }
      table.items tr { page-break-inside: avoid; }
      table.items tr.fam-row { page-break-after: avoid; }
      thead { display: table-header-group; }
    }
    @page { size: letter; margin: 12mm; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
    <button class="ghost" onclick="window.close()">Cerrar</button>
  </div>

  <div class="header">
    <div class="brand-block">
      <div class="brand-name">SOGRUB</div>
      <div class="brand-sub">Grupo Constructor</div>
      <div class="brand-sub" style="margin-top: 6px;">Solicitud de cotización</div>
    </div>
    <div class="meta-block">
      <div class="folio">${esc(folioInterno)}</div>
      <div class="meta-line">Fecha: ${esc(fechaStr)}</div>
      ${p.vigenciaDias ? `<div class="meta-line">Vigencia solicitada: ${esc(p.vigenciaDias)} días</div>` : ''}
    </div>
  </div>

  <div class="grid-2">
    <div class="box">
      <div class="lbl">Para</div>
      <div class="val">${esc(p.destinatario.nombre)}</div>
      ${p.destinatario.rfc ? `<div class="extra">RFC: ${esc(p.destinatario.rfc)}</div>` : ''}
      ${p.destinatario.contacto ? `<div class="extra">Atención: ${esc(p.destinatario.contacto)}</div>` : ''}
      ${p.destinatario.email ? `<div class="extra">${esc(p.destinatario.email)}</div>` : ''}
      ${p.destinatario.telefono ? `<div class="extra">Tel: ${esc(p.destinatario.telefono)}</div>` : ''}
    </div>
    <div class="box">
      <div class="lbl">Obra</div>
      <div class="val">${esc(obraNombre)}</div>
      ${obraContrato ? `<div class="extra">Contrato: ${esc(obraContrato)}</div>` : ''}
      ${p.fechaEntrega ? `<div class="extra">Entrega: ${esc(p.fechaEntrega)}</div>` : ''}
      ${p.autor.nombre ? `<div class="extra">Solicita: ${esc(p.autor.nombre)}</div>` : ''}
    </div>
  </div>

  <h2>Materiales a cotizar (${p.items.length})</h2>
  <table class="items">
    <thead>
      <tr>
        <th style="width: 30px;">#</th>
        <th style="width: 100px;">Clave</th>
        <th>Descripción</th>
        <th style="width: 50px;">Unidad</th>
        <th style="width: 90px;">Marca</th>
        ${p.incluirCantidades ? '<th style="width: 70px;" class="num">Cantidad</th>' : ''}
        <th style="width: 90px;">Precio unitario</th>
      </tr>
    </thead>
    <tbody>${rowsHTML}</tbody>
  </table>

  ${p.notas ? `
  <div class="footer-note">
    <strong>Observaciones:</strong><br>${esc(p.notas).replace(/\n/g, '<br>')}
  </div>` : ''}

  <div class="footer-note" style="font-size: 10px;">
    Esta solicitud no constituye una orden de compra. Sirve únicamente para obtener su mejor cotización
    en los materiales listados. Por favor responda incluyendo precio unitario, tiempo de entrega y condiciones de pago.
  </div>

  <div class="signature">
    <div class="line">${esc(p.autor.nombre || 'Solicita')}<br><span style="font-size: 9px; color: #888;">SOGRUB · Departamento de compras</span></div>
    <div class="line">${esc(p.destinatario.nombre)}<br><span style="font-size: 9px; color: #888;">Firma de recibido</span></div>
  </div>

  <script>
    // Auto-print al cargar — el usuario decide cancelar si solo quiere ver
    window.addEventListener('load', () => { setTimeout(() => window.print(), 300); });
  </script>
</body>
</html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
}
