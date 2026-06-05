// Export/import de licitantes para subcontratos.
//
// jsPDF y SheetJS están cargados via CDN en index.html como globals
// (window.jspdf, window.XLSX). Cuatro funciones:
//   1. exportLicitanteXlsx — template para que el licitante llene precios.
//   2. exportLicitantePdf  — invitación a cotizar en PDF.
//   3. parseLicitanteXlsx  — lee el XLSX devuelto y extrae precios.
//   4. exportComparativaXlsx / exportComparativaPdf — comparativa lista
//      para revisión offline o presentar a dirección.
//   5/6. exportCatalogoComparativaPdf / exportCatalogoComparativaXlsx —
//      comparativa EJECUTIVA de los materiales de una solicitud × los
//      proveedores activos, con ranking y total por proveedor (usando las
//      cantidades de la solicitud). Compara MATERIALES, no conceptos.
//
// El XLSX para licitante incluye una fila "marca" con metadata para que al
// importarse se reconozca como template de subcontrato de compras.

const LIC_MARK = '#APP-COMPRAS-LICITANTE-SUBCONTRATO#';

function safeName(s) {
  return String(s || 'sin-nombre').replace(/[^a-z0-9-_]/gi, '_').slice(0, 60);
}
function dateStr(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}
function num2(n) {
  return Number.isFinite(Number(n))
    ? Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';
}
function money(n) {
  return '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  // Ahorro positivo = se muestra en plano (ej. "12.6%"); sobrecosto con '-'.
  // Solo ASCII: la fuente del PDF no tiene el signo menos Unicode (U+2212).
  const v = n * 100;
  return (v < 0 ? '-' : '') + Math.abs(v).toFixed(1) + '%';
}
function setNumFmt(ws, r, c, fmt) {
  const ref = XLSX.utils.encode_cell({ r, c });
  if (ws[ref]) ws[ref].z = fmt;
}

// Helper: pinta header de obra simple en el PDF (no usa estimacion's header
// porque ese carga datos que aquí no aplican)
function drawHeader(doc, obra, titulo) {
  const m = obra?.meta || {};
  const W = doc.internal.pageSize.width;
  doc.setFillColor(40, 50, 65);
  doc.rect(0, 0, W, 90, 'F');
  doc.setTextColor(255).setFont('helvetica', 'bold').setFontSize(20);
  doc.text('SOGRUB', 30, 38);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(220);
  doc.text('Grupo Constructor', 30, 54);
  doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(255);
  doc.text(titulo, W - 30, 38, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(220);
  doc.text(m.nombre || '', W - 30, 54, { align: 'right' });

  // Sub-header con datos no sensibles de la obra
  doc.setTextColor(50).setFont('helvetica', 'normal').setFontSize(9);
  let y = 110;
  if (m.contratoNo) { doc.text(`Contrato: ${m.contratoNo}`, 30, y); }
  if (m.ubicacion || m.municipio) {
    doc.text(`Ubicación: ${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`, 30, y + 14);
  }
  return y + 30;
}

function drawFooter(doc, data) {
  const W = doc.internal.pageSize.width;
  const H = doc.internal.pageSize.height;
  doc.setFontSize(8).setTextColor(140);
  doc.text(`SOGRUB · ${new Date().toLocaleString('es-MX')}`, 30, H - 20);
  doc.text(`Pág. ${data.pageNumber}`, W - 30, H - 20, { align: 'right' });
}

// ===== Helpers para shape compras (conceptos objeto, no array) =====
//
// Aceptamos las dos formas (compras y estimaciones adaptado) por defensa,
// porque el módulo en estimaciones usa array. Aquí compras es objeto.
function conceptosToArray(sub) {
  const c = sub?.conceptos;
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') {
    return Object.values(c).map(x => ({
      conceptoId: x.conceptoId,
      cantidadSub: Number(x.cantidad ?? x.cantidadSub) || 0,
      costoMaterialSogrub: Number(x.costoMaterialSogrub) || 0,
      notas: x.notas || ''
    }));
  }
  return [];
}

// 1) ===== Template XLSX para licitante =====
export function exportLicitanteXlsxCompras(obra, sub, scId, conceptosAll) {
  const m = obra?.meta || {};
  const meta = sub?.meta || {};
  const conceptosSub = conceptosToArray(sub);

  const aoa = [
    ['SOLICITUD DE COTIZACIÓN'],
    [LIC_MARK, scId || '', meta.nombre || ''],
    [],
    ['CONSTRUCTORA:', m.construye || '', '', 'PROGRAMA:', m.programa || ''],
    ['UBICACIÓN:', `${m.ubicacion || ''}${m.municipio ? ', ' + m.municipio : ''}`,
      '', 'PERÍODO DE OBRA:', `${dateStr(m.fechaInicio)} – ${dateStr(m.fechaFin)}`],
    ['SUBCONTRATO:', meta.nombre || '', '', 'FECHA EMISIÓN:', dateStr(Date.now())],
    [],
    ['DATOS DEL LICITANTE (favor de llenar)'],
    ['Nombre / Razón social:', ''],
    ['RFC:', ''],
    ['Persona de contacto:', ''],
    ['Email:', ''],
    ['Teléfono:', ''],
    ['Fecha de cotización:', ''],
    ['Tipo de cotización:', '', '', '', '', '(Subcontrato / Destajo solo MO)'],
    [],
    ['INSTRUCCIONES:'],
    ['  · Llene la columna "P.U. COTIZADO" con sus precios unitarios.'],
    ['  · La columna "Importe" se calcula automáticamente.'],
    ['  · NO modifique la columna "Clave" (es nuestro identificador).'],
    ['  · Devuélvanos este mismo archivo lleno por correo.'],
    [],
    ['Clave', 'Descripción', 'Unidad', 'Cantidad', 'P.U. COTIZADO', 'Importe']
  ];

  const headerRow = aoa.length - 1;
  const startData = aoa.length;

  for (const cs of conceptosSub) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    aoa.push([cat.clave || '', cat.descripcion || '', cat.unidad || '',
      Number(cs.cantidadSub) || 0, '', '']);
  }
  const endData = aoa.length - 1;
  aoa.push([]);
  aoa.push(['', '', '', 'TOTAL', '', '']);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 60 }, { wch: 8 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];

  // Fórmula Importe = Cantidad × P.U. cotizado
  for (let r = startData; r <= endData; r++) {
    const dCell = XLSX.utils.encode_cell({ r, c: 3 });
    const eCell = XLSX.utils.encode_cell({ r, c: 4 });
    const fCell = XLSX.utils.encode_cell({ r, c: 5 });
    ws[fCell] = { f: `${dCell}*${eCell}`, t: 'n', z: '"$"#,##0.00' };
    setNumFmt(ws, r, 3, '#,##0.00');
    setNumFmt(ws, r, 4, '"$"#,##0.00');
  }
  const totalRow = endData + 2;
  const fTotal = XLSX.utils.encode_cell({ r: totalRow, c: 5 });
  ws[fTotal] = {
    f: `SUM(${XLSX.utils.encode_cell({ r: startData, c: 5 })}:${XLSX.utils.encode_cell({ r: endData, c: 5 })})`,
    t: 'n',
    z: '"$"#,##0.00'
  };

  XLSX.utils.book_append_sheet(wb, ws, 'Cotización');
  XLSX.writeFile(wb, `Cotizacion_${safeName(m.nombre)}_${safeName(meta.nombre)}.xlsx`);
}

