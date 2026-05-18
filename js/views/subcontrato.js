import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, getSubcontrato, updateSubcontratoMeta,
  addSubcontratoConcepto, removeSubcontratoConcepto, updateSubcontratoConcepto,
  addSubcontratoLicitante, updateSubcontratoLicitante, removeSubcontratoLicitante,
  setSubcontratoLicitantePrecio,
  adjudicarSubcontrato, desadjudicarSubcontrato,
  loadCatalogoConceptos,
  listProveedoresObra, listProveedoresGlobal, mergeProveedorObraConGlobal
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx, num, num0, money } from '../util/format.js';
import { estadoSCBadge } from './subcontratos.js';

// Detalle de subcontrato con 3 tabs:
//   - Alcance: conceptos OPUS + cantidades
//   - Licitantes: tabla comparativa de precios por concepto, con ahorro % vs
//     catálogo y CTA "Cotizar con un proveedor existente"
//   - Adjudicación: ranking de licitantes por total, botón "Adjudicar"

export async function renderSubcontratoDetalle({ params, query }) {
  const obraId = params.id;
  const scId = params.scid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, sc, catCon, { items: provObra }, globales] = await Promise.all([
    getObraMetaLegacy(obraId),
    getSubcontrato(obraId, scId),
    loadCatalogoConceptos(obraId),
    listProveedoresObra(obraId),
    listProveedoresGlobal()
  ]);

  if (!sc) {
    renderShell(crumbs(obraId, meta?.nombre, '...'),
      h('div', { class: 'empty' }, 'Subcontrato no encontrado.'));
    return;
  }

  const conceptos = catCon?.conceptos || {};   // catálogo OPUS de la obra
  const scMeta = sc.meta || {};
  const scConceptos = sc.conceptos || {};
  const scLicitantes = sc.licitantes || {};
  const proveedoresObra = provObra.map(p => mergeProveedorObraConGlobal(p, globales));
  const tab = query?.tab || 'alcance';

  const editable = scMeta.estado !== 'cerrado';
  const adjudicado = scMeta.estado === 'adjudicado';

  // === Header ===
  const head = h('div', { class: 'row' }, [
    h('h1', {}, [scMeta.nombre || 'Subcontrato', ' ', estadoSCBadge(scMeta.estado)]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', {
      class: 'btn ghost',
      onClick: () => onEditarMeta(obraId, scId, scMeta)
    }, '✎ Editar datos'),
    adjudicado && h('button', {
      class: 'btn danger ghost',
      onClick: () => onDesadjudicar(obraId, scId)
    }, '↺ Desadjudicar')
  ]);

  const datosCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos del subcontrato'),
    h('div', { class: 'grid-3' }, [
      kv('Nombre', scMeta.nombre),
      kv('Estado', scMeta.estado),
      kv('Creado', dateMx(scMeta.createdAt)),
      adjudicado && kv('Adjudicado', dateMx(scMeta.adjudicadoAt)),
      adjudicado && scMeta.licitanteAdjudicadoId && kv(
        'Ganador',
        h('b', { style: { color: 'var(--ok)' } },
          scLicitantes[scMeta.licitanteAdjudicadoId]?.nombre || '—')),
      adjudicado && kv('Importe total', money(totalLicitante(scLicitantes[scMeta.licitanteAdjudicadoId], scConceptos)))
    ]),
    scMeta.descripcion && h('div', { style: { marginTop: '8px' } }, [
      h('label', { class: 'muted', style: { fontSize: '12px' } }, 'Descripción'),
      h('div', {}, scMeta.descripcion)
    ])
  ]);

  // === Tab bar ===
  const tabBar = h('div', { class: 'row', style: { marginBottom: '14px', gap: '4px' } }, [
    tabBtn('alcance',      '📋 Alcance',                Object.keys(scConceptos).length),
    tabBtn('licitantes',   '💬 Licitantes',             Object.keys(scLicitantes).length),
    tabBtn('adjudicacion', '🏆 Adjudicación',           adjudicado ? '✓' : '—')
  ]);

  function tabBtn(id, label, badge) {
    return h('button', {
      class: 'btn sm ' + (tab === id ? 'primary' : 'ghost'),
      onClick: () => navigate(`/obras/${obraId}/subcontratos/${scId}?tab=${id}`)
    }, [label, ' ', h('span', { class: 'tag muted' }, String(badge))]);
  }

  let tabBody;
  if (tab === 'alcance') {
    tabBody = renderAlcance(obraId, scId, scConceptos, conceptos, editable);
  } else if (tab === 'licitantes') {
    tabBody = renderLicitantes(obraId, scId, scConceptos, scLicitantes, conceptos, proveedoresObra, editable, scMeta);
  } else {
    tabBody = renderAdjudicacion(obraId, scId, scConceptos, scLicitantes, conceptos, scMeta, editable);
  }

  renderShell(crumbs(obraId, meta?.nombre, scMeta.nombre),
    h('div', {}, [head, datosCard, tabBar, tabBody]));
}

