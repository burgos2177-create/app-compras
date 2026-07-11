import { h, toast, modal } from '../util/dom.js?v=20260711j';
import { renderShell } from './shell.js?v=20260711j';
import { state, setState } from '../state/store.js?v=20260711j';
import {
  getObraMetaLegacy, getProveedorObra, updateProveedorObra,
  loadCatalogoMateriales, loadCatalogoConceptos,
  listCotizaciones, listOC,
  listProveedoresGlobal, updateProveedorGlobal,
  mergeProveedorObraConGlobal
} from '../services/db.js?v=20260711j';
import { navigate } from '../state/router.js?v=20260711j';
import { dateMx, num, num0, money, ocFolio, reqFolio } from '../util/format.js?v=20260711j';

// Detalle de un proveedor en el contexto de una obra. Incluye:
//   - Datos del proveedor (editable, sincroniza solo en obra; el global es
//     fuente separada).
//   - Tabla "Catálogo vs cotizado": para cada material del catálogo de la
//     obra muestra precio del catálogo OPUS y, si este proveedor lo ha
//     cotizado, los datos de la última cotización (cantidad, precio, delta
//     vs catálogo, estado).

const ESTADO_LABEL = {
  borrador:   { txt: '✎ Borrador',   color: 'var(--warn)' },
  recibida:   { txt: '📩 Recibida',   color: 'var(--ok)' },
  ganadora:   { txt: '🏆 Ganadora',   color: 'var(--ok)' },
  descartada: { txt: '✕ Descartada', color: 'var(--text-2)' }
};

