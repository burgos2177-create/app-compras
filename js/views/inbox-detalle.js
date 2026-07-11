import { h, toast, modal } from '../util/dom.js?v=20260711j';
import { renderShell } from './shell.js?v=20260711j';
import { state, setState } from '../state/store.js?v=20260711j';
import {
  getObraMetaLegacy, getBuzonItem, updateBuzonItem,
  getRequisicionMateriales,
  loadCatalogoConceptos, loadCatalogoMateriales,
  listOC, listCotizaciones, calcularCoberturaReq,
  buildPreciosPorProveedorObra, analizarReqVsProveedores,
  aplicarReemplazosRequisicion
} from '../services/db.js?v=20260711j';
import { emitirOC } from '../services/oc-emit.js?v=20260711j';
import { navigate } from '../state/router.js?v=20260711j';
import { dateMx, num, num0, money, reqFolio } from '../util/format.js?v=20260711j';
import { estadoCotBadge } from './cotizaciones.js?v=20260711j';
import { estadoBuzonBadge } from './inbox.js?v=20260711j';

// Detalle de una requisición que llegó al inbox de compras (item del buzón
// con tipo='requisicion_materiales'). Acciones del comprador:
//   - Tomar (recibido → en_revision): marca que esta requisición ya está
//     siendo trabajada — útil si hay varios compradores.
//   - Aprobar (en_revision → aprobado): habilita capturar cotizaciones y
//     emitir OC contra esta requisición.
//   - Rechazar (cualquier → rechazado): con motivo. Notifica a materiales.
//   - Reabrir (rechazado/aprobado → en_revision): para corregir decisiones.
//
// "Cerrado" lo establece el flujo de OC al consolidar la requisición en una
// orden de compra emitida (no se cierra a mano desde aquí).

export async function renderInboxDetalle({ params }) {
  const obraId = params.id;
  const buzonId = params.buzonid;
  setState({ obraActual: obraId });
  renderShell(crumbsView(obraId, '...', '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, buzonItem, catCon, catMat, ocs, preciosPorProv, cotizaciones] = await Promise.all([
    getObraMetaLegacy(obraId),
    getBuzonItem(buzonId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId),
    listOC(obraId),
    buildPreciosPorProveedorObra(obraId),
    listCotizaciones(obraId)
  ]);
  setState({ conceptos: catCon?.conceptos || null, materiales: catMat?.items || null });

  if (!buzonItem) {
    renderShell(crumbsView(obraId, meta?.nombre, '...'),
      h('div', { class: 'empty' }, 'Item no encontrado en el buzón.'));
    return;
  }

  // Hidratar con la requisición viva si está disponible (por si hubo edición).
  const reqViva = buzonItem.reqId
    ? await getRequisicionMateriales(obraId, buzonItem.reqId)
    : null;

  const folio = reqFolio(buzonItem.numero);
  const conceptos = catCon?.conceptos || {};
  const materiales = catMat?.items || {};

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [folio, ' ', estadoBuzonBadge(buzonItem.estado)]),
    h('div', { style: { flex: 1 } }),
    ...renderActions(obraId, buzonId, buzonItem)
  ]);

  const metaCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos de la requisición'),
    h('div', { class: 'grid-3' }, [
      kv('Folio almacén', folio),
      kv('Estado en compras', buzonItem.estado),
      kv('Solicita', buzonItem.autor?.displayName || buzonItem.autor?.email || '—'),
      kv('Fecha', dateMx(buzonItem.fechaSolicitud || buzonItem.creadoAt)),
      kv('Recibido', dateMx(buzonItem.creadoAt)),
      kv('Última actualización', dateMx(buzonItem.actualizadoAt))
    ]),
    reqViva && reqViva.estado !== 'enviada' && h('div', {
      class: 'tag warn',
      style: { marginTop: '8px' }
    }, `⚠ La requisición original cambió de estado a "${reqViva.estado}" en materiales.`)
  ]);

  const items = buzonItem.items || {};
  const cobertura = calcularCoberturaReq({ ...buzonItem, id: buzonId }, ocs);
  const coberturaCard = cobertura.totalPedido > 0
    ? renderCoberturaCard(cobertura, materiales, ocs, buzonId, obraId)
    : null;
  const itemsCard = renderItemsCard(items, materiales, conceptos, cobertura);

  // Análisis vs proveedores: solo lo mostramos cuando la requisición está
  // 'aprobado' (ya pasó el filtro del comprador y se va a cotizar/comprar).
  const analisis = (buzonItem.estado === 'aprobado')
    ? analizarReqVsProveedores(buzonItem, preciosPorProv, materiales, cobertura)
    : null;
  const comparativaCard = analisis ? renderComparativaCard(analisis, materiales, obraId, buzonId) : null;

  // Tablero de cotizaciones REALES capturadas para esta requisición: lista,
  // comparativa material×proveedor con esas cotizaciones (sirve incluso con
  // materiales ad-hoc sin precio histórico) y emisión de OC (por reparto o
  // por cotización completa).
  const cotsDeReq = Object.entries(cotizaciones || {})
    .filter(([, c]) => (c.reqIds || []).includes(buzonId))
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  const tableroCard = (buzonItem.estado === 'aprobado')
    ? renderTableroCotizaciones(obraId, buzonId, buzonItem, cotsDeReq, materiales, conceptos, cobertura)
    : null;

  renderShell(crumbsView(obraId, meta?.nombre, folio), h('div', {}, [
    head, metaCard, coberturaCard, tableroCard, comparativaCard, itemsCard
  ]));
}

// === Tablero de cotizaciones de la requisición ===

function precioSinIvaCot(c, it) {
  const p = Number(it.costoUnitario) || 0;
  return c.incluyeIva ? p / (1 + (c.ivaPct ?? 0.16)) : p;
}

