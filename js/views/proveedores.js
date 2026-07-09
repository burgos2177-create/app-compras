import { h, toast, modal } from '../util/dom.js?v=20260610';
import { renderShell } from './shell.js?v=20260610';
import { state } from '../state/store.js?v=20260610';
import {
  listProveedoresGlobal, addProveedorGlobal,
  updateProveedorGlobal, deleteProveedorGlobal,
  getDriveEndpoint, setDriveEndpoint
} from '../services/db.js?v=20260610';
import { uploadProveedorDoc } from '../services/drive.js?v=20260610';

// CRUD de proveedores globales. Almacenado en /legacy/bitacora/sogrub_proveedores
// como array (compatible con appsogrub). MVP: una sola lista global; la
// asignación por obra (sogrub_proy_proveedores) se construye después.

const CLASIFICACIONES = ['Materiales', 'Servicios', 'Subcontratista', 'Equipo / Renta', 'Fletes', 'Otro'];
const MEDIOS_PAGO = ['Transferencia', 'Cheque', 'Efectivo', 'Tarjeta', 'Otro'];
// Documentos anti-lavado (PLD) que se solicitan a cada proveedor.
const DOC_TIPOS = [
  { key: 'constanciaFiscal', label: 'Constancia de situación fiscal' },
  { key: 'caratulaBancaria', label: 'Carátula bancaria (RFC visible)' },
  { key: 'opinionSat', label: 'D-32 Opinión positiva SAT' }
];

function docsCount(p) {
  return DOC_TIPOS.filter(d => p.documentos?.[d.key]?.url).length;
}
function docsBadge(p) {
  const n = docsCount(p);
  const color = n === 3 ? 'var(--ok)' : n === 0 ? 'var(--text-2)' : 'var(--warn)';
  return h('span', { style: { color, fontWeight: '600', fontSize: '12px' } }, `${n}/3`);
}

export async function renderProveedores() {
  renderShell([{ label: 'Proveedores' }], h('div', { class: 'empty' }, 'Cargando…'));
  const [list, driveEndpoint] = await Promise.all([listProveedoresGlobal(), getDriveEndpoint()]);
  const isAdmin = state.user?.role === 'admin';

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Proveedores'),
    h('div', { style: { flex: 1 } }),
    isAdmin && h('button', {
      class: 'btn ghost',
      title: driveEndpoint ? 'Drive configurado — clic para cambiar el endpoint' : 'Configura el endpoint de Google Drive para subir documentos',
      onClick: () => configDriveDialog(driveEndpoint)
    }, driveEndpoint ? '⚙ Drive ✓' : '⚙ Configurar Drive'),
    h('button', { class: 'btn primary', onClick: () => editDialog(null, driveEndpoint) }, '+ Nuevo proveedor')
  ]);

  const driveWarn = !driveEndpoint && h('div', {
    style: {
      padding: '10px 14px', marginBottom: '10px', fontSize: '12px',
      background: 'rgba(245, 196, 81, 0.08)', border: '1px solid rgba(245, 196, 81, 0.35)', borderRadius: '6px'
    }
  }, isAdmin
    ? 'Para subir los documentos anti-lavado a Google Drive, configura el endpoint con el botón "⚙ Configurar Drive".'
    : 'La subida de documentos a Drive aún no está configurada. Pídele a un administrador que la active.');

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
          h('th', {}, 'Clasificación'),
          h('th', {}, 'Pago'),
          h('th', {}, 'Teléfono'),
          h('th', {}, 'Docs AML'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, sorted.map(p => provRow(p, driveEndpoint)))
      ])
    ]);
  }

  const footnote = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '14px' } },
    'Vive en /legacy/bitacora/sogrub_proveedores · compartido con la bitácora del contador.');

  renderShell([
    { label: 'Obras', to: '/' },
    { label: 'Proveedores' }
  ], h('div', {}, [head, driveWarn, body, footnote]));
}

function provRow(p, driveEndpoint) {
  return h('tr', {}, [
    h('td', {}, h('b', {}, p.nombre)),
    h('td', { class: 'mono muted', style: { fontSize: '12px' } }, p.rfc || '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, p.clasificacion || '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, p.medioPago || '—'),
    h('td', { class: 'muted' }, p.telefono || '—'),
    h('td', {}, docsBadge(p)),
    h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', { class: 'btn sm ghost', onClick: () => editDialog(p, driveEndpoint) }, '✎'),
      h('button', { class: 'btn sm danger', onClick: () => onDelete(p) }, '🗑')
    ]))
  ]);
}

