import { h, toast, modal } from '../util/dom.js?v=20260606';
import { renderShell } from './shell.js?v=20260606';
import { state, setState } from '../state/store.js?v=20260606';
import {
  getObraMetaLegacy, getBuzonItem, updateBuzonItem,
  getRequisicionMateriales,
  loadCatalogoConceptos, loadCatalogoMateriales,
  listOC, calcularCoberturaReq,
  buildPreciosPorProveedorObra, analizarReqVsProveedores
} from '../services/db.js?v=20260606';
import { navigate } from '../state/router.js?v=20260606';
import { dateMx, num, num0, reqFolio } from '../util/format.js?v=20260606';
import { estadoBuzonBadge } from './inbox.js?v=20260606';

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

  const [meta, buzonItem, catCon, catMat, ocs, preciosPorProv] = await Promise.all([
    getObraMetaLegacy(obraId),
    getBuzonItem(buzonId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId),
    listOC(obraId),
    buildPreciosPorProveedorObra(obraId)
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

  renderShell(crumbsView(obraId, meta?.nombre, folio), h('div', {}, [
    head, metaCard, coberturaCard, comparativaCard, itemsCard
  ]));
}

// === Comparativa de proveedores ===

function renderComparativaCard(an, materiales, obraId, buzonId) {
  if (an.matKeys.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, '🔍 Comparativa de proveedores'),
      h('div', { class: 'muted', style: { fontSize: '12px' } },
        'No hay materiales pendientes por cubrir en esta requisición.')
    ]);
  }

  const sinOfertas = an.matKeys.every(mk => an.porMaterial[mk].ofertas.length === 0);

  return h('div', { class: 'card' }, [
    h('h3', {}, '🔍 Comparativa de proveedores'),
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