// Resumen por (cotización × material): precio unitario capturado y cantidad.
// Toma la primera línea de ese material (todas comparten precio; las líneas
// se separan solo por concepto para trazabilidad).
function resumenCotPorMaterial(c) {
  const byMat = {};
  for (const it of Object.values(c.items || {})) {
    if (!it.materialKey) continue;
    if (!byMat[it.materialKey]) {
      byMat[it.materialKey] = {
        precio: Number(it.costoUnitario) || 0,
        precioSinIva: precioSinIvaCot(c, it),
        cantidad: 0,
        clave: it.clave, descripcion: it.descripcion, unidad: it.unidad
      };
    }
    byMat[it.materialKey].cantidad += Number(it.cantidad) || 0;
  }
  return byMat;
}

function renderTableroCotizaciones(obraId, buzonId, buzonItem, cotsDeReq, materiales, conceptos, cobertura) {
  const nuevaBtn = h('button', {
    class: 'btn sm primary',
    onClick: () => nuevaCotizacionDialog(obraId, buzonId, buzonItem, materiales, cobertura)
  }, '➕ Nueva cotización (elegir items)');

  const head = h('div', { style: { padding: '14px 18px 0', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
    h('h3', {}, [
      '🧾 Cotizaciones de esta requisición ',
      h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } }, `(${num0(cotsDeReq.length)})`)
    ]),
    h('div', { style: { flex: 1 } }),
    nuevaBtn
  ]);

  if (cotsDeReq.length === 0) {
    return h('div', { class: 'card', style: { padding: 0 } }, [
      head,
      h('div', { class: 'empty', style: { padding: '18px' } }, [
        h('div', {}, 'Aún no capturas cotizaciones para esta requisición.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          'Puedes armar varias: una por proveedor, o partir los items entre distintas. Al juntar 2+ podrás compararlas y emitir la(s) OC desde aquí.')
      ])
    ]);
  }

  // Lista de cotizaciones
  const lista = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Proveedor'),
      h('th', {}, 'Estado'),
      h('th', { class: 'num' }, 'Items'),
      h('th', { class: 'num' }, 'Total'),
      h('th', {}, '')
    ])]),
    h('tbody', {}, cotsDeReq.map(([cotId, c]) => {
      const nItems = c.items ? Object.keys(c.items).length : 0;
      const yaGanadora = c.estado === 'ganadora';
      return h('tr', {}, [
        h('td', {}, h('b', {}, c.proveedor?.nombre || '—')),
        h('td', {}, estadoCotBadge(c.estado)),
        h('td', { class: 'num' }, num0(nItems)),
        h('td', { class: 'num' }, money(c.total || 0)),
        h('td', {}, h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } }, [
          h('button', { class: 'btn sm ghost', onClick: () => navigate(`/obras/${obraId}/cotizaciones/${cotId}`) }, 'Ver'),
          !yaGanadora && h('button', {
            class: 'btn sm primary',
            onClick: () => emitirCotizacionCompleta(obraId, buzonId, cotId, c)
          }, '↗ Emitir OC completa')
        ]))
      ]);
    }))
  ]);

  // Materiales ad-hoc que aparecen en las cotizaciones pero NO están en la
  // requisición (ej. la lámina de 4m que reemplazó a la de 5m). Ofrecemos
  // aplicar el cambio a la requisición para que todo cuadre.
  const adhocNuevos = adhocNoEnRequisicion(buzonItem, cotsDeReq);
  const ajusteBar = adhocNuevos.length > 0
    ? h('div', { style: { margin: '0 18px 8px', padding: '10px 14px', background: 'rgba(245, 196, 81, 0.08)', border: '1px solid rgba(245, 196, 81, 0.35)', borderRadius: '6px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
      h('div', { style: { flex: 1, fontSize: '12px', color: 'var(--text-1)' } }, [
        h('b', {}, `${adhocNuevos.length} material${adhocNuevos.length === 1 ? '' : 'es'} ad-hoc`),
        ' de las cotizaciones no está', adhocNuevos.length === 1 ? '' : 'n', ' en la requisición ',
        h('span', { class: 'muted' }, '(ej. una medida distinta que reemplazó a la pedida). Puedes aplicar el cambio a la requisición para que el reparto y la OC cuadren.')
      ]),
      h('button', {
        class: 'btn sm primary',
        onClick: () => ajustarRequisicionDialog(obraId, buzonId, buzonItem, cotsDeReq, adhocNuevos, materiales, conceptos)
      }, '🔧 Ajustar requisición')
    ])
    : null;

  // Comparativa material × proveedor con las cotizaciones capturadas
  const comparativa = renderComparativaCotizaciones(obraId, buzonId, cotsDeReq, materiales, cobertura);

  return h('div', { class: 'card', style: { padding: 0 } }, [
    head,
    h('div', { style: { padding: '10px 0' } }, lista),
    ajusteBar,
    comparativa
  ]);
}

// Materiales ad-hoc (creados en compras) presentes en las cotizaciones cuyo
// materialKey no está en la requisición → candidatos a "aplicar a la req".
function adhocNoEnRequisicion(buzonItem, cotsDeReq) {
  const reqKeys = new Set(Object.values(buzonItem.items || {}).map(it => it.materialKey).filter(Boolean));
  const found = new Map();
  for (const [, c] of cotsDeReq) {
    for (const it of Object.values(c.items || {})) {
      if (it.origen !== 'ad_hoc_compras') continue;
      if (!it.materialKey || reqKeys.has(it.materialKey)) continue;
      if (!found.has(it.materialKey)) {
        found.set(it.materialKey, {
          materialKey: it.materialKey,
          clave: it.clave || '',
          descripcion: it.descripcion || '',
          unidad: it.unidad || 'PZA',
          conceptoKey: it.conceptoKey || null
        });
      }
    }
  }
  return [...found.values()];
}

