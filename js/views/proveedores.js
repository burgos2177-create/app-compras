import { h, toast, modal } from '../util/dom.js?v=20260618';
import { renderShell } from './shell.js?v=20260618';
import { state } from '../state/store.js?v=20260618';
import {
  listProveedoresGlobal, addProveedorGlobal,
  updateProveedorGlobal, deleteProveedorGlobal,
  getGoogleClientId, setGoogleClientId
} from '../services/db.js?v=20260618';
import { uploadProveedorDoc, gisReady } from '../services/drive.js?v=20260618';

// Los navegadores envoltorio (Ferdium/Electron) no completan el popup de OAuth:
// el token nunca vuelve. Avisamos para que suban desde Chrome/Edge real.
const esEnvoltorio = /Electron|Ferdium/i.test(navigator.userAgent);

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
  const [list, clientId] = await Promise.all([listProveedoresGlobal(), getGoogleClientId()]);
  const isAdmin = state.user?.role === 'admin';

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Proveedores'),
    h('div', { style: { flex: 1 } }),
    isAdmin && h('button', {
      class: 'btn ghost',
      title: clientId ? 'Google Drive configurado — clic para cambiar el Client ID' : 'Configura el Client ID de Google para subir documentos',
      onClick: () => configDriveDialog(clientId)
    }, clientId ? '⚙ Drive ✓' : '⚙ Configurar Drive'),
    h('button', { class: 'btn primary', onClick: () => editDialog(null, clientId) }, '+ Nuevo proveedor')
  ]);

  const warns = [];
  if (!clientId) {
    warns.push(isAdmin
      ? 'Para subir los documentos anti-lavado a Google Drive, configura el Client ID con el botón "⚙ Configurar Drive".'
      : 'La subida de documentos a Drive aún no está configurada. Pídele a un administrador que la active.');
  }
  if (clientId && esEnvoltorio) {
    warns.push('Estás en Ferdium/navegador envoltorio: el inicio de sesión de Google no completa aquí. Para SUBIR documentos, abre la app en Chrome o Edge.');
  }
  const driveWarn = warns.length ? h('div', {
    style: {
      padding: '10px 14px', marginBottom: '10px', fontSize: '12px',
      background: 'rgba(245, 196, 81, 0.08)', border: '1px solid rgba(245, 196, 81, 0.35)', borderRadius: '6px'
    }
  }, warns.map(w => h('div', {}, w))) : null;

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

    const search = h('input', {
      type: 'search',
      placeholder: 'Buscar por nombre, RFC o clasificación…',
      style: { width: '320px', marginBottom: '10px' }
    });
    const tbody = h('tbody', {});
    const info = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } });

    function fill() {
      const q = search.value.trim().toLowerCase();
      const rows = q
        ? sorted.filter(p => `${p.nombre || ''} ${p.rfc || ''} ${p.clasificacion || ''} ${p.medioPago || ''}`.toLowerCase().includes(q))
        : sorted;
      tbody.innerHTML = '';
      rows.forEach(p => tbody.appendChild(provRow(p, clientId)));
      if (rows.length === 0) {
        tbody.appendChild(h('tr', {}, h('td', {
          colSpan: 7, class: 'muted', style: { textAlign: 'center', padding: '16px', fontSize: '12px' }
        }, 'Sin coincidencias')));
      }
      info.textContent = `${rows.length} de ${sorted.length} proveedores`;
    }
    search.addEventListener('input', fill);
    fill();

    body = h('div', {}, [
      search,
      h('div', { class: 'card', style: { padding: 0 } }, [
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
          tbody
        ])
      ]),
      info
    ]);
  }

  const footnote = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '14px' } },
    'Vive en /legacy/bitacora/sogrub_proveedores · compartido con la bitácora del contador.');

  renderShell([
    { label: 'Obras', to: '/' },
    { label: 'Proveedores' }
  ], h('div', {}, [head, driveWarn, body, footnote]));
}

function provRow(p, clientId) {
  return h('tr', {}, [
    h('td', {}, h('b', {}, p.nombre)),
    h('td', { class: 'mono muted', style: { fontSize: '12px' } }, p.rfc || '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, p.clasificacion || '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, p.medioPago || '—'),
    h('td', { class: 'muted' }, p.telefono || '—'),
    h('td', {}, docsBadge(p)),
    h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', { class: 'btn sm ghost', onClick: () => editDialog(p, clientId) }, '✎'),
      h('button', { class: 'btn sm danger', onClick: () => onDelete(p) }, '🗑')
    ]))
  ]);
}

