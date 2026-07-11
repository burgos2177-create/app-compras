import { h, toast, modal } from '../util/dom.js?v=20260711b';
import { renderShell } from './shell.js?v=20260711b';
import { state, setState } from '../state/store.js?v=20260711b';
import {
  getObraMetaLegacy,
  loadCatalogoConceptos, loadCatalogoMateriales,
  listProveedoresGlobal, listProveedoresObra,
  getBuzonItem, updateBuzonItem,
  getCotizacion, createCotizacion, updateCotizacion, listCotizaciones,
  createOC, getOC, updateOC, listOC,
  pushBuzonItem, setRequisicionOcRef,
  calcularCoberturaReq,
  buildPreciosPorProveedorObra
} from '../services/db.js?v=20260711b';
import { navigate } from '../state/router.js?v=20260711b';
import { dateMx, num, num0, money, reqFolio, ocFolio } from '../util/format.js?v=20260711b';
import { deriveTotales } from '../services/totales.js?v=20260711b';
import { emitirOC } from '../services/oc-emit.js?v=20260711b';
import { estadoCotBadge } from './cotizaciones.js?v=20260711b';

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

    // La cobertura es a nivel material, pero la requisición trae una línea por
    // (material × concepto). Prorrateamos el restante del material entre sus
    // líneas en proporción a lo pedido en cada concepto — así no se duplica la
    // cantidad cuando el mismo material aparece en varios conceptos, y la
    // trazabilidad por concepto se conserva intacta.
    const pedidoPorMat = {};
    for (const it of Object.values(reqItem.items || {})) {
      if (!it.materialKey) continue;
      pedidoPorMat[it.materialKey] = (pedidoPorMat[it.materialKey] || 0) + (Number(it.cantidad) || 0);
    }

    // Partir la requisición: si viene ?items=id1,id2 solo se siembran esos
    // items (para armar cotizaciones distintas con subconjuntos de la req).
    const itemsFilter = query?.items ? new Set(String(query.items).split(',').filter(Boolean)) : null;

    const seedItems = {};
    for (const [reqItemId, it] of Object.entries(reqItem.items || {})) {
      if (itemsFilter && !itemsFilter.has(reqItemId)) continue;
      const lineaPedida = Number(it.cantidad) || 0;
      const cov = cobertura.byMaterial[it.materialKey];
      let cantidad = lineaPedida;
      if (cov) {
        const totalMat = pedidoPorMat[it.materialKey] || lineaPedida;
        const factor = totalMat > 0 ? cov.restante / totalMat : 0;
        cantidad = Math.round(lineaPedida * factor * 1e6) / 1e6;
      }
      if (cantidad <= 0) continue;
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
        cantidad,
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
  // Agrupamos las líneas por material: el mismo material puede venir en varios
  // conceptos OPUS (una línea por concepto, para la trazabilidad a contabilidad).
  // Visualmente se colapsa en una sola fila con un único precio; por debajo cada
  // concepto sigue siendo su propio item de cot.items (nada se pierde).
  const refs = {
    itemImporte: {},   // itemId → <td> Importe (filas simples y sub-filas)
    groupImporte: {},  // groupKey → <td> Importe total del grupo
    groupCant: {},     // groupKey → <td> Cantidad total del grupo
    groupMembers: {}   // groupKey → [itemId, ...]
  };
  const totalesCardRef = { node: null };  // se llena al renderizar
  const itemsCardRef = { node: null };
  const expandedGroups = new Set();       // grupos abiertos (persiste entre repintados)

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
  const itemsCtx = { cot, materiales, conceptos, editable };

  function softRecomputeTotales() {
    // Celda Importe de cada línea (filas simples + sub-filas de grupos).
    for (const [itemId, it] of Object.entries(cot.items)) {
      const cell = refs.itemImporte[itemId];
      if (cell) cell.textContent = money((Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0));
    }
    // Totales agregados de cada grupo (suma de sus conceptos).
    for (const [gk, ids] of Object.entries(refs.groupMembers)) {
      let cant = 0, imp = 0;
      for (const id of ids) {
        const it = cot.items[id];
        if (!it) continue;
        const c = Number(it.cantidad) || 0, u = Number(it.costoUnitario) || 0;
        cant += c; imp += c * u;
      }
      if (refs.groupCant[gk]) refs.groupCant[gk].textContent = num(cant, 2);
      if (refs.groupImporte[gk]) refs.groupImporte[gk].textContent = money(imp);
    }
    if (totalesCardRef.node) {
      const fresh = renderTotalesCardContent(cot);
      totalesCardRef.node.replaceWith(fresh);
      totalesCardRef.node = fresh;
    }
  }

  // Alta/baja de items son operaciones poco frecuentes → repintamos el card
  // completo (más simple y robusto que insertar/quitar filas de un grupo).
  function rebuildItemsCard() {
    refs.itemImporte = {}; refs.groupImporte = {}; refs.groupCant = {}; refs.groupMembers = {};
    const fresh = renderItemsCard(itemsCtx, refs, handlers, expandedGroups);
    itemsCardRef.node.replaceWith(fresh);
    itemsCardRef.node = fresh;
    softRecomputeTotales();
  }

  function softRemoveItem(itemId) {
    delete cot.items[itemId];
    rebuildItemsCard();
  }

  function softAddItem(item) {
    const id = 'it_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    cot.items[id] = item;
    rebuildItemsCard();
  }

  // Handlers que las filas/grupos usan (precio único por material, etc.).
  const handlers = {
    recompute: softRecomputeTotales,
    remove: softRemoveItem,
    // Un solo precio para todo el material → se propaga a cada concepto.
    setGroupPrecio: (ids, val) => {
      for (const id of ids) if (cot.items[id]) cot.items[id].costoUnitario = val;
      softRecomputeTotales();
    },
    addDialog: () => addItemDialog(itemsCtx, softAddItem)
  };

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
  itemsCardRef.node = renderItemsCard(itemsCtx, refs, handlers, expandedGroups);

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
//
// Las líneas se agrupan por material. El mismo material puede llegar en varias
// líneas (una por concepto OPUS) — eso es correcto para la trazabilidad, pero
// hace ruido visual y obliga a capturar el precio repetido. Aquí colapsamos ese
// material en UNA fila con un único precio; al capturarlo se propaga a todos sus
// conceptos. Cada concepto sigue siendo su propio item en cot.items (la
// trazabilidad a contabilidad no se toca), y se puede desplegar para ver/ajustar
// la cantidad de cada uno.

function groupItems(entries) {
  // Clave de agrupación: materialKey del catálogo; para ad-hoc sin materialKey
  // usamos clave+descripción (los ad-hoc traen materialKey único, así que en la
  // práctica no se agrupan entre sí).
  const map = new Map();
  for (const [id, it] of entries) {
    const key = it.materialKey || ('adhoc:' + (it.clave || '') + ':' + (it.descripcion || ''));
    if (!map.has(key)) map.set(key, { key, items: [] });
    map.get(key).items.push([id, it]);
  }
  return [...map.values()];
}

function matCellContent(it) {
  return h('div', {}, [
    it.clave && h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, [
      it.clave,
      it.origen === 'ad_hoc_compras' && h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'AD-HOC compras'),
      (it.origen === 'ad_hoc' || it.origen === 'ad_hoc_materiales')
        ? h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'AD-HOC almacén') : null
    ]),
    h('div', {}, it.descripcion || '—'),
    it.notas && h('div', { class: 'muted', style: { fontSize: '11px' } }, it.notas)
  ]);
}

