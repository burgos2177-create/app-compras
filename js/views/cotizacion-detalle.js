import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy,
  loadCatalogoConceptos, loadCatalogoMateriales,
  listProveedoresGlobal,
  getBuzonItem, updateBuzonItem,
  getCotizacion, createCotizacion, updateCotizacion, listCotizaciones,
  createOC, updateOC,
  pushBuzonItem, setRequisicionOcRef
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx, num, num0, money, reqFolio, ocFolio } from '../util/format.js';
import { deriveTotales } from '../services/totales.js';
import { estadoCotBadge } from './cotizaciones.js';

// Captura/edita una cotización contra una requisición aprobada y desde aquí
// se emite la OC. Reutilizada para `nueva` y `cotid` rutas — distinguimos por
// presencia de cotId en params.

export async function renderCotizacionDetalle({ params, query }) {
  const obraId = params.id;
  const cotId = params.cotid || null;          // null = captura nueva
  const reqBuzonId = query?.req || null;        // solo en modo nueva
  setState({ obraActual: obraId });
  renderShell(crumbsView(obraId, '...', cotId), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, catCon, catMat, proveedores, existing, reqItem] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId),
    listProveedoresGlobal(),
    cotId ? getCotizacion(obraId, cotId) : null,
    reqBuzonId ? getBuzonItem(reqBuzonId) : null
  ]);

  setState({ conceptos: catCon?.conceptos || null, materiales: catMat?.items || null });

  // Hidratamos la fuente de items: si es nueva, los traemos de la requisición;
  // si es edición, ya están en la cotización.
  let cot = existing;
  if (!cot) {
    if (!reqItem) {
      renderShell(crumbsView(obraId, meta?.nombre, null),
        h('div', { class: 'empty' }, 'Requisición no encontrada en el buzón.'));
      return;
    }
    if (reqItem.estado !== 'aprobado') {
      renderShell(crumbsView(obraId, meta?.nombre, null),
        h('div', { class: 'empty' }, [
          h('div', {}, 'La requisición no está en estado "aprobado".'),
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
            `Estado actual: ${reqItem.estado}. Solo se pueden cotizar requisiciones aprobadas.`)
        ]));
      return;
    }
    // Sembrar items desde la requisición. Conserva conceptoKey y materialKey.
    const seedItems = {};
    for (const [reqItemId, it] of Object.entries(reqItem.items || {})) {
      const m = (catMat?.items || {})[it.materialKey];
      seedItems[reqItemId] = {
        materialKey: it.materialKey,
        clave: m?.clave || '',
        descripcion: m?.descripcion || '',
        unidad: m?.unidad || '',
        cantidad: Number(it.cantidad) || 0,
        costoUnitario: Number(m?.costoUnitario) || 0,    // pre-llena con OPUS si existe
        conceptoKey: it.conceptoKey || null,
        origen: m?.origen || 'opus',
        notas: it.notas || ''
      };
    }
    cot = {
      reqIds: [reqBuzonId],
      proveedor: { id: null, nombre: '', rfc: '', telefono: '', email: '', contacto: '' },
      fechaCotizacion: Date.now(),
      vigenciaDias: 15,
      items: seedItems,
      incluyeIva: true,
      ivaPct: 0.16,
      retenciones: [],
      condicionesPago: 'Crédito 30 días',
      comentarios: '',
      estado: 'borrador'
    };
  }

  renderEditor({
    obraId, cotId, cot, meta,
    materiales: catMat?.items || {},
    conceptos: catCon?.conceptos || {},
    proveedores
  });
}