// ====================== TAB: ALCANCE ======================

function renderAlcance(obraId, scId, scConceptos, conceptos, editable) {
  const entries = Object.entries(scConceptos);
  let totalCatalogo = 0;
  for (const [, c] of entries) {
    const con = conceptos[c.conceptoId];
    if (con) totalCatalogo += (Number(c.cantidad) || 0) * (Number(con.precioUnitario) || 0);
  }

  const head = h('div', { class: 'row' }, [
    h('h3', { style: { margin: 0, flex: 1 } },
      `Alcance (${num0(entries.length)} concepto${entries.length === 1 ? '' : 's'})`),
    entries.length > 0 && h('span', { class: 'muted', style: { fontSize: '12px' } },
      `Importe a precios catálogo: ${money(totalCatalogo)}`),
    editable && h('button', {
      class: 'btn sm primary',
      onClick: () => onAgregarConcepto(obraId, scId, scConceptos, conceptos)
    }, '+ Agregar concepto')
  ]);

  if (entries.length === 0) {
    return h('div', { class: 'card' }, [
      head,
      h('div', { class: 'empty', style: { marginTop: '10px' } }, [
        h('div', { class: 'ico' }, '📋'),
        h('div', {}, 'Sin conceptos en el alcance.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Agrega los conceptos OPUS que cubre este subcontrato con su cantidad.')
      ])
    ]);
  }

  // Ordenar por clave OPUS
  const sorted = entries.sort(([, a], [, b]) => {
    const ca = conceptos[a.conceptoId]?.clave || '';
    const cb = conceptos[b.conceptoId]?.clave || '';
    return ca.localeCompare(cb);
  });

  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 4px' } }, head),
    h('table', { class: 'tbl' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, 'Clave'),
        h('th', {}, 'Descripción'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'P.U. catálogo'),
        h('th', { class: 'num' }, 'Importe ref.'),
        h('th', {}, 'Notas'),
        editable && h('th', {}, '')
      ])),
      h('tbody', {}, sorted.map(([cid, c]) => conceptoAlcanceRow(obraId, scId, cid, c, conceptos, editable)))
    ])
  ]);
}

function conceptoAlcanceRow(obraId, scId, cid, c, conceptos, editable) {
  const con = conceptos[c.conceptoId];
  const precioCat = Number(con?.precioUnitario) || 0;
  const cantidad = Number(c.cantidad) || 0;
  const importe = cantidad * precioCat;

  const conLabel = con
    ? h('div', {}, [
      h('span', {}, (con.descripcion || '').slice(0, 80)),
      (con.descripcion || '').length > 80 && '…'
    ])
    : h('div', { class: 'tag warn' }, '⚠ Concepto no existe en catálogo');

  return h('tr', {}, [
    h('td', { class: 'mono', style: { fontSize: '11px' } }, con?.clave || c.conceptoId.slice(0, 10)),
    h('td', { style: { maxWidth: '380px' } }, conLabel),
    h('td', {}, con?.unidad || '—'),
    h('td', { class: 'num' }, num(cantidad)),
    h('td', { class: 'num muted' }, precioCat > 0 ? money(precioCat) : '—'),
    h('td', { class: 'num' }, importe > 0 ? money(importe) : '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, c.notas || ''),
    editable && h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', { class: 'btn sm ghost', onClick: () => onEditarConcepto(obraId, scId, cid, c, conceptos) }, '✎'),
      h('button', { class: 'btn sm danger', onClick: () => onQuitarConcepto(obraId, scId, cid) }, '🗑')
    ]))
  ]);
}

