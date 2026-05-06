import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state } from '../state/store.js';
import {
  listProveedoresGlobal, addProveedorGlobal,
  updateProveedorGlobal, deleteProveedorGlobal
} from '../services/db.js';

// CRUD de proveedores globales. Almacenado en /legacy/bitacora/sogrub_proveedores
// como array (compatible con appsogrub). MVP: una sola lista global; la
// asignación por obra (sogrub_proy_proveedores) se construye después.

export async function renderProveedores() {
  renderShell([{ label: 'Proveedores' }], h('div', { class: 'empty' }, 'Cargando…'));
  const list = await listProveedoresGlobal();

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Proveedores'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => editDialog(null) }, '+ Nuevo proveedor')
  ]);

  let body;
  if (list.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🏷️'),
      h('div', {}, 'Aún no hay proveedores capturados.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Los proveedores son globales: sirven en todas las obras. La asignación por obra se hará en una fase posterior.')
    ]);
  } else {
    const sorted = [...list].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    body = h('div', { class: 'card', style: { padding: 0 } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Nombre'),
          h('th', {}, 'RFC'),
          h('th', {}, 'Teléfono'),
          h('th', {}, 'Email'),
          h('th', {}, 'Notas'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, sorted.map(p => provRow(p)))
      ])
    ]);
  }

  const footnote = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '14px' } },
    'Vive en /legacy/bitacora/sogrub_proveedores · compartido con la bitácora del contador.');

  renderShell([
    { label: 'Obras', to: '/' },
    { label: 'Proveedores' }
  ], h('div', {}, [head, body, footnote]));
}

function provRow(p) {
  return h('tr', {}, [
    h('td', {}, h('b', {}, p.nombre)),
    h('td', { class: 'mono muted', style: { fontSize: '12px' } }, p.rfc || '—'),
    h('td', { class: 'muted' }, p.telefono || '—'),
    h('td', { class: 'muted' }, p.email || '—'),
    h('td', { class: 'muted', style: { fontSize: '12px', maxWidth: '300px' } }, (p.notas || '').slice(0, 80) || '—'),
    h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', { class: 'btn sm ghost', onClick: () => editDialog(p) }, '✎'),
      h('button', { class: 'btn sm danger', onClick: () => onDelete(p) }, '🗑')
    ]))
  ]);
}

async function editDialog(prov) {
  const nombre   = h('input', { value: prov?.nombre || '', autofocus: true });
  const rfc      = h('input', { value: prov?.rfc || '', placeholder: 'RFC (opcional)' });
  const telefono = h('input', { value: prov?.telefono || '' });
  const email    = h('input', { type: 'email', value: prov?.email || '' });
  const notas    = h('textarea', { rows: 3, placeholder: 'Familias que maneja, condiciones de pago default, etc.' }, prov?.notas || '');

  await modal({
    title: prov ? 'Editar proveedor' : 'Nuevo proveedor',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'RFC'), rfc]),
        h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Email'), email]),
      h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas])
    ]),
    confirmLabel: prov ? 'Guardar' : 'Crear',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Captura el nombre', 'danger'); return false; }
      const data = {
        nombre: n,
        rfc: rfc.value.trim(),
        telefono: telefono.value.trim(),
        email: email.value.trim(),
        notas: notas.value.trim()
      };
      try {
        if (prov) await updateProveedorGlobal(prov.id, data);
        else      await addProveedorGlobal(data);
        toast(prov ? 'Proveedor actualizado' : 'Proveedor creado', 'ok');
        renderProveedores();
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function onDelete(prov) {
  await modal({
    title: 'Borrar proveedor',
    body: h('div', {}, [
      h('p', {}, [`¿Borrar "${prov.nombre}"?`]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'No se borra de cotizaciones ni OC anteriores (ahí queda el snapshot del nombre/RFC).')
    ]),
    confirmLabel: 'Borrar', danger: true,
    onConfirm: async () => {
      try {
        await deleteProveedorGlobal(prov.id);
        toast('Proveedor borrado', 'ok');
        renderProveedores();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}