function renderEditor(ctx) {
  const { obraId, cotId, cot, meta, materiales, conceptos, proveedores } = ctx;

  // ====== Refs editables (mutamos `cot` en memoria; al guardar se persiste) ======
  const provSelect = h('select', {},
    [h('option', { value: '' }, '— elige proveedor —')]
      .concat([...proveedores].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '')).map(p =>
        h('option', { value: p.id, selected: cot.proveedor?.id === p.id }, p.nombre)))
  );
  provSelect.addEventListener('change', () => {
    const p = proveedores.find(x => x.id === provSelect.value);
    if (p) {
      cot.proveedor = { id: p.id, nombre: p.nombre, rfc: p.rfc || '', telefono: p.telefono || '', email: p.email || '', contacto: '' };
    } else {
      cot.proveedor = { id: null, nombre: '', rfc: '', telefono: '', email: '', contacto: '' };
    }
    repaint();
  });

  const provNombre = h('input', { value: cot.proveedor?.nombre || '', placeholder: '(o escribe un nombre nuevo)' });
  provNombre.addEventListener('input', () => {
    cot.proveedor = { ...(cot.proveedor || {}), nombre: provNombre.value, id: null };
  });

  const fechaInput = h('input', { type: 'date', value: dateForInput(cot.fechaCotizacion) });
  fechaInput.addEventListener('change', () => {
    cot.fechaCotizacion = fromInputDateLocal(fechaInput.value) || cot.fechaCotizacion;
  });

  const vigenciaInput = h('input', { type: 'number', min: '0', max: '365', value: String(cot.vigenciaDias || 0) });
  vigenciaInput.addEventListener('input', () => {
    cot.vigenciaDias = Number(vigenciaInput.value) || 0;
  });

  const condInput = h('input', { value: cot.condicionesPago || '' });
  condInput.addEventListener('input', () => { cot.condicionesPago = condInput.value; });

  const ivaToggle = h('input', { type: 'checkbox', checked: !!cot.incluyeIva });
  ivaToggle.addEventListener('change', () => {
    cot.incluyeIva = ivaToggle.checked;
    repaint();
  });
  const ivaPctInput = h('input', { type: 'number', step: '0.01', min: '0', max: '0.5', value: String(cot.ivaPct ?? 0.16) });
  ivaPctInput.addEventListener('input', () => {
    const v = Number(ivaPctInput.value);
    if (Number.isFinite(v)) { cot.ivaPct = v; repaint(); }
  });

  const comentariosArea = h('textarea', { rows: 2, placeholder: 'Comentarios internos / del proveedor' }, cot.comentarios || '');
  comentariosArea.addEventListener('input', () => { cot.comentarios = comentariosArea.value; });

  // ====== Render ======
  const editable = !cot.estado || ['borrador', 'recibida'].includes(cot.estado);
  const readonly = !editable;

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [cotId ? 'Cotización' : 'Nueva cotización', ' ', estadoCotBadge(cot.estado)]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', {
      class: 'btn',
      onClick: () => onSave(ctx, false)
    }, '💾 Guardar borrador'),
    editable && h('button', {
      class: 'btn primary',
      onClick: () => onSave(ctx, true)
    }, '📩 Marcar recibida'),
    cot.estado === 'recibida' && h('button', {
      class: 'btn primary',
      onClick: () => onEmitirOC(ctx)
    }, '↗ Emitir OC con esta cotización')
  ]);

  // Inputs deshabilitados visualmente cuando readonly
  if (readonly) {
    [provSelect, provNombre, fechaInput, vigenciaInput, condInput, ivaToggle, ivaPctInput, comentariosArea].forEach(el => el.disabled = true);
  }

  const datosCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos de la cotización'),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Proveedor (de catálogo)'), provSelect]),
      h('div', { class: 'field' }, [h('label', {}, 'O nuevo proveedor (texto libre)'), provNombre]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha de cotización'), fechaInput]),
      h('div', { class: 'field' }, [h('label', {}, 'Vigencia (días)'), vigenciaInput]),
      h('div', { class: 'field' }, [h('label', {}, 'Condiciones de pago'), condInput]),
      h('div', { class: 'field' }, [
        h('label', {}, 'IVA'),
        h('div', { class: 'row' }, [
          h('label', { class: 'row', style: { gap: '6px' } }, [
            ivaToggle, h('span', {}, 'Costos incluyen IVA')
          ]),
          h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Tasa:'),
          ivaPctInput
        ])
      ])
    ]),
    h('div', { class: 'field', style: { marginTop: '10px' } },
      [h('label', {}, 'Comentarios'), comentariosArea])
  ]);

  const itemsCard = renderItemsCard(ctx, repaint);
  const totalesCard = renderTotalesCard(cot);

  const cardOriginRef = h('div', { class: 'card' }, [
    h('h3', {}, 'Origen'),
    h('div', { class: 'muted', style: { fontSize: '13px' } },
      cot.reqIds && cot.reqIds.length > 0
        ? [
          'Cotización para ',
          ...cot.reqIds.map((rid, i) => [
            i > 0 && ', ',
            h('a', { href: `#/obras/${obraId}/inbox/${rid}` }, `requisición ${rid.slice(0, 6)}`)
          ])
        ]
        : 'Sin requisición vinculada.')
  ]);

  function repaint() {
    renderShell(crumbsView(obraId, meta?.nombre, cotId),
      h('div', {}, [head, datosCard, itemsCard, totalesCard, cardOriginRef]));
  }
  repaint();
}