async function onAgregarConcepto(obraId, scId, scConceptos, conceptos) {
  const yaEnAlcance = new Set(Object.values(scConceptos).map(c => c.conceptoId));
  const disponibles = Object.entries(conceptos)
    .filter(([cid]) => !yaEnAlcance.has(cid))
    .map(([cid, con]) => ({ cid, ...con }));

  if (disponibles.length === 0) {
    toast('Ya están todos los conceptos del catálogo en este alcance', 'warn');
    return;
  }

  const search = h('input', { placeholder: 'Buscar por clave o descripción…', autofocus: true });
  const list = h('div', { style: { maxHeight: '320px', overflow: 'auto' } });
  const cantidad = h('input', { type: 'number', step: '0.01', min: '0', value: '0' });
  const notas = h('input', { placeholder: 'Notas (opcional)' });
  let selected = null;

  function refresh() {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const visibles = disponibles.filter(c =>
      !q || `${c.clave || ''} ${c.descripcion || ''}`.toLowerCase().includes(q)
    ).slice(0, 100);
    for (const c of visibles) {
      const row = h('div', {
        style: {
          padding: '6px 10px', cursor: 'pointer',
          borderBottom: '1px solid var(--border)',
          background: selected === c.cid ? 'var(--bg-3)' : 'transparent'
        }
      }, [
        h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, c.clave || c.cid.slice(0, 10)),
        h('div', { style: { fontSize: '12px' } }, (c.descripcion || '').slice(0, 80))
      ]);
      row.addEventListener('click', () => { selected = c.cid; refresh(); });
      list.appendChild(row);
    }
  }
  search.addEventListener('input', refresh);
  refresh();

  await modal({
    title: 'Agregar concepto al alcance',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Buscar concepto'), search]),
      h('div', { class: 'card', style: { padding: 0, marginTop: '6px' } }, list),
      h('div', { class: 'grid-2', style: { marginTop: '10px' } }, [
        h('div', { class: 'field' }, [h('label', {}, 'Cantidad *'), cantidad]),
        h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas])
      ])
    ]),
    confirmLabel: 'Agregar', size: 'lg',
    onConfirm: async () => {
      if (!selected) { toast('Elige un concepto', 'danger'); return false; }
      const cant = Number(cantidad.value);
      if (!cant || cant <= 0) { toast('Cantidad inválida', 'danger'); return false; }
      try {
        await addSubcontratoConcepto(obraId, scId, { conceptoId: selected, cantidad: cant, notas: notas.value.trim() });
        toast('Concepto agregado al alcance', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=alcance`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onEditarConcepto(obraId, scId, cid, c, conceptos) {
  const con = conceptos[c.conceptoId];
  const cantidad = h('input', { type: 'number', step: '0.01', min: '0', value: String(c.cantidad || 0), autofocus: true });
  const notas = h('input', { value: c.notas || '' });
  await modal({
    title: `Editar concepto: ${con?.clave || ''}`,
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Cantidad'), cantidad]),
      h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      await updateSubcontratoConcepto(obraId, scId, cid, {
        cantidad: Number(cantidad.value) || 0,
        notas: notas.value.trim()
      });
      toast('Concepto actualizado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}?tab=alcance`);
      return true;
    }
  });
}

async function onQuitarConcepto(obraId, scId, cid) {
  await modal({
    title: 'Quitar concepto del alcance',
    body: h('div', {}, '¿Quitar este concepto? Si algún licitante había capturado precio para él, ese precio se conserva pero queda huérfano.'),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeSubcontratoConcepto(obraId, scId, cid);
      toast('Concepto quitado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}?tab=alcance`);
      return true;
    }
  });
}