function conceptoLabelNode(conceptos, conceptoKey) {
  const concepto = conceptoKey ? conceptos[conceptoKey] : null;
  return concepto
    ? h('span', { title: concepto.descripcion }, [
      h('span', { class: 'mono', style: { fontSize: '11px' } }, concepto.clave),
      h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } },
        (concepto.descripcion || '').slice(0, 28))
    ])
    : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—');
}

function renderItemsCard(ctx, refs, handlers, expandedGroups) {
  const { cot, editable } = ctx;
  const entries = Object.entries(cot.items || {});

  const head = h('div', { style: { padding: '14px 18px 0', display: 'flex', alignItems: 'center', gap: '8px' } }, [
    h('h3', {}, [
      'Items ', h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } }, `(${num0(entries.length)})`)
    ]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', { class: 'btn sm primary', onClick: handlers.addDialog }, '+ Item ad-hoc')
  ]);

  if (entries.length === 0) {
    return h('div', { class: 'card' }, [head, h('div', { class: 'empty' }, 'Sin items.')]);
  }

  const groups = groupItems(entries);
  const tbody = h('tbody', {});
  for (const g of groups) {
    if (g.items.length === 1) {
      tbody.appendChild(singleItemRow(ctx, refs, handlers, g.items[0][0], g.items[0][1]));
    } else {
      appendGroupRows(tbody, ctx, refs, handlers, expandedGroups, g);
    }
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
      tbody
    ])
  ]);
}