// Modal para mapear cada material ad-hoc nuevo a la línea de la requisición que
// reemplaza (misma cantidad y concepto). Aplica en la copia de compras y en el
// registro vivo de almacén, y registra el material en el catálogo.
function ajustarRequisicionDialog(obraId, buzonId, buzonItem, cotsDeReq, adhocNuevos, materiales, conceptos) {
  // Materiales de la req que NO tienen oferta en ninguna cotización (candidatos
  // naturales a haber sido reemplazados).
  const conOferta = new Set();
  for (const [, c] of cotsDeReq) {
    for (const it of Object.values(c.items || {})) {
      if ((Number(it.costoUnitario) || 0) > 0 && it.materialKey) conOferta.add(it.materialKey);
    }
  }
  const reqEntries = Object.entries(buzonItem.items || {});
  const reqLabel = (it) => {
    const m = materiales[it.materialKey] || {};
    const cn = it.conceptoKey ? conceptos[it.conceptoKey] : null;
    return `${m.descripcion || it.materialKey} · ${cn ? cn.clave : 's/concepto'} · ${num(it.cantidad, 2)} ${m.unidad || ''}`.trim();
  };

  const filas = adhocNuevos.map(a => {
    const sel = h('select', {}, [
      h('option', { value: '' }, '— no aplicar —'),
      ...reqEntries.map(([rid, it]) =>
        h('option', { value: rid }, `${reqEntries.length > 1 ? '' : ''}${reqLabel(it)}${conOferta.has(it.materialKey) ? '' : '  (sin ofertas)'}`))
    ]);
    // Sugerencia: única línea de req con el mismo concepto y sin ofertas.
    const candidatos = reqEntries.filter(([, it]) =>
      it.conceptoKey === a.conceptoKey && !conOferta.has(it.materialKey));
    if (candidatos.length === 1) sel.value = candidatos[0][0];
    return { a, sel };
  });

  modal({
    title: 'Ajustar requisición con los cambios de la cotización',
    size: 'lg',
    body: h('div', {}, [
      h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
        'Elige a qué línea de la requisición reemplaza cada material nuevo. La línea conserva su cantidad y concepto; solo cambia el material (ej. lámina 5m → 4m). Se aplica en compras y en el registro de almacén.'),
      ...filas.map(({ a, sel }) => h('div', { class: 'field', style: { borderTop: '1px solid var(--border)', paddingTop: '10px' } }, [
        h('label', {}, [
          h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, a.clave || a.materialKey.slice(0, 10)),
          ' ', h('b', {}, a.descripcion || '(sin descripción)')
        ]),
        h('div', { class: 'muted', style: { fontSize: '11px', margin: '2px 0 6px' } }, 'Reemplaza a la línea de la requisición:'),
        sel
      ]))
    ]),
    confirmLabel: 'Aplicar a la requisición',
    onConfirm: async () => {
      const replacements = filas
        .filter(({ sel }) => sel.value)
        .map(({ a, sel }) => ({
          reqItemId: sel.value,
          nuevoMaterialKey: a.materialKey,
          material: { clave: a.clave, descripcion: a.descripcion, unidad: a.unidad }
        }));
      if (replacements.length === 0) { toast('No asignaste ningún reemplazo', 'danger'); return false; }
      // No permitir dos ad-hoc apuntando a la misma línea.
      const dests = replacements.map(r => r.reqItemId);
      if (new Set(dests).size !== dests.length) { toast('Dos materiales apuntan a la misma línea de la requisición', 'danger'); return false; }
      try {
        await aplicarReemplazosRequisicion(obraId, buzonId, replacements, actorPayload());
        toast(`Requisición ajustada (${replacements.length} reemplazo${replacements.length === 1 ? '' : 's'})`, 'ok');
        renderInboxDetalle({ params: { id: obraId, buzonid: buzonId } });
        return true;
      } catch (err) {
        console.error('[ajustarRequisicion]', err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// Matriz: filas = materiales pendientes; columnas = cotizaciones; celda =
// precio unitario sin IVA capturado. Marca el mejor por material. Debajo, un
// selector por material (default el mejor) para emitir OC por reparto.
function renderComparativaCotizaciones(obraId, buzonId, cotsDeReq, materiales, cobertura) {
  // Cotizaciones candidatas para emitir (no descartadas ni ya ganadoras).
  const candidatas = cotsDeReq.filter(([, c]) => !['descartada', 'ganadora'].includes(c.estado));
  const resumen = new Map(); // cotId → { c, byMat }
  for (const [cotId, c] of cotsDeReq) resumen.set(cotId, { c, byMat: resumenCotPorMaterial(c) });

  // Materiales a comparar: los que aún tienen restante > 0 en la req.
  const matKeys = Object.keys(cobertura?.byMaterial || {})
    .filter(mk => (cobertura.byMaterial[mk].restante || 0) > 0);

  if (matKeys.length === 0) {
    return h('div', { style: { padding: '0 18px 18px' } },
      h('div', { class: 'muted', style: { fontSize: '12px' } },
        '✓ No quedan materiales pendientes por cubrir en esta requisición.'));
  }

  // Estado de selección por material (cotId elegido). Default: mejor precio.
  // Un costo en 0 significa "no manejan ese material" → NO cuenta como oferta
  // (no debe ganar como "el más barato").
  const seleccion = {};
  for (const mk of matKeys) {
    let best = null;
    for (const [cotId, { byMat, c }] of resumen) {
      if (['descartada', 'ganadora'].includes(c.estado)) continue;
      const q = byMat[mk];
      if (!q || q.precio <= 0) continue;
      if (!best || q.precioSinIva < best.precio) best = { cotId, precio: q.precioSinIva };
    }
    seleccion[mk] = best ? best.cotId : null;
  }

  const cols = cotsDeReq; // una columna por cotización (en orden)

  const table = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Material'),
      h('th', { class: 'num' }, 'Restante'),
      ...cols.map(([, c]) => h('th', { class: 'num', title: c.proveedor?.nombre || '' },
        (c.proveedor?.nombre || '—').slice(0, 16) + ((c.proveedor?.nombre || '').length > 16 ? '…' : ''))),
      h('th', {}, 'Asignar a')
    ])]),
    h('tbody', {}, matKeys.map(mk => {
      const m = materiales[mk] || {};
      const restante = cobertura.byMaterial[mk].restante || 0;
      // mejor precio sin IVA entre candidatas (ignorando 0 = no lo manejan)
      let mejor = Infinity;
      for (const [cotId, { byMat, c }] of resumen) {
        if (['descartada', 'ganadora'].includes(c.estado)) continue;
        const q = byMat[mk];
        if (q && q.precio > 0 && q.precioSinIva < mejor) mejor = q.precioSinIva;
      }
      const selectEl = h('select', { style: { maxWidth: '160px' } });
      let hayOferta = false;
      selectEl.appendChild(h('option', { value: '' }, '— ninguno —'));
      for (const [cotId, c] of candidatas) {
        const q = resumen.get(cotId).byMat[mk];
        if (!q || q.precio <= 0) continue;   // no manejan ese material
        hayOferta = true;
        const opt = h('option', { value: cotId, selected: seleccion[mk] === cotId },
          `${c.proveedor?.nombre || '—'} · ${money(q.precioSinIva)}`);
        selectEl.appendChild(opt);
      }
      selectEl.addEventListener('change', () => { seleccion[mk] = selectEl.value || null; });
      if (!hayOferta) { selectEl.disabled = true; }

      return h('tr', {}, [
        h('td', { style: { maxWidth: '260px' } }, [
          h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave || mk.slice(0, 10)),
          h('div', { style: { fontSize: '13px' } }, m.descripcion || '—')
        ]),
        h('td', { class: 'num' }, num(restante, 2)),
        ...cols.map(([cotId, c]) => {
          const q = resumen.get(cotId).byMat[mk];
          if (!q || q.precio <= 0) return h('td', { class: 'num muted', title: 'No lo manejan / sin precio' }, '—');
          const esMejor = mejor !== Infinity && Math.abs(q.precioSinIva - mejor) < 0.005 && !['descartada', 'ganadora'].includes(c.estado);
          return h('td', {
            class: 'num',
            style: {
              color: esMejor ? 'var(--ok)' : 'var(--text-0)',
              fontWeight: esMejor ? '600' : 'normal',
              background: esMejor ? 'rgba(93, 211, 158, 0.06)' : 'transparent'
            },
            title: `${c.incluyeIva ? 'capturado con IVA' : 'sin IVA'} · unit s/IVA ${money(q.precioSinIva)}`
          }, [money(q.precioSinIva), esMejor && h('span', { style: { fontSize: '10px', marginLeft: '4px' } }, '✓')]);
        }),
        h('td', {}, selectEl)
      ]);
    }))
  ]);

  const emitirBtn = h('button', {
    class: 'btn primary',
    onClick: () => emitirPorReparto(obraId, buzonId, resumen, seleccion, matKeys)
  }, '↗ Emitir OC(s) por reparto');

  return h('div', { style: { padding: '4px 0 0' } }, [
    h('div', { style: { padding: '10px 18px 4px' } },
      h('h3', { style: { fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-1)' } },
        'Comparativa y reparto')),
    h('div', { style: { overflow: 'auto' } }, table),
    candidatas.length > 0 && h('div', { style: { padding: '12px 18px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
      h('div', { class: 'muted', style: { fontSize: '12px', flex: 1 } },
        'Elige de qué proveedor comprar cada material (por defecto el más barato). Se emitirá una OC por cada proveedor con los materiales que le asignaste.'),
      emitirBtn
    ])
  ]);
}

// Emite una OC por cada proveedor según el reparto elegido por material.
async function emitirPorReparto(obraId, buzonId, resumen, seleccion, matKeys) {
  // Agrupar materiales por cotización elegida
  const porCot = {};   // cotId → [mk,...]
  for (const mk of matKeys) {
    const cotId = seleccion[mk];
    if (!cotId) continue;
    (porCot[cotId] = porCot[cotId] || []).push(mk);
  }
  const grupos = Object.entries(porCot);
  if (grupos.length === 0) {
    toast('No asignaste ningún material a un proveedor', 'danger');
    return;
  }

  // Preparar el resumen para el modal de confirmación
  const resumenGrupos = grupos.map(([cotId, mks]) => {
    const { c } = resumen.get(cotId);
    const items = {};
    let bruto = 0;
    for (const [itemId, it] of Object.entries(c.items || {})) {
      if (!it.materialKey || !mks.includes(it.materialKey)) continue;
      if ((Number(it.costoUnitario) || 0) <= 0) continue;   // 0 = no lo manejan, no se compra
      items[itemId] = it;
      bruto += (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);
    }
    return { cotId, c, mks, items, bruto };
  }).filter(g => Object.keys(g.items).length > 0);

  await modal({
    title: 'Emitir OC(s) por reparto',
    size: 'lg',
    body: h('div', {}, [
      h('p', {}, `Se emitirán ${resumenGrupos.length} orden${resumenGrupos.length === 1 ? '' : 'es'} de compra:`),
      h('ul', { style: { margin: '8px 0', paddingLeft: '20px' } },
        resumenGrupos.map(g => h('li', { style: { marginBottom: '4px' } }, [
          h('b', {}, g.c.proveedor?.nombre || '—'),
          h('span', { class: 'muted' }, ` · ${g.mks.length} material${g.mks.length === 1 ? '' : 'es'} · ${money(g.bruto)} (bruto)`)
        ]))),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Cada OC se publica al buzón de contabilidad con su desglose por concepto OPUS. La requisición se cierra sola al llegar al 100%.')
    ]),
    confirmLabel: 'Emitir',
    onConfirm: async () => {
      try {
        const u = state.user;
        const autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras' };
        for (const g of resumenGrupos) {
          await emitirOC(obraId, {
            reqIds: [buzonId],
            proveedor: g.c.proveedor,
            items: g.items,
            incluyeIva: !!g.c.incluyeIva,
            ivaPct: g.c.ivaPct ?? 0.16,
            retenciones: g.c.retenciones || [],
            condicionesPago: g.c.condicionesPago || '',
            comentarios: g.c.comentarios || '',
            cotizacionGanadoraId: g.cotId,
            claseCompra: 'material',
            autor
          });
        }
        toast(`${resumenGrupos.length} OC emitida(s) y enviada(s) a contabilidad`, 'ok');
        navigate(`/obras/${obraId}/oc`);
        return true;
      } catch (err) {
        console.error('[emitirPorReparto]', err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// Emite una cotización completa como OC (atajo desde el tablero).
async function emitirCotizacionCompleta(obraId, buzonId, cotId, c) {
  if (!c.proveedor?.nombre) { toast('La cotización no tiene proveedor', 'danger'); return; }
  if (!c.items || Object.keys(c.items).length === 0) { toast('La cotización no tiene items', 'danger'); return; }
  await modal({
    title: 'Emitir orden de compra',
    body: h('div', {}, [
      h('p', {}, [`Se emitirá una OC al proveedor `, h('b', {}, c.proveedor.nombre),
        ' por un total de ', h('b', { style: { color: 'var(--accent)' } }, money(c.total || 0)), '.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Se publica al buzón de contabilidad. La requisición se cierra sola al llegar al 100%.')
    ]),
    confirmLabel: 'Emitir', size: 'lg',
    onConfirm: async () => {
      try {
        const u = state.user;
        const autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras' };
        await emitirOC(obraId, {
          reqIds: c.reqIds && c.reqIds.length ? c.reqIds : [buzonId],
          proveedor: c.proveedor,
          items: c.items,
          incluyeIva: !!c.incluyeIva,
          ivaPct: c.ivaPct ?? 0.16,
          retenciones: c.retenciones || [],
          condicionesPago: c.condicionesPago || '',
          comentarios: c.comentarios || '',
          cotizacionGanadoraId: cotId,
          claseCompra: 'material',
          autor
        });
        toast('OC emitida y enviada a contabilidad', 'ok');
        navigate(`/obras/${obraId}/oc`);
        return true;
      } catch (err) {
        console.error('[emitirCotizacionCompleta]', err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// Modal para crear una cotización eligiendo un subconjunto de items de la req.
function nuevaCotizacionDialog(obraId, buzonId, buzonItem, materiales, cobertura) {
  const entries = Object.entries(buzonItem.items || {});
  // Solo items con restante > 0 (los ya cubiertos no necesitan más cotización).
  const disponibles = entries.filter(([, it]) => {
    const cov = cobertura?.byMaterial?.[it.materialKey];
    return !cov || (cov.restante || 0) > 0;
  });

  if (disponibles.length === 0) {
    toast('No quedan items pendientes por cotizar en esta requisición', 'danger');
    return;
  }

  const checks = {};
  const rows = disponibles.map(([itemId, it]) => {
    const m = materiales[it.materialKey] || {};
    const cb = h('input', { type: 'checkbox', checked: true });
    checks[itemId] = cb;
    return h('label', { class: 'row', style: { gap: '8px', padding: '6px 0', alignItems: 'flex-start', cursor: 'pointer' } }, [
      cb,
      h('div', { style: { flex: 1 } }, [
        h('div', { style: { fontSize: '13px' } }, m.descripcion || it.materialKey),
        h('div', { class: 'muted', style: { fontSize: '11px' } },
          `${m.clave || ''} · ${num(it.cantidad, 2)} ${m.unidad || ''}`)
      ])
    ]);
  });

  const selAll = h('button', { class: 'btn sm ghost', type: 'button' }, 'Todos');
  const selNone = h('button', { class: 'btn sm ghost', type: 'button' }, 'Ninguno');
  selAll.addEventListener('click', () => Object.values(checks).forEach(c => { c.checked = true; }));
  selNone.addEventListener('click', () => Object.values(checks).forEach(c => { c.checked = false; }));

  modal({
    title: 'Nueva cotización — elegir items',
    body: h('div', {}, [
      h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' } },
        'Marca los materiales que va a cotizar este proveedor. Puedes crear otra cotización con los demás.'),
      h('div', { class: 'row', style: { gap: '6px', marginBottom: '6px' } }, [selAll, selNone]),
      h('div', { style: { maxHeight: '320px', overflow: 'auto' } }, rows)
    ]),
    confirmLabel: 'Continuar',
    onConfirm: () => {
      const seleccionados = Object.entries(checks).filter(([, c]) => c.checked).map(([id]) => id);
      if (seleccionados.length === 0) { toast('Elige al menos un item', 'danger'); return false; }
      const todos = seleccionados.length === disponibles.length;
      const itemsParam = todos ? '' : `&items=${seleccionados.join(',')}`;
      navigate(`/obras/${obraId}/cotizaciones/nueva?req=${buzonId}${itemsParam}`);
      return true;
    }
  });
}

// === Comparativa de proveedores ===

function renderComparativaCard(an, materiales, obraId, buzonId) {
  if (an.matKeys.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, '🔮 Sugerencia por precios históricos'),
      h('div', { class: 'muted', style: { fontSize: '12px' } },
        'No hay materiales pendientes por cubrir en esta requisición.')
    ]);
  }

  const sinOfertas = an.matKeys.every(mk => an.porMaterial[mk].ofertas.length === 0);

  return h('div', { class: 'card' }, [
    h('h3', {}, '🔮 Sugerencia por precios históricos'),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '-4px', marginBottom: '8px' } },
      'A quién pedir cotización, según lo que cada proveedor ha cobrado antes (catálogo/cotizaciones/OC previas). Para decidir con las cotizaciones que ya juntaste, usa el tablero de arriba.'),
    sinOfertas
      ? h('div', { class: 'muted', style: { fontSize: '13px', padding: '14px 0' } }, [
        h('div', {}, 'Ningún proveedor de la obra ha cotizado todavía estos materiales.'),
        h('div', { style: { marginTop: '6px', fontSize: '12px' } },
          'Captura cotizaciones con tus proveedores para que aparezcan aquí las sugerencias.')
      ])
      : h('div', {}, [
        renderResumenAnalisis(an, obraId, buzonId),
        h('h3', { style: { marginTop: '20px', marginBottom: '8px' } }, 'Detalle por material'),
        renderTablaComparativa(an, materiales)
      ])
  ]);
}

function renderResumenAnalisis(an, obraId, buzonId) {
  const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const grid = h('div', { class: 'grid-2', style: { gap: '12px' } });

  // === Card 1: Todo a un proveedor ===
  const completos = an.todoAUno.filter(p => p.completo);
  const parciales = an.todoAUno.filter(p => !p.completo).slice(0, 3);

  const todoAUnoCard = h('div', {
    style: { padding: '12px 14px', background: 'var(--bg-2)', borderRadius: '8px', borderLeft: '3px solid var(--accent)' }
  }, [
    h('div', { style: { fontSize: '12px', color: 'var(--text-1)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' } },
      '📦 Todo a un solo proveedor'),
    completos.length > 0 ? h('div', {}, [
      h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '4px' } },
        `${completos.length} proveedor${completos.length === 1 ? '' : 'es'} cubre${completos.length === 1 ? '' : 'n'} todo:`),
      ...completos.slice(0, 5).map(p => h('div', { class: 'row', style: { padding: '4px 0' } }, [
        h('span', { style: { flex: 1 } }, h('b', {}, p.nombre)),
        h('span', { style: { fontFamily: 'var(--mono)', fontWeight: '600' } }, fmt(p.total)),
        h('button', {
          class: 'btn sm primary',
          style: { marginLeft: '8px' },
          onClick: () => onCotizarConProveedor(obraId, buzonId, p.provId, p.nombre)
        }, 'Cotizar →')
      ]))
    ]) : h('div', { class: 'muted', style: { fontSize: '12px' } },
      'Ningún proveedor cubre los ' + an.matKeys.length + ' materiales solo. Considera dividir entre varios.'),
    parciales.length > 0 && h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)' } }, [
      h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '4px' } },
        'Proveedores que cubren parcialmente:'),
      ...parciales.map(p => h('div', { class: 'row', style: { padding: '3px 0', fontSize: '12px' } }, [
        h('span', { style: { flex: 1 } }, p.nombre),
        h('span', { class: 'muted' }, `${p.cubre}/${p.totalMateriales} items`),
        h('span', { style: { fontFamily: 'var(--mono)', marginLeft: '8px' } }, fmt(p.total)),
        h('button', {
          class: 'btn sm ghost',
          style: { marginLeft: '6px', fontSize: '11px', padding: '2px 8px' },
          onClick: () => onCotizarConProveedor(obraId, buzonId, p.provId, p.nombre)
        }, 'Cotizar')
      ]))
    ])
  ]);

  // === Card 2: Combinación óptima (más barata) ===
  const numProvsOptimo = an.optimo.porProveedor.length;
  const optimoCard = h('div', {
    style: { padding: '12px 14px', background: 'var(--bg-2)', borderRadius: '8px', borderLeft: '3px solid var(--ok)' }
  }, [
    h('div', { style: { fontSize: '12px', color: 'var(--text-1)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' } },
      '💰 Combinación más económica'),
    an.optimo.combinacion.length === 0
      ? h('div', { class: 'muted', style: { fontSize: '12px' } },
        'No hay datos suficientes para calcular un óptimo.')
      : h('div', {}, [
        h('div', { class: 'row', style: { marginBottom: '8px' } }, [
          h('div', { style: { fontSize: '20px', fontWeight: '600', color: 'var(--ok)', fontFamily: 'var(--mono)' } },
            fmt(an.optimo.total)),
          h('span', { class: 'muted', style: { fontSize: '11px' } },
            `· ${numProvsOptimo} proveedor${numProvsOptimo === 1 ? '' : 'es'}`)
        ]),
        h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '4px' } }, 'Reparto:'),
        ...an.optimo.porProveedor.map(p => h('div', { class: 'row', style: { padding: '3px 0', fontSize: '12px' } }, [
          h('span', { style: { flex: 1 } }, [h('b', {}, p.nombre), h('span', { class: 'muted' }, ` (${p.items.length} item${p.items.length === 1 ? '' : 's'})`)]),
          h('span', { style: { fontFamily: 'var(--mono)' } }, fmt(p.total)),
          h('button', {
            class: 'btn sm ghost',
            style: { marginLeft: '6px', fontSize: '11px', padding: '2px 8px' },
            onClick: () => onCotizarConProveedor(obraId, buzonId, p.provId, p.nombre)
          }, 'Cotizar')
        ]))
      ])
  ]);

  grid.appendChild(todoAUnoCard);
  grid.appendChild(optimoCard);

  // Faltantes globales
  const ningunoTiene = an.matKeys.filter(mk => an.porMaterial[mk].ofertas.length === 0);
  const faltantesCard = ningunoTiene.length > 0
    ? h('div', { style: { marginTop: '12px', padding: '10px 14px', background: 'rgba(245, 196, 81, 0.07)', borderRadius: '6px', border: '1px solid rgba(245, 196, 81, 0.3)' } }, [
      h('div', { style: { fontSize: '12px', color: 'var(--warn)', marginBottom: '6px' } },
        `⚠ ${ningunoTiene.length} material${ningunoTiene.length === 1 ? '' : 'es'} sin cotización todavía:`),
      h('div', { style: { fontSize: '11px', color: 'var(--text-1)' } },
        ningunoTiene.slice(0, 5).map(mk => an.porMaterial[mk]).map((_, i) => {
          // formato simple — solo claves
          return null;
        }))
    ])
    : null;

  return h('div', {}, [grid, faltantesCard]);
}