function renderItemsCard(ctx, repaint) {
  const { cot } = ctx;
  const editable = !cot.estado || ['borrador', 'recibida'].includes(cot.estado);
  const entries = Object.entries(cot.items || {});

  const head = h('div', { style: { padding: '14px 18px 0', display: 'flex', alignItems: 'center', gap: '8px' } }, [
    h('h3', {}, [
      'Items ', h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } }, `(${num0(entries.length)})`)
    ]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', { class: 'btn sm primary', onClick: () => addItemDialog(ctx, repaint) }, '+ Item ad-hoc')
  ]);

  if (entries.length === 0) {
    return h('div', { class: 'card' }, [
      head,
      h('div', { class: 'empty' }, 'Sin items.')
    ]);
  }

  return h('div', { class: 'card', style: { padding: 0 } }, [
    head,
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'Costo unit.'),
        h('th', { class: 'num' }, 'Importe'),
        h('th', {}, 'Concepto OPUS'),
        editable && h('th', {}, '')
      ])]),
      h('tbody', {}, entries.map(([id, it]) => itemRow(ctx, id, it, repaint)))
    ])
  ]);
}

function itemRow(ctx, itemId, it, repaint) {
  const { cot, conceptos } = ctx;
  const editable = !cot.estado || ['borrador', 'recibida'].includes(cot.estado);
  const importe = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);

  const matLabel = h('div', {}, [
    it.clave && h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, [
      it.clave,
      it.origen === 'ad_hoc_compras' && h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'AD-HOC compras'),
      it.origen === 'ad_hoc' || it.origen === 'ad_hoc_materiales'
        ? h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'AD-HOC almacén') : null
    ]),
    h('div', {}, it.descripcion || '—'),
    it.notas && h('div', { class: 'muted', style: { fontSize: '11px' } }, it.notas)
  ]);

  const cantInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(it.cantidad || 0), style: { width: '90px' } });
  cantInput.addEventListener('input', () => {
    cot.items[itemId].cantidad = Number(cantInput.value) || 0;
    repaint();
  });

  const costoInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(it.costoUnitario || 0), style: { width: '110px' } });
  costoInput.addEventListener('input', () => {
    cot.items[itemId].costoUnitario = Number(costoInput.value) || 0;
    repaint();
  });

  if (!editable) { cantInput.disabled = true; costoInput.disabled = true; }

  const concepto = it.conceptoKey ? conceptos[it.conceptoKey] : null;
  const conceptoLabel = concepto
    ? h('span', { title: concepto.descripcion }, [
      h('span', { class: 'mono', style: { fontSize: '11px' } }, concepto.clave),
      h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } },
        (concepto.descripcion || '').slice(0, 28))
    ])
    : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—');

  return h('tr', {}, [
    h('td', { style: { maxWidth: '320px' } }, matLabel),
    h('td', {}, it.unidad || ''),
    h('td', { class: 'num' }, cantInput),
    h('td', { class: 'num' }, costoInput),
    h('td', { class: 'num' }, money(importe)),
    h('td', {}, conceptoLabel),
    editable && h('td', {}, h('button', {
      class: 'btn sm danger',
      onClick: () => {
        delete cot.items[itemId];
        repaint();
      }
    }, '🗑'))
  ]);
}