// 2) ===== PDF de invitación =====
export function exportLicitantePdfCompras(obra, sub, conceptosAll) {
  const m = obra?.meta || {};
  const meta = sub?.meta || {};
  const conceptosSub = conceptosToArray(sub);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  let y = drawHeader(doc, obra, 'INVITACIÓN A COTIZAR');

  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(30);
  doc.text(`Subcontrato: ${meta.nombre || ''}`, 30, y);
  if (meta.descripcion) {
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(70);
    const lines = doc.splitTextToSize(meta.descripcion, doc.internal.pageSize.width - 60);
    doc.text(lines, 30, y + 14);
    y += 14 + lines.length * 11;
  }

  // Box "Datos del licitante" para que llene a mano
  y += 14;
  doc.setFillColor(245, 248, 252);
  doc.rect(30, y, doc.internal.pageSize.width - 60, 110, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(40);
  doc.text('DATOS DEL LICITANTE', 38, y + 14);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(80);
  const labels = ['Nombre / Razón social:', 'RFC:', 'Persona de contacto:',
    'Email:', 'Teléfono:', 'Fecha de cotización:', 'Tipo (subcontrato / destajo):'];
  const colX = [38, 320];
  labels.forEach((l, i) => {
    const col = Math.floor(i / 4);
    const xx = colX[col];
    const yy = y + 32 + (i % 4) * 18;
    doc.text(l, xx, yy);
    doc.setDrawColor(180);
    doc.line(xx + 110, yy + 1, xx + 250, yy + 1);
  });

  // Tabla de conceptos
  doc.autoTable({
    startY: y + 130,
    head: [['Clave', 'Descripción', 'Unidad', 'Cantidad', 'P.U. cotizado', 'Importe']],
    body: conceptosSub.map(cs => {
      const cat = conceptosAll[cs.conceptoId] || {};
      return [cat.clave || '', cat.descripcion || '', cat.unidad || '',
        num2(cs.cantidadSub), '', ''];
    }),
    foot: [[{ content: 'TOTAL', colSpan: 5, styles: { halign: 'right', fontStyle: 'bold' } }, '']],
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 5, lineColor: [200, 210, 220], lineWidth: 0.4 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold' },
    footStyles: { fillColor: [240, 245, 250], textColor: 30, minCellHeight: 24 },
    columnStyles: {
      0: { cellWidth: 60, font: 'courier' },
      1: { cellWidth: 220 },
      2: { cellWidth: 36, halign: 'center' },
      3: { halign: 'right' },
      4: { halign: 'right', minCellHeight: 22 },
      5: { halign: 'right' }
    },
    margin: { left: 30, right: 30, bottom: 90 },
    didDrawPage: (data) => drawFooter(doc, data)
  });

  // Notas y firmas
  let yy = doc.lastAutoTable.finalY + 24;
  if (yy > 680) { doc.addPage(); yy = 100; }
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
  doc.text('NOTAS:', 30, yy);
  for (let i = 0; i < 3; i++) {
    doc.setDrawColor(200);
    doc.line(30, yy + 14 + i * 14, doc.internal.pageSize.width - 30, yy + 14 + i * 14);
  }
  yy += 60;
  doc.line(60, yy + 30, 260, yy + 30);
  doc.line(360, yy + 30, 560, yy + 30);
  doc.setFontSize(8).setTextColor(120);
  doc.text('Firma del licitante', 160, yy + 42, { align: 'center' });
  doc.text('Sello / fecha', 460, yy + 42, { align: 'center' });

  doc.save(`Invitacion_${safeName(m.nombre)}_${safeName(meta.nombre)}.pdf`);
}

// 3) ===== Parser de XLSX del licitante =====
export async function parseLicitanteXlsxCompras(file, sub, conceptosAll = {}) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let isOurTemplate = false;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if ((rows[i] || []).some(c => c === LIC_MARK || c === '#APP-ESTIMACIONES-LICITANTE#')) {
      isOurTemplate = true; break;
    }
  }

  // Extraer datos del licitante de las filas etiquetadas
  let nombre = '', rfc = '', email = '', telefono = '', contacto = '', tipoTexto = '';
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] || [];
    const lbl = String(r[0] || '').toLowerCase();
    const val = String(r[1] || '').trim();
    if (!val) continue;
    if (lbl.includes('nombre') || lbl.includes('razón social')) nombre = val;
    else if (lbl.includes('rfc')) rfc = val;
    else if (lbl.includes('email') || lbl.includes('correo')) email = val;
    else if (lbl.includes('teléfono') || lbl.includes('telefono')) telefono = val;
    else if (lbl.includes('contacto')) contacto = val;
    else if (lbl.includes('tipo')) tipoTexto = val.toLowerCase();
  }
  // Heurística para tipoSubcontratacion
  const tipoSubcontratacion = (tipoTexto.includes('destajo') || tipoTexto.includes('solo mo') || tipoTexto.includes('mano de obra'))
    ? 'destajo'
    : 'subcontrato';

  // Buscar header de tabla
  let headerIdx = -1, claveCol = -1, puCol = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] || []).map(x => String(x || '').toLowerCase().trim());
    const cIdx = r.findIndex(c => c === 'clave');
    if (cIdx === -1) continue;
    const pIdx = r.findIndex(c => c.includes('p.u') || c.includes('precio unitario') || c.includes('p u') || c === 'pu cotizado' || c.includes('cotizado'));
    if (pIdx === -1) continue;
    headerIdx = i; claveCol = cIdx; puCol = pIdx;
    break;
  }
  if (headerIdx === -1) throw new Error('No se encontró la tabla con columnas "Clave" y "P.U. cotizado"');

  const preciosByClave = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const clave = String(r[claveCol] || '').trim();
    if (!clave) continue;
    const pu = Number(String(r[puCol] || '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(pu) || pu <= 0) continue;
    preciosByClave[clave] = pu;
  }

  // Mapear clave → conceptoId usando los conceptos del subcontrato
  const conceptosSub = conceptosToArray(sub);
  const precios = {};
  const unmatched = [];
  for (const cs of conceptosSub) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    const p = preciosByClave[cat.clave];
    if (p != null) precios[cs.conceptoId] = p;
  }
  for (const k of Object.keys(preciosByClave)) {
    const found = conceptosSub.some(cs => conceptosAll[cs.conceptoId]?.clave === k);
    if (!found) unmatched.push(k);
  }

  return {
    nombre, rfc, email, telefono, contacto,
    tipoSubcontratacion,
    precios, preciosByClave, unmatched, isOurTemplate,
    foundCount: Object.keys(precios).length
  };
}

