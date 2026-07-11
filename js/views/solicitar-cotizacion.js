import { h, toast, modal } from '../util/dom.js?v=20260711j';
import { renderShell } from './shell.js?v=20260711j';
import { state, setState } from '../state/store.js?v=20260711j';
import {
  getObraMetaLegacy,
  loadCatalogoMateriales,
  listProveedoresObra,
  listProveedoresGlobal, mergeProveedorObraConGlobal,
  listSolicitudesCotizacion, getSolicitudCotizacion,
  createSolicitudCotizacion, updateSolicitudCotizacion,
  deleteSolicitudCotizacion
} from '../services/db.js?v=20260711j';
import { navigate } from '../state/router.js?v=20260711j';
import { dateMx, num0 } from '../util/format.js?v=20260711j';
import { abrirSolicitudPDF } from '../services/solicitud-pdf.js?v=20260711j';

// Generador de listas de "solicitud de cotización" para mandar rápido a una
// casa de materiales. No persiste nada — es un PDF utilitario para obtener
// precios de referencia. Las cotizaciones formales (que sí cuentan para el
// flujo de OC) viven aparte.
//
// Flujo:
//   1. Filtros + búsqueda sobre el catálogo de la obra.
//   2. Selección por checkbox (con "seleccionar todos los filtrados").
//   3. Panel lateral con los seleccionados y cantidad opcional por item.
//   4. Datos del destinatario (de la lista de obra o nombre libre).
//   5. Notas/observaciones.
//   6. "🖨️ Generar PDF" abre nueva ventana con HTML formateado y dispara print.

