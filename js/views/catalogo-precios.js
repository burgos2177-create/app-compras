import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy,
  loadCatalogoMateriales,
  listProveedoresObra,
  listPreciosCatalogo,
  setPrecioCatalogo, removePrecioCatalogo,
  listProveedoresGlobal, mergeProveedorObraConGlobal,
  listSolicitudesCotizacion
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx, num, num0, money } from '../util/format.js';

// Catálogo de precios pre-cotización. Tabla materiales × proveedores donde
// el comprador captura proactivamente precios. Sirve para tener una base
// lista antes de que llegue la primera requisición.
//
// Filas: cada material del catálogo de la obra (escrito por materiales).
// Columnas dinámicas: cada proveedor asignado a la obra (más OPUS).
//
// Edición: inline. El input pierde foco con blur o Enter → persistir.
// Estado intermedio "dirty" para que cambios pendientes no se pierdan al
// re-renderizar.

export async function renderCatalogoPrecios({ params, query }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, catMat, { proyectoId, items: provs }, precios, globales, solicitudes] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoMateriales(obraId),
    listProveedoresObra(obraId),
    listPreciosCatalogo(obraId),
    listProveedoresGlobal(),
    listSolicitudesCotizacion(obraId)
  ]);

  if (!proyectoId) {
    renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
      h('h1', {}, 'Catálogo de precios'),
      h('div', { class: 'empty' }, [
        h('div', { class: 'ico' }, '⚠'),
        h('div', {}, 'Esta obra aún no está vinculada a un proyecto contable.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Pide al admin que vincule la obra desde la app de estimaciones para poder asignar proveedores aquí.')
      ])
    ]));
    return;
  }

  const materiales = catMat?.items || {};
  const matKeys = Object.keys(materiales);
  const IVA_PCT = 0.16;
  const conIva = (n) => (Number(n) || 0) * (1 + IVA_PCT);

  // Merge proveedores con global para mostrar nombres canónicos y régimen fiscal
  const provsConDatos = provs.map(p => mergeProveedorObraConGlobal(p, globales))
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

  // Si hay al menos un proveedor que vende +IVA (no acepta sin IVA), mostramos
  // la columna "Catálogo +IVA" para que la comparación sea justa.
  const hayProvConIva = provsConDatos.some(p => p.aceptaSinIva === false);

  // Identidad usada para path en /preciosCatalogo/{provId}: proveedor_global_id si está,
  // si no el id local de obra (mismo criterio que en cotizaciones/OCs)
  const provIdOf = (p) => p.proveedor_global_id || p.id;

  // Filtros UI
  let filtro = (query?.q || '').toLowerCase();
  let famFiltro = query?.fam || '';
  let soloIncompletos = query?.incompletos === '1';
  let provFiltro = query?.prov || '';            // provId o '' = todos
  let soloCotizados = query?.cotizados === '1';   // solo filas con al menos un precio
  let solicitudFiltro = query?.solicitud || '';   // solId del preset o '' = ninguno

  // Familias para selector
  const familias = Array.from(new Set(matKeys.map(k => materiales[k].familia || '').filter(Boolean))).sort();

  // Estado en memoria de cambios pendientes (dirty buffer). El cuerpo se
  // re-render solo cuando aplican filtros, no en cada keystroke (los inputs
  // viven con sus propios listeners).
  const dirty = new Map();  // `${provId}::${mk}` → { precio, notas, disponible }

  // === Render top ===
  const search = h('input', { type: 'search', placeholder: 'Buscar por clave o descripción…', value: filtro, style: { width: '240px' } });
  search.addEventListener('input', () => {
    filtro = search.value.trim().toLowerCase();
    renderBody();
  });

  const famSel = h('select', {}, [
    h('option', { value: '' }, 'Todas las familias'),
    ...familias.map(f => h('option', { value: f, selected: f === famFiltro }, f))
  ]);
  famSel.addEventListener('change', () => { famFiltro = famSel.value; renderBody(); });

  const incompletosCb = h('input', { type: 'checkbox', checked: soloIncompletos });
  incompletosCb.addEventListener('change', () => { soloIncompletos = incompletosCb.checked; renderBody(); });

  // Filtro por proveedor (oculta las otras columnas)
  const provFiltroSel = h('select', {}, [
    h('option', { value: '' }, 'Todos los proveedores'),
    ...provsConDatos.map(p => h('option', {
      value: provIdOf(p),
      selected: provIdOf(p) === provFiltro
    }, p.nombre + (p.aceptaSinIva ? ' (sin IVA)' : ' (+ IVA)')))
  ]);
  provFiltroSel.addEventListener('change', () => { provFiltro = provFiltroSel.value; renderBody(); });

  // Solo ya cotizados (filas con al menos un precio capturado)
  const cotizadosCb = h('input', { type: 'checkbox', checked: soloCotizados });
  cotizadosCb.addEventListener('change', () => { soloCotizados = cotizadosCb.checked; renderBody(); });

  // Filtro por preset de solicitud de cotización (muestra solo los materiales
  // que están en ese preset, útil para comparar contra los precios capturados)
  const solicitudesOrden = Object.entries(solicitudes).sort(([, a], [, b]) =>
    (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const solicitudSel = h('select', {}, [
    h('option', { value: '' }, 'Sin filtrar por solicitud'),
    ...solicitudesOrden.map(([id, s]) => {
      const n = Object.keys(s.items || {}).length;
      return h('option', { value: id, selected: id === solicitudFiltro },
        `${s.nombre || '(sin nombre)'} — ${n} item${n === 1 ? '' : 's'}`);
    })
  ]);
  solicitudSel.addEventListener('change', () => { solicitudFiltro = solicitudSel.value; renderBody(); });

  const guardarBtn = h('button', { class: 'btn primary', disabled: true }, '💾 Guardar cambios (0)');
  guardarBtn.addEventListener('click', async () => {
    if (dirty.size === 0) return;
    const u = state.user;
    const autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '' };
    const tasks = [];
    for (const [k, data] of dirty.entries()) {
      const [provId, mk] = k.split('::');
      const precio = Number(data.precio);
      if (!Number.isFinite(precio) || precio <= 0) {
        // Vacío → borrar (a menos que disponible=false explícito)
        if (data.disponible !== false) {
          tasks.push(removePrecioCatalogo(obraId, provId, mk));
          continue;
        }
      }
      tasks.push(setPrecioCatalogo(obraId, provId, mk, {
        precio: precio > 0 ? precio : 0,
        disponible: data.disponible !== false,
        notas: data.notas || '',
        capturadoPor: autor
      }));
    }
    try {
      await Promise.all(tasks);
      const n = dirty.size;
      dirty.clear();
      toast(`${n} cambio${n === 1 ? '' : 's'} guardado${n === 1 ? '' : 's'}`, 'ok');
      // Recargar para reflejar los datos nuevos y resetear inputs
      renderCatalogoPrecios({ params, query });
    } catch (err) {
      toast('Error al guardar: ' + err.message, 'danger');
    }
  });

  function updateGuardarBtn() {
    guardarBtn.disabled = dirty.size === 0;
    guardarBtn.textContent = `💾 Guardar cambios (${dirty.size})`;
  }

  const head = h('div', { class: 'row', style: { marginBottom: '14px' } }, [
    h('h1', { style: { margin: 0 } }, 'Catálogo de precios'),
    h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '12px' } },
      `${num0(matKeys.length)} materiales · ${num0(provsConDatos.length)} proveedores`),
    h('div', { style: { flex: 1 } }),
    guardarBtn
  ]);

  const solicitarBtn = h('button', { class: 'btn ghost' }, '🖨️ Solicitar cotización (filtrados)');
  solicitarBtn.addEventListener('click', () => {
    // Pasamos las claves visibles como query param para que la vista de
    // solicitud pre-seleccione esos materiales.
    const visibles = matKeys.filter(mk => {
      const m = materiales[mk];
      if (filtro && !(`${m.clave || ''} ${m.descripcion || ''} ${m.marca || ''}`.toLowerCase().includes(filtro))) return false;
      if (famFiltro && m.familia !== famFiltro) return false;
      return true;
    });
    if (visibles.length === 0) { toast('No hay materiales filtrados', 'danger'); return; }
    if (visibles.length > 100) {
      toast(`${visibles.length} es mucho. Filtra más para hacer una solicitud manejable.`, 'warn');
    }
    const q = encodeURIComponent(visibles.join(','));
    navigate(`/obras/${obraId}/solicitar-cotizacion?materiales=${q}`);
  });

  const filtros = h('div', { style: { marginBottom: '12px' } }, [
    h('div', { class: 'row', style: { gap: '10px' } }, [
      search,
      famSel,
      provFiltroSel,
      solicitudesOrden.length > 0 && solicitudSel,
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer', fontSize: '13px' } }, [
        cotizadosCb, h('span', {}, 'Solo ya cotizados')
      ]),
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer', fontSize: '13px' } }, [
        incompletosCb, h('span', {}, 'Solo incompletos')
      ]),
      h('div', { style: { flex: 1 } }),
      solicitarBtn,
      h('button', { class: 'btn ghost', onClick: () => navigate(`/obras/${obraId}/proveedores`) }, '🏷️ Gestionar proveedores')
    ])
  ]);

  // === Vacíos ===
  if (provsConDatos.length === 0) {
    renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
      head, filtros,
      h('div', { class: 'empty' }, [
        h('div', { class: 'ico' }, '🏷️'),
        h('div', {}, 'Asigna proveedores a esta obra primero.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'El catálogo de precios necesita columnas — una por cada proveedor que vas a comparar.'),
        h('button', {
          class: 'btn primary',
          style: { marginTop: '12px' },
          onClick: () => navigate(`/obras/${obraId}/proveedores`)
        }, '+ Asignar proveedores')
      ])
    ]));
    return;
  }
  if (matKeys.length === 0) {
    renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
      head, filtros,
      h('div', { class: 'empty' }, [
        h('div', { class: 'ico' }, '📦'),
        h('div', {}, 'No hay materiales cargados en el catálogo de esta obra.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'El almacenista (app de materiales) carga el XLS de OPUS con los materiales del proyecto.')
      ])
    ]));
    return;
  }

  // === Render principal ===
  const bannerEl = h('div', {});
  const tableWrap = h('div', { class: 'card', style: { padding: 0, overflow: 'auto', maxHeight: 'calc(100vh - 280px)' } });
  const sumaryEl = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } });

  function getEffectivePrecio(provId, mk) {
    const k = `${provId}::${mk}`;
    if (dirty.has(k)) return dirty.get(k);
    const entry = (precios[provId] || {})[mk];
    if (!entry) return { precio: '', disponible: true, notas: '' };
    return {
      precio: entry.disponible === false ? '' : (entry.precio || ''),
      disponible: entry.disponible !== false,
      notas: entry.notas || ''
    };
  }

  function setDirty(provId, mk, patch) {
    const k = `${provId}::${mk}`;
    const current = getEffectivePrecio(provId, mk);
    dirty.set(k, { ...current, ...patch });
    updateGuardarBtn();
  }

  function renderBody() {
    // Proveedores visibles según el filtro: si hay uno seleccionado, solo ese.
    const provsVisibles = provFiltro
      ? provsConDatos.filter(p => provIdOf(p) === provFiltro)
      : provsConDatos;
    // Si el filtro por proveedor no encuentra nada (raro), caemos a todos
    const provsParaFila = provsVisibles.length > 0 ? provsVisibles : provsConDatos;

    // Recalculamos hayProvConIva solo sobre los visibles (la columna +IVA
    // solo aparece si hace falta para los proveedores actualmente mostrados).
    const hayProvConIvaVisible = provsParaFila.some(p => p.aceptaSinIva === false);

    // Subset por solicitud rápida (preset). Construimos un set con las
    // claves del preset para filtrar abajo.
    const solicitudActiva = solicitudFiltro ? solicitudes[solicitudFiltro] : null;
    const matsDelPreset = solicitudActiva
      ? new Set(Object.keys(solicitudActiva.items || {}))
      : null;

    // Filtrar materiales
    const visibles = matKeys.filter(mk => {
      const m = materiales[mk];
      if (matsDelPreset && !matsDelPreset.has(mk)) return false;
      if (filtro && !(`${m.clave || ''} ${m.descripcion || ''} ${m.marca || ''}`.toLowerCase().includes(filtro))) return false;
      if (famFiltro && m.familia !== famFiltro) return false;
      if (soloCotizados) {
        // Filas donde el(los) proveedor(es) visible(s) tienen al menos un
        // precio capturado. Si hay filtro por proveedor, solo cuenta ese.
        const algunoTiene = provsParaFila.some(p => {
          const pid = provIdOf(p);
          const eff = getEffectivePrecio(pid, mk);
          return Number(eff.precio) > 0;
        });
        if (!algunoTiene) return false;
      }
      if (soloIncompletos) {
        // Incompleto si algún proveedor visible no tiene precio (ni marcado no-disp)
        const incomp = provsParaFila.some(p => {
          const pid = provIdOf(p);
          const eff = getEffectivePrecio(pid, mk);
          return !eff.precio && eff.disponible !== false;
        });
        if (!incomp) return false;
      }
      return true;
    }).sort((a, b) => (materiales[a].clave || '').localeCompare(materiales[b].clave || ''));

    const detalleFiltros = [];
    if (provFiltro) {
      const pName = provsConDatos.find(p => provIdOf(p) === provFiltro)?.nombre || '';
      detalleFiltros.push(`proveedor: ${pName}`);
    }
    if (solicitudActiva) {
      detalleFiltros.push(`solicitud: ${solicitudActiva.nombre || solicitudFiltro.slice(0, 6)}`);
    }
    if (soloCotizados) detalleFiltros.push('solo cotizados');
    if (soloIncompletos) detalleFiltros.push('solo incompletos');
    const sufijo = detalleFiltros.length > 0 ? ` · filtros: ${detalleFiltros.join(', ')}` : '';
    sumaryEl.textContent = `Mostrando ${num0(visibles.length)} de ${num0(matKeys.length)} materiales${sufijo}.`;

    // Banner contextual cuando hay solicitud filtrada
    bannerEl.innerHTML = '';
    if (solicitudActiva) {
      const totalItems = Object.keys(solicitudActiva.items || {}).length;
      const matsExistentes = visibles.length;
      const matsNoEnCatalogo = totalItems - matsExistentes;
      bannerEl.appendChild(h('div', {
        style: {
          padding: '10px 14px', marginBottom: '10px',
          background: 'rgba(106, 169, 255, 0.07)',
          border: '1px solid rgba(106, 169, 255, 0.3)',
          borderRadius: '6px', fontSize: '12px',
          display: 'flex', alignItems: 'center', gap: '10px'
        }
      }, [
        h('span', { style: { fontSize: '14px' } }, '📁'),
        h('span', { style: { flex: 1 } }, [
          'Mostrando solo los ',
          h('b', {}, num0(totalItems)),
          ` materiales de la solicitud "${solicitudActiva.nombre || 'sin nombre'}"`,
          matsNoEnCatalogo > 0
            ? h('span', { class: 'muted' },
              ` · ${num0(matsNoEnCatalogo)} no aparecen porque ya no están en el catálogo`)
            : null
        ]),
        h('a', {
          href: `#/obras/${obraId}/solicitar-cotizacion?solicitud=${solicitudFiltro}`,
          style: { fontSize: '12px' }
        }, 'Ver / editar solicitud →')
      ]));
    }

    // Header
    const thead = h('thead', {}, h('tr', {}, [
      h('th', { style: { minWidth: '320px', position: 'sticky', left: 0, background: 'var(--bg-2)', zIndex: 2 } }, 'Material'),
      h('th', { style: { minWidth: '70px' } }, 'Unidad'),
      h('th', { class: 'num', style: { minWidth: '110px' } }, [
        h('div', {}, 'Catálogo OPUS'),
        h('div', { class: 'muted', style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0 } }, 'sin IVA')
      ]),
      hayProvConIvaVisible && h('th', { class: 'num', style: { minWidth: '110px' } }, [
        h('div', {}, 'Catálogo +IVA'),
        h('div', { class: 'muted', style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0 } }, `con ${(IVA_PCT * 100).toFixed(0)}% IVA`)
      ]),
      ...provsParaFila.map(p => h('th', {
        class: 'num',
        style: { minWidth: '130px' },
        title: p.nombre + (p.aceptaSinIva ? ' · acepta sin IVA' : ' · siempre con IVA')
      }, [
        h('div', {}, (p.nombre || '').slice(0, 18)),
        h('div', { style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0 } }, [
          p.aceptaSinIva
            ? h('span', { style: { color: 'var(--ok)' } }, 'sin IVA')
            : h('span', { style: { color: 'var(--warn)' } }, '+ IVA')
        ])
      ]))
    ]));

    const tbody = h('tbody', {});
    const cap = 400;   // cap defensivo
    for (const mk of visibles.slice(0, cap)) {
      tbody.appendChild(matRow(mk, provsParaFila, hayProvConIvaVisible));
    }
    if (visibles.length > cap) {
      tbody.appendChild(h('tr', {}, h('td', {
        colSpan: 3 + provsParaFila.length + (hayProvConIvaVisible ? 1 : 0),
        class: 'muted',
        style: { textAlign: 'center', padding: '12px', fontSize: '12px' }
      }, `Mostrando primeros ${cap}. Usa los filtros para acotar.`)));
    }

    const tbl = h('table', { class: 'tbl', style: { minWidth: '100%' } }, [thead, tbody]);
    tableWrap.innerHTML = '';
    tableWrap.appendChild(tbl);
  }

  function matRow(mk, provsParaFila, hayProvConIvaVisible) {
    const m = materiales[mk];
    const opusPrecio = Number(m.costoUnitario) || 0;
    const opusConIva = conIva(opusPrecio);

    // Mejor normalizado calculado solo sobre los proveedores visibles
    let mejorNormalizado = Infinity;
    for (const p of provsParaFila) {
      const pid = provIdOf(p);
      const eff = getEffectivePrecio(pid, mk);
      const v = Number(eff.precio) || 0;
      if (eff.disponible === false || v <= 0) continue;
      const norm = p.aceptaSinIva ? v : (v / (1 + IVA_PCT));
      if (norm < mejorNormalizado) mejorNormalizado = norm;
    }

    const tr = h('tr', {});
    tr.appendChild(h('td', {
      style: { maxWidth: '320px', position: 'sticky', left: 0, background: 'var(--bg-1)', zIndex: 1 }
    }, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave || mk.slice(0, 10)),
      h('div', { style: { fontSize: '13px' } }, (m.descripcion || '').slice(0, 60) + ((m.descripcion || '').length > 60 ? '…' : '')),
      m.familia && h('div', { class: 'muted', style: { fontSize: '10px' } }, m.familia)
    ]));
    tr.appendChild(h('td', { class: 'muted', style: { fontSize: '12px' } }, m.unidad || '—'));
    tr.appendChild(h('td', { class: 'num muted' }, opusPrecio > 0 ? money(opusPrecio) : '—'));
    if (hayProvConIvaVisible) {
      tr.appendChild(h('td', { class: 'num muted', style: { fontStyle: 'italic' } },
        opusPrecio > 0 ? money(opusConIva) : '—'));
    }

    for (const p of provsParaFila) {
      const pid = provIdOf(p);
      const refPrecio = p.aceptaSinIva ? opusPrecio : opusConIva;
      tr.appendChild(precioCell(p, pid, mk, refPrecio, mejorNormalizado));
    }
    return tr;
  }

  function precioCell(p, provId, mk, refPrecio, mejorNormalizado) {
    const eff = getEffectivePrecio(provId, mk);
    const valor = eff.precio;
    const noDisp = eff.disponible === false;

    const input = h('input', {
      type: 'number',
      step: '0.01',
      min: '0',
      value: valor === '' ? '' : String(valor),
      placeholder: noDisp ? '— no maneja —' : '$',
      style: {
        width: '100px',
        textAlign: 'right',
        fontFamily: 'var(--mono)',
        background: noDisp ? 'rgba(108, 115, 132, 0.15)' : 'var(--bg-1)'
      }
    });

    // Color según comparación contra el catálogo CORRECTO para este proveedor
    // (OPUS si acepta sin IVA, OPUS+IVA si no). El "mejor de fila" se mide
    // sobre precios normalizados sin IVA.
    function colorize() {
      const v = Number(input.value) || 0;
      if (!v || noDisp) {
        input.style.color = noDisp ? 'var(--text-2)' : 'var(--text-0)';
        input.style.borderColor = 'var(--border)';
        return;
      }
      const norm = p.aceptaSinIva ? v : (v / (1 + IVA_PCT));
      const esMejor = mejorNormalizado < Infinity && Math.abs(norm - mejorNormalizado) < 0.005;
      if (esMejor) {
        input.style.color = 'var(--ok)';
        input.style.borderColor = 'rgba(93, 211, 158, 0.4)';
      } else if (refPrecio > 0 && v < refPrecio) {
        input.style.color = 'var(--ok)';
        input.style.borderColor = 'var(--border)';
      } else if (refPrecio > 0 && v > refPrecio) {
        input.style.color = 'var(--danger)';
        input.style.borderColor = 'var(--border)';
      } else {
        input.style.color = 'var(--text-0)';
        input.style.borderColor = 'var(--border)';
      }
    }
    colorize();

    input.addEventListener('input', () => {
      setDirty(provId, mk, { precio: input.value, disponible: input.value !== '' });
      colorize();
    });
    input.addEventListener('blur', colorize);

    // Tooltip con detalles fiscales
    input.title = p.aceptaSinIva
      ? `Comparado contra catálogo OPUS ${refPrecio > 0 ? '($' + refPrecio.toFixed(2) + ')' : ''}`
      : `Comparado contra catálogo OPUS +IVA ${refPrecio > 0 ? '($' + refPrecio.toFixed(2) + ')' : ''} · proveedor solo factura`;

    // Botón pequeño para marcar "no maneja este material" (toggle disponible)
    const toggleBtn = h('button', {
      type: 'button',
      style: {
        padding: '0 4px', fontSize: '10px', marginLeft: '2px',
        background: 'transparent', border: 'none', color: 'var(--text-2)',
        cursor: 'pointer'
      },
      title: noDisp ? 'Marcar como disponible (volver a cotizar)' : 'Marcar como "no maneja este material"'
    }, noDisp ? '↺' : '⊘');
    toggleBtn.addEventListener('click', () => {
      const newNoDisp = !noDisp;
      if (newNoDisp) {
        input.value = '';
      }
      setDirty(provId, mk, { precio: '', disponible: !newNoDisp });
      const newCell = precioCell(p, provId, mk, refPrecio, mejorNormalizado);
      td.replaceWith(newCell);
    });

    const td = h('td', { class: 'num', style: { padding: '4px 6px' } },
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '0' } }, [input, toggleBtn]));
    return td;
  }

  renderBody();
  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, filtros, bannerEl, tableWrap, sumaryEl]));
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Catálogo de precios' }
  ];
}