// 4) ===== Comparativa XLSX =====
export function exportComparativaXlsxCompras(obra, sub, conceptosAll) {
  const m = obra?.meta || {};
  const meta = sub?.meta || {};
  const conceptosSub = conceptosToArray(sub);
  const lics = Object.entries(sub?.licitantes || {})
    .filter(([_, l]) => !l.archivado)
    .map(([id, l]) => ({ id, ...l }));

  // Header columnas (cada licitante: P.U., Importe, Ahorro %)
  const aoa = [
    ['COMPARATIVA DE LICITANTES'],
    [],
    ['OBRA:', m.nombre || '', '', 'SUBCONTRATO:', meta.nombre || ''],
    ['CONTRATO:', m.contratoNo || '', '', 'FECHA:', dateStr(Date.now())],
    [],
    ['Clave', 'Descripción', 'U.', 'Cant.', 'P.U. catálogo', 'Importe catálogo',
      'Mat. SOGRUB',
      ...lics.flatMap(l => {
        const labelTipo = l.tipoSubcontratacion === 'destajo' ? ' (DESTAJO+mat)' : '';
        return [`${l.nombre || ''}${labelTipo} P.U.`, `${l.nombre || ''} importe`, `${l.nombre || ''} ahorro %`];
      })
    ]
  ];

  let totalCat = 0;
  const totales = lics.map(() => 0);

  for (const cs of conceptosSub) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    const cant = Number(cs.cantidadSub) || 0;
    const puCat = cat.precio_unitario || 0;
    const impCat = cant * puCat;
    const matSogrub = Number(cs.costoMaterialSogrub) || 0;
    totalCat += impCat;
    const cells = [cat.clave, cat.descripcion, cat.unidad, cant, puCat, impCat, matSogrub];

    lics.forEach((l, i) => {
      const p = Number(l.precios?.[cs.conceptoId]);
      const valid = Number.isFinite(p) && p > 0;
      // Precio comparable: destajo suma material SOGRUB
      const comparable = valid
        ? (l.tipoSubcontratacion === 'destajo' ? p + matSogrub : p)
        : 0;
      const imp = valid ? comparable * cant : 0;
      totales[i] += imp;
      cells.push(valid ? p : '');                              // P.U. cotizado (puro)
      cells.push(valid ? imp : '');                            // Importe comparable
      cells.push(valid && puCat > 0 ? (puCat - comparable) / puCat : '');  // Ahorro vs catálogo
    });
    aoa.push(cells);
  }

  // Total
  const totalRow = ['', '', '', '', 'TOTAL', totalCat, ''];
  lics.forEach((l, i) => {
    const t = totales[i];
    totalRow.push('', t, totalCat > 0 ? (totalCat - t) / totalCat : '');
  });
  aoa.push([]);
  aoa.push(totalRow);

  // Análisis
  const cotizadosArr = lics.map((_, i) => 0);
  for (const cs of conceptosSub) {
    lics.forEach((l, i) => {
      const p = Number(l.precios?.[cs.conceptoId]);
      if (Number.isFinite(p) && p > 0) cotizadosArr[i]++;
    });
  }
  const resumen = lics.map((l, i) => ({
    nombre: l.nombre || '',
    tipo: l.tipoSubcontratacion || 'subcontrato',
    total: totales[i],
    cotizados: cotizadosArr[i],
    completo: cotizadosArr[i] === conceptosSub.length,
    ahorroAbs: totalCat - totales[i],
    ahorroPct: totalCat > 0 ? (totalCat - totales[i]) / totalCat : 0
  }));
  const completos = resumen.filter(r => r.completo).sort((a, b) => a.total - b.total);
  const ganador = completos.length ? completos[0] : null;

  aoa.push([]);
  aoa.push([]);
  aoa.push(['ANÁLISIS DE COTIZACIONES']);
  aoa.push(['Licitante', 'Tipo', 'Cotizado', 'Total comparable', 'Ahorro $ vs catálogo', 'Ahorro % vs catálogo']);
  for (const r of resumen) {
    aoa.push([
      r.nombre,
      r.tipo === 'destajo' ? 'Destajo (solo MO + mat. SOGRUB)' : 'Subcontrato completo',
      `${r.cotizados} / ${conceptosSub.length}` + (r.completo ? '' : ' (incompleto)'),
      r.total, r.ahorroAbs, r.ahorroPct
    ]);
  }
  aoa.push([]);
  if (ganador) {
    aoa.push(['OPCIÓN MÁS ECONÓMICA:', ganador.nombre, ganador.tipo]);
    aoa.push(['Total:', '', '', ganador.total]);
    aoa.push([(ganador.ahorroAbs >= 0 ? 'Ahorro' : 'Sobrecosto') + ' vs catálogo:',
      '', '', Math.abs(ganador.ahorroAbs), ganador.ahorroPct]);
  } else {
    aoa.push(['SIN OPCIÓN COMPLETA — ningún licitante cotizó todo el alcance']);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const cols = [{ wch: 12 }, { wch: 50 }, { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 12 }];
  for (const _ of lics) cols.push({ wch: 14 }, { wch: 14 }, { wch: 9 });
  ws['!cols'] = cols;

  XLSX.utils.book_append_sheet(wb, ws, 'Comparativa');
  XLSX.writeFile(wb, `Comparativa_${safeName(m.nombre)}_${safeName(meta.nombre)}.xlsx`);
}