function renderTotalesCard(cot) {
  const t = deriveTotales(cot);
  return h('div', { class: 'card' }, [
    h('h3', {}, 'Totales'),
    h('div', { class: 'grid-3' }, [
      kv('Importe bruto', money(t.importeBruto)),
      kv('Subtotal (sin IVA)', money(t.subtotal)),
      kv(`IVA (${(t.ivaPct * 100).toFixed(0)}%)`, money(t.ivaImporte))
    ]),
    h('div', { class: 'grid-3', style: { marginTop: '8px' } }, [
      kv('Retenciones', money(t.retencionesTotal)),
      kv('Total', h('b', { style: { fontSize: '20px', color: 'var(--accent)' } }, money(t.total))),
      kv('Régimen IVA', cot.incluyeIva ? 'Costos brutos' : 'Costos sin IVA')
    ])
  ]);
}

// ====== Acciones ======

async function onSave(ctx, marcarRecibida) {
  const { obraId, cotId, cot } = ctx;
  // Validación mínima
  if (!cot.proveedor?.nombre) { toast('Captura un proveedor', 'danger'); return; }
  if (Object.keys(cot.items || {}).length === 0) { toast('La cotización no tiene items', 'danger'); return; }

  const totales = deriveTotales(cot);
  const dataPersist = {
    ...cot,
    subtotal: totales.subtotal,
    ivaImporte: totales.ivaImporte,
    retencionesTotal: totales.retencionesTotal,
    total: totales.total,
    estado: marcarRecibida ? 'recibida' : (cot.estado === 'recibida' ? 'recibida' : 'borrador')
  };

  try {
    if (cotId) {
      await updateCotizacion(obraId, cotId, dataPersist);
      toast(marcarRecibida ? 'Cotización marcada como recibida' : 'Cotización guardada', 'ok');
      navigate(`/obras/${obraId}/cotizaciones/${cotId}`);
    } else {
      const u = state.user;
      dataPersist.autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '' };
      const newId = await createCotizacion(obraId, dataPersist);
      toast(marcarRecibida ? 'Cotización creada y marcada como recibida' : 'Cotización creada', 'ok');
      navigate(`/obras/${obraId}/cotizaciones/${newId}`);
    }
  } catch (err) {
    toast('Error: ' + err.message, 'danger');
  }
}