function renderTablaComparativa(an, materiales) {
  // Encabezados: cada proveedor que tenga al menos una oferta para esta req
  const provsSet = new Map();
  for (const mk of an.matKeys) {
    for (const o of an.porMaterial[mk].ofertas) {
      const k = o.provId || (o.nombre || '').toLowerCase();
      if (!provsSet.has(k)) provsSet.set(k, { provId: o.provId, nombre: o.nombre });
    }
  }
  const provsCols = Array.from(provsSet.values());

  if (provsCols.length === 0) {
    return h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Sin ofertas registradas.');
  }

  const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return h('div', { style: { overflow: 'auto' } }, [
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'Catálogo OPUS'),
        ...provsCols.map(p => h('th', { class: 'num', title: p.nombre },
          (p.nombre || '').slice(0, 18) + ((p.nombre || '').length > 18 ? '…' : '')))
      ])]),
      h('tbody', {}, an.matKeys.map(mk => {
        const r = an.porMaterial[mk];
        const m = materiales[mk] || {};
        const mejorPrecio = r.mejor?.precio;
        return h('tr', {}, [
          h('td', { style: { maxWidth: '280px' } }, [
            h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave || mk.slice(0, 10)),
            h('div', { style: { fontSize: '13px' } }, m.descripcion || '—')
          ]),
          h('td', { class: 'num' }, num(r.cantidad)),
          h('td', { class: 'num muted' }, r.precioCatalogo > 0 ? fmt(r.precioCatalogo) : '—'),
          ...provsCols.map(p => {
            const k = p.provId || (p.nombre || '').toLowerCase();
            const oferta = r.ofertas.find(o => (o.provId || (o.nombre || '').toLowerCase()) === k);
            if (!oferta) return h('td', { class: 'num muted' }, '—');
            const esMejor = oferta.precio === mejorPrecio;
            const fuenteIcon = oferta.fuente === 'cotizacion' ? '💬'
              : oferta.fuente === 'oc' ? '📄'
              : '📋';   // catálogo pre-cotización
            const fuenteLabel = oferta.fuente === 'cotizacion' ? 'cotización'
              : oferta.fuente === 'oc' ? 'OC anterior'
              : 'catálogo de precios';
            return h('td', {
              class: 'num',
              style: {
                color: esMejor ? 'var(--ok)' : 'var(--text-0)',
                fontWeight: esMejor ? '600' : 'normal',
                background: esMejor ? 'rgba(93, 211, 158, 0.06)' : 'transparent'
              },
              title: `Importe: ${fmt(oferta.importe)} · fuente: ${fuenteLabel}${oferta.fecha ? ' · ' + dateMx(oferta.fecha) : ''}`
            }, [
              h('span', { style: { fontSize: '9px', marginRight: '4px', opacity: '0.5' } }, fuenteIcon),
              fmt(oferta.precio),
              esMejor && h('span', { style: { fontSize: '10px', marginLeft: '4px' } }, '✓')
            ]);
          })
        ]);
      }))
    ])
  ]);
}