// Configura (admin) el OAuth Client ID de Google para subir documentos a Drive.
async function configDriveDialog(current) {
  const cid = h('input', { value: current || '', placeholder: '…apps.googleusercontent.com' });
  const testBtn = h('button', { class: 'btn sm ghost', type: 'button' }, '🔑 Probar acceso');
  const testOut = h('span', { style: { fontSize: '12px' } });
  testBtn.addEventListener('click', async () => {
    const v = cid.value.trim();
    if (!v) { toast('Pega el Client ID primero', 'warn'); return; }
    if (!gisReady()) { toast('Google Identity aún no carga; espera unos segundos', 'warn'); return; }
    testBtn.disabled = true; testOut.textContent = 'Abriendo Google…'; testOut.style.color = 'var(--text-2)';
    try {
      // Fuerza el popup para validar client_id + orígenes autorizados.
      const { requestAccessTokenTest } = await import('../services/drive.js?v=20260618');
      await requestAccessTokenTest(v);
      testOut.textContent = '✓ Acceso concedido'; testOut.style.color = 'var(--ok)';
    } catch (err) {
      testOut.textContent = '✕ ' + err.message; testOut.style.color = 'var(--danger)';
    } finally { testBtn.disabled = false; }
  });
  await modal({
    title: 'Google Drive (OAuth)',
    body: h('div', {}, [
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Pega el OAuth Client ID (tipo Web) de Google Cloud. Los archivos se suben al Drive de la cuenta con la que autorices el popup (usa proveedores.sogrubgc@gmail.com).'),
      h('div', { class: 'field' }, [h('label', {}, 'OAuth Client ID'), cid]),
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', marginTop: '4px' } }, [testBtn, testOut]),
      h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } },
        'En Google Cloud → Credenciales → tu Client ID Web, agrega estos "Authorized JavaScript origins": https://burgos2177-create.github.io y http://localhost. OAuth no funciona en Ferdium: sube desde Chrome/Edge.')
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      const v = cid.value.trim();
      if (v && !/\.apps\.googleusercontent\.com$/.test(v)) {
        toast('El Client ID debe terminar en .apps.googleusercontent.com', 'danger');
        return false;
      }
      try {
        await setGoogleClientId(v);
        toast('Client ID guardado', 'ok');
        renderProveedores();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// Fila de un documento AML dentro del editor de proveedor: estado + subir/reemplazar.
function docRow(prov, d, getClasificacion, clientId) {
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
    if (!clientId) { toast('Configura primero el Client ID de Drive (⚙ Drive)', 'danger'); return; }
    if (!getClasificacion()) { toast('Elige la clasificación del proveedor antes de subir', 'warn'); return; }
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    btn.disabled = true; btn.textContent = 'Subiendo…';
    try {
      const res = await uploadProveedorDoc({
        clientId, clasificacion: getClasificacion(),
        proveedor: prov.nombre, tipo: d.key, tipoLabel: d.label, file,
        prevFileId: prov.documentos?.[d.key]?.fileId,
        folderId: prov.driveFolderId   // reusa la carpeta del proveedor (evita duplicados)
      });
      const documentos = { ...(prov.documentos || {}), [d.key]: { url: res.url, fileId: res.fileId, name: res.name, uploadedAt: Date.now() } };
      const patch = { documentos };
      if (res.folderId && !prov.driveFolderId) { patch.driveFolderId = res.folderId; prov.driveFolderId = res.folderId; }
      await updateProveedorGlobal(prov.id, patch);
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

async function editDialog(prov, clientId) {
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
    style: { fontFamily: 'var(--mono)', flex: 1 }
  });
  const copyClabeBtn = h('button', {
    type: 'button', class: 'btn sm ghost', title: 'Copiar CLABE al portapapeles'
  }, '📋');
  copyClabeBtn.addEventListener('click', async () => {
    const v = clabe.value.trim();
    if (!v) { toast('No hay CLABE que copiar', 'warn'); return; }
    try {
      await navigator.clipboard.writeText(v);
    } catch {
      clabe.focus(); clabe.select();
      try { document.execCommand('copy'); } catch { toast('No se pudo copiar', 'danger'); return; }
    }
    toast('CLABE copiada', 'ok');
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
        clientId
          ? 'Se guardan en Drive: Proveedores SOGRUB / <clasificación> / <proveedor>. Deben ir a nombre del mismo RFC.'
          : 'Configura el Client ID de Drive (⚙ Drive) para habilitar la subida.'),
      ...DOC_TIPOS.map(d => docRow(prov, d, () => clasificacion.value, clientId))
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
      h('div', { class: 'field' }, [
        h('label', {}, 'CLABE interbancaria'),
        h('div', { class: 'row', style: { gap: '6px', alignItems: 'stretch' } }, [clabe, copyClabeBtn])
      ]),
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