// 5) ===== Comparativa PDF =====
export function exportComparativaPdfCompras(obra, sub, conceptosAll) {
  const m = obra?.meta || {};
  const meta = sub?.meta || {};
  const conceptosSub = conceptosToArray(sub);
  const lics = Object.entries(sub?.licitantes || {})
    .filter(([_, l]) => !l.archivado)
    .map(([id, l]) => ({ id, ...l }));

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  drawHeader(doc, obra, `COMPARATIVA — ${meta.nombre || 'Subcontrato'}`);

  // Solo mostramos columna "Mat. SOGRUB" si hay al menos un destajista
  // (si no, esa columna está siempre vacía y solo estorba).
  const hayDestajo = lics.some(l => l.tipoSubcontratacion === 'destajo');

  let totalCat = 0;
  const totales = lics.map(() => 0);
  const cotizados = lics.map(() => 0);
  const mejores = lics.map(() => 0);
  const body = [];

  for (const cs of conceptosSub) {
    const cat = conceptosAll[cs.conceptoId];
    if (!cat) continue;
    const cant = Number(cs.cantidadSub) || 0;
    const puCat = cat.precio_unitario || 0;
    const impCat = cant * puCat;
    const matSogrub = Number(cs.costoMaterialSogrub) || 0;
    totalCat += impCat;

    // Precio comparable: destajo suma mat. SOGRUB. Subcontrato usa su P.U. directo.
    const comparables = lics.map(l => {
      const p = Number(l.precios?.[cs.conceptoId]);
      if (!Number.isFinite(p) || p <= 0) return null;
      return l.tipoSubcontratacion === 'destajo' ? p + matSogrub : p;
    });
    const validIdxs = comparables.map((p, i) => p != null ? i : -1).filter(i => i >= 0);
    const bestComp = validIdxs.length ? Math.min(...validIdxs.map(i => comparables[i])) : null;

    const row = [cat.clave || '', cat.descripcion || '', cat.unidad || '',
      num2(cant), money(puCat), money(impCat)];
    if (hayDestajo) {
      // Mostramos el mat. SOGRUB del concepto. Vacío si 0 para no saturar.
      row.push(matSogrub > 0 ? money(matSogrub) : '—');
    }

    lics.forEach((l, i) => {
      const p = Number(l.precios?.[cs.conceptoId]);
      const valid = Number.isFinite(p) && p > 0;
      const comp = comparables[i];
      const imp = valid ? comp * cant : 0;
      if (valid) { cotizados[i]++; totales[i] += imp; }
      const isBest = valid && bestComp != null && Math.abs(comp - bestComp) < 0.01;
      if (isBest) mejores[i]++;

      row.push(valid ? money(p) : '—');
      row.push(valid ? money(imp) : '—');
      const ahorroPct = valid && puCat > 0 ? (puCat - comp) / puCat : null;
      row.push(ahorroPct != null ? fmtPct(ahorroPct) : '—');
    });
    body.push(row);
  }

  // Total row
  const totalRow = ['', '', '', '', 'TOTAL', money(totalCat)];
  if (hayDestajo) totalRow.push('');
  lics.forEach((l, i) => {
    const t = totales[i];
    totalRow.push('', money(t), totalCat > 0 ? fmtPct((totalCat - t) / totalCat) : '—');
  });
  body.push(totalRow);

  // Headers: el grupo "Catálogo" cubre P.U./Importe(/Mat. SOGRUB)
  const head1Cols = ['', '', '', '', '', 'Catálogo'];
  if (hayDestajo) head1Cols.push('Mat. SOGRUB');
  for (const l of lics) {
    const tipo = l.tipoSubcontratacion === 'destajo' ? '(D + mat)' : '';
    head1Cols.push(`${l.nombre || ''} ${tipo}`, '', '');
  }
  const head2Cols = ['Clave', 'Descripción', 'U.', 'Cant.', 'P.U.', 'Importe'];
  if (hayDestajo) head2Cols.push('P.U.');
  for (let i = 0; i < lics.length; i++) head2Cols.push('P.U.', 'Importe', 'Ahorro %');

  const columnStyles = {
    0: { cellWidth: 50, font: 'courier' },
    1: { cellWidth: 160 },
    2: { cellWidth: 22, halign: 'center' },
    3: { halign: 'right', cellWidth: 36 },
    4: { halign: 'right', cellWidth: 48 },
    5: { halign: 'right', cellWidth: 55 }
  };
  if (hayDestajo) {
    columnStyles[6] = { halign: 'right', cellWidth: 50, fillColor: [255, 250, 230] };
  }

  doc.autoTable({
    startY: 140,
    head: [head1Cols, head2Cols],
    body,
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 3, lineColor: [200, 210, 220], lineWidth: 0.3 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold', halign: 'center' },
    columnStyles,
    margin: { left: 20, right: 20, bottom: 60 },
    didDrawPage: (data) => drawFooter(doc, data)
  });

  // Resumen
  let y = doc.lastAutoTable.finalY + 20;
  if (y > 500) { doc.addPage(); y = 100; }
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(40);
  doc.text('ANÁLISIS', 30, y);
  doc.autoTable({
    startY: y + 8,
    head: [['Licitante', 'Tipo', 'Cotizado', 'Total', '# Mejor precio', 'Ahorro %']],
    body: lics.map((l, i) => [
      l.nombre || '',
      l.tipoSubcontratacion === 'destajo' ? 'Destajo' : 'Subcontrato',
      `${cotizados[i]} / ${conceptosSub.length}` + (cotizados[i] === conceptosSub.length ? '' : ' ⚠'),
      money(totales[i]),
      String(mejores[i]),
      totalCat > 0 ? fmtPct((totalCat - totales[i]) / totalCat) : '—'
    ]),
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold' },
    margin: { left: 30, right: 30, bottom: 60 },
    didDrawPage: (data) => drawFooter(doc, data)
  });

  doc.save(`Comparativa_${safeName(m.nombre)}_${safeName(meta.nombre)}.pdf`);
}