export async function renderProveedorObraDetalle({ params }) {
  const obraId = params.id;
  const provObraId = params.provid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, provRaw, catMat, catCon, cotizaciones, ocs, globales] = await Promise.all([
    getObraMetaLegacy(obraId),
    getProveedorObra(provObraId),
    loadCatalogoMateriales(obraId),
    loadCatalogoConceptos(obraId),
    listCotizaciones(obraId),
    listOC(obraId),
    listProveedoresGlobal()
  ]);

  if (!provRaw) {
    renderShell(crumbs(obraId, meta?.nombre, '...'),
      h('div', { class: 'empty' }, 'Proveedor no encontrado en esta obra.'));
    return;
  }
  // Merge con catálogo global: si está vinculado, los datos canónicos
  // (RFC, teléfono, email) salen del global. _global queda disponible para
  // edición.
  const prov = mergeProveedorObraConGlobal(provRaw, globales);

  const materiales = catMat?.items || {};

  // === Filtrar cotizaciones de este proveedor ===
  const matchesProv = (cot) => {
    const id = cot.proveedor?.id;
    const nombre = (cot.proveedor?.nombre || '').toLowerCase();
    if (id && (id === prov.proveedor_global_id || id === prov.id)) return true;
    return nombre && nombre === (prov.nombre || '').toLowerCase();
  };
  const cotsProv = Object.entries(cotizaciones).filter(([, c]) => matchesProv(c));
  const ocsProv = Object.entries(ocs).filter(([, oc]) => {
    const id = oc.proveedor?.id;
    const nombre = (oc.proveedor?.nombre || '').toLowerCase();
    if (id && (id === prov.proveedor_global_id || id === prov.id)) return true;
    return nombre && nombre === (prov.nombre || '').toLowerCase();
  });

  // === Construir vista por material ===
  // Map: materialKey → { cotizaciones: [{cotId, c, item}], ocs: [{ocId, oc, item}] }
  const byMat = new Map();
  for (const [matKey] of Object.entries(materiales)) byMat.set(matKey, { cots: [], ocs: [] });
  for (const [cotId, c] of cotsProv) {
    for (const it of Object.values(c.items || {})) {
      if (!it.materialKey) continue;
      if (!byMat.has(it.materialKey)) byMat.set(it.materialKey, { cots: [], ocs: [] });
      byMat.get(it.materialKey).cots.push({ cotId, c, item: it });
    }
  }
  for (const [ocId, oc] of ocsProv) {
    for (const it of Object.values(oc.items || {})) {
      if (!it.materialKey) continue;
      if (!byMat.has(it.materialKey)) byMat.set(it.materialKey, { cots: [], ocs: [] });
      byMat.get(it.materialKey).ocs.push({ ocId, oc, item: it });
    }
  }

  // KPIs
  const matsCotizados = Array.from(byMat.values()).filter(v => v.cots.length > 0).length;
  const matsConOC = Array.from(byMat.values()).filter(v => v.ocs.length > 0).length;
  const totalCotizado = cotsProv.reduce((s, [, c]) => s + (Number(c.total) || 0), 0);
  const totalOC = ocsProv.reduce((s, [, oc]) => s + (Number(oc.total) || 0), 0);

  // === Render ===
  const head = h('div', { class: 'row' }, [
    h('h1', {}, prov.nombre),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => onEditar(obraId, prov) }, '✎ Editar datos')
  ]);

  const linkedToGlobal = prov._fuenteCanonica === 'global';
  const datosCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos del proveedor'),
    h('div', { class: 'grid-3' }, [
      kv('Nombre', prov.nombre),
      kv('RFC', prov.rfc),
      kv('Teléfono', prov.telefono),
      kv('Email', prov.email),
      kv('Contacto', prov.contacto),
      kv('Origen',
        linkedToGlobal
          ? h('span', { class: 'tag' }, 'En catálogo global')
          : h('span', { class: 'tag warn' }, 'Solo en obra')),
      kv('Régimen fiscal',
        prov.aceptaSinIva
          ? h('span', { class: 'tag ok' }, '✓ Acepta sin IVA')
          : h('span', { class: 'tag warn' }, '⚠ Siempre con IVA (+ 16%)'))
    ]),
    prov.notas && h('div', { style: { marginTop: '8px' } }, [
      h('label', { class: 'muted', style: { fontSize: '12px' } }, 'Notas'),
      h('div', {}, prov.notas)
    ]),
    linkedToGlobal && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '10px' } },
      'Nombre, RFC, teléfono y email vienen del catálogo global. Contacto y notas pueden ser específicos de esta obra.')
  ]);

  const kpisCard = h('div', { class: 'grid-4' }, [
    kpi('Cotizaciones', num0(cotsProv.length), `${num0(matsCotizados)} materiales distintos`),
    kpi('OCs emitidas', num0(ocsProv.length), `${num0(matsConOC)} materiales`),
    kpi('Total cotizado', money(totalCotizado), 'suma de cotizaciones'),
    kpi('Total comprado', money(totalOC), 'suma de OCs')
  ]);

  const matsCard = renderMaterialesCard(byMat, materiales, prov);
  const cotsCard = renderCotizacionesCard(obraId, cotsProv, ocsProv);

  renderShell(crumbs(obraId, meta?.nombre, prov.nombre),
    h('div', {}, [head, datosCard, kpisCard, matsCard, cotsCard]));
}