function onCotizarConProveedor(obraId, buzonId, provId, nombre) {
  // Si tiene id pasamos el id; si no, pasamos el nombre como fallback.
  const param = provId
    ? `proveedor=${encodeURIComponent(provId)}`
    : `proveedorNombre=${encodeURIComponent(nombre || '')}`;
  navigate(`/obras/${obraId}/cotizaciones/nueva?req=${buzonId}&${param}`);
}

function renderCoberturaCard(cobertura, materiales, ocs, buzonId, obraId) {
  const pct = Math.round(cobertura.pct * 100);
  const color = pct >= 100 ? 'var(--ok)' : pct > 0 ? 'var(--warn)' : 'var(--text-2)';
  const label = pct >= 100 ? '✓ Completamente cubierta' : pct > 0 ? '⚠ Parcialmente cubierta' : 'Sin cubrir';

  // OCs vinculadas a esta req
  const ocsLink = Object.entries(ocs)
    .filter(([, oc]) => (oc.reqIds || []).includes(buzonId))
    .sort((a, b) => (a[1].numero || 0) - (b[1].numero || 0));

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Cobertura por OC'),
    h('div', { class: 'row', style: { gap: '12px', alignItems: 'center', marginBottom: '10px' } }, [
      h('div', { style: { fontSize: '22px', fontWeight: '600', color, fontFamily: 'var(--mono)', minWidth: '70px' } }, `${pct}%`),
      h('div', { style: { flex: 1, height: '10px', background: 'var(--bg-3)', borderRadius: '5px', overflow: 'hidden' } },
        h('div', { style: { height: '100%', width: `${Math.min(pct, 100)}%`, background: color, transition: 'width .3s' } })),
      h('div', { class: 'muted', style: { fontSize: '12px' } }, label)
    ]),
    h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' } },
      `${num(cobertura.totalCubierto)} de ${num(cobertura.totalPedido)} unidades comprometidas en OC.`),
    ocsLink.length > 0 && h('div', {}, [
      h('div', { style: { fontSize: '12px', marginBottom: '6px', color: 'var(--text-1)' } },
        `${ocsLink.length} OC vinculada${ocsLink.length === 1 ? '' : 's'}:`),
      h('ul', { style: { margin: '0', paddingLeft: '20px', fontSize: '13px' } },
        ocsLink.map(([id, oc]) => h('li', {}, [
          h('a', { href: `#/obras/${obraId}/oc/${id}` },
            `OC-${String(oc.numero || 0).padStart(4, '0')}`),
          h('span', { class: 'muted' }, ` · ${oc.proveedor?.nombre || '—'} · ${num(Object.keys(oc.items || {}).length)} item(s) · `),
          h('span', { class: 'tag muted', style: { fontSize: '10px' } }, oc.estado || '—')
        ])))
    ])
  ]);
}