// ===== Cálculos compartidos de comparativa de catálogo (materiales) =====
//
// Compara MATERIALES (no conceptos de subcontrato): los materiales de una
// solicitud × los proveedores activos, con el precio capturado en el catálogo.
//
// IVA por CELDA (no por proveedor): cada precio se captura CON IVA por defecto
// y, como el IVA se acredita, su costo efectivo = monto / (1+IVA). Si una celda
// se marcó "considerar sin IVA" (sin factura, no se acredita), el costo efectivo
// es el monto completo. El ranking y el "mejor precio" usan ese costo efectivo,
// comparable contra el catálogo OPUS (que es sin IVA).
//
// payload: {
//   provs:           [{ nombre }]                 columnas en orden de despliegue
//   rows:            [{ clave, descripcion, unidad, familia, opus, cantidad,
//                       precios: [{ valor, disponible, sinIva }] }]  (paralelo a provs)
//   iva:             0.16
//   solicitudNombre: string (título del documento)
//   filtrosDesc:     string descriptivo de los filtros activos
// }
function analizarComparativaCatalogo(payload) {
  const { provs = [], rows = [], iva = 0.16 } = payload || {};
  // Costo efectivo (acreditando IVA): celda con IVA → monto/(1+iva); sin IVA → monto.
  const effOf = (cell) => {
    const v = Number(cell?.valor) || 0;
    if (!cell || cell.disponible === false || v <= 0) return null;
    return cell.sinIva ? v : v / (1 + iva);
  };
  const hasCant = rows.some(r => Number(r.cantidad) > 0);

  const cotizados = provs.map(() => 0);
  const mejores = provs.map(() => 0);
  const ahorroAcum = provs.map(() => 0);
  const ahorroN = provs.map(() => 0);
  const totalProv = provs.map(() => 0);          // Σ cantidad × costo efectivo
  const bestCells = new Set();                    // `${rowIdx}:${provIdx}` celda ganadora
  const sinIvaCells = new Set();                  // celdas marcadas "sin IVA"
  const bestProvByRow = [];
  let opusTotal = 0;

  rows.forEach((r, ri) => {
    const opus = Number(r.opus) || 0;
    const cant = Number(r.cantidad) || 0;
    opusTotal += cant * opus;

    let best = Infinity, bestIdx = -1;
    provs.forEach((p, pi) => {
      const cell = r.precios[pi];
      const e = effOf(cell);
      if (e == null) return;
      if (cell.sinIva) sinIvaCells.add(`${ri}:${pi}`);
      if (e < best) { best = e; bestIdx = pi; }
    });
    bestProvByRow.push(bestIdx);

    provs.forEach((p, pi) => {
      const e = effOf(r.precios[pi]);
      if (e == null) return;
      cotizados[pi]++;
      totalProv[pi] += cant * e;
      if (opus > 0) { ahorroAcum[pi] += (opus - e) / opus; ahorroN[pi]++; }
      if (best < Infinity && Math.abs(e - best) < 0.005) { mejores[pi]++; bestCells.add(`${ri}:${pi}`); }
    });
  });

  // Ranking: completos por total ascendente; el resto detrás por # de mejores.
  const full = provs.map((_, i) => cotizados[i] === rows.length && rows.length > 0);
  const order = provs.map((_, i) => i).sort((a, b) => {
    if (hasCant && full[a] !== full[b]) return full[a] ? -1 : 1;
    if (hasCant && full[a] && full[b]) return totalProv[a] - totalProv[b];
    return mejores[b] - mejores[a];
  });
  const winnerIdx = order.length ? order[0] : -1;

  return { effOf, hasCant, cotizados, mejores, ahorroAcum, ahorroN, totalProv,
    opusTotal, bestCells, sinIvaCells, bestProvByRow, full, order, winnerIdx };
}

