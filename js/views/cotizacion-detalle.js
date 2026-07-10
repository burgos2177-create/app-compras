import { h, toast, modal } from '../util/dom.js?v=20260613';
import { renderShell } from './shell.js?v=20260613';
import { state, setState } from '../state/store.js?v=20260613';
import {
  getObraMetaLegacy,
  loadCatalogoConceptos, loadCatalogoMateriales,
  listProveedoresGlobal, listProveedoresObra,
  getBuzonItem, updateBuzonItem,
  getCotizacion, createCotizacion, updateCotizacion, listCotizaciones,
  createOC, updateOC, listOC,
  pushBuzonItem, setRequisicionOcRef,
  calcularCoberturaReq,
  buildPreciosPorProveedorObra
} from '../services/db.js?v=20260613';
import { navigate } from '../state/router.js?v=20260613';
import { dateMx, num, num0, money, reqFolio } from '../util/format.js?v=20260613';
import { deriveTotales } from '../services/totales.js?v=20260613';
import { estadoCotBadge } from './cotizaciones.js?v=20260613';

// Captura/edita una cotización contra una requisición aprobada y emite la OC.
//
// Importante (decisión 2026-05-06): una req se puede satisfacer parcialmente
// con varias cotizaciones/OC. Al sembrar items para una nueva cotización,
// usamos la cantidad RESTANTE (cantidad pedida menos lo ya cubierto en OCs
// emitidas anteriores). La req solo se marca como `cerrado` cuando la
// cobertura llega a 100%.
//
// Sobre el foco de inputs: NO hacemos `repaint()` completo en cada keystroke
// (eso destruye los inputs y pierde foco). Mutamos cot.items en memoria,
// y solo refrescamos los nodos calculados (celda Importe + card Totales)
// vía referencias guardadas en el cierre.

export async function renderCotizacionDetalle({ params, query }) {
  const obraId = params.id;
  const cotId = params.cotid || null;
  const reqBuzonId = query?.req || null;
  // Pre-selección de proveedor (desde la comparativa del inbox).
  const provIdHint = query?.proveedor || null;
  const provNombreHint = query?.proveedorNombre || null;
  setState({ obraActual: obraId });
  renderShell(crumbsView(obraId, '...', cotId), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, catCon, catMat, globales, provObra, existing, reqItem, ocs, preciosPorProv] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId),
    listProveedoresGlobal(),
    listProveedoresObra(obraId),
    cotId ? getCotizacion(obraId, cotId) : null,
    reqBuzonId ? getBuzonItem(reqBuzonId) : null,
    listOC(obraId),
    buildPreciosPorProveedorObra(obraId)
  ]);
  // Lista combinada: primero proveedores de obra, luego globales no asignados.
  // Identidad: usamos proveedor_global_id si está, si no el id local de obra.
  const obraProvs = (provObra?.items || []).map(p => ({
    id: p.proveedor_global_id || p.id,
    nombre: p.nombre, rfc: p.rfc, telefono: p.telefono, email: p.email,
    _scope: 'obra'
  }));
  const obraIds = new Set(obraProvs.map(p => p.id));
  const globalesNoEnObra = globales.filter(g => !obraIds.has(g.id))
    .map(g => ({ ...g, _scope: 'global' }));
  const proveedores = [...obraProvs, ...globalesNoEnObra];

  setState({ conceptos: catCon?.conceptos || null, materiales: catMat?.items || null });

  let cot = existing;
  let cobertura = null;

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

    cobertura = calcularCoberturaReq({ ...reqItem, id: reqBuzonId }, ocs);

    // Resolver proveedor sugerido (si llegó hint desde la comparativa del inbox).
    let provHint = null;
    if (provIdHint && preciosPorProv.has(provIdHint)) {
      provHint = preciosPorProv.get(provIdHint);
    } else if (provNombreHint) {
      const lower = provNombreHint.toLowerCase();
      for (const p of preciosPorProv.values()) {
        if ((p.nombre || '').toLowerCase() === lower) { provHint = p; break; }
      }
    }

    const seedItems = {};
    for (const [reqItemId, it] of Object.entries(reqItem.items || {})) {
      const cov = cobertura.byMaterial[it.materialKey];
      const restante = cov ? cov.restante : (Number(it.cantidad) || 0);
      if (restante <= 0) continue;
      const m = (catMat?.items || {})[it.materialKey];
      // Precio: si viene hint de proveedor y tiene precio para este material,
      // usar el último precio cotizado por él. Si no, fallback al catálogo OPUS.
      let costoUnitario = Number(m?.costoUnitario) || 0;
      if (provHint?.precios?.[it.materialKey]) {
        costoUnitario = Number(provHint.precios[it.materialKey].precio) || costoUnitario;
      }
      seedItems[reqItemId] = {
        materialKey: it.materialKey,
        clave: m?.clave || '',
        descripcion: m?.descripcion || '',
        unidad: m?.unidad || '',
        cantidad: restante,
        costoUnitario,
        conceptoKey: it.conceptoKey || null,
        origen: m?.origen || 'opus',
        notas: it.notas || ''
      };
    }

    // Pre-seleccionar proveedor si vino hint y existe en la lista
    let proveedorPrecargado = { id: null, nombre: '', rfc: '', telefono: '', email: '', contacto: '' };
    if (provHint) {
      // Buscamos los datos canónicos en la lista de obra o global
      const provInList = (provObra?.items || []).find(p =>
        (p.proveedor_global_id || p.id) === provHint.provId
        || (p.nombre || '').toLowerCase() === (provHint.nombre || '').toLowerCase()
      );
      const provInGlobal = globales.find(g => g.id === provHint.provId);
      const datos = provInGlobal || provInList || {};
      proveedorPrecargado = {
        id: provHint.provId || null,
        nombre: provHint.nombre || datos.nombre || '',
        rfc: datos.rfc || '',
        telefono: datos.telefono || '',
        email: datos.email || '',
        contacto: ''
      };
    }

    cot = {
      reqIds: [reqBuzonId],
      proveedor: proveedorPrecargado,
      fechaCotizacion: Date.now(),
      vigenciaDias: 15,
      items: seedItems,
      incluyeIva: true,
      ivaPct: 0.16,
      retenciones: [],
      condicionesPago: 'Crédito 30 días',
      comentarios: provHint
        ? `Pre-llenado con precios cotizados anteriormente por ${provHint.nombre}.`
        : '',
      estado: 'borrador'
    };
  } else {
    // Edición: cobertura informativa basada en la primera req vinculada.
    const firstReqId = (cot.reqIds || [])[0];
    if (firstReqId) {
      const reqIt = await getBuzonItem(firstReqId);
      if (reqIt) cobertura = calcularCoberturaReq({ ...reqIt, id: firstReqId }, ocs);
    }
  }

  renderEditor({
    obraId, cotId, cot, meta, cobertura,
    materiales: catMat?.items || {},
    conceptos: catCon?.conceptos || {},
    proveedores
  });
}