// ====================== TAB: LICITANTES ======================

function renderLicitantes(obraId, scId, scConceptos, scLicitantes, conceptos, proveedoresObra, editable, scMeta) {
  const conceptoEntries = Object.entries(scConceptos);
  const licEntries = Object.entries(scLicitantes);
  const adjudicadoId = scMeta.licitanteAdjudicadoId;

  const head = h('div', { class: 'row' }, [
    h('h3', { style: { margin: 0, flex: 1 } },
      `Licitantes (${num0(licEntries.length)})`),
    editable && h('button', {
      class: 'btn sm primary',
      onClick: () => onAgregarLicitante(obraId, scId, scConceptos, scLicitantes, proveedoresObra)
    }, '+ Agregar licitante')
  ]);

  if (conceptoEntries.length === 0) {
    return h('div', { class: 'card' }, [
      head,
      h('div', { class: 'empty', style: { marginTop: '10px' } },
        'Define primero el alcance del subcontrato. Sin conceptos no se pueden cotizar precios.')
    ]);
  }
  if (licEntries.length === 0) {
    return h('div', { class: 'card' }, [
      head,
      h('div', { class: 'empty', style: { marginTop: '10px' } }, [
        h('div', { class: 'ico' }, '💬'),
        h('div', {}, 'Sin licitantes todavía.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Agrega proveedores (o crea nuevos) y captura sus precios por concepto.')
      ])
    ]);
  }

  // Ordenar conceptos por clave
  const sortedConceptos = conceptoEntries.sort(([, a], [, b]) => {
    const ca = conceptos[a.conceptoId]?.clave || '';
    const cb = conceptos[b.conceptoId]?.clave || '';
    return ca.localeCompare(cb);
  });

  // Pre-calcular: por concepto, mejor precio (sin IVA normalizado)
  const mejorPorConcepto = {};
  for (const [cid, c] of sortedConceptos) {
    let minNorm = Infinity, mejorLic = null;
    for (const [licId, lic] of licEntries) {
      const p = Number(lic.precios?.[c.conceptoId]) || 0;
      if (p <= 0) continue;
      const norm = lic.aceptaSinIva !== false ? p : (p / 1.16);
      if (norm < minNorm) { minNorm = norm; mejorLic = licId; }
    }
    mejorPorConcepto[cid] = mejorLic;
  }

  // Pre-calcular: total por licitante
  const totalesLic = {};
  for (const [licId, lic] of licEntries) {
    let t = 0;
    for (const [, c] of sortedConceptos) {
      const p = Number(lic.precios?.[c.conceptoId]) || 0;
      t += p * (Number(c.cantidad) || 0);
    }
    totalesLic[licId] = t;
  }

  // Total a catálogo
  let totalCatalogo = 0;
  for (const [, c] of sortedConceptos) {
    const con = conceptos[c.conceptoId];
    totalCatalogo += (Number(c.cantidad) || 0) * (Number(con?.precioUnitario) || 0);
  }

  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 4px' } }, head),
    h('div', { class: 'muted', style: { fontSize: '11px', padding: '0 18px 8px' } },
      'Captura precios unitarios por celda. La celda en verde es el mejor precio de la fila (normalizado sin IVA si aplica). Ahorro % vs catálogo OPUS.'),
    h('div', { style: { overflow: 'auto', maxHeight: '70vh' } },
      h('table', { class: 'tbl' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { style: { position: 'sticky', left: 0, background: 'var(--bg-2)', zIndex: 2, minWidth: '280px' } }, 'Concepto'),
          h('th', { class: 'num' }, 'Cantidad'),
          h('th', { class: 'num' }, 'P.U. Catálogo'),
          ...licEntries.map(([licId, lic]) =>
            licColumnHeader(obraId, scId, licId, lic, totalesLic[licId], totalCatalogo, adjudicadoId === licId, editable))
        ])),
        h('tbody', {},
          sortedConceptos.map(([cid, c]) =>
            licitanteFila(obraId, scId, cid, c, conceptos, licEntries, mejorPorConcepto[cid], editable, adjudicadoId)))
      ])
    )
  ]);
}