// Insights accionables para comparar proveedores de materiales en la vista
// activa. Devuelve [{ t: título, d: detalle }]. Es texto narrativo, no tabla.
function computeInsights(payload, a) {
  const { provs = [], rows = [] } = payload || {};
  const n = rows.length;
  const ins = [];
  const pct1 = (x) => (x * 100).toFixed(1) + '%';

  let sinNinguna = 0, unaSola = 0, cubiertos = 0;
  let basketBest = 0;                       // Σ cantidad × mejor costo efectivo
  let sobreOpus = 0;                        // materiales cuyo mejor efectivo > OPUS
  let disp = { pct: -1, clave: '', desc: '' };
  rows.forEach((r) => {
    const opus = Number(r.opus) || 0;
    const cant = Number(r.cantidad) || 0;
    const effs = provs.map((_, pi) => a.effOf(r.precios[pi])).filter(e => e != null);
    if (!effs.length) { sinNinguna++; return; }
    cubiertos++;
    if (effs.length === 1) unaSola++;
    const min = Math.min(...effs), max = Math.max(...effs);
    basketBest += cant * min;
    if (opus > 0 && min > opus) sobreOpus++;
    if (min > 0 && max > min) {
      const p = (max - min) / min;
      if (p > disp.pct) disp = { pct: p, clave: r.clave || '', desc: r.descripcion || '' };
    }
  });

  // 1) Recomendación: mejor opción de un solo proveedor.
  if (a.winnerIdx >= 0) {
    const w = provs[a.winnerIdx];
    if (a.hasCant && a.full[a.winnerIdx]) {
      ins.push({ t: `Mejor opción de un solo proveedor: ${w.nombre}`,
        d: `Total efectivo ${money(a.totalProv[a.winnerIdx])} para el alcance cotizado: ${pct1((a.opusTotal - a.totalProv[a.winnerIdx]) / a.opusTotal)} de ahorro vs catálogo OPUS (${money(a.opusTotal)}). Cotizó ${a.cotizados[a.winnerIdx]} de ${n} materiales.` });
    } else {
      ins.push({ t: `Proveedor más competitivo: ${w.nombre}`,
        d: `Ofrece el mejor precio en ${a.mejores[a.winnerIdx]} de ${n} materiales.` });
    }
  }

  // 2) ¿Conviene dividir la compra entre proveedores?
  if (a.hasCant && a.winnerIdx >= 0 && a.full[a.winnerIdx] && basketBest > 0) {
    const single = a.totalProv[a.winnerIdx];
    const dif = single - basketBest;
    if (dif > 0.5) {
      ins.push({ t: `Dividir la compra ahorra ${money(dif)} (${pct1(dif / single)})`,
        d: `Comprando cada material con el proveedor más barato la canasta cuesta ${money(basketBest)} vs ${money(single)} concentrando en ${provs[a.winnerIdx].nombre}. Implica emitir varias órdenes de compra.` });
    } else {
      ins.push({ t: 'Conviene concentrar la compra en un solo proveedor',
        d: `Dividir entre proveedores casi no mejora el costo (canasta óptima ${money(basketBest)}); la opción única simplifica la gestión sin perder ahorro.` });
    }
  }

  // 3) Cobertura de la cotización.
  const completos = a.full.filter(Boolean).length;
  ins.push({ t: 'Cobertura de la cotización',
    d: `${completos} de ${provs.length} proveedores cotizaron el 100% del alcance. ${cubiertos} de ${n} materiales tienen al menos un precio.` });

  // 4) Riesgos: huecos y poca competencia.
  if (sinNinguna > 0 || unaSola > 0) {
    const partes = [];
    if (sinNinguna > 0) partes.push(`${sinNinguna} material(es) sin ninguna cotización (faltan por solicitar)`);
    if (unaSola > 0) partes.push(`${unaSola} con una sola cotización (poca competencia)`);
    ins.push({ t: 'Atención', d: partes.join('; ') + '.' });
  }

  // 5) Dispersión / margen de negociación.
  if (disp.pct > 0.01) {
    ins.push({ t: `Mayor dispersión: ${disp.clave}`,
      d: `${(disp.desc || '').slice(0, 60)} varía ${pct1(disp.pct)} entre el proveedor más caro y el más barato — margen para negociar.` });
  }

  // 6) Sobreprecio vs catálogo.
  if (sobreOpus > 0) {
    ins.push({ t: `${sobreOpus} material(es) por encima del catálogo OPUS`,
      d: `Aun con la mejor cotización superan el costo OPUS (s/IVA). Conviene revisar especificación o buscar más proveedores.` });
  }

  // 7) Precios sin factura.
  if (a.sinIvaCells.size > 0) {
    ins.push({ t: `${a.sinIvaCells.size} precio(s) marcados SIN IVA`,
      d: 'Se tomaron al monto completo (sin factura, no acreditable). Verifica que el ahorro compense no poder deducir el IVA.' });
  }

  return ins;
}