function renderMaterialesCard(byMat, materiales, prov) {
  // Solo mostramos materiales que (a) están en el catálogo y este proveedor
  // ha cotizado o (b) están en el catálogo y NO han sido cotizados pero
  // queremos compararlos para sugerir cotización.
  // Para no saturar, ordenamos: primero los que tienen cotización, después
  // los del catálogo sin cotizar, y al final los ad-hoc cotizados que no están
  // en el catálogo.
  const filas = [];
  const adHocCotizados = [];

  for (const [matKey, info] of byMat.entries()) {
    const m = materiales[matKey];
    if (!m && info.cots.length === 0 && info.ocs.length === 0) continue;
    if (!m) {
      // ad-hoc cotizado por este proveedor (no está en catálogo)
      adHocCotizados.push({ matKey, info });
      continue;
    }
    filas.push({ matKey, m, info, cotizado: info.cots.length > 0 });
  }

  // ordenar: cotizados primero, luego por descripción
  filas.sort((a, b) => {
    if (a.cotizado !== b.cotizado) return a.cotizado ? -1 : 1;
    return (a.m.descripcion || '').localeCompare(b.m.descripcion || '');
  });

  const totalRows = filas.length + adHocCotizados.length;

  if (totalRows === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, 'Materiales · catálogo vs cotizado por el proveedor'),
      h('div', { class: 'empty' }, [
        h('div', {}, 'Este proveedor aún no ha cotizado materiales en esta obra.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          'Cuando captures cotizaciones, esta tabla compara el precio del catálogo con el precio del proveedor.')
      ])
    ]);
  }

  const filasMostrar = filas.slice(0, 200); // cap defensivo
  const overflow = filas.length - filasMostrar.length;

  const rows = [];
  for (const f of filasMostrar) rows.push(matRow(f.matKey, f.m, f.info));
  for (const f of adHocCotizados) {
    // Sintetizamos un material "fantasma" desde el primero de los items cotizados
    const sample = f.info.cots[0]?.item || f.info.ocs[0]?.item;
    if (!sample) continue;
    const m = {
      clave: sample.clave || '—',
      descripcion: sample.descripcion || '—',
      unidad: sample.unidad || '—',
      costoUnitario: 0,
      origen: sample.origen || 'ad_hoc_compras'
    };
    rows.push(matRow(f.matKey, m, f.info, /*adHoc*/true));
  }

  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 0' } }, [
      h('h3', {}, [
        'Materiales · catálogo vs cotizado por el proveedor ',
        h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } },
          `(${num0(rows.length)})`)
      ]),
      h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
        'Última cotización vista en cualquier estado. Δ% verde = más barato que el catálogo, rojo = más caro.')
    ]),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Catálogo OPUS'),
        h('th', { class: 'num' }, 'Última cotización'),
        h('th', { class: 'num' }, 'Δ%'),
        h('th', { class: 'num' }, 'Cant. cotizada'),
        h('th', {}, 'Estado'),
        h('th', {}, 'Última fecha')
      ])]),
      h('tbody', {}, rows)
    ]),
    overflow > 0 && h('div', { class: 'muted', style: { padding: '8px 18px', fontSize: '11px' } },
      `... y ${overflow} materiales más en el catálogo que este proveedor aún no ha cotizado.`)
  ]);
}

function matRow(matKey, m, info, adHoc = false) {
  const cotsOrden = [...info.cots].sort((a, b) =>
    (b.c.fechaCotizacion || b.c.createdAt || 0) - (a.c.fechaCotizacion || a.c.createdAt || 0));
  const ultimaCot = cotsOrden[0];
  const tieneCot = !!ultimaCot;

  const catalogoPrecio = Number(m.costoUnitario) || 0;
  const provPrecio = tieneCot ? (Number(ultimaCot.item.costoUnitario) || 0) : null;

  let deltaPct = null;
  if (tieneCot && catalogoPrecio > 0 && provPrecio !== null) {
    deltaPct = (provPrecio - catalogoPrecio) / catalogoPrecio;
  }
  const deltaColor = deltaPct === null
    ? 'var(--text-2)'
    : (deltaPct < 0 ? 'var(--ok)' : (deltaPct > 0 ? 'var(--danger)' : 'var(--text-2)'));
  const deltaTxt = deltaPct === null
    ? '—'
    : (deltaPct === 0 ? '0%' : `${deltaPct > 0 ? '+' : ''}${(deltaPct * 100).toFixed(1)}%`);

  // Cantidad cotizada total (todas las cotizaciones, no solo la última)
  const cantCotizada = info.cots.reduce((s, c) => s + (Number(c.item.cantidad) || 0), 0);
  const cantOC = info.ocs.reduce((s, x) => s + (Number(x.item.cantidad) || 0), 0);

  // Estado: ganadora > recibida > borrador. Si está en OC, prioriza eso.
  let estadoCol;
  if (info.ocs.length > 0) {
    estadoCol = h('span', { class: 'tag ok' }, `🏆 ${info.ocs.length} OC`);
  } else if (cotsOrden.length > 0) {
    const cfg = ESTADO_LABEL[ultimaCot.c.estado] || { txt: ultimaCot.c.estado, color: 'var(--text-2)' };
    estadoCol = h('span', { style: { color: cfg.color, fontSize: '12px' } }, cfg.txt);
  } else {
    estadoCol = h('span', { class: 'muted', style: { fontSize: '12px' } }, 'sin cotizar');
  }

  const fechaUlt = tieneCot ? dateMx(ultimaCot.c.fechaCotizacion || ultimaCot.c.createdAt) : '—';

  return h('tr', {}, [
    h('td', { style: { maxWidth: '320px' } }, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, [
        m.clave,
        adHoc && h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'ad-hoc compras')
      ]),
      h('div', {}, m.descripcion)
    ]),
    h('td', {}, m.unidad || '—'),
    h('td', { class: 'num' }, catalogoPrecio > 0 ? money(catalogoPrecio) : '—'),
    h('td', { class: 'num' }, provPrecio !== null ? money(provPrecio) : '—'),
    h('td', { class: 'num', style: { color: deltaColor, fontWeight: '600' } }, deltaTxt),
    h('td', { class: 'num' }, cantCotizada > 0 ? num(cantCotizada) : '—'),
    h('td', {}, estadoCol),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, fechaUlt)
  ]);
}