function renderActions(obraId, buzonId, item) {
  const estado = item.estado;
  const acts = [];

  if (estado === 'recibido') {
    acts.push(h('button', {
      class: 'btn',
      onClick: () => onTomar(obraId, buzonId)
    }, '👁 Tomar (en revisión)'));
  }

  if (estado === 'recibido' || estado === 'en_revision') {
    acts.push(h('button', {
      class: 'btn primary',
      onClick: () => onAprobar(obraId, buzonId)
    }, '✓ Aprobar y cotizar'));
    acts.push(h('button', {
      class: 'btn ghost',
      onClick: () => onRechazar(obraId, buzonId)
    }, '✕ Rechazar'));
  }

  if (estado === 'aprobado') {
    acts.push(h('button', {
      class: 'btn primary',
      onClick: () => navigate(`/obras/${obraId}/cotizaciones?req=${buzonId}`)
    }, '+ Capturar cotización'));
    acts.push(h('button', {
      class: 'btn',
      onClick: () => navigate(`/obras/${obraId}/oc/nueva?req=${buzonId}`)
    }, '↗ Emitir OC'));
    acts.push(h('button', {
      class: 'btn ghost',
      onClick: () => onReabrir(obraId, buzonId)
    }, '↺ Reabrir'));
  }

  if (estado === 'rechazado') {
    acts.push(h('button', {
      class: 'btn',
      onClick: () => onReabrir(obraId, buzonId)
    }, '↺ Reabrir'));
  }

  return acts;
}