// 6) ===== Comparativa ejecutiva de catálogo (materiales) — PDF =====
export function exportCatalogoComparativaPdf(obra, payload) {
  const m = obra?.meta || {};
  const { provs = [], rows = [], iva = 0.16, solicitudNombre = '', filtrosDesc = '' } = payload || {};
  const a = analizarComparativaCatalogo(payload);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  let y = drawHeader(doc, obra, 'COMPARATIVA EJECUTIVA');

  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(30);
  doc.text(solicitudNombre || 'Comparativa de precios', 30, y);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  doc.text(`${rows.length} materiales · ${provs.length} proveedores${filtrosDesc ? ' · ' + filtrosDesc : ''}`, 30, y + 15);
  doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(120);
  doc.text('Precios CON IVA; el costo efectivo descuenta el IVA acreditable. Celdas marcadas "sin IVA" se toman al monto completo.', 30, y + 28);
  y += 42;

  // ===== Resumen ejecutivo (ranking) =====
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(40);
  doc.text('RESUMEN EJECUTIVO', 30, y);

  const sumHead = ['#', 'Proveedor', 'Cotizados'];
  if (a.hasCant) sumHead.push('Total efectivo', 'Ahorro $ vs OPUS', 'Ahorro %');
  sumHead.push('# Mejor precio', 'Ahorro prom.');

  const sumBody = a.order.map((i, rank) => {
    const p = provs[i];
    const row = [
      String(rank + 1),
      (p.nombre || '') + (i === a.winnerIdx ? '  *' : ''),
      `${a.cotizados[i]} / ${rows.length}` + (a.full[i] ? '' : ' (incompleto)')
    ];
    if (a.hasCant) {
      row.push(money(a.totalProv[i]));
      row.push(a.full[i] ? money(a.opusTotal - a.totalProv[i]) : '—');
      row.push(a.full[i] && a.opusTotal > 0 ? fmtPct((a.opusTotal - a.totalProv[i]) / a.opusTotal) : '—');
    }
    row.push(String(a.mejores[i]));
    row.push(a.ahorroN[i] > 0 ? fmtPct(a.ahorroAcum[i] / a.ahorroN[i]) : '—');
    return row;
  });

  doc.autoTable({
    startY: y + 8,
    head: [sumHead],
    body: sumBody,
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 22, halign: 'center' } },
    margin: { left: 30, right: 30, bottom: 60 },
    didParseCell: (data) => {
      if (data.section === 'body' && a.order[data.row.index] === a.winnerIdx) {
        data.cell.styles.fillColor = [225, 245, 233];
        data.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawPage: (data) => drawFooter(doc, data)
  });

  let yr = doc.lastAutoTable.finalY + 10;
  if (a.winnerIdx >= 0) {
    const w = provs[a.winnerIdx];
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(20, 120, 70);
    const linea = a.hasCant && a.full[a.winnerIdx]
      ? `Opción más económica: ${w.nombre} — ${money(a.totalProv[a.winnerIdx])} (ahorro ${fmtPct((a.opusTotal - a.totalProv[a.winnerIdx]) / a.opusTotal)} vs OPUS)`
      : `Proveedor con más precios ganadores: ${w.nombre} (${a.mejores[a.winnerIdx]} de ${rows.length})`;
    doc.text(linea, 30, yr);
    yr += 14;
  }
  if (a.hasCant) {
    doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(110);
    doc.text(`Referencia catálogo OPUS (s/IVA): ${money(a.opusTotal)}`, 30, yr);
    yr += 12;
  }

  // ===== Insights =====
  const insights = computeInsights(payload, a);
  if (insights.length) {
    let yi = yr + 16;
    if (yi > 500) { doc.addPage(); yi = 60; }
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(40);
    doc.text('INSIGHTS', 30, yi);
    yi += 16;
    const wText = doc.internal.pageSize.width - 84;
    for (const it of insights) {
      const detLines = doc.splitTextToSize(it.d, wText);
      const blockH = 12 + detLines.length * 11 + 8;
      if (yi + blockH > 560) { doc.addPage(); yi = 60; }
      doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(40);
      doc.text('• ' + it.t, 30, yi);
      yi += 12;
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(80);
      doc.text(detLines, 42, yi);
      yi += detLines.length * 11 + 8;
    }
  }

  // ===== Detalle por material =====
  doc.addPage();
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(40);
  doc.text('DETALLE POR MATERIAL', 30, 60);

  const head = ['Clave', 'Descripción', 'U.'];
  if (a.hasCant) head.push('Cant.');
  head.push('OPUS s/IVA', 'OPUS +IVA');
  for (const p of provs) head.push(p.nombre || '');
  const opusIdx = 3 + (a.hasCant ? 1 : 0);
  const baseCols = opusIdx + 2;   // dos columnas OPUS antes de proveedores

  const body = rows.map((r) => {
    const opus = Number(r.opus) || 0;
    const line = [r.clave || '', r.descripcion || '', r.unidad || ''];
    if (a.hasCant) line.push(num2(r.cantidad));
    line.push(opus > 0 ? money(opus) : '—', opus > 0 ? money(opus * (1 + iva)) : '—');
    provs.forEach((p, pi) => {
      const cell = r.precios[pi];
      const v = Number(cell?.valor) || 0;
      line.push(!cell || v <= 0 ? (cell && cell.disponible === false ? 'no maneja' : '—') : money(v));
    });
    return line;
  });

  // Fila TOTAL efectivo (solo con cantidades).
  if (a.hasCant) {
    const tRow = new Array(head.length).fill('');
    tRow[1] = 'TOTAL EFECTIVO';
    tRow[opusIdx] = money(a.opusTotal);
    provs.forEach((p, pi) => { tRow[baseCols + pi] = money(a.totalProv[pi]) + (a.full[pi] ? '' : ' *'); });
    body.push(tRow);
  }

  const columnStyles = {
    0: { cellWidth: 50, font: 'courier' },
    1: { cellWidth: 150 },
    2: { cellWidth: 22, halign: 'center' },
    [opusIdx]: { halign: 'right', cellWidth: 52, textColor: [120, 120, 120] },
    [opusIdx + 1]: { halign: 'right', cellWidth: 52, textColor: [120, 120, 120] }
  };
  if (a.hasCant) columnStyles[3] = { halign: 'right', cellWidth: 40 };
  for (let i = 0; i < provs.length; i++) columnStyles[baseCols + i] = { halign: 'right' };

  const totalRowIdx = a.hasCant ? rows.length : -1;
  doc.autoTable({
    startY: 72,
    head: [head],
    body,
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 3, lineColor: [200, 210, 220], lineWidth: 0.3 },
    headStyles: { fillColor: [40, 50, 65], textColor: 230, fontStyle: 'bold', halign: 'center' },
    columnStyles,
    margin: { left: 20, right: 20, bottom: 60 },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      if (data.row.index === totalRowIdx) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [240, 244, 248]; return; }
      if (data.column.index < baseCols) return;
      const pi = data.column.index - baseCols;
      const key = `${data.row.index}:${pi}`;
      if (a.bestCells.has(key)) {
        data.cell.styles.textColor = [20, 120, 70];
        data.cell.styles.fontStyle = 'bold';
      } else if (a.sinIvaCells.has(key)) {
        data.cell.styles.textColor = [196, 130, 20];   // ámbar = celda sin IVA
      }
    },
    didDrawPage: (data) => drawFooter(doc, data)
  });

  let yl = doc.lastAutoTable.finalY + 12;
  if (yl > 540) { doc.addPage(); yl = 60; }
  doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(120);
  doc.text('Verde = mejor costo efectivo de la fila. Ámbar = precio marcado SIN IVA (sin factura).', 30, yl);

  doc.save(`Comparativa_${safeName(solicitudNombre || m.nombre)}.pdf`);
}