function licColumnHeader(obraId, scId, licId, lic, total, totalCat, esAdj, editable) {
  const ahorro = totalCat > 0 ? (totalCat - total) / totalCat : 0;
  const ahorroColor = ahorro > 0 ? 'var(--ok)' : 'var(--danger)';
  return h('th', {
    class: 'num',
    style: {
      minWidth: '140px',
      background: esAdj ? 'rgba(93, 211, 158, 0.08)' : undefined,
      borderTop: esAdj ? '2px solid var(--ok)' : undefined
    },
    title: lic.nombre + (lic.aceptaSinIva !== false ? ' · sin IVA' : ' · +IVA')
  }, [
    h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '4px' } }, [
      h('div', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, [
        (lic.nombre || '').slice(0, 16),
        esAdj && h('span', { style: { marginLeft: '4px', color: 'var(--ok)' } }, '🏆')
      ]),
      editable && h('button', {
        class: 'btn ghost',
        style: { padding: '0 4px', fontSize: '10px', textTransform: 'none', letterSpacing: 0 },
        onClick: (e) => { e.stopPropagation(); onQuitarLicitante(obraId, scId, licId, lic); }
      }, '✕')
    ]),
    h('div', { style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0 } }, [
      lic.aceptaSinIva !== false
        ? h('span', { style: { color: 'var(--ok)' } }, 'sin IVA')
        : h('span', { style: { color: 'var(--warn)' } }, '+ IVA')
    ]),
    h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-0)', marginTop: '2px' } }, money(total)),
    total > 0 && totalCat > 0 && h('div', {
      style: { fontSize: '10px', fontWeight: 'normal', color: ahorroColor, textTransform: 'none', letterSpacing: 0 }
    }, `${ahorro > 0 ? '−' : '+'}${Math.abs(ahorro * 100).toFixed(1)}%`)
  ]);
}

function licitanteFila(obraId, scId, cid, c, conceptos, licEntries, mejorLicId, editable, adjudicadoId) {
  const con = conceptos[c.conceptoId];
  const precioCat = Number(con?.precioUnitario) || 0;
  return h('tr', {}, [
    h('td', { style: { maxWidth: '280px', position: 'sticky', left: 0, background: 'var(--bg-1)', zIndex: 1 } }, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, con?.clave || c.conceptoId.slice(0, 10)),
      h('div', { style: { fontSize: '12px' } }, (con?.descripcion || '').slice(0, 60) + ((con?.descripcion || '').length > 60 ? '…' : '')),
      h('div', { class: 'muted', style: { fontSize: '10px' } }, con?.unidad || '')
    ]),
    h('td', { class: 'num' }, num(c.cantidad)),
    h('td', { class: 'num muted' }, precioCat > 0 ? money(precioCat) : '—'),
    ...licEntries.map(([licId, lic]) =>
      precioCelda(obraId, scId, licId, lic, c, precioCat, licId === mejorLicId, editable, adjudicadoId === licId))
  ]);
}