function renderCotizacionesCard(obraId, cotsProv, ocsProv) {
  if (cotsProv.length === 0 && ocsProv.length === 0) return null;

  const cotsOrden = [...cotsProv].sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  const ocsOrden = [...ocsProv].sort((a, b) => (b[1].numero || 0) - (a[1].numero || 0));

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Historial con este proveedor'),
    h('div', { class: 'grid-2' }, [
      h('div', {}, [
        h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } },
          `${num0(cotsOrden.length)} cotización${cotsOrden.length === 1 ? '' : 'es'}`),
        cotsOrden.length === 0
          ? h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Sin cotizaciones todavía.')
          : h('ul', { style: { margin: 0, paddingLeft: '20px', fontSize: '13px' } },
            cotsOrden.slice(0, 8).map(([id, c]) => h('li', {}, [
              h('a', { href: `#/obras/${obraId}/cotizaciones/${id}` }, dateMx(c.fechaCotizacion || c.createdAt)),
              h('span', { class: 'muted', style: { marginLeft: '6px' } },
                `· ${num0(Object.keys(c.items || {}).length)} item · ${money(c.total || 0)}`),
              c.estado === 'ganadora' && h('span', { class: 'tag ok', style: { marginLeft: '6px', fontSize: '10px' } }, '🏆')
            ])))
      ]),
      h('div', {}, [
        h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } },
          `${num0(ocsOrden.length)} OC emitida${ocsOrden.length === 1 ? '' : 's'}`),
        ocsOrden.length === 0
          ? h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Sin OCs todavía.')
          : h('ul', { style: { margin: 0, paddingLeft: '20px', fontSize: '13px' } },
            ocsOrden.slice(0, 8).map(([id, oc]) => h('li', {}, [
              h('a', { href: `#/obras/${obraId}/oc/${id}` }, ocFolio(oc.numero)),
              h('span', { class: 'muted', style: { marginLeft: '6px' } },
                `· ${dateMx(oc.fechaEmision || oc.createdAt)} · ${money(oc.total || 0)}`),
              h('span', { class: 'tag muted', style: { marginLeft: '6px', fontSize: '10px' } }, oc.estado || '—')
            ])))
      ])
    ])
  ]);
}

