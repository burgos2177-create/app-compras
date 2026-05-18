// Export/import de licitantes para subcontratos.
//
// jsPDF y SheetJS están cargados via CDN en index.html como globals
// (window.jspdf, window.XLSX). Cuatro funciones:
//   1. exportLicitanteXlsx — template para que el licitante llene precios.
//   2. exportLicitantePdf  — invitación a cotizar en PDF.
//   3. parseLicitanteXlsx  — lee el XLSX devuelto y extrae precios.
//   4. exportComparativaXlsx / exportComparativaPdf — comparativa lista
//      para revisión offline o presentar a dirección.
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
  return (n >= 0 ? '−' : '+') + Math.abs(n * 100).toFixed(1) + '%';
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