// Fila simple: material que solo aparece en un concepto (o ad-hoc).
function singleItemRow(ctx, refs, handlers, itemId, it) {
  const { cot, conceptos, editable } = ctx;
  const importe = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);

  const cantInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(it.cantidad || 0), style: { width: '90px' } });
  cantInput.addEventListener('input', () => {
    cot.items[itemId].cantidad = Number(cantInput.value) || 0;
    handlers.recompute();
  });

  const costoInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(it.costoUnitario || 0), style: { width: '110px' } });
  costoInput.addEventListener('input', () => {
    cot.items[itemId].costoUnitario = Number(costoInput.value) || 0;
    handlers.recompute();
  });

  if (!editable) { cantInput.disabled = true; costoInput.disabled = true; }

  const importeCell = h('td', { class: 'num' }, money(importe));
  refs.itemImporte[itemId] = importeCell;

  const tr = h('tr', {}, [
    h('td', { style: { maxWidth: '320px' } }, matCellContent(it)),
    h('td', {}, it.unidad || ''),
    h('td', { class: 'num' }, cantInput),
    h('td', { class: 'num' }, costoInput),
    importeCell,
    h('td', {}, conceptoLabelNode(conceptos, it.conceptoKey))
  ]);

  if (editable) {
    const delBtn = h('button', { class: 'btn sm danger' }, '🗑');
    delBtn.addEventListener('click', () => handlers.remove(itemId));
    tr.appendChild(h('td', {}, delBtn));
  }
  return tr;
}