function renderItemsCard(items, materiales, conceptos, cobertura) {
  const entries = Object.entries(items);
  if (entries.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, 'Items'),
      h('div', { class: 'empty' }, 'Sin items.')
    ]);
  }
  const totalCant = entries.reduce((s, [, it]) => s + (Number(it.cantidad) || 0), 0);
  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 0' } }, h('h3', {}, [
      'Items ', h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } },
        `(${num0(entries.length)} · ${num(totalCant)} unidades)`)
    ])),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Pedido'),
        h('th', { class: 'num' }, 'Cubierto'),
        h('th', { class: 'num' }, 'Restante'),
        h('th', {}, 'Concepto destino'),
        h('th', {}, 'Notas')
      ])]),
      h('tbody', {}, entries.map(([itemId, it]) => itemRow(it, materiales, conceptos, cobertura)))
    ])
  ]);
}

function itemRow(it, materiales, conceptos, cobertura) {
  const m = materiales[it.materialKey];
  const matLabel = m
    ? h('div', {}, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave),
      h('div', {}, m.descripcion),
      m.marca && h('div', { class: 'muted', style: { fontSize: '11px' } }, m.marca)
    ])
    : h('div', { class: 'tag warn' }, [
      h('div', { class: 'mono' }, it.materialKey || '—'),
      h('div', {}, '⚠ Material no encontrado en el catálogo')
    ]);

  const conceptoLabel = it.conceptoKey
    ? (conceptos[it.conceptoKey]
      ? h('span', { title: conceptos[it.conceptoKey].descripcion }, [
        h('span', { class: 'mono', style: { fontSize: '11px' } }, conceptos[it.conceptoKey].clave),
        h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } },
          (conceptos[it.conceptoKey].descripcion || '').slice(0, 30))
      ])
      : h('span', { class: 'tag warn' }, '⚠ Concepto eliminado'))
    : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—');

  const cov = cobertura?.byMaterial?.[it.materialKey];
  const pedido = Number(it.cantidad) || 0;
  const cubierto = cov ? Math.min(cov.cubierto, cov.pedido) : 0;
  // El cubierto está agregado por materialKey (la req puede tener varios items
  // del mismo material); para el reporte por fila prorrateamos por share.
  const share = cov && cov.pedido > 0 ? pedido / cov.pedido : 1;
  const cubiertoFila = Math.min(pedido, cubierto * share);
  const restanteFila = Math.max(0, pedido - cubiertoFila);
  const cubiertoColor = restanteFila === 0 ? 'var(--ok)' : (cubiertoFila > 0 ? 'var(--warn)' : 'var(--text-2)');

  return h('tr', {}, [
    h('td', { style: { maxWidth: '380px' } }, matLabel),
    h('td', {}, m?.unidad || ''),
    h('td', { class: 'num' }, num(pedido, 2)),
    h('td', { class: 'num', style: { color: cubiertoColor } }, num(cubiertoFila, 2)),
    h('td', { class: 'num', style: { color: restanteFila === 0 ? 'var(--ok)' : 'var(--text-0)' } },
      restanteFila === 0 ? '✓' : num(restanteFila, 2)),
    h('td', {}, conceptoLabel),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, it.notas || '')
  ]);
}