// Configura (admin) la URL del Apps Script que sube documentos a Drive.
async function configDriveDialog(current) {
  const url = h('input', { value: current || '', placeholder: 'https://script.google.com/macros/.../exec' });
  await modal({
    title: 'Endpoint de Google Drive',
    body: h('div', {}, [
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Pega la URL de la app web del Apps Script (proveedores.sogrubgc@gmail.com). Ver apps-script/proveedores-drive.gs para desplegarlo.'),
      h('div', { class: 'field' }, [h('label', {}, 'URL (/exec)'), url])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      const v = url.value.trim();
      if (v && !/^https:\/\/script\.google\.com\/.*\/exec$/.test(v)) {
        toast('La URL debe ser de script.google.com y terminar en /exec', 'danger');
        return false;
      }
      try {
        await setDriveEndpoint(v);
        toast('Endpoint guardado', 'ok');
        renderProveedores();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// Fila de un documento AML dentro del editor de proveedor: estado + subir/reemplazar.
function docRow(prov, d, getClasificacion, driveEndpoint) {
  const statusEl = h('span', { style: { fontSize: '12px' } });
  const fileInput = h('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png', style: { display: 'none' } });
  const btn = h('button', { class: 'btn sm ghost', type: 'button' }, 'Subir');

  function refresh() {
    statusEl.innerHTML = '';
    const cur = prov.documentos?.[d.key];
    if (cur?.url) {
      statusEl.appendChild(h('a', { href: cur.url, target: '_blank', style: { color: 'var(--ok)' } },
        '✓ ' + (cur.name || 'ver en Drive').slice(0, 40)));
      btn.textContent = 'Reemplazar';
    } else {
      statusEl.appendChild(h('span', { class: 'muted' }, 'pendiente'));
      btn.textContent = 'Subir';
    }
  }
  refresh();

  btn.addEventListener('click', () => {
    if (!driveEndpoint) { toast('Configura primero el endpoint de Drive (⚙ Drive)', 'danger'); return; }
    if (!getClasificacion()) { toast('Elige la clasificación del proveedor antes de subir', 'warn'); return; }
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    btn.disabled = true; btn.textContent = 'Subiendo…';
    try {
      const res = await uploadProveedorDoc({
        endpoint: driveEndpoint, clasificacion: getClasificacion(),
        proveedor: prov.nombre, proveedorId: prov.id, tipo: d.key, tipoLabel: d.label, file
      });
      const documentos = { ...(prov.documentos || {}), [d.key]: { url: res.url, fileId: res.fileId, name: res.name, uploadedAt: Date.now() } };
      await updateProveedorGlobal(prov.id, { documentos });
      prov.documentos = documentos;
      toast(`${d.label}: subido`, 'ok');
    } catch (err) {
      toast('Error al subir: ' + err.message, 'danger');
    } finally {
      btn.disabled = false; fileInput.value = ''; refresh();
    }
  });

  return h('div', { class: 'row', style: { gap: '10px', padding: '6px 0', borderBottom: '1px solid var(--border)', alignItems: 'center' } }, [
    h('div', { style: { flex: 1, fontSize: '13px' } }, d.label),
    statusEl,
    btn, fileInput
  ]);
}

async function editDialog(prov, driveEndpoint) {
  const nombre   = h('input', { value: prov?.nombre || '', autofocus: true });
  const rfc      = h('input', { value: prov?.rfc || '', placeholder: 'RFC (opcional)' });
  const telefono = h('input', { value: prov?.telefono || '' });
  const email    = h('input', { type: 'email', value: prov?.email || '' });
  const notas    = h('textarea', { rows: 3, placeholder: 'Familias que maneja, condiciones de pago default, etc.' }, prov?.notas || '');

  const clasificacion = h('select', {}, [
    h('option', { value: '' }, '— clasificación —'),
    ...CLASIFICACIONES.map(c => h('option', { value: c, selected: (prov?.clasificacion || '') === c }, c))
  ]);
  const clabe = h('input', {
    value: prov?.clabe || '', placeholder: '18 dígitos', inputmode: 'numeric', maxlength: 18,
    style: { fontFamily: 'var(--mono)' }
  });
  const medioPago = h('select', {}, [
    h('option', { value: '' }, '— medio de pago —'),
    ...MEDIOS_PAGO.map(c => h('option', { value: c, selected: (prov?.medioPago || '') === c }, c))
  ]);

  // Documentos anti-lavado: solo para proveedores ya guardados (necesitan id).
  const docsSection = prov
    ? h('div', {}, [
      h('h2', { style: { fontSize: '13px', margin: '14px 0 6px', color: 'var(--text-1)' } }, 'Documentos (PLD / anti-lavado)'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } },
        driveEndpoint
          ? 'Se guardan en Drive: Proveedores SOGRUB / <clasificación> / <proveedor>. Deben ir a nombre del mismo RFC.'
          : 'Configura el endpoint de Drive (⚙ Drive) para habilitar la subida.'),
      ...DOC_TIPOS.map(d => docRow(prov, d, () => clasificacion.value, driveEndpoint))
    ])
    : h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } },
      'Guarda el proveedor para poder subir sus documentos anti-lavado.');

  await modal({
    title: prov ? 'Editar proveedor' : 'Nuevo proveedor',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'RFC'), rfc]),
        h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telefono])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Email'), email]),
      h('h2', { style: { fontSize: '13px', margin: '14px 0 6px', color: 'var(--text-1)' } }, 'Pago y clasificación'),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'Clasificación'), clasificacion]),
        h('div', { class: 'field' }, [h('label', {}, 'Medio de pago usual'), medioPago])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'CLABE interbancaria'), clabe]),
      h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas]),
      docsSection
    ]),
    confirmLabel: prov ? 'Guardar' : 'Crear',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Captura el nombre', 'danger'); return false; }
      const clabeDigits = clabe.value.replace(/\D/g, '').slice(0, 18);
      if (clabeDigits && clabeDigits.length !== 18) {
        toast('La CLABE debe tener 18 dígitos', 'warn');
      }
      const data = {
        nombre: n,
        rfc: rfc.value.trim(),
        telefono: telefono.value.trim(),
        email: email.value.trim(),
        clasificacion: clasificacion.value,
        clabe: clabeDigits,
        medioPago: medioPago.value,
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
