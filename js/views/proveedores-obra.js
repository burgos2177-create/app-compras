import { h, toast, modal } from '../util/dom.js?v=20260607';
import { renderShell } from './shell.js?v=20260607';
import { state, setState } from '../state/store.js?v=20260607';
import {
  getObraMetaLegacy,
  listProveedoresObra, addProveedorAObra, removeProveedorObra,
  importarProveedoresGlobales,
  listProveedoresGlobal, addProveedorGlobal,
  listCotizaciones, getProyectoIdByObraId,
  mergeProveedorObraConGlobal
} from '../services/db.js?v=20260607';
import { navigate } from '../state/router.js?v=20260607';
import { dateMx, num0, money } from '../util/format.js?v=20260607';

// Lista de proveedores asignados a una obra (sogrub_proy_proveedores filtrado
// por proyectoId de la obra). Patrón calcado de bitácora: catálogo global +
// lista local por proyecto.

export async function renderProveedoresObra({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, { proyectoId, items }, globales, cotizaciones] = await Promise.all([
    getObraMetaLegacy(obraId),
    listProveedoresObra(obraId),
    listProveedoresGlobal(),
    listCotizaciones(obraId)
  ]);

  // Agregados por proveedor: cantidad de cotizaciones, total cotizado, ganadoras.
  const aggByProv = {};
  for (const cot of Object.values(cotizaciones || {})) {
    const key = cot.proveedor?.id || (cot.proveedor?.nombre || '').toLowerCase();
    if (!key) continue;
    if (!aggByProv[key]) aggByProv[key] = { cotizaciones: 0, ganadoras: 0, totalCotizado: 0 };
    const a = aggByProv[key];
    a.cotizaciones++;
    if (cot.estado === 'ganadora') a.ganadoras++;
    a.totalCotizado += Number(cot.total) || 0;
  }

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Proveedores de la obra'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn', onClick: () => onImportarGlobal(obraId, items, globales) }, '⬇ Importar de catálogo global'),
    h('button', { class: 'btn primary', onClick: () => onNuevo(obraId) }, '+ Nuevo proveedor de obra')
  ]);

  if (!proyectoId) {
    renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
      head,
      h('div', { class: 'empty' }, [
        h('div', { class: 'ico' }, '⚠'),
        h('div', {}, 'Esta obra aún no está vinculada a un proyecto contable.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Pídele al admin que vincule la obra desde la app de estimaciones (Admin → Vincular obras).')
      ])
    ]));
    return;
  }

  let body;
  if (items.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🏷️'),
      h('div', {}, 'No hay proveedores asignados a esta obra todavía.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Importa del catálogo global o crea uno nuevo solo para esta obra.')
    ]);
  } else {
    // Merge cada proveedor con el global para mostrar siempre los datos
    // canónicos vigentes (RFC, teléfono, email del global cuando existe).
    const merged = items.map(p => mergeProveedorObraConGlobal(p, globales));
    const sorted = merged.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    body = h('div', { class: 'card', style: { padding: 0 } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Nombre'),
          h('th', {}, 'RFC'),
          h('th', {}, 'Origen'),
          h('th', { class: 'num' }, 'Cotizaciones'),
          h('th', { class: 'num' }, 'Ganadoras'),
          h('th', { class: 'num' }, 'Total cotizado'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, sorted.map(p => provObraRow(obraId, p, aggByProv)))
      ])
    ]);
  }

  const footnote = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '14px' } }, [
    'Los proveedores de la obra viven en /legacy/bitacora/sogrub_proy_proveedores ',
    `· proyecto contable ${proyectoId}.`
  ]);

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, body, footnote]));
}