function renderEditor(ctx) {
  const { obraId, cotId, cot, meta, cobertura, materiales, conceptos, proveedores } = ctx;

  // === Refs DOM que se actualizan vía soft-recompute ===
  const importeCellRefs = {};   // itemId → <td> de la columna Importe
  const totalesCardRef = { node: null };  // se llena al renderizar

  // === Datos card ===
  // Dropdown con optgroups: "Proveedores de esta obra" y "Catálogo global".
  // Si la obra no tiene proveedores, solo aparece el grupo global.
  const sortByName = (a, b) => (a.nombre || '').localeCompare(b.nombre || '');
  const obraGroup = proveedores.filter(p => p._scope === 'obra').sort(sortByName);
  const globalGroup = proveedores.filter(p => p._scope === 'global').sort(sortByName);
  const provSelect = h('select', {}, [
    h('option', { value: '' }, '— elige proveedor —'),
    obraGroup.length > 0 && h('optgroup', { label: 'Proveedores de esta obra' },
      obraGroup.map(p => h('option', { value: p.id, selected: cot.proveedor?.id === p.id }, p.nombre))),
    globalGroup.length > 0 && h('optgroup', { label: 'Catálogo global (no asignados a esta obra)' },
      globalGroup.map(p => h('option', { value: p.id, selected: cot.proveedor?.id === p.id }, p.nombre)))
  ]);
  provSelect.addEventListener('change', () => {
    const p = proveedores.find(x => x.id === provSelect.value);
    if (p) {
      cot.proveedor = { id: p.id, nombre: p.nombre, rfc: p.rfc || '', telefono: p.telefono || '', email: p.email || '', contacto: '' };
      provNombre.value = p.nombre;
    } else {
      cot.proveedor = { id: null, nombre: provNombre.value || '', rfc: '', telefono: '', email: '', contacto: '' };
    }
  });
  const provNombre = h('input', { value: cot.proveedor?.nombre || '', placeholder: '(o escribe un nombre nuevo)' });
  provNombre.addEventListener('input', () => {
    cot.proveedor = { ...(cot.proveedor || {}), nombre: provNombre.value, id: null };
    provSelect.value = '';
  });

  const fechaInput = h('input', { type: 'date', value: dateForInput(cot.fechaCotizacion) });
  fechaInput.addEventListener('change', () => {
    cot.fechaCotizacion = fromInputDateLocal(fechaInput.value) || cot.fechaCotizacion;
  });
  const vigenciaInput = h('input', { type: 'number', min: '0', max: '365', value: String(cot.vigenciaDias || 0) });
  vigenciaInput.addEventListener('input', () => { cot.vigenciaDias = Number(vigenciaInput.value) || 0; });
  const condInput = h('input', { value: cot.condicionesPago || '' });
  condInput.addEventListener('input', () => { cot.condicionesPago = condInput.value; });

  const ivaToggle = h('input', { type: 'checkbox', checked: !!cot.incluyeIva });
  ivaToggle.addEventListener('change', () => {
    cot.incluyeIva = ivaToggle.checked;
    softRecomputeTotales();
  });
  const ivaPctInput = h('input', { type: 'number', step: '0.01', min: '0', max: '0.5', value: String(cot.ivaPct ?? 0.16) });
  ivaPctInput.addEventListener('input', () => {
    const v = Number(ivaPctInput.value);
    if (Number.isFinite(v)) { cot.ivaPct = v; softRecomputeTotales(); }
  });
  const comentariosArea = h('textarea', { rows: 2, placeholder: 'Comentarios internos / del proveedor' }, cot.comentarios || '');
  comentariosArea.addEventListener('input', () => { cot.comentarios = comentariosArea.value; });

  const editable = !cot.estado || ['borrador', 'recibida'].includes(cot.estado);
  const readonly = !editable;
  if (readonly) {
    [provSelect, provNombre, fechaInput, vigenciaInput, condInput, ivaToggle, ivaPctInput, comentariosArea].forEach(el => el.disabled = true);
  }

  // === Funciones de soft refresh ===
  function softRecomputeTotales() {
    // Actualiza la celda Importe de cada fila + recrea el contenido de totales
    for (const [itemId, it] of Object.entries(cot.items)) {
      const cell = importeCellRefs[itemId];
      if (cell) {
        const importe = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);
        cell.textContent = money(importe);
      }
    }
    if (totalesCardRef.node) {
      const fresh = renderTotalesCardContent(cot);
      totalesCardRef.node.replaceWith(fresh);
      totalesCardRef.node = fresh;
    }
  }

  function softRemoveItem(itemId, rowEl) {
    delete cot.items[itemId];
    delete importeCellRefs[itemId];
    if (rowEl && rowEl.parentNode) rowEl.parentNode.removeChild(rowEl);
    softRecomputeTotales();
  }

  function softAddItem(item) {
    const id = 'it_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    cot.items[id] = item;
    // Reemplazar tabla completa solo si no hay tabla previa, si no insertar fila al final
    if (itemsTbodyRef.node) {
      const tr = itemRow(itemsCtx, id, item, softRemoveItem, softRecomputeTotales, importeCellRefs);
      itemsTbodyRef.node.appendChild(tr);
    } else {
      // No había tabla (estaba vacío); repintar el card de items.
      const fresh = renderItemsCard(itemsCtx, softAddItem, softRemoveItem, softRecomputeTotales, importeCellRefs, itemsTbodyRef);
      itemsCardRef.node.replaceWith(fresh);
      itemsCardRef.node = fresh;
    }
    softRecomputeTotales();
  }

  // === Acciones cabecera ===
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

  // === Datos card ===
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
          h('label', { class: 'row', style: { gap: '6px' } }, [ivaToggle, h('span', {}, 'Costos incluyen IVA')]),
          h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Tasa:'),
          ivaPctInput
        ])
      ])
    ]),
    h('div', { class: 'field', style: { marginTop: '10px' } },
      [h('label', {}, 'Comentarios'), comentariosArea])
  ]);

  // === Cobertura informativa ===
  const coberturaCard = cobertura && cobertura.totalPedido > 0
    ? renderCoberturaCard(cobertura, materiales)
    : null;

  // === Items card ===
  const itemsTbodyRef = { node: null };
  const itemsCardRef = { node: null };
  const itemsCtx = { cot, materiales, conceptos, editable };

  itemsCardRef.node = renderItemsCard(itemsCtx, softAddItem, softRemoveItem, softRecomputeTotales, importeCellRefs, itemsTbodyRef);

  // === Totales card ===
  const totalesCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Totales')
  ]);
  totalesCardRef.node = renderTotalesCardContent(cot);
  totalesCard.appendChild(totalesCardRef.node);

  // === Origen ===
  const origenCard = h('div', { class: 'card' }, [
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

  renderShell(crumbsView(obraId, meta?.nombre, cotId),
    h('div', {}, [head, datosCard, coberturaCard, itemsCardRef.node, totalesCard, origenCard]));
}

// === Items table ===

function renderItemsCard(ctx, softAddItem, softRemoveItem, softRecomputeTotales, importeCellRefs, tbodyRef) {
  const { cot, materiales, editable } = ctx;
  const entries = Object.entries(cot.items || {});

  const head = h('div', { style: { padding: '14px 18px 0', display: 'flex', alignItems: 'center', gap: '8px' } }, [
    h('h3', {}, [
      'Items ', h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } }, `(${num0(entries.length)})`)
    ]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', { class: 'btn sm primary', onClick: () => addItemDialog(ctx, softAddItem) }, '+ Item ad-hoc')
  ]);

  if (entries.length === 0) {
    return h('div', { class: 'card' }, [head, h('div', { class: 'empty' }, 'Sin items.')]);
  }

  const tbody = h('tbody', {});
  for (const [id, it] of entries) {
    tbody.appendChild(itemRow(ctx, id, it, softRemoveItem, softRecomputeTotales, importeCellRefs));
  }
  tbodyRef.node = tbody;

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
      tbody
    ])
  ]);
}

