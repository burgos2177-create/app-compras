import { h, toast, modal } from '../util/dom.js?v=20260620';
import { renderShell } from './shell.js?v=20260620';
import { state, setState } from '../state/store.js?v=20260620';
import {
  getObraMetaLegacy,
  loadCatalogoMateriales,
  listProveedoresObra,
  listPreciosCatalogo,
  setPrecioCatalogo, removePrecioCatalogo,
  listProveedoresGlobal, mergeProveedorObraConGlobal,
  listSolicitudesCotizacion
} from '../services/db.js?v=20260620';
import { navigate } from '../state/router.js?v=20260620';
import { dateMx, num, num0, money } from '../util/format.js?v=20260620';
import { exportCatalogoComparativaPdf, exportCatalogoComparativaXlsx, exportMaterialesOpusXlsx } from '../services/subcontrato-export.js?v=20260620';

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

  // Columnas (proveedores) ocultas en esta vista. Se persisten por obra para
  // que la "vista configurada" sobreviva recargas. Afecta tabla, filtros y PDF.
  const HIDDEN_KEY = `compras:catalogo-cols:${obraId}`;
  const hiddenProvs = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
    const validos = new Set(provsConDatos.map(p => provIdOf(p)));
    if (Array.isArray(saved)) saved.forEach(id => { if (validos.has(id)) hiddenProvs.add(id); });
  } catch { /* localStorage no disponible o JSON inválido: arrancamos sin ocultar */ }
  function persistHidden() {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenProvs])); } catch { /* ignore */ }
  }

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
    }, p.nombre))
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
        sinIva: data.sinIva === true,   // celda marcada "considerar sin IVA" (sin factura)
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

  // Botón "Proveedores activos": deja activos solo los proveedores que van al
  // caso. Los inactivos se ocultan de la tabla, los filtros y la comparativa.
  const colsBtnLabel = () =>
    `👥 Proveedores activos (${provsConDatos.length - hiddenProvs.size}/${provsConDatos.length})`;
  const colsBtn = h('button', { class: 'btn ghost' }, colsBtnLabel());
  colsBtn.addEventListener('click', async () => {
    const checks = provsConDatos.map(p => {
      const pid = provIdOf(p);
      const cb = h('input', { type: 'checkbox', checked: !hiddenProvs.has(pid) });
      return {
        pid, cb,
        el: h('label', { class: 'row', style: { gap: '8px', padding: '4px 0', cursor: 'pointer' } }, [
          cb, h('span', {}, p.nombre || '')
        ])
      };
    });
    const body = h('div', {}, [
      h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
        'Deja activos solo los proveedores que entran a la comparación. Los inactivos se ocultan de la tabla, los filtros y la comparativa.'),
      h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } }, [
        h('button', { class: 'btn sm ghost', type: 'button', onClick: () => checks.forEach(c => { c.cb.checked = true; }) }, 'Todos'),
        h('button', { class: 'btn sm ghost', type: 'button', onClick: () => checks.forEach(c => { c.cb.checked = false; }) }, 'Ninguno')
      ]),
      ...checks.map(c => c.el)
    ]);
    const ok = await modal({ title: 'Proveedores activos', body, confirmLabel: 'Aplicar' });
    if (!ok) return;
    hiddenProvs.clear();
    checks.forEach(c => { if (!c.cb.checked) hiddenProvs.add(c.pid); });
    persistHidden();
    colsBtn.textContent = colsBtnLabel();
    renderBody();
  });

  // Construye el payload de la comparativa: los materiales visibles (los de la
  // solicitud cuando hay una seleccionada) × los proveedores activos, con las
  // cantidades estimadas de la solicitud. Devuelve null y avisa si no hay datos.
  function buildComparativaPayload() {
    const { provsParaFila, solicitudActiva, visibles, detalleFiltros } = computeView();
    if (visibles.length === 0) { toast('No hay materiales en la vista actual', 'danger'); return null; }
    if (provsParaFila.length === 0) { toast('No hay proveedores activos', 'danger'); return null; }
    if (dirty.size > 0) toast('La comparativa usa los valores en pantalla (incluye cambios sin guardar)', 'warn');
    const items = solicitudActiva?.items || {};
    const cap = 1000;
    const rows = visibles.slice(0, cap).map(mk => {
      const mm = materiales[mk];
      return {
        clave: mm.clave || mk.slice(0, 10),
        descripcion: mm.descripcion || '',
        unidad: mm.unidad || '',
        familia: mm.familia || '',
        opus: Number(mm.costoUnitario) || 0,
        cantidad: Number(items[mk]?.cantidad) || 0,
        precios: provsParaFila.map(p => {
          const eff = getEffectivePrecio(provIdOf(p), mk);
          return { valor: Number(eff.precio) || 0, disponible: eff.disponible !== false, sinIva: eff.sinIva === true };
        })
      };
    });
    return {
      provs: provsParaFila.map(p => ({ nombre: p.nombre })),
      rows,
      iva: IVA_PCT,
      solicitudNombre: solicitudActiva?.nombre || '',
      filtrosDesc: detalleFiltros.join(', ')
    };
  }

  function exportarComparativa(kind) {
    const payload = buildComparativaPayload();
    if (!payload) return;
    if (kind === 'pdf') exportCatalogoComparativaPdf({ meta }, payload);
    else exportCatalogoComparativaXlsx({ meta }, payload);
  }

  // Export a OPUS (Herramientas OLE → De Excel a OPUS): reconstruye costos de
  // materiales con los precios capturados. OPUS empareja por Clave + Unidad, y
  // cada material lleva UN solo costo, por eso abrimos un cuadro para elegir,
  // por material, qué proveedor usar cuando hay más de uno.
  async function opusExportFlow() {
    const { provsParaFila, visibles } = computeView();
    if (visibles.length === 0) { toast('No hay materiales en la vista actual', 'danger'); return; }

    const mats = [];
    let sinPrecio = 0;
    for (const mk of visibles) {
      const m = materiales[mk];
      const opts = [];
      for (const p of provsParaFila) {
        const eff = getEffectivePrecio(provIdOf(p), mk);
        const raw = Number(eff.precio) || 0;
        if (eff.disponible === false || raw <= 0) continue;
        opts.push({ pid: provIdOf(p), nombre: p.nombre, raw, sinIva: eff.sinIva === true, base: eff.sinIva ? raw : raw / (1 + IVA_PCT) });
      }
      if (!opts.length) { sinPrecio++; continue; }
      opts.sort((a, b) => a.base - b.base);   // más barato primero (default)
      mats.push({ mk, m, opts, _inc: null, _radios: null });
    }
    if (!mats.length) { toast('Ningún material visible tiene precio en los proveedores activos', 'danger'); return; }

    // Selector de base: por defecto "tal cual" (con IVA) porque OPUS suele
    // recibir el costo capturado; opción sin IVA (efectivo) si se prefiere.
    const basisConIva = h('input', { type: 'radio', name: 'opx-basis', checked: true });
    const basisSinIva = h('input', { type: 'radio', name: 'opx-basis' });
    const labelStyle = { display: 'inline-flex', gap: '5px', alignItems: 'center', cursor: 'pointer', fontSize: '12px' };

    const prefSel = h('select', { style: { fontSize: '12px' } }, [
      h('option', { value: '' }, 'Preferir proveedor…'),
      ...provsParaFila.map(p => h('option', { value: provIdOf(p) }, p.nombre))
    ]);

    const lista = h('div', {});
    mats.forEach(mat => {
      const inc = h('input', { type: 'checkbox', checked: true });
      mat._inc = inc;
      const radios = mat.opts.map(o => {
        const r = h('input', { type: 'radio', name: `opx-${mat.mk}`, checked: o.pid === mat.opts[0].pid });
        return {
          o, r,
          el: h('label', { style: { ...labelStyle, marginRight: '12px' } }, [
            r, h('span', {}, `${o.nombre}: ${money(o.raw)}${o.sinIva ? ' (s/IVA)' : ''}`)
          ])
        };
      });
      mat._radios = radios;
      lista.appendChild(h('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--border)' } }, [
        h('label', { style: { ...labelStyle, fontSize: '13px' } }, [
          inc,
          h('span', {}, [
            h('b', { class: 'mono', style: { fontSize: '11px' } }, mat.m.clave || mat.mk.slice(0, 10)),
            ' ', (mat.m.descripcion || '').slice(0, 55),
            h('span', { class: 'muted' }, ` (${mat.m.unidad || '—'})`)
          ])
        ]),
        mat.opts.length > 1
          ? h('div', { style: { marginLeft: '22px', marginTop: '4px', display: 'flex', flexWrap: 'wrap' } }, radios.map(x => x.el))
          : h('div', { style: { marginLeft: '22px', marginTop: '2px', fontSize: '12px', color: 'var(--text-2)' } },
            `${mat.opts[0].nombre}: ${money(mat.opts[0].raw)}${mat.opts[0].sinIva ? ' (s/IVA)' : ''}`)
      ]));
    });

    prefSel.addEventListener('change', () => {
      const pid = prefSel.value;
      if (!pid) return;
      mats.forEach(mat => {
        const idx = mat._radios.findIndex(x => x.o.pid === pid);
        if (idx >= 0) mat._radios.forEach((x, i) => { x.r.checked = i === idx; });
      });
    });

    const body = h('div', {}, [
      h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' } }, [
        'OPUS empareja por ', h('b', {}, 'Clave + Unidad'), '. Se genera una fila por material con el precio del proveedor elegido. ',
        sinPrecio > 0 ? h('span', {}, `${num0(sinPrecio)} material(es) sin precio se omiten.`) : null
      ]),
      h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', marginBottom: '8px', alignItems: 'center' } }, [
        h('span', { style: { fontSize: '12px', fontWeight: 600 } }, 'Costo base:'),
        h('label', { style: labelStyle }, [basisConIva, h('span', {}, 'Tal como se capturó (con IVA)')]),
        h('label', { style: labelStyle }, [basisSinIva, h('span', {}, 'Sin IVA (efectivo ÷1.16)')])
      ]),
      h('div', { class: 'row', style: { gap: '10px', marginBottom: '6px', alignItems: 'center' } }, [
        h('button', { class: 'btn sm ghost', type: 'button', onClick: () => mats.forEach(x => { x._inc.checked = true; }) }, 'Incluir todos'),
        h('button', { class: 'btn sm ghost', type: 'button', onClick: () => mats.forEach(x => { x._inc.checked = false; }) }, 'Ninguno'),
        prefSel
      ]),
      h('div', { style: { maxHeight: '50vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px', padding: '0 12px' } }, lista)
    ]);

    const ok = await modal({ title: `Exportar a OPUS (${num0(mats.length)} materiales)`, body, confirmLabel: 'Exportar XLSX', size: 'lg' });
    if (!ok) return;

    const useSinIva = basisSinIva.checked;
    const items = [];
    for (const mat of mats) {
      if (!mat._inc.checked) continue;
      const chosen = (mat._radios.find(x => x.r.checked) || mat._radios[0]).o;
      const costo = useSinIva ? chosen.base : chosen.raw;
      items.push({
        clave: mat.m.clave || mat.mk,
        descripcion: mat.m.descripcion || '',
        unidad: mat.m.unidad || '',
        familia: mat.m.familia || '',
        costo: Math.round(costo * 100) / 100
      });
    }
    if (!items.length) { toast('No seleccionaste materiales', 'warn'); return; }
    exportMaterialesOpusXlsx(items);
    toast(`${items.length} material(es) exportados a formato OPUS`, 'ok');
  }

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
      colsBtn,
      h('button', { class: 'btn ghost', title: 'Exportar el catálogo (vista actual) al formato de OPUS: Herramientas OLE → De Excel a OPUS', onClick: () => opusExportFlow() }, '⤓ OPUS materiales'),
      solicitarBtn,
      h('button', { class: 'btn ghost', onClick: () => navigate(`/obras/${obraId}/proveedores`) }, '🏷️ Gestionar proveedores')
    ]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
      'Los precios se capturan CON IVA por defecto. Si una celda en particular sale sin factura, usa el botón "iva" junto al precio para marcarla SIN IVA (se vuelve s/IVA en ámbar).')
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
    if (!entry) return { precio: '', disponible: true, notas: '', sinIva: false };
    return {
      precio: entry.disponible === false ? '' : (entry.precio || ''),
      disponible: entry.disponible !== false,
      sinIva: entry.sinIva === true,
      notas: entry.notas || ''
    };
  }

  function setDirty(provId, mk, patch) {
    const k = `${provId}::${mk}`;
    const current = getEffectivePrecio(provId, mk);
    dirty.set(k, { ...current, ...patch });
    updateGuardarBtn();
  }

  // Proveedores visibles: si hay filtro por uno solo manda ese; si no, todos
  // menos los ocultados manualmente (con fallback a todos si se ocultaron todos).
  function visibleProvs() {
    if (provFiltro) {
      const only = provsConDatos.filter(p => provIdOf(p) === provFiltro);
      if (only.length) return only;
    }
    const shown = provsConDatos.filter(p => !hiddenProvs.has(provIdOf(p)));
    return shown.length ? shown : provsConDatos;
  }

  // Calcula proveedores y materiales visibles + descripción de filtros. Lo usan
  // tanto el render de la tabla como la exportación a PDF (misma vista exacta).
  function computeView() {
    const provsParaFila = visibleProvs();
    const solicitudActiva = solicitudFiltro ? solicitudes[solicitudFiltro] : null;
    const matsDelPreset = solicitudActiva ? new Set(Object.keys(solicitudActiva.items || {})) : null;

    const visibles = matKeys.filter(mk => {
      const m = materiales[mk];
      if (matsDelPreset && !matsDelPreset.has(mk)) return false;
      if (filtro && !(`${m.clave || ''} ${m.descripcion || ''} ${m.marca || ''}`.toLowerCase().includes(filtro))) return false;
      if (famFiltro && m.familia !== famFiltro) return false;
      if (soloCotizados) {
        const algunoTiene = provsParaFila.some(p => Number(getEffectivePrecio(provIdOf(p), mk).precio) > 0);
        if (!algunoTiene) return false;
      }
      if (soloIncompletos) {
        const incomp = provsParaFila.some(p => {
          const eff = getEffectivePrecio(provIdOf(p), mk);
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
    } else if (hiddenProvs.size > 0) {
      detalleFiltros.push(`${provsParaFila.length} de ${provsConDatos.length} proveedores`);
    }
    if (solicitudActiva) detalleFiltros.push(`solicitud: ${solicitudActiva.nombre || solicitudFiltro.slice(0, 6)}`);
    if (soloCotizados) detalleFiltros.push('solo cotizados');
    if (soloIncompletos) detalleFiltros.push('solo incompletos');

    return { provsParaFila, solicitudActiva, visibles, detalleFiltros };
  }

  function renderBody() {
    const { provsParaFila, solicitudActiva, visibles, detalleFiltros } = computeView();

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
          ` · comparando ${num0(provsParaFila.length)} proveedor${provsParaFila.length === 1 ? '' : 'es'} activo${provsParaFila.length === 1 ? '' : 's'}`,
          matsNoEnCatalogo > 0
            ? h('span', { class: 'muted' },
              ` · ${num0(matsNoEnCatalogo)} no aparecen porque ya no están en el catálogo`)
            : null
        ]),
        h('button', {
          class: 'btn sm primary',
          title: 'Comparativa ejecutiva en PDF: ranking de proveedores y total estimado para esta solicitud',
          onClick: () => exportarComparativa('pdf')
        }, '📄 PDF ejecutiva'),
        h('button', {
          class: 'btn sm ghost',
          title: 'Comparativa en hoja de cálculo (XLSX) de los materiales de esta solicitud',
          onClick: () => exportarComparativa('xlsx')
        }, '⬇ XLSX'),
        h('a', {
          href: `#/obras/${obraId}/solicitar-cotizacion?solicitud=${solicitudFiltro}`,
          style: { fontSize: '12px' }
        }, 'Ver / editar solicitud →')
      ]));
    }

    // Header. Los precios se capturan CON IVA por defecto; ambas referencias
    // OPUS (sin IVA y +IVA) se muestran siempre porque cada celda puede ser una
    // u otra (botón "IVA" por celda).
    const thead = h('thead', {}, h('tr', {}, [
      h('th', { style: { minWidth: '320px', position: 'sticky', left: 0, background: 'var(--bg-2)', zIndex: 2 } }, 'Material'),
      h('th', { style: { minWidth: '70px' } }, 'Unidad'),
      h('th', { class: 'num', style: { minWidth: '110px' } }, [
        h('div', {}, 'Catálogo OPUS'),
        h('div', { class: 'muted', style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0 } }, 'sin IVA')
      ]),
      h('th', { class: 'num', style: { minWidth: '110px' } }, [
        h('div', {}, 'Catálogo +IVA'),
        h('div', { class: 'muted', style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0 } }, `con ${(IVA_PCT * 100).toFixed(0)}% IVA`)
      ]),
      ...provsParaFila.map(p => h('th', {
        class: 'num',
        style: { minWidth: '130px' },
        title: p.nombre
      }, [
        h('div', {}, (p.nombre || '').slice(0, 18)),
        h('div', { class: 'muted', style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0 } }, 'con IVA')
      ]))
    ]));

    const tbody = h('tbody', {});
    const cap = 400;   // cap defensivo
    for (const mk of visibles.slice(0, cap)) {
      tbody.appendChild(matRow(mk, provsParaFila));
    }
    if (visibles.length > cap) {
      tbody.appendChild(h('tr', {}, h('td', {
        colSpan: 4 + provsParaFila.length,
        class: 'muted',
        style: { textAlign: 'center', padding: '12px', fontSize: '12px' }
      }, `Mostrando primeros ${cap}. Usa los filtros para acotar.`)));
    }

    const tbl = h('table', { class: 'tbl', style: { minWidth: '100%' } }, [thead, tbody]);
    tableWrap.innerHTML = '';
    tableWrap.appendChild(tbl);
  }

  function matRow(mk, provsParaFila) {
    const m = materiales[mk];
    const opusPrecio = Number(m.costoUnitario) || 0;
    const opusConIva = conIva(opusPrecio);

    // Mejor costo efectivo de la fila (acreditando IVA). Por celda: si está
    // marcada "sin IVA" el costo efectivo es el monto completo; si es "con IVA"
    // (default) el efectivo es monto/1.16.
    let mejorEfectivo = Infinity;
    for (const p of provsParaFila) {
      const eff = getEffectivePrecio(provIdOf(p), mk);
      const v = Number(eff.precio) || 0;
      if (eff.disponible === false || v <= 0) continue;
      const efectivo = eff.sinIva ? v : (v / (1 + IVA_PCT));
      if (efectivo < mejorEfectivo) mejorEfectivo = efectivo;
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
    tr.appendChild(h('td', { class: 'num muted', style: { fontStyle: 'italic' } },
      opusPrecio > 0 ? money(opusConIva) : '—'));

    for (const p of provsParaFila) {
      tr.appendChild(precioCell(p, provIdOf(p), mk, opusPrecio, opusConIva, mejorEfectivo));
    }
    return tr;
  }

  function precioCell(p, provId, mk, opusPrecio, opusConIva, mejorEfectivo) {
    const eff = getEffectivePrecio(provId, mk);
    const valor = eff.precio;
    const noDisp = eff.disponible === false;
    const sinIva = eff.sinIva === true;
    // Referencia OPUS según el régimen de la celda: sin IVA → OPUS sin IVA;
    // con IVA (default) → OPUS +IVA (el monto capturado ya trae IVA).
    const refPrecio = sinIva ? opusPrecio : opusConIva;

    const input = h('input', {
      type: 'number',
      step: '0.01',
      min: '0',
      value: valor === '' ? '' : String(valor),
      placeholder: noDisp ? '— no maneja —' : '$',
      style: {
        width: '92px',
        textAlign: 'right',
        fontFamily: 'var(--mono)',
        background: noDisp ? 'rgba(108, 115, 132, 0.15)' : 'var(--bg-1)'
      }
    });

    // Color contra la referencia OPUS correcta de la celda. El "mejor de fila"
    // se mide sobre el costo efectivo (acreditando IVA en las celdas con IVA).
    function colorize() {
      const v = Number(input.value) || 0;
      if (!v || noDisp) {
        input.style.color = noDisp ? 'var(--text-2)' : 'var(--text-0)';
        input.style.borderColor = sinIva ? 'rgba(245, 196, 81, 0.5)' : 'var(--border)';
        return;
      }
      const efectivo = sinIva ? v : (v / (1 + IVA_PCT));
      const esMejor = mejorEfectivo < Infinity && Math.abs(efectivo - mejorEfectivo) < 0.005;
      if (esMejor) {
        input.style.color = 'var(--ok)';
        input.style.borderColor = 'rgba(93, 211, 158, 0.4)';
      } else if (refPrecio > 0 && v < refPrecio) {
        input.style.color = 'var(--ok)';
        input.style.borderColor = sinIva ? 'rgba(245, 196, 81, 0.5)' : 'var(--border)';
      } else if (refPrecio > 0 && v > refPrecio) {
        input.style.color = 'var(--danger)';
        input.style.borderColor = sinIva ? 'rgba(245, 196, 81, 0.5)' : 'var(--border)';
      } else {
        input.style.color = 'var(--text-0)';
        input.style.borderColor = sinIva ? 'rgba(245, 196, 81, 0.5)' : 'var(--border)';
      }
    }
    colorize();

    input.addEventListener('input', () => {
      setDirty(provId, mk, { precio: input.value, disponible: input.value !== '' });
      colorize();
    });
    input.addEventListener('blur', colorize);

    const v = Number(input.value) || 0;
    input.title = sinIva
      ? `SIN IVA (sin factura, no se acredita) · costo efectivo $${v.toFixed(2)} · ref. OPUS sin IVA${refPrecio > 0 ? ' ($' + refPrecio.toFixed(2) + ')' : ''}`
      : `CON IVA (se acredita) · costo efectivo $${(v / (1 + IVA_PCT)).toFixed(2)} · ref. OPUS +IVA${refPrecio > 0 ? ' ($' + refPrecio.toFixed(2) + ')' : ''}`;

    // Botón chico "considerar SIN IVA" para esta celda (toggle, default = con IVA).
    const ivaBtn = !noDisp && h('button', {
      type: 'button',
      style: {
        padding: '0 4px', fontSize: '9px', marginLeft: '2px',
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: sinIva ? 'var(--warn)' : 'var(--text-2)',
        fontWeight: sinIva ? '700' : '400'
      },
      title: sinIva ? 'Quitar: volver a CON IVA (se acredita)' : 'Considerar esta celda SIN IVA (sin factura, no se acredita)'
    }, sinIva ? 's/IVA' : 'iva');
    if (ivaBtn) ivaBtn.addEventListener('click', () => {
      setDirty(provId, mk, { sinIva: !sinIva });
      td.replaceWith(precioCell(p, provId, mk, opusPrecio, opusConIva, mejorEfectivo));
    });

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
      if (newNoDisp) input.value = '';
      setDirty(provId, mk, { precio: '', disponible: !newNoDisp });
      td.replaceWith(precioCell(p, provId, mk, opusPrecio, opusConIva, mejorEfectivo));
    });

    const td = h('td', { class: 'num', style: { padding: '4px 6px' } },
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '0', alignItems: 'center' } }, [input, ivaBtn, toggleBtn]));
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