function provObraRow(obraId, p, aggByProv) {
  const key = p.proveedor_global_id || (p.nombre || '').toLowerCase();
  const a = aggByProv[key] || aggByProv[(p.nombre || '').toLowerCase()] || { cotizaciones: 0, ganadoras: 0, totalCotizado: 0 };

  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/proveedores/${p.id}`)
  }, [
    h('td', {}, h('b', {}, p.nombre)),
    h('td', { class: 'mono muted', style: { fontSize: '12px' } }, p.rfc || '—'),
    h('td', {},
      p.proveedor_global_id
        ? h('span', { class: 'tag', style: { fontSize: '10px' } }, 'Global')
        : h('span', { class: 'tag warn', style: { fontSize: '10px' } }, 'Solo en obra')
    ),
    h('td', { class: 'num' }, num0(a.cotizaciones)),
    h('td', { class: 'num' }, num0(a.ganadoras)),
    h('td', { class: 'num' }, money(a.totalCotizado)),
    h('td', {}, h('button', {
      class: 'btn sm danger',
      onClick: (e) => { e.stopPropagation(); onQuitar(obraId, p); }
    }, '🗑'))
  ]);
}

// === Acciones ===

async function onImportarGlobal(obraId, yaEnObra, globales) {
  const ids = new Set(yaEnObra.map(p => p.proveedor_global_id).filter(Boolean));
  const nombres = new Set(yaEnObra.map(p => (p.nombre || '').toLowerCase()));
  const candidatos = globales.filter(g => !ids.has(g.id) && !nombres.has((g.nombre || '').toLowerCase()));

  if (globales.length === 0) {
    await modal({
      title: 'Catálogo global vacío',
      body: h('div', {}, [
        h('p', {}, 'No hay proveedores en el catálogo global todavía.'),
        h('p', { class: 'muted', style: { fontSize: '12px' } },
          'Crea proveedores en la lista global desde el botón "🏷️ Proveedores" en la página de obras.')
      ]),
      confirmLabel: 'OK'
    });
    return;
  }
  if (candidatos.length === 0) {
    await modal({
      title: 'Todos importados',
      body: h('div', {}, 'Todos los proveedores del catálogo global ya están en esta obra.'),
      confirmLabel: 'OK'
    });
    return;
  }

  const checks = {};
  const list = h('div', { style: { maxHeight: '380px', overflow: 'auto' } },
    candidatos.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      .map(g => {
        checks[g.id] = h('input', { type: 'checkbox' });
        return h('label', {
          class: 'row',
          style: { padding: '6px 0', cursor: 'pointer', borderBottom: '1px solid var(--border)' }
        }, [
          checks[g.id],
          h('div', { style: { flex: 1 } }, [
            h('div', {}, h('b', {}, g.nombre)),
            h('div', { class: 'muted', style: { fontSize: '11px' } }, [
              g.rfc ? `RFC: ${g.rfc}` : 'sin RFC',
              g.telefono ? ` · ${g.telefono}` : ''
            ])
          ])
        ]);
      }));

  await modal({
    title: 'Importar proveedores del catálogo global',
    body: h('div', {}, [
      h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: '8px' } },
        `Selecciona los proveedores que trabajarán en esta obra. Mostrando ${candidatos.length} disponibles.`),
      list
    ]),
    confirmLabel: 'Importar', size: 'lg',
    onConfirm: async () => {
      const seleccionados = Object.entries(checks).filter(([, cb]) => cb.checked).map(([id]) => id);
      if (seleccionados.length === 0) { toast('Selecciona al menos uno', 'danger'); return false; }
      try {
        const importados = await importarProveedoresGlobales(obraId, seleccionados);
        toast(`${importados.length} proveedor${importados.length === 1 ? '' : 'es'} importado${importados.length === 1 ? '' : 's'}`, 'ok');
        renderProveedoresObra({ params: { id: obraId } });
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function onNuevo(obraId) {
  const nombre   = h('input', { autofocus: true });
  const rfc      = h('input', { placeholder: 'RFC (opcional)' });
  const telefono = h('input', {});
  const email    = h('input', { type: 'email' });
  const contacto = h('input', { placeholder: 'Persona de contacto' });
  const notas    = h('textarea', { rows: 2, placeholder: 'Familias que maneja, condiciones de pago, etc.' });
  const aceptaSinIva = h('input', { type: 'checkbox', checked: true });
  const tambienGlobal = h('input', { type: 'checkbox', checked: true });

  await modal({
    title: 'Nuevo proveedor de obra',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'RFC'), rfc]),
        h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
      ]),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'Email'), email]),
        h('div', { class: 'field' }, [h('label', {}, 'Contacto'), contacto])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas]),
      h('div', { style: { padding: '10px 12px', background: 'var(--bg-2)', borderRadius: '6px', marginTop: '8px' } }, [
        h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
          aceptaSinIva,
          h('span', {}, h('b', {}, 'Acepta transacciones sin IVA')),
          h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } }, '(default)')
        ]),
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
          'Desmarca si el proveedor SIEMPRE emite factura (Home Depot, casas que venden al público en general). Sus precios se compararán contra catálogo OPUS + IVA, no contra OPUS directo.')
      ]),
      h('label', { class: 'row', style: { gap: '6px', marginTop: '8px' } }, [
        tambienGlobal,
        h('span', {}, 'Agregar también al catálogo global'),
        h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } },
          '(útil si lo van a usar otras obras también)')
      ])
    ]),
    confirmLabel: 'Crear', size: 'lg',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Captura el nombre', 'danger'); return false; }
      const data = {
        nombre: n,
        rfc: rfc.value.trim(),
        telefono: telefono.value.trim(),
        email: email.value.trim(),
        contacto: contacto.value.trim(),
        notas: notas.value.trim(),
        aceptaSinIva: aceptaSinIva.checked
      };
      try {
        if (tambienGlobal.checked) {
          const g = await addProveedorGlobal(data);
          await addProveedorAObra(obraId, { ...data, proveedor_global_id: g.id });
          toast('Proveedor creado en obra y en catálogo global', 'ok');
        } else {
          await addProveedorAObra(obraId, data);
          toast('Proveedor creado en obra', 'ok');
        }
        renderProveedoresObra({ params: { id: obraId } });
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onQuitar(obraId, p) {
  await modal({
    title: 'Quitar de la obra',
    body: h('div', {}, [
      h('p', {}, [`¿Quitar a "${p.nombre}" de los proveedores de esta obra?`]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        p.proveedor_global_id
          ? 'Sigue existiendo en el catálogo global.'
          : 'Este proveedor solo existe en esta obra. Si lo quitas, se borra por completo.')
    ]),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeProveedorObra(p.id);
      toast('Proveedor quitado de la obra', 'ok');
      renderProveedoresObra({ params: { id: obraId } });
      return true;
    }
  });
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Proveedores' }
  ];
}