// Grupo: un material presente en varios conceptos. Fila cabecera colapsada
// (precio único) + sub-filas por concepto que se muestran/ocultan al desplegar.
function appendGroupRows(tbody, ctx, refs, handlers, expandedGroups, g) {
  const { editable } = ctx;
  const gk = g.key;
  const ids = g.items.map(([id]) => id);
  refs.groupMembers[gk] = ids;

  const first = g.items[0][1];
  let totalCant = 0, totalImp = 0;
  for (const [, it] of g.items) {
    const c = Number(it.cantidad) || 0, u = Number(it.costoUnitario) || 0;
    totalCant += c; totalImp += c * u;
  }
  // Precio del grupo = el del primer concepto (deben coincidir; al editarlo se
  // unifican todos, lo cual también corrige cualquier desfase heredado).
  const precioGrupo = Number(first.costoUnitario) || 0;
  const expanded = expandedGroups.has(gk);

  const cantCell = h('td', { class: 'num' }, num(totalCant, 2));
  const impCell = h('td', { class: 'num' }, money(totalImp));
  refs.groupCant[gk] = cantCell;
  refs.groupImporte[gk] = impCell;

  const costoInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(precioGrupo), style: { width: '110px' } });
  costoInput.addEventListener('input', () => handlers.setGroupPrecio(ids, Number(costoInput.value) || 0));
  if (!editable) costoInput.disabled = true;

  const subRows = g.items.map(([id, it]) => groupSubRow(ctx, refs, handlers, id, it));

  const arrow = h('span', { class: 'mono' }, expanded ? '▾' : '▸');
  const toggleBtn = h('button', { class: 'btn sm', style: { fontSize: '11px', padding: '2px 8px' } }, [
    arrow, h('span', { style: { marginLeft: '6px' } }, `${g.items.length} conceptos`)
  ]);
  toggleBtn.addEventListener('click', () => {
    const abrir = arrow.textContent === '▸';
    arrow.textContent = abrir ? '▾' : '▸';
    if (abrir) expandedGroups.add(gk); else expandedGroups.delete(gk);
    subRows.forEach(r => { r.style.display = abrir ? '' : 'none'; });
  });

  const headerRow = h('tr', { style: { background: 'var(--bg-2)' } }, [
    h('td', { style: { maxWidth: '320px' } }, matCellContent(first)),
    h('td', {}, first.unidad || ''),
    cantCell,
    editable ? h('td', { class: 'num' }, costoInput) : h('td', { class: 'num' }, money(precioGrupo)),
    impCell,
    h('td', {}, toggleBtn),
    editable && h('td', {}, '')
  ]);
  tbody.appendChild(headerRow);
  for (const r of subRows) {
    r.style.display = expanded ? '' : 'none';
    tbody.appendChild(r);
  }
}

// Sub-fila de un grupo: un concepto concreto. Solo su cantidad es editable;
// el precio lo gobierna la fila cabecera del material.
function groupSubRow(ctx, refs, handlers, itemId, it) {
  const { cot, conceptos, editable } = ctx;
  const importe = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);

  const cantInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(it.cantidad || 0), style: { width: '90px' } });
  cantInput.addEventListener('input', () => {
    cot.items[itemId].cantidad = Number(cantInput.value) || 0;
    handlers.recompute();
  });
  if (!editable) cantInput.disabled = true;

  const importeCell = h('td', { class: 'num' }, money(importe));
  refs.itemImporte[itemId] = importeCell;

  const conceptoCell = h('td', { style: { maxWidth: '320px', paddingLeft: '28px' } }, [
    h('div', {}, [
      h('span', { class: 'muted', style: { marginRight: '6px' } }, '↳'),
      conceptoLabelNode(conceptos, it.conceptoKey)
    ]),
    it.notas && h('div', { class: 'muted', style: { fontSize: '11px', paddingLeft: '18px' } }, it.notas)
  ]);

  const tr = h('tr', {}, [
    conceptoCell,
    h('td', {}, ''),
    h('td', { class: 'num' }, cantInput),
    h('td', { class: 'num muted', style: { fontSize: '11px' } }, '↑'),
    importeCell,
    h('td', {}, '')
  ]);

  if (editable) {
    const delBtn = h('button', { class: 'btn sm danger' }, '🗑');
    delBtn.addEventListener('click', () => handlers.remove(itemId));
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
        await emitirOCFromCotizacion(ctx);
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

// Emite la cotización completa como OC (delegando en el emisor compartido).
async function emitirOCFromCotizacion(ctx) {
  const { obraId, cotId, cot } = ctx;
  const u = state.user;
  const autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras' };
  return emitirOC(obraId, {
    reqIds: cot.reqIds || [],
    proveedor: cot.proveedor,
    items: cot.items,
    incluyeIva: !!cot.incluyeIva,
    ivaPct: cot.ivaPct ?? 0.16,
    retenciones: cot.retenciones || [],
    condicionesPago: cot.condicionesPago || '',
    comentarios: cot.comentarios || '',
    cotizacionGanadoraId: cotId,
    claseCompra: 'material',
    autor
  });
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