function precioCelda(obraId, scId, licId, lic, c, precioCat, esMejor, editable, esAdj) {
  const precio = Number(lic.precios?.[c.conceptoId]) || 0;
  const refPrecio = lic.aceptaSinIva !== false ? precioCat : (precioCat * 1.16);
  const cantidad = Number(c.cantidad) || 0;
  const importe = precio * cantidad;
  const ahorro = refPrecio > 0 && precio > 0 ? (refPrecio - precio) / refPrecio : 0;

  const input = h('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    value: precio > 0 ? String(precio) : '',
    placeholder: '$',
    style: {
      width: '90px', textAlign: 'right', fontFamily: 'var(--mono)',
      background: esAdj ? 'rgba(93, 211, 158, 0.05)' : 'var(--bg-1)'
    }
  });
  if (!editable) input.disabled = true;

  function colorize() {
    const v = Number(input.value) || 0;
    if (!v) {
      input.style.color = 'var(--text-0)';
      input.style.borderColor = 'var(--border)';
      return;
    }
    if (esMejor) {
      input.style.color = 'var(--ok)';
      input.style.borderColor = 'rgba(93, 211, 158, 0.4)';
      input.style.fontWeight = '600';
    } else if (refPrecio > 0 && v < refPrecio) {
      input.style.color = 'var(--ok)';
      input.style.borderColor = 'var(--border)';
      input.style.fontWeight = 'normal';
    } else if (refPrecio > 0 && v > refPrecio) {
      input.style.color = 'var(--danger)';
      input.style.borderColor = 'var(--border)';
      input.style.fontWeight = 'normal';
    } else {
      input.style.color = 'var(--text-0)';
      input.style.borderColor = 'var(--border)';
      input.style.fontWeight = 'normal';
    }
  }
  colorize();

  let timer = null;
  input.addEventListener('input', () => {
    colorize();
    clearTimeout(timer);
    const v = Number(input.value) || 0;
    timer = setTimeout(() => {
      setSubcontratoLicitantePrecio(obraId, scId, licId, c.conceptoId, v)
        .catch(err => toast('Error guardando: ' + err.message, 'danger'));
    }, 600);
  });

  return h('td', {
    class: 'num',
    style: {
      padding: '4px 6px',
      background: esAdj ? 'rgba(93, 211, 158, 0.04)' : undefined
    },
    title: precio > 0 ? `Importe ${money(importe)}${refPrecio > 0 ? ' · ahorro ' + (ahorro * 100).toFixed(1) + '%' : ''}` : ''
  }, [
    input,
    importe > 0 && h('div', { style: { fontSize: '10px', color: 'var(--text-2)', marginTop: '2px' } }, money(importe))
  ]);
}

async function onAgregarLicitante(obraId, scId, scConceptos, scLicitantes, proveedoresObra) {
  const yaProvIds = new Set(Object.values(scLicitantes).map(l => l.provId).filter(Boolean));
  const disponibles = proveedoresObra.filter(p =>
    !yaProvIds.has(p.proveedor_global_id || p.id)
  );

  if (disponibles.length === 0) {
    await modal({
      title: 'Sin proveedores disponibles',
      body: h('div', {}, [
        h('p', {}, 'Todos los proveedores de la obra ya están como licitantes en este subcontrato.'),
        h('p', { class: 'muted', style: { fontSize: '12px' } },
          'Para agregar más, primero asigna proveedores adicionales a la obra desde 🏷️ Proveedores.')
      ]),
      confirmLabel: 'Ir a proveedores',
      onConfirm: () => {
        navigate(`/obras/${obraId}/proveedores`);
        return true;
      }
    });
    return;
  }

  const provSel = h('select', {}, [
    h('option', { value: '' }, '— elige proveedor de la obra —'),
    ...disponibles
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      .map(p => h('option', {
        value: p.proveedor_global_id || p.id,
        dataset: {
          nombre: p.nombre, rfc: p.rfc || '', email: p.email || '',
          telefono: p.telefono || '', contacto: p.contacto || '',
          aceptaSinIva: p.aceptaSinIva !== false ? '1' : '0'
        }
      }, p.nombre + (p.aceptaSinIva !== false ? ' (sin IVA)' : ' (+ IVA)')))
  ]);
  const notas = h('input', { placeholder: 'Notas (opcional)' });

  await modal({
    title: 'Agregar licitante',
    body: h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', {}, 'Proveedor *'),
        provSel,
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, [
          '¿No está en la lista? ',
          h('a', { href: `#/obras/${obraId}/proveedores` }, 'Agrégalo primero a la obra'),
          ' y vuelve aquí.'
        ])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Notas iniciales'), notas])
    ]),
    confirmLabel: 'Agregar',
    onConfirm: async () => {
      if (!provSel.value) { toast('Elige un proveedor', 'danger'); return false; }
      const opt = provSel.options[provSel.selectedIndex];
      try {
        await addSubcontratoLicitante(obraId, scId, {
          provId: provSel.value,
          nombre: opt.dataset.nombre,
          rfc: opt.dataset.rfc,
          email: opt.dataset.email,
          telefono: opt.dataset.telefono,
          contacto: opt.dataset.contacto,
          aceptaSinIva: opt.dataset.aceptaSinIva === '1',
          notas: notas.value.trim()
        });
        toast('Licitante agregado', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=licitantes`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onQuitarLicitante(obraId, scId, licId, lic) {
  await modal({
    title: 'Quitar licitante',
    body: h('div', {}, [
      h('p', {}, `¿Quitar a "${lic.nombre}" del subcontrato?`),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Se pierden los precios que capturaste. El proveedor sigue en la obra.')
    ]),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeSubcontratoLicitante(obraId, scId, licId);
      toast('Licitante quitado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}?tab=licitantes`);
      return true;
    }
  });
}