async function onEditar(obraId, prov) {
  const linkedToGlobal = prov._fuenteCanonica === 'global';

  // Inputs para datos canónicos (global) y para overrides locales (obra).
  const nombre   = h('input', { value: prov.nombre || '', autofocus: true });
  const rfc      = h('input', { value: prov.rfc || '' });
  const telefono = h('input', { value: prov.telefono || '' });
  const email    = h('input', { type: 'email', value: prov.email || '' });
  // Contacto y notas: si está vinculado al global, lo que se edita es el
  // override de obra (no se toca el global). Si no está vinculado, se edita
  // todo localmente.
  const contacto = h('input', { value: prov._global ? (prov._fuenteCanonica === 'global' ? (prov.contacto || '') : prov.contacto) : (prov.contacto || '') });
  const notas    = h('textarea', { rows: 2 }, prov.notas || '');
  const aceptaSinIva = h('input', { type: 'checkbox', checked: prov.aceptaSinIva !== false });

  if (linkedToGlobal) {
    // Datos canónicos vienen del global. El modal los muestra solo lectura
    // a menos que el usuario diga "Editar en catálogo global".
    nombre.disabled = true; rfc.disabled = true;
    telefono.disabled = true; email.disabled = true;
  }

  const editarGlobalToggle = h('input', { type: 'checkbox' });
  editarGlobalToggle.addEventListener('change', () => {
    const lock = !editarGlobalToggle.checked;
    nombre.disabled = lock; rfc.disabled = lock;
    telefono.disabled = lock; email.disabled = lock;
  });

  const body = h('div', {}, [
    linkedToGlobal && h('div', { style: { padding: '8px 10px', background: 'var(--bg-2)', borderRadius: '6px', marginBottom: '12px', fontSize: '12px' } }, [
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        editarGlobalToggle,
        h('span', {}, h('b', {}, 'Editar también en el catálogo global')),
        h('span', { class: 'muted' }, ' (afecta a todas las obras donde se use este proveedor)')
      ])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'RFC'), rfc]),
      h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Email'), email]),
      h('div', { class: 'field' }, [h('label', {}, 'Contacto (override de obra)'), contacto])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Notas (override de obra)'), notas]),
    h('div', { style: { padding: '10px 12px', background: 'var(--bg-2)', borderRadius: '6px', marginTop: '10px' } }, [
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        aceptaSinIva,
        h('span', {}, h('b', {}, 'Acepta transacciones sin IVA'))
      ]),
      h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
        'Si está marcado, sus precios se comparan contra el catálogo OPUS directo. Si no, se comparan contra OPUS + 16% IVA (porque el proveedor solo vende facturado).')
    ]),
    linkedToGlobal && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } },
      'Por defecto solo se actualiza contacto, notas y régimen fiscal en esta obra. Marca el checkbox para también actualizar nombre/RFC/teléfono/email en el catálogo global.')
  ]);

  await modal({
    title: 'Editar proveedor',
    body, confirmLabel: 'Guardar', size: 'lg',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Captura el nombre', 'danger'); return false; }
      try {
        const datosCanonicos = {
          nombre: n,
          rfc: rfc.value.trim(),
          telefono: telefono.value.trim(),
          email: email.value.trim()
        };
        const datosObra = {
          contacto: contacto.value.trim(),
          notas: notas.value.trim(),
          aceptaSinIva: aceptaSinIva.checked
        };

        if (linkedToGlobal && editarGlobalToggle.checked) {
          // Actualizar global y limpiar snapshot de obra para que siempre
          // se lea del global (evita stale).
          await updateProveedorGlobal(prov.proveedor_global_id, datosCanonicos);
          await updateProveedorObra(prov.id, {
            ...datosObra,
            // Limpiamos el snapshot de obra para canónicos — el merge ya los
            // toma del global.
            nombre: '', rfc: '', telefono: '', email: ''
          });
          toast('Proveedor actualizado en obra y catálogo global', 'ok');
        } else if (linkedToGlobal) {
          // Solo override de obra (contacto + notas).
          await updateProveedorObra(prov.id, datosObra);
          toast('Datos de la obra actualizados', 'ok');
        } else {
          // Proveedor solo de obra: actualizar todo localmente.
          await updateProveedorObra(prov.id, { ...datosCanonicos, ...datosObra });
          toast('Proveedor actualizado', 'ok');
        }
        renderProveedorObraDetalle({ params: { id: obraId, provid: prov.id } });
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

function kpi(label, big, sub) {
  return h('div', { class: 'card' }, [
    h('h3', {}, label),
    h('div', { style: { fontSize: '24px', fontWeight: '600', color: 'var(--accent)' } }, big),
    h('div', { class: 'muted', style: { fontSize: '11px' } }, sub)
  ]);
}
function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}
function crumbs(obraId, nombre, prov) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Proveedores', to: `/obras/${obraId}/proveedores` },
    { label: prov || '...' }
  ];
}