// === Acciones del comprador ===

async function onTomar(obraId, buzonId) {
  await updateBuzonItem(buzonId, {
    estado: 'en_revision',
    enRevisionAt: Date.now(),
    enRevisionPor: actorPayload()
  });
  toast('Requisición tomada para revisión', 'ok');
  navigate(`/obras/${obraId}/inbox/${buzonId}`);
}

async function onAprobar(obraId, buzonId) {
  await modal({
    title: 'Aprobar requisición',
    body: h('div', {}, [
      h('p', {}, 'Aprobarla habilita capturar cotizaciones y emitir órdenes de compra.'),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'El almacenista verá que ya está siendo procesada en compras. La requisición original queda bloqueada para edición.')
    ]),
    confirmLabel: 'Aprobar',
    onConfirm: async () => {
      await updateBuzonItem(buzonId, {
        estado: 'aprobado',
        aprobadoAt: Date.now(),
        aprobadoPor: actorPayload()
      });
      toast('Requisición aprobada', 'ok');
      navigate(`/obras/${obraId}/inbox/${buzonId}`);
      return true;
    }
  });
}

async function onRechazar(obraId, buzonId) {
  const motivo = h('textarea', { rows: 3, placeholder: 'Razón del rechazo (visible para el almacenista)' });
  await modal({
    title: 'Rechazar requisición',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Motivo'), motivo])
    ]),
    confirmLabel: 'Rechazar', danger: true,
    onConfirm: async () => {
      const m = motivo.value.trim();
      if (!m) { toast('Captura un motivo', 'danger'); return false; }
      await updateBuzonItem(buzonId, {
        estado: 'rechazado',
        motivoRechazo: m,
        rechazadoAt: Date.now(),
        rechazadoPor: actorPayload()
      });
      toast('Requisición rechazada', 'ok');
      navigate(`/obras/${obraId}/inbox/${buzonId}`);
      return true;
    }
  });
}

async function onReabrir(obraId, buzonId) {
  await modal({
    title: 'Reabrir requisición',
    body: h('div', {}, 'Vuelve al estado "en revisión" para volver a tomar decisión.'),
    confirmLabel: 'Reabrir',
    onConfirm: async () => {
      await updateBuzonItem(buzonId, {
        estado: 'en_revision',
        reabiertaAt: Date.now(),
        reabiertaPor: actorPayload()
      });
      toast('Requisición reabierta', 'ok');
      navigate(`/obras/${obraId}/inbox/${buzonId}`);
      return true;
    }
  });
}

function actorPayload() {
  const u = state.user;
  return { uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras' };
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function crumbsView(obraId, nombre, folio) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Inbox', to: `/obras/${obraId}/inbox` },
    { label: folio || '...' }
  ];
}