// ====================== TAB: ADJUDICACIÓN ======================

function renderAdjudicacion(obraId, scId, scConceptos, scLicitantes, conceptos, scMeta, editable) {
  const conceptoArr = Object.values(scConceptos);
  const licEntries = Object.entries(scLicitantes);

  if (conceptoArr.length === 0 || licEntries.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, 'Adjudicación'),
      h('div', { class: 'empty' }, 'Necesitas al menos un concepto en el alcance y un licitante con precios capturados.')
    ]);
  }

  // Calcular total y % completado de cotización por licitante
  let totalCatalogo = 0;
  for (const c of conceptoArr) {
    totalCatalogo += (Number(c.cantidad) || 0) * (Number(conceptos[c.conceptoId]?.precioUnitario) || 0);
  }

  const ranking = licEntries.map(([licId, lic]) => {
    let total = 0, cubre = 0;
    for (const c of conceptoArr) {
      const p = Number(lic.precios?.[c.conceptoId]) || 0;
      if (p > 0) {
        cubre++;
        total += p * (Number(c.cantidad) || 0);
      }
    }
    return {
      licId, lic, total, cubre, totalConceptos: conceptoArr.length,
      completo: cubre === conceptoArr.length,
      ahorro: totalCatalogo > 0 ? (totalCatalogo - total) / totalCatalogo : 0
    };
  }).sort((a, b) => {
    if (a.completo !== b.completo) return a.completo ? -1 : 1;
    if (b.cubre !== a.cubre) return b.cubre - a.cubre;
    return a.total - b.total;
  });

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Ranking de licitantes'),
    h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '10px' } },
      `Ordenado por: completitud de cotización, luego por menor importe. Total a catálogo OPUS: ${money(totalCatalogo)}.`),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      ranking.map(r => rankingCard(obraId, scId, r, scMeta, editable)))
  ]);
}