// Si llega ?materiales=k1,k2,k3 los pre-selecciona (atajo desde catálogo-precios).
// Si llega ?solicitud=X carga ese preset guardado y permite editar/regenerar.
export async function renderSolicitarCotizacion({ params, query }) {
  const obraId = params.id;
  const solIdParam = query?.solicitud || null;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, catMat, { items: provObra }, globales, preset] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoMateriales(obraId),
    listProveedoresObra(obraId),
    listProveedoresGlobal(),
    solIdParam ? getSolicitudCotizacion(obraId, solIdParam) : null
  ]);

  const materiales = catMat?.items || {};
  const matKeys = Object.keys(materiales);
  const provsObra = (provObra || []).map(p => mergeProveedorObraConGlobal(p, globales))
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

  if (matKeys.length === 0) {
    renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
      h('h1', {}, 'Solicitar cotización'),
      h('div', { class: 'empty' }, [
        h('div', { class: 'ico' }, '📦'),
        h('div', {}, 'No hay materiales en el catálogo de esta obra.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'El almacenista carga el XLS de OPUS desde la app de materiales.')
      ])
    ]));
    return;
  }

  // === Estado de la sesión ===
  const selected = new Map();   // matKey → { cantidad: '', notasItem: '' }
  let solId = solIdParam;       // null si es nueva; string si está editando
  let nombrePreset = preset?.nombre || '';

  // Si hay preset cargado, sembramos selected con sus items y guardamos
  // defaults de destinatario/términos para precargarlos abajo.
  let presetDest = preset?.destinatario || null;
  let presetTerminos = preset?.terminos || null;

  if (preset?.items) {
    for (const [mk, sel] of Object.entries(preset.items)) {
      if (!materiales[mk]) continue;  // skip si el material ya no existe
      selected.set(mk, { cantidad: sel.cantidad || '', notasItem: sel.notasItem || '' });
    }
  } else if (query?.materiales) {
    // Pre-selección desde catálogo-precios
    for (const mk of query.materiales.split(',').map(s => s.trim()).filter(Boolean)) {
      if (materiales[mk]) selected.set(mk, { cantidad: '', notasItem: '' });
    }
  }

  let filtro = '';
  let famFiltro = '';
  let marcaFiltro = '';

  const familias = Array.from(new Set(matKeys.map(k => materiales[k].familia || '').filter(Boolean))).sort();
  const marcas = Array.from(new Set(matKeys.map(k => materiales[k].marca || '').filter(Boolean))).sort();

  // === UI: izquierda (tabla) ===
  const search = h('input', { type: 'search', placeholder: 'Buscar por clave o descripción…', style: { flex: '1', minWidth: '200px' } });
  search.addEventListener('input', () => { filtro = search.value.trim().toLowerCase(); renderTabla(); });

  const famSel = h('select', {}, [
    h('option', { value: '' }, 'Todas las familias'),
    ...familias.map(f => h('option', { value: f }, f))
  ]);
  famSel.addEventListener('change', () => { famFiltro = famSel.value; renderTabla(); });

  const marcaSel = h('select', {}, [
    h('option', { value: '' }, 'Todas las marcas'),
    ...marcas.map(m => h('option', { value: m }, m))
  ]);
  marcaSel.addEventListener('change', () => { marcaFiltro = marcaSel.value; renderTabla(); });

  const selectAllBtn = h('button', { class: 'btn sm ghost' }, '✓ Marcar visibles');
  const unselectAllBtn = h('button', { class: 'btn sm ghost' }, '✕ Desmarcar visibles');

  const tableWrap = h('div', { class: 'card', style: { padding: 0, maxHeight: '60vh', overflow: 'auto' } });
  const counterEl = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } }, '');

  function getVisibles() {
    return matKeys.filter(mk => {
      const m = materiales[mk];
      if (filtro && !(`${m.clave || ''} ${m.descripcion || ''} ${m.marca || ''}`.toLowerCase().includes(filtro))) return false;
      if (famFiltro && (m.familia || '') !== famFiltro) return false;
      if (marcaFiltro && (m.marca || '') !== marcaFiltro) return false;
      return true;
    }).sort((a, b) => (materiales[a].clave || '').localeCompare(materiales[b].clave || ''));
  }

  function renderTabla() {
    const visibles = getVisibles();
    counterEl.textContent = `Mostrando ${num0(visibles.length)} de ${num0(matKeys.length)} materiales · ${num0(selected.size)} seleccionados.`;
    const tbody = h('tbody', {});
    const cap = 300;
    for (const mk of visibles.slice(0, cap)) {
      tbody.appendChild(rowMat(mk));
    }
    if (visibles.length > cap) {
      tbody.appendChild(h('tr', {}, h('td', { colSpan: 5, class: 'muted', style: { textAlign: 'center', padding: '12px', fontSize: '12px' } },
        `Mostrando primeros ${cap}. Acota con los filtros.`)));
    }
    const tbl = h('table', { class: 'tbl' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { style: { width: '40px' } }, ''),
        h('th', {}, 'Clave'),
        h('th', {}, 'Descripción'),
        h('th', {}, 'Unidad'),
        h('th', {}, 'Marca')
      ])),
      tbody
    ]);
    tableWrap.innerHTML = '';
    tableWrap.appendChild(tbl);
  }

  function rowMat(mk) {
    const m = materiales[mk];
    const cb = h('input', { type: 'checkbox', checked: selected.has(mk) });
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!selected.has(mk)) selected.set(mk, { cantidad: '', notasItem: '' });
      } else {
        selected.delete(mk);
      }
      renderPanel();
      counterEl.textContent = `Mostrando ${num0(getVisibles().length)} de ${num0(matKeys.length)} materiales · ${num0(selected.size)} seleccionados.`;
    });
    return h('tr', { style: { cursor: 'pointer' }, onClick: (e) => {
      if (e.target.tagName !== 'INPUT') {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      }
    } }, [
      h('td', {}, cb),
      h('td', { class: 'mono', style: { fontSize: '11px' } }, m.clave || mk.slice(0, 10)),
      h('td', { style: { maxWidth: '380px' } }, m.descripcion || '—'),
      h('td', {}, m.unidad || ''),
      h('td', { class: 'muted', style: { fontSize: '12px' } }, m.marca || '—')
    ]);
  }

  selectAllBtn.addEventListener('click', () => {
    for (const mk of getVisibles()) {
      if (!selected.has(mk)) selected.set(mk, { cantidad: '', notasItem: '' });
    }
    renderTabla();
    renderPanel();
  });
  unselectAllBtn.addEventListener('click', () => {
    for (const mk of getVisibles()) selected.delete(mk);
    renderTabla();
    renderPanel();
  });

  // === UI: derecha (panel selección + form destinatario) ===
  const provSel = h('select', {}, [
    h('option', { value: '' }, '— elige proveedor de la obra —'),
    ...provsObra.map(p => h('option', {
      value: p.proveedor_global_id || p.id,
      selected: presetDest && (presetDest.proveedor_id === (p.proveedor_global_id || p.id)),
      dataset: { nombre: p.nombre, rfc: p.rfc || '', email: p.email || '', telefono: p.telefono || '' }
    }, p.nombre))
  ]);
  const destNombre = h('input', { placeholder: 'Nombre / razón social', value: presetDest?.nombre || '', style: { width: '100%' } });
  const destRfc    = h('input', { placeholder: 'RFC (opcional)', value: presetDest?.rfc || '', style: { width: '100%' } });
  const destContacto = h('input', { placeholder: 'Contacto / atención a', value: presetDest?.contacto || '', style: { width: '100%' } });
  const destEmail  = h('input', { type: 'email', placeholder: 'Email', value: presetDest?.email || '', style: { width: '100%' } });
  const destTel    = h('input', { placeholder: 'Teléfono', value: presetDest?.telefono || '', style: { width: '100%' } });
  provSel.addEventListener('change', () => {
    const opt = provSel.options[provSel.selectedIndex];
    if (opt?.dataset?.nombre) {
      destNombre.value = opt.dataset.nombre || '';
      destRfc.value = opt.dataset.rfc || '';
      destEmail.value = opt.dataset.email || '';
      destTel.value = opt.dataset.telefono || '';
      destContacto.value = '';
    }
  });

  // Atajo "A quien corresponda" para solicitudes sin proveedor específico
  const aQuienCorrespondaBtn = h('button', {
    class: 'btn sm ghost',
    type: 'button',
    title: 'Llenar como solicitud genérica sin proveedor específico',
    style: { marginTop: '4px' }
  }, '⚡ A quien corresponda');
  aQuienCorrespondaBtn.addEventListener('click', () => {
    provSel.value = '';
    destNombre.value = 'A quien corresponda';
    destRfc.value = '';
    destContacto.value = '';
    destEmail.value = '';
    destTel.value = '';
    destNombre.focus();
    destNombre.select();
  });

  const vigenciaDias = h('input', { type: 'number', value: String(presetTerminos?.vigenciaDias ?? 15), min: '0', max: '90', style: { width: '80px' } });
  const fechaEntrega = h('input', { placeholder: 'p.ej. "lo antes posible" o "antes del 15-may"', value: presetTerminos?.fechaEntrega || '', style: { width: '100%' } });
  const notas = h('textarea', { rows: 3, placeholder: 'Observaciones, lugar de entrega, condiciones especiales, etc.', style: { width: '100%' } }, presetTerminos?.notas || '');
  const incluirCantidades = h('input', { type: 'checkbox', checked: presetTerminos?.incluirCantidades !== false });

  const panelSeleccionWrap = h('div', { class: 'card', style: { padding: 0, maxHeight: '40vh', overflow: 'auto' } });

  function renderPanel() {
    panelSeleccionWrap.innerHTML = '';
    if (selected.size === 0) {
      panelSeleccionWrap.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, [
        h('div', { class: 'muted', style: { fontSize: '12px' } },
          'Aún no has seleccionado materiales. Marca los checkboxes de la izquierda.')
      ]));
      generarBtn.disabled = true;
      return;
    }
    generarBtn.disabled = false;

    // Agrupar por familia para presentación
    const porFamilia = new Map();
    for (const mk of selected.keys()) {
      const m = materiales[mk];
      const fam = m.familia || '(sin familia)';
      if (!porFamilia.has(fam)) porFamilia.set(fam, []);
      porFamilia.get(fam).push({ mk, m });
    }
    const sortedFams = Array.from(porFamilia.keys()).sort();

    const tbl = h('table', { class: 'tbl' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, 'Clave'),
        h('th', {}, 'Descripción'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', {}, '')
      ]))
    ]);
    const tbody = h('tbody', {});
    for (const fam of sortedFams) {
      tbody.appendChild(h('tr', {}, h('td', {
        colSpan: 5,
        style: { background: 'var(--bg-2)', fontWeight: '600', fontSize: '12px', color: 'var(--accent)', padding: '6px 10px' }
      }, fam)));
      for (const { mk, m } of porFamilia.get(fam).sort((a, b) => (a.m.clave || '').localeCompare(b.m.clave || ''))) {
        const cantInp = h('input', {
          type: 'number',
          step: '0.01', min: '0',
          value: selected.get(mk).cantidad,
          placeholder: 'opcional',
          style: { width: '90px', textAlign: 'right', fontFamily: 'var(--mono)' }
        });
        cantInp.addEventListener('input', () => {
          const cur = selected.get(mk);
          if (cur) { cur.cantidad = cantInp.value; }
        });
        const removeBtn = h('button', { class: 'btn sm danger', title: 'Quitar' }, '🗑');
        removeBtn.addEventListener('click', () => {
          selected.delete(mk);
          renderPanel();
          renderTabla();
        });
        tbody.appendChild(h('tr', {}, [
          h('td', { class: 'mono', style: { fontSize: '11px' } }, m.clave || mk.slice(0, 10)),
          h('td', { style: { maxWidth: '240px', fontSize: '12px' } }, (m.descripcion || '').slice(0, 80)),
          h('td', { class: 'muted', style: { fontSize: '12px' } }, m.unidad || ''),
          h('td', { class: 'num' }, cantInp),
          h('td', {}, removeBtn)
        ]));
      }
    }
    tbl.appendChild(tbody);
    panelSeleccionWrap.appendChild(tbl);
  }

  const generarBtn = h('button', { class: 'btn primary', disabled: true }, '🖨️ Generar PDF');
  generarBtn.addEventListener('click', () => {
    if (selected.size === 0) { toast('No has seleccionado materiales', 'danger'); return; }
    if (!destNombre.value.trim()) { toast('Captura el nombre del destinatario', 'danger'); return; }
    const payload = {
      obra: meta,
      destinatario: {
        nombre: destNombre.value.trim(),
        rfc: destRfc.value.trim(),
        contacto: destContacto.value.trim(),
        email: destEmail.value.trim(),
        telefono: destTel.value.trim()
      },
      vigenciaDias: Number(vigenciaDias.value) || 15,
      fechaEntrega: fechaEntrega.value.trim(),
      notas: notas.value.trim(),
      incluirCantidades: incluirCantidades.checked,
      autor: {
        nombre: state.user?.displayName || state.user?.email || '',
        email: state.user?.email || ''
      },
      items: Array.from(selected.entries()).map(([mk, sel]) => ({
        materialKey: mk,
        clave: materiales[mk].clave || '',
        descripcion: materiales[mk].descripcion || '',
        unidad: materiales[mk].unidad || '',
        marca: materiales[mk].marca || '',
        familia: materiales[mk].familia || '',
        cantidad: sel.cantidad,
        notasItem: sel.notasItem || ''
      })),
      generadoAt: Date.now()
    };
    Promise.resolve(abrirSolicitudPDF(payload)).catch(e => toast('Error al generar PDF: ' + e.message, 'danger'));
  });

  // === Botones de persistencia ===
  const guardarBtn = h('button', { class: 'btn' }, solId ? '💾 Guardar cambios' : '💾 Guardar como preset');
  guardarBtn.addEventListener('click', () => onGuardar());
  const borrarBtn = h('button', { class: 'btn danger' }, '🗑 Borrar preset');
  borrarBtn.addEventListener('click', () => onBorrar());
  const misSolicitudesBtn = h('button', { class: 'btn ghost' }, '📁 Mis solicitudes');
  misSolicitudesBtn.addEventListener('click', () => onAbrirLista());

  // === Render layout ===
  const tituloEl = h('h1', { style: { margin: 0 } }, solId ? `Solicitud · ${nombrePreset || solId.slice(0, 6)}` : 'Solicitar cotización');
  const head = h('div', { class: 'row' }, [
    tituloEl,
    h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '12px' } },
      'Genera una lista lista para mandar al proveedor. Sin compromiso de compra.'),
    h('div', { style: { flex: 1 } }),
    misSolicitudesBtn,
    solId && borrarBtn,
    guardarBtn,
    generarBtn
  ]);

  const filtros = h('div', { class: 'card', style: { marginBottom: '12px' } },
    h('div', { class: 'row' }, [search, famSel, marcaSel, selectAllBtn, unselectAllBtn]));

  // Columnas: izquierda 2/3 (tabla), derecha 1/3 (panel + form)
  const layout = h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '14px' } }, [
    h('div', {}, [
      h('h2', { style: { marginTop: 0, fontSize: '14px', color: 'var(--text-1)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'Catálogo de materiales'),
      tableWrap,
      counterEl
    ]),
    h('div', {}, [
      h('h2', { style: { marginTop: 0, fontSize: '14px', color: 'var(--text-1)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, `Seleccionados`),
      panelSeleccionWrap,
      h('div', { class: 'card', style: { marginTop: '12px' } }, [
        h('div', { class: 'row' }, [
          h('h3', { style: { margin: 0, flex: 1 } }, 'Destinatario'),
          aQuienCorrespondaBtn
        ]),
        h('div', { class: 'field' }, [h('label', {}, 'De la lista de obra'), provSel]),
        h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), destNombre]),
        h('div', { class: 'grid-2' }, [
          h('div', { class: 'field' }, [h('label', {}, 'RFC'), destRfc]),
          h('div', { class: 'field' }, [h('label', {}, 'Contacto'), destContacto])
        ]),
        h('div', { class: 'grid-2' }, [
          h('div', { class: 'field' }, [h('label', {}, 'Email'), destEmail]),
          h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), destTel])
        ])
      ]),
      h('div', { class: 'card' }, [
        h('h3', {}, 'Términos'),
        h('div', { class: 'grid-2' }, [
          h('div', { class: 'field' }, [h('label', {}, 'Vigencia solicitada (días)'), vigenciaDias]),
          h('div', { class: 'field' }, [h('label', {}, 'Entrega'), fechaEntrega])
        ]),
        h('div', { class: 'field' }, [h('label', {}, 'Observaciones'), notas]),
        h('label', { class: 'row', style: { gap: '6px', marginTop: '8px', cursor: 'pointer' } }, [
          incluirCantidades, h('span', { style: { fontSize: '12px' } }, 'Incluir cantidades estimadas en el PDF')
        ])
      ])
    ])
  ]);

  // === Persistencia ===

  function buildPayload() {
    const itemsObj = {};
    for (const [mk, sel] of selected.entries()) {
      itemsObj[mk] = { cantidad: sel.cantidad || '', notasItem: sel.notasItem || '' };
    }
    return {
      destinatario: {
        nombre: destNombre.value.trim(),
        rfc: destRfc.value.trim(),
        contacto: destContacto.value.trim(),
        email: destEmail.value.trim(),
        telefono: destTel.value.trim(),
        proveedor_id: provSel.value || null
      },
      terminos: {
        vigenciaDias: Number(vigenciaDias.value) || 15,
        fechaEntrega: fechaEntrega.value.trim(),
        notas: notas.value.trim(),
        incluirCantidades: incluirCantidades.checked
      },
      items: itemsObj
    };
  }

  async function onGuardar() {
    if (selected.size === 0) { toast('No has seleccionado materiales', 'danger'); return; }
    if (!destNombre.value.trim()) { toast('Captura el nombre del destinatario', 'danger'); return; }

    // Pedir nombre del preset (si es nuevo o si no tiene nombre todavía)
    let nombre = nombrePreset;
    if (!solId || !nombre) {
      const sugerencia = destNombre.value.trim() && destNombre.value.trim() !== 'A quien corresponda'
        ? `${destNombre.value.trim()} · ${new Date().toLocaleDateString('es-MX')}`
        : `Solicitud ${new Date().toLocaleDateString('es-MX')}`;
      const nombreInput = h('input', { value: sugerencia, autofocus: true });
      const ok = await new Promise(resolve => {
        modal({
          title: solId ? 'Renombrar solicitud' : 'Guardar solicitud',
          body: h('div', {}, [
            h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' } },
              'Dale un nombre para encontrarla después. Por ejemplo: "Acero · obra Torres mayo" o "Cementos · Construrama".'),
            h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombreInput])
          ]),
          confirmLabel: 'Guardar',
          onConfirm: () => {
            const v = nombreInput.value.trim();
            if (!v) { toast('Captura un nombre', 'danger'); return false; }
            nombre = v;
            resolve(true);
            return true;
          }
        }).then(r => { if (!r) resolve(false); });
      });
      if (!ok) return;
    }

    const u = state.user;
    const autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '' };
    const payload = { ...buildPayload(), nombre, autor };

    try {
      if (solId) {
        await updateSolicitudCotizacion(obraId, solId, payload);
        nombrePreset = nombre;
        toast('Solicitud actualizada', 'ok');
        // Repintar el título sin recargar todo
        tituloEl.textContent = `Solicitud · ${nombre}`;
        guardarBtn.textContent = '💾 Guardar cambios';
      } else {
        const newId = await createSolicitudCotizacion(obraId, payload);
        toast('Solicitud guardada', 'ok');
        // Navegar para que la ruta refleje el preset y permitir editar
        navigate(`/obras/${obraId}/solicitar-cotizacion?solicitud=${newId}`);
      }
    } catch (err) {
      toast('Error al guardar: ' + err.message, 'danger');
    }
  }

  async function onBorrar() {
    if (!solId) return;
    await modal({
      title: 'Borrar solicitud',
      body: h('div', {}, [
        h('p', {}, `¿Borrar "${nombrePreset}"?`),
        h('p', { class: 'muted', style: { fontSize: '12px' } },
          'Solo se borra el preset guardado — no afecta nada del flujo formal. Cualquier PDF que ya hayas mandado al proveedor sigue siendo válido.')
      ]),
      confirmLabel: 'Borrar', danger: true,
      onConfirm: async () => {
        try {
          await deleteSolicitudCotizacion(obraId, solId);
          toast('Solicitud borrada', 'ok');
          navigate(`/obras/${obraId}/solicitar-cotizacion`);
          return true;
        } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
      }
    });
  }

  async function onAbrirLista() {
    const all = await listSolicitudesCotizacion(obraId);
    const entries = Object.entries(all).sort(([, a], [, b]) =>
      (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

    if (entries.length === 0) {
      await modal({
        title: 'Mis solicitudes',
        body: h('div', {}, [
          h('p', {}, 'Aún no tienes solicitudes guardadas en esta obra.'),
          h('p', { class: 'muted', style: { fontSize: '12px' } },
            'Cuando armes una lista de materiales y captures el destinatario, usa "💾 Guardar como preset" para poder reabrirla después.')
        ]),
        confirmLabel: 'OK'
      });
      return;
    }

    const list = h('div', { style: { maxHeight: '440px', overflow: 'auto' } },
      entries.map(([id, s]) => {
        const numItems = Object.keys(s.items || {}).length;
        const fechaTxt = new Date(s.updatedAt || s.createdAt).toLocaleString('es-MX');
        const row = h('div', {
          style: {
            padding: '10px 12px',
            borderBottom: '1px solid var(--border)',
            cursor: 'pointer',
            display: 'flex',
            gap: '10px',
            alignItems: 'center'
          }
        }, [
          h('div', { style: { flex: 1, minWidth: 0 } }, [
            h('div', { style: { fontWeight: '600' } }, s.nombre || '(sin nombre)'),
            h('div', { class: 'muted', style: { fontSize: '11px' } }, [
              s.destinatario?.nombre || '—',
              ' · ', num0(numItems), ' material', numItems === 1 ? '' : 'es',
              ' · actualizada ', fechaTxt
            ])
          ]),
          id === solId
            ? h('span', { class: 'tag ok', style: { fontSize: '10px' } }, 'abierta')
            : h('button', { class: 'btn sm primary' }, 'Abrir')
        ]);
        row.addEventListener('click', () => {
          if (id !== solId) {
            navigate(`/obras/${obraId}/solicitar-cotizacion?solicitud=${id}`);
            // Cerrar modal: el modal-backdrop se removerá al navegar (mount limpia el DOM)
            document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
          }
        });
        return row;
      }));

    await modal({
      title: `Mis solicitudes de cotización (${entries.length})`,
      body: h('div', {}, [
        h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
          'Click en una para abrirla, editarla o regenerar su PDF.'),
        list
      ]),
      confirmLabel: 'Cerrar', cancelLabel: 'Cancelar'
    });
  }

  renderTabla();
  renderPanel();
  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, filtros, layout]));
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Solicitar cotización' }
  ];
}