// 7) ===== Comparativa ejecutiva de catálogo (materiales) — XLSX =====
export function exportCatalogoComparativaXlsx(obra, payload) {
  const m = obra?.meta || {};
  const { provs = [], rows = [], iva = 0.16, solicitudNombre = '', filtrosDesc = '' } = payload || {};
  const a = analizarComparativaCatalogo(payload);

  const header = ['Clave', 'Descripción', 'Unidad', 'Familia'];
  if (a.hasCant) header.push('Cantidad');
  header.push('OPUS s/IVA', 'OPUS +IVA');
  for (const p of provs) header.push(p.nombre || '');
  header.push('Mejor $ (efectivo)', 'Mejor proveedor');

  const aoa = [
    ['COMPARATIVA EJECUTIVA — CATÁLOGO DE PRECIOS'],
    ['OBRA:', m.nombre || '', '', 'SOLICITUD:', solicitudNombre || ''],
    ['FECHA:', dateStr(Date.now()), '', `${rows.length} materiales · ${provs.length} proveedores${filtrosDesc ? ' · ' + filtrosDesc : ''}`],
    ['Precios CON IVA. Costo efectivo = monto/(1+IVA) salvo celdas marcadas SIN IVA (monto completo). El mejor y los totales usan el costo efectivo.'],
    [],
    header
  ];
  const startData = aoa.length;
  const opusCol = 4 + (a.hasCant ? 1 : 0);     // índice de "OPUS s/IVA"
  const baseCols = opusCol + 2;                 // dos columnas OPUS antes de proveedores

  rows.forEach((r, ri) => {
    const opus = Number(r.opus) || 0;
    const line = [r.clave || '', r.descripcion || '', r.unidad || '', r.familia || ''];
    if (a.hasCant) line.push(Number(r.cantidad) || 0);
    line.push(opus > 0 ? opus : '', opus > 0 ? opus * (1 + iva) : '');
    provs.forEach((p, pi) => {
      const cell = r.precios[pi];
      const v = Number(cell?.valor) || 0;
      line.push(!cell || v <= 0 ? (cell && cell.disponible === false ? 'no maneja' : '') : v);
    });
    const bi = a.bestProvByRow[ri];
    line.push(bi >= 0 ? a.effOf(r.precios[bi]) : '');
    line.push(bi >= 0 ? (provs[bi].nombre || '') : '');
    aoa.push(line);
  });

  // Fila TOTAL efectivo (si hay cantidades)
  if (a.hasCant) {
    const tRow = new Array(header.length).fill('');
    tRow[1] = 'TOTAL EFECTIVO';
    tRow[opusCol] = a.opusTotal;
    provs.forEach((p, pi) => { tRow[baseCols + pi] = a.totalProv[pi]; });
    aoa.push(tRow);
  }
  const lastTableRow = aoa.length - 1;

  // Análisis por proveedor
  aoa.push([]);
  aoa.push(['ANÁLISIS POR PROVEEDOR']);
  const anaHead = ['#', 'Proveedor', 'Cotizados'];
  if (a.hasCant) anaHead.push('Total efectivo', 'Ahorro $ vs OPUS', 'Ahorro %');
  anaHead.push('# Mejor precio', 'Ahorro prom. vs OPUS');
  aoa.push(anaHead);
  a.order.forEach((i, rank) => {
    const p = provs[i];
    const row = [rank + 1, p.nombre || '',
      `${a.cotizados[i]} / ${rows.length}` + (a.full[i] ? '' : ' (incompleto)')];
    if (a.hasCant) {
      row.push(a.totalProv[i]);
      row.push(a.full[i] ? a.opusTotal - a.totalProv[i] : '');
      row.push(a.full[i] && a.opusTotal > 0 ? (a.opusTotal - a.totalProv[i]) / a.opusTotal : '');
    }
    row.push(a.mejores[i]);
    row.push(a.ahorroN[i] > 0 ? a.ahorroAcum[i] / a.ahorroN[i] : '');
    aoa.push(row);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const cols = [{ wch: 14 }, { wch: 50 }, { wch: 8 }, { wch: 16 }];
  if (a.hasCant) cols.push({ wch: 10 });
  cols.push({ wch: 12 }, { wch: 12 });
  for (const _ of provs) cols.push({ wch: 16 });
  cols.push({ wch: 16 }, { wch: 22 });
  ws['!cols'] = cols;

  // Formato moneda en columnas numéricas (OPUS x2, proveedores, mejor $).
  for (let r = startData; r <= lastTableRow; r++) {
    for (let c = opusCol; c <= header.length - 2; c++) setNumFmt(ws, r, c, '"$"#,##0.00');
    if (a.hasCant) setNumFmt(ws, r, 4, '#,##0.00');   // cantidad
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Comparativa');
  XLSX.writeFile(wb, `Comparativa_${safeName(solicitudNombre || m.nombre)}.xlsx`);
}