function rankingCard(obraId, scId, r, scMeta, editable) {
  const esAdj = scMeta.licitanteAdjudicadoId === r.licId;
  const hayOtroAdj = scMeta.licitanteAdjudicadoId && !esAdj;
  const ahorroColor = r.ahorro > 0 ? 'var(--ok)' : 'var(--danger)';

  return h('div', {
    style: {
      padding: '12px 14px',
      background: esAdj ? 'rgba(93, 211, 158, 0.08)' : 'var(--bg-2)',
      border: '1px solid ' + (esAdj ? 'var(--ok)' : 'var(--border)'),
      borderRadius: '8px'
    }
  }, [
    h('div', { class: 'row', style: { gap: '12px' } }, [
      h('div', { style: { flex: 1 } }, [
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          esAdj && h('span', { style: { color: 'var(--ok)', fontSize: '18px' } }, '🏆'),
          h('b', { style: { fontSize: '15px' } }, r.lic.nombre),
          r.lic.aceptaSinIva !== false
            ? h('span', { class: 'tag', style: { fontSize: '10px' } }, 'sin IVA')
            : h('span', { class: 'tag warn', style: { fontSize: '10px' } }, '+ IVA')
        ]),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, [
          'Cotizó ', h('b', {}, `${r.cubre}/${r.totalConceptos}`), ' conceptos',
          r.completo ? '' : ' · ⚠ cotización incompleta',
          r.lic.rfc && ' · RFC: ' + r.lic.rfc
        ])
      ]),
      h('div', { style: { textAlign: 'right' } }, [
        h('div', { style: { fontFamily: 'var(--mono)', fontSize: '18px', fontWeight: '600' } }, money(r.total)),
        r.total > 0 && h('div', { style: { fontSize: '11px', color: ahorroColor } },
          `${r.ahorro > 0 ? '−' : '+'}${Math.abs(r.ahorro * 100).toFixed(1)}% vs catálogo`)
      ]),
      editable && (esAdj
        ? h('button', {
          class: 'btn',
          onClick: () => onDesadjudicar(obraId, scId)
        }, '↺ Desadjudicar')
        : !hayOtroAdj && r.completo
          ? h('button', {
            class: 'btn primary',
            onClick: () => onAdjudicar(obraId, scId, r.licId, r.lic)
          }, '🏆 Adjudicar')
          : !hayOtroAdj && !r.completo
            ? h('button', {
              class: 'btn',
              disabled: true,
              title: 'Captura precio para todos los conceptos antes de adjudicar'
            }, 'Incompleto')
            : null)
    ])
  ]);
}

async function onAdjudicar(obraId, scId, licId, lic) {
  await modal({
    title: 'Adjudicar subcontrato',
    body: h('div', {}, [
      h('p', {}, ['Se adjudicará el subcontrato a ', h('b', {}, lic.nombre), '.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'A partir de aquí, la app de estimaciones puede generar las estimaciones parciales con base en este subcontrato. Mientras esté adjudicado no se podrán modificar precios; si necesitas cambiarlos, primero desadjudica.')
    ]),
    confirmLabel: 'Adjudicar',
    onConfirm: async () => {
      try {
        await adjudicarSubcontrato(obraId, scId, licId);
        toast(`Subcontrato adjudicado a ${lic.nombre}`, 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=adjudicacion`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onDesadjudicar(obraId, scId) {
  await modal({
    title: 'Desadjudicar subcontrato',
    body: h('div', {}, [
      h('p', {}, '¿Desadjudicar este subcontrato? Volverá a estado "cotizando" y se podrán editar precios.'),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Si ya hay estimaciones parciales emitidas hacia bitácora, esas no se afectan — son eventos independientes que el contador procesa.')
    ]),
    confirmLabel: 'Desadjudicar', danger: true,
    onConfirm: async () => {
      try {
        await desadjudicarSubcontrato(obraId, scId);
        toast('Subcontrato desadjudicado', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=adjudicacion`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// ====================== Meta ======================

async function onEditarMeta(obraId, scId, scMeta) {
  const nombre = h('input', { value: scMeta.nombre || '', autofocus: true });
  const descripcion = h('textarea', { rows: 3 }, scMeta.descripcion || '');
  await modal({
    title: 'Editar datos del subcontrato',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
      h('div', { class: 'field' }, [h('label', {}, 'Descripción'), descripcion])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Captura un nombre', 'danger'); return false; }
      await updateSubcontratoMeta(obraId, scId, {
        nombre: n,
        descripcion: descripcion.value.trim()
      });
      toast('Subcontrato actualizado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}`);
      return true;
    }
  });
}

// ====================== Helpers ======================

function totalLicitante(lic, scConceptos) {
  if (!lic) return 0;
  let t = 0;
  for (const c of Object.values(scConceptos || {})) {
    const p = Number(lic.precios?.[c.conceptoId]) || 0;
    t += p * (Number(c.cantidad) || 0);
  }
  return t;
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function crumbs(obraId, nombre, scNombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Subcontratos', to: `/obras/${obraId}/subcontratos` },
    { label: scNombre || '...' }
  ];
}