function itemRow(ctx, itemId, it, softRemoveItem, softRecomputeTotales, importeCellRefs) {
  const { cot, conceptos, editable } = ctx;
  const importe = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);

  const matLabel = h('div', {}, [
    it.clave && h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, [
      it.clave,
      it.origen === 'ad_hoc_compras' && h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'AD-HOC compras'),
      (it.origen === 'ad_hoc' || it.origen === 'ad_hoc_materiales')
        ? h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'AD-HOC almacén') : null
    ]),
    h('div', {}, it.descripcion || '—'),
    it.notas && h('div', { class: 'muted', style: { fontSize: '11px' } }, it.notas)
  ]);

  const cantInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(it.cantidad || 0), style: { width: '90px' } });
  cantInput.addEventListener('input', () => {
    cot.items[itemId].cantidad = Number(cantInput.value) || 0;
    softRecomputeTotales();
  });

  const costoInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(it.costoUnitario || 0), style: { width: '110px' } });
  costoInput.addEventListener('input', () => {
    cot.items[itemId].costoUnitario = Number(costoInput.value) || 0;
    softRecomputeTotales();
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

  const importeCell = h('td', { class: 'num' }, money(importe));
  importeCellRefs[itemId] = importeCell;

  const tr = h('tr', {}, [
    h('td', { style: { maxWidth: '320px' } }, matLabel),
    h('td', {}, it.unidad || ''),
    h('td', { class: 'num' }, cantInput),
    h('td', { class: 'num' }, costoInput),
    importeCell,
    h('td', {}, conceptoLabel)
  ]);

  if (editable) {
    const delBtn = h('button', { class: 'btn sm danger' }, '🗑');
    delBtn.addEventListener('click', () => softRemoveItem(itemId, tr));
    tr.appendChild(h('td', {}, delBtn));
  }
  return tr;
}

// === Totales card content (replaceable) ===

function renderTotalesCardContent(cot) {
  const t = deriveTotales(cot);
  return h('div', {}, [
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

// === Cobertura card ===

function renderCoberturaCard(cobertura, materiales) {
  const pct = Math.round(cobertura.pct * 100);
  const color = pct >= 100 ? 'var(--ok)' : pct > 0 ? 'var(--warn)' : 'var(--text-2)';

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Cobertura de la requisición'),
    h('div', { class: 'row', style: { gap: '12px', alignItems: 'center', marginBottom: '10px' } }, [
      h('div', { style: { fontSize: '20px', fontWeight: '600', color, fontFamily: 'var(--mono)', minWidth: '60px' } }, `${pct}%`),
      h('div', { style: { flex: 1, height: '8px', background: 'var(--bg-3)', borderRadius: '4px', overflow: 'hidden' } },
        h('div', { style: { height: '100%', width: `${Math.min(pct, 100)}%`, background: color } })),
      h('div', { class: 'muted', style: { fontSize: '12px' } },
        `${num(cobertura.totalCubierto)} de ${num(cobertura.totalPedido)} unidades cubiertas en otras OC`)
    ]),
    h('div', { class: 'muted', style: { fontSize: '11px' } },
      pct >= 100
        ? '✓ Esta requisición ya está completamente cubierta. Esta cotización quedaría sobre lo ya pedido.'
        : 'Esta cotización cubre lo restante. Se pueden emitir varias OCs hasta llegar al 100%.')
  ]);
}

// === Acciones ===

async function onSave(ctx, marcarRecibida) {
  const { obraId, cotId, cot } = ctx;
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
        'La requisición se marca como cerrada solo cuando la cobertura llega al 100%; ',
        'si esta OC cubre solo parte, la req sigue abierta para más cotizaciones.'
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
        console.error('[emitirOC]', err);
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

  // 1. Crear OC
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

  // 2. Desglose por concepto OPUS para bitácora
  const desglose = Object.values(cot.items)
    .filter(it => it.conceptoKey)
    .map(it => ({
      conceptoKey: it.conceptoKey,
      conceptoClave: it.clave || '',
      conceptoDescripcion: it.descripcion || '',
      monto: ((Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0)) * (cot.incluyeIva
        ? 1 / (1 + (cot.ivaPct ?? 0.16))
        : 1)
    }));

  // 3. Push al buzón
  const buzonItem = {
    tipo: 'oc_materiales',
    origenApp: 'compras',
    obraId,
    ocId,
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

  // 4. Update OC con referencia al buzón
  await updateOC(obraId, ocId, { buzonId: buzonOcId, enviadaBuzonAt: Date.now() });

  // 5. Marcar la cotización como ganadora
  await updateCotizacion(obraId, cotId, {
    estado: 'ganadora',
    ocId,
    ocBuzonId: buzonOcId,
    ganadoraAt: Date.now()
  });

  // 6. Para cada req cubierta: agregar la OC a la lista, recalcular cobertura
  // y solo cerrar si llega a 100%. NO descartamos otras cotizaciones en
  // estado 'recibida' — pueden ser para los items aún no cubiertos.
  const ocsActualizadas = await listOC(obraId);
  for (const reqBuzonId of (cot.reqIds || [])) {
    const reqItem = await getBuzonItem(reqBuzonId);
    if (!reqItem) continue;

    const cobertura = calcularCoberturaReq({ ...reqItem, id: reqBuzonId }, ocsActualizadas);
    const ocBuzonIds = Array.from(new Set([...(reqItem.ocBuzonIds || []), buzonOcId]));
    const ocIds = Array.from(new Set([...(reqItem.ocIds || []), ocId]));

    const patch = {
      ocBuzonIds, ocIds,
      coberturaPct: cobertura.pct,
      // Compat: mantener ocBuzonId/ocId apuntando al primero (lectores viejos)
      ocBuzonId: reqItem.ocBuzonId || buzonOcId,
      ocId: reqItem.ocId || ocId
    };
    if (cobertura.completa) {
      patch.estado = 'cerrado';
      patch.cerradoAt = Date.now();
      patch.cerradoPor = autor;
    }
    await updateBuzonItem(reqBuzonId, patch);

    if (reqItem.reqId && reqItem.obraId) {
      await setRequisicionOcRef(reqItem.obraId, reqItem.reqId, {
        ocBuzonIds, ocIds, coberturaPct: cobertura.pct,
        ocBuzonId: reqItem.ocBuzonId || buzonOcId,
        ocId: reqItem.ocId || ocId
      });
    }
  }
}

// === Helpers ===

function addItemDialog(ctx, softAddItem) {
  const { materiales } = ctx;
  const materialList = Object.entries(materiales)
    .sort((a, b) => (a[1].descripcion || '').localeCompare(b[1].descripcion || ''))
    .slice(0, 500);

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
      let item;
      if (matSelect.value) {
        const m = materiales[matSelect.value];
        item = {
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
        item = {
          materialKey: 'adhoc_' + Date.now().toString(36),
          clave: adHocClave.value.trim(),
          descripcion: desc,
          unidad: adHocUnidad.value.trim() || 'PZA',
          cantidad: cant, costoUnitario: cost,
          conceptoKey: null,
          origen: 'ad_hoc_compras',
          notas: ''
        };
      }
      softAddItem(item);
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
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val || '—')]);
}
function crumbsView(obraId, nombre, cotId) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Cotizaciones', to: `/obras/${obraId}/cotizaciones` },
    { label: cotId ? cotId.slice(0, 8) : 'Nueva' }
  ];
}