async function onEmitirOC(ctx) {
  const { obraId, cotId, cot } = ctx;
  if (!cot.proveedor?.nombre) { toast('La cotización no tiene proveedor', 'danger'); return; }
  if (Object.keys(cot.items || {}).length === 0) { toast('La cotización no tiene items', 'danger'); return; }

  const totales = deriveTotales(cot);

  await modal({
    title: 'Emitir orden de compra',
    body: h('div', {}, [
      h('p', {}, [`Se emitirá una OC al proveedor `, h('b', {}, cot.proveedor.nombre),
        ' por un total de ', h('b', { style: { color: 'var(--accent)' } }, money(totales.total)), '.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, [
        'La OC se publica al buzón de bitácora para que el contador la apruebe y pague. ',
        'Las requisiciones vinculadas se cierran y otras cotizaciones de las mismas requisiciones se descartan.'
      ])
    ]),
    confirmLabel: 'Emitir', size: 'lg',
    onConfirm: async () => {
      try {
        await emitirOCFromCotizacion(ctx, totales);
        toast('OC emitida y enviada a contabilidad', 'ok');
        navigate(`/obras/${obraId}/oc`);
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function emitirOCFromCotizacion(ctx, totales) {
  const { obraId, cotId, cot } = ctx;
  const u = state.user;
  const autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras' };

  // 1. Crear OC en /shared/compras/obras/{obraId}/oc
  const ocPayload = {
    reqIds: cot.reqIds || [],
    cotizacionGanadoraId: cotId,
    proveedor: cot.proveedor,
    fechaEmision: Date.now(),
    fechaEntregaEstimada: null,
    condicionesPago: cot.condicionesPago || '',
    items: cot.items,
    incluyeIva: !!cot.incluyeIva,
    ivaPct: cot.ivaPct ?? 0.16,
    importeBruto: totales.importeBruto,
    subtotal: totales.subtotal,
    ivaImporte: totales.ivaImporte,
    retenciones: totales.retenciones,
    retencionesTotal: totales.retencionesTotal,
    total: totales.total,
    comentariosCompras: cot.comentarios || '',
    estado: 'enviada_buzon',
    autor
  };
  const ocId = await createOC(obraId, ocPayload);

  // 2. Construir el desglose por concepto OPUS para que bitácora lo reciba
  // ya armado y solo tenga que mapear conceptoKey → concepto_id (que ya
  // coincide en la suite unificada) al crear el sogrub_proy_movimientos.
  const desglose = Object.values(cot.items)
    .filter(it => it.conceptoKey)
    .map(it => ({
      conceptoKey: it.conceptoKey,
      conceptoClave: it.clave || '',
      conceptoDescripcion: it.descripcion || '',
      monto: ((Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0)) * (cot.incluyeIva
        ? 1 / (1 + (cot.ivaPct ?? 0.16))   // si incluye IVA, mandamos el subtotal sin IVA
        : 1)
    }));

  // 3. Push al buzón con tipo='oc_materiales'
  const buzonItem = {
    tipo: 'oc_materiales',
    origenApp: 'compras',
    obraId,
    ocId,
    numero: ocPayload.subtotal && ocId,    // bitácora asignará el folio CP-YYYY-NNN al aprobar
    proveedor: cot.proveedor,
    reqIds: cot.reqIds || [],
    fechaEmision: ocPayload.fechaEmision,
    condicionesPago: ocPayload.condicionesPago,
    items: Object.values(cot.items).map(it => ({
      materialKey: it.materialKey,
      clave: it.clave,
      descripcion: it.descripcion,
      unidad: it.unidad,
      cantidad: it.cantidad,
      costoUnitario: it.costoUnitario,
      importe: (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0),
      conceptoKey: it.conceptoKey || null,
      origen: it.origen || 'opus',
      notas: it.notas || ''
    })),
    incluyeIva: !!cot.incluyeIva,
    ivaPct: cot.ivaPct ?? 0.16,
    importeBruto: totales.importeBruto,
    subtotal: totales.subtotal,
    ivaImporte: totales.ivaImporte,
    retenciones: totales.retenciones,
    retencionesTotal: totales.retencionesTotal,
    total: totales.total,
    desglose,
    comentariosCompras: cot.comentarios || '',
    autor,
    estado: 'recibido'
  };
  const buzonOcId = await pushBuzonItem(buzonItem);

  // 4. Actualizar la OC con la referencia al item del buzón
  await updateOC(obraId, ocId, { buzonId: buzonOcId, enviadaBuzonAt: Date.now() });

  // 5. Marcar la cotización como ganadora
  await updateCotizacion(obraId, cotId, {
    estado: 'ganadora',
    ocId,
    ocBuzonId: buzonOcId,
    ganadoraAt: Date.now()
  });

  // 6. Descartar las demás cotizaciones que cubrían las mismas requisiciones
  const todas = await listCotizaciones(obraId);
  for (const [otherId, otherCot] of Object.entries(todas)) {
    if (otherId === cotId) continue;
    if (otherCot.estado === 'ganadora' || otherCot.estado === 'descartada') continue;
    const overlapsReqs = (otherCot.reqIds || []).some(r => (cot.reqIds || []).includes(r));
    if (overlapsReqs) {
      await updateCotizacion(obraId, otherId, {
        estado: 'descartada',
        descartadaAt: Date.now(),
        motivoDescarte: `Otra cotización ganó (OC ${ocId.slice(0, 6)})`
      });
    }
  }

  // 7. Cerrar las requisiciones en el buzón (estado='cerrado' con ocBuzonId)
  // y propagar la referencia a la requisición original en materiales para
  // que el almacenista vea el folio de la OC.
  for (const reqBuzonId of (cot.reqIds || [])) {
    await updateBuzonItem(reqBuzonId, {
      estado: 'cerrado',
      ocBuzonId: buzonOcId,
      ocId,
      cerradoAt: Date.now(),
      cerradoPor: autor
    });
    const reqItem = await getBuzonItem(reqBuzonId);
    if (reqItem?.reqId && reqItem?.obraId) {
      await setRequisicionOcRef(reqItem.obraId, reqItem.reqId, {
        ocBuzonId: buzonOcId,
        ocId
      });
    }
  }
}

// ====== Helpers ======

function addItemDialog(ctx, repaint) {
  const { cot, materiales } = ctx;
  // Permite agregar un material existente del catálogo o uno totalmente nuevo
  // (ad-hoc compras). Los del catálogo conservan materialKey; los nuevos
  // generan un materialKey efímero (no se persiste al catálogo desde acá —
  // eso pasa al emitir la OC a través de un createMaterialAdHocDesdeCompras
  // futuro; por ahora viven solo en la cotización/OC).
  const materialList = Object.entries(materiales)
    .sort((a, b) => (a[1].descripcion || '').localeCompare(b[1].descripcion || ''))
    .slice(0, 500); // Cap para que no truene la UI con catálogos grandes

  const matSelect = h('select', {}, [
    h('option', { value: '' }, '— elige material existente —'),
    ...materialList.map(([k, m]) =>
      h('option', { value: k }, `${m.clave} · ${m.descripcion}`))
  ]);

  const adHocClave = h('input', { placeholder: 'Clave (opcional, ej. AD-001)' });
  const adHocDesc = h('input', { placeholder: 'Descripción del material' });
  const adHocUnidad = h('input', { placeholder: 'Unidad (PZA, KG, etc.)' });
  const cantidad = h('input', { type: 'number', step: '0.01', min: '0', value: '1' });
  const costo = h('input', { type: 'number', step: '0.01', min: '0', value: '0' });

  modal({
    title: 'Agregar item a la cotización',
    body: h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', {}, 'Del catálogo de materiales'),
        matSelect,
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
          `Mostrando ${materialList.length} de ${Object.keys(materiales).length}`)
      ]),
      h('div', { style: { borderTop: '1px solid var(--border)', margin: '12px 0', textAlign: 'center' } },
        h('span', { class: 'muted', style: { fontSize: '11px', position: 'relative', top: '-9px', background: 'var(--bg-1)', padding: '0 8px' } }, 'O ad-hoc compras')),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'Clave'), adHocClave]),
        h('div', { class: 'field' }, [h('label', {}, 'Unidad'), adHocUnidad])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Descripción'), adHocDesc]),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'Cantidad'), cantidad]),
        h('div', { class: 'field' }, [h('label', {}, 'Costo unitario'), costo])
      ])
    ]),
    confirmLabel: 'Agregar',
    onConfirm: () => {
      const cant = Number(cantidad.value) || 0;
      const cost = Number(costo.value) || 0;
      if (cant <= 0) { toast('Cantidad inválida', 'danger'); return false; }
      const id = 'it_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

      if (matSelect.value) {
        const m = materiales[matSelect.value];
        cot.items[id] = {
          materialKey: matSelect.value,
          clave: m.clave, descripcion: m.descripcion, unidad: m.unidad,
          cantidad: cant, costoUnitario: cost,
          conceptoKey: null,
          origen: m.origen || 'opus',
          notas: ''
        };
      } else {
        const desc = adHocDesc.value.trim();
        if (!desc) { toast('Captura una descripción', 'danger'); return false; }
        cot.items[id] = {
          materialKey: 'adhoc_' + id,
          clave: adHocClave.value.trim(),
          descripcion: desc,
          unidad: adHocUnidad.value.trim() || 'PZA',
          cantidad: cant, costoUnitario: cost,
          conceptoKey: null,
          origen: 'ad_hoc_compras',
          notas: ''
        };
      }
      repaint();
      return true;
    }
  });
}

function dateForInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fromInputDateLocal(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function crumbsView(obraId, nombre, cotId) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Cotizaciones', to: `/obras/${obraId}/cotizaciones` },
    { label: cotId ? cotId.slice(0, 8) : 'Nueva' }
  ];
}
