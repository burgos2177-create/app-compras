import { h, toast, modal } from '../util/dom.js?v=20260619';
import { renderShell } from './shell.js?v=20260619';
import { state } from '../state/store.js?v=20260619';
import { listUsersLegacy, listObrasLegacy } from '../services/db.js?v=20260619';
import { createUser, updateUserRole, setUserAssignment } from '../services/auth.js?v=20260619';

const ROLES = ['comprador', 'almacenista', 'ingeniero', 'admin'];

export async function renderAdmin() {
  if (state.user.role !== 'admin') {
    renderShell([{ label: 'Sin acceso' }], h('div', { class: 'empty' }, 'Solo el administrador puede acceder a este panel.'));
    return;
  }

  renderShell([{ label: 'Obras', to: '/' }, { label: 'Admin' }], h('div', { class: 'empty' }, 'Cargando…'));
  const [users, obras] = await Promise.all([listUsersLegacy(), listObrasLegacy()]);

  renderShell([{ label: 'Obras', to: '/' }, { label: 'Admin' }], h('div', {}, [
    h('h1', {}, 'Administración'),
    renderUsersBlock(users, obras),
    h('div', { class: 'card' }, [
      h('h3', {}, 'Obras'),
      h('div', { class: 'muted', style: { fontSize: '12px' } },
        'Las obras se crean en la app de estimaciones. Aquí solo se gestionan asignaciones de compradores.')
    ])
  ]));
}

function renderUsersBlock(users, obras) {
  const tbody = h('tbody', {}, Object.entries(users).map(([uid, u]) => userRow(uid, u, obras)));
  return h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('h3', {}, 'Usuarios'),
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn primary sm', onClick: () => newUserDialog() }, '+ Crear usuario')
    ]),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Nombre'), h('th', {}, 'Email'), h('th', {}, 'Rol'),
        h('th', {}, 'Obras asignadas'), h('th', {}, '')
      ])]),
      tbody
    ]),
    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
      'Los usuarios viven en /legacy/estimaciones/users (compartidos con todas las apps de la suite).')
  ]);
}

function userRow(uid, u, obras) {
  const assigned = u.obrasAsignadas || {};
  const obraNames = Object.keys(assigned).map(id => obras[id]?.meta?.nombre || id.slice(0, 6)).join(', ') || '—';
  return h('tr', {}, [
    h('td', {}, u.displayName || ''),
    h('td', { class: 'mono' }, u.email),
    h('td', {}, h('span', { class: 'tag ' + (u.role === 'admin' ? 'ok' : '') }, u.role)),
    h('td', { class: 'muted' }, obraNames),
    h('td', {}, h('div', { class: 'row' }, [
      h('button', { class: 'btn sm ghost', onClick: () => assignmentsDialog(uid, u, obras) }, 'Asignar'),
      h('button', { class: 'btn sm ghost', onClick: () => roleDialog(uid, u) }, 'Rol')
    ]))
  ]);
}

async function newUserDialog() {
  const email = h('input', { type: 'email', placeholder: 'correo@empresa.com' });
  const displayName = h('input', { placeholder: 'Nombre visible' });
  const password = h('input', { type: 'text', placeholder: 'contraseña inicial (min 6)', value: randomPwd() });
  const role = h('select', {}, ROLES.map(r => h('option', { value: r, selected: r === 'comprador' }, r)));

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, 'Email'), email]),
    h('div', { class: 'field' }, [h('label', {}, 'Nombre'), displayName]),
    h('div', { class: 'field' }, [h('label', {}, 'Contraseña inicial'), password]),
    h('div', { class: 'field' }, [h('label', {}, 'Rol'), role]),
    h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
      'El usuario podrá iniciar sesión en cualquiera de las apps de la suite con estas credenciales.')
  ]);

  await modal({
    title: 'Crear usuario', body, confirmLabel: 'Crear',
    onConfirm: async () => {
      try {
        await createUser({
          email: email.value.trim(),
          password: password.value,
          displayName: displayName.value.trim(),
          role: role.value
        });
        toast('Usuario creado', 'ok');
        renderAdmin();
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function roleDialog(uid, user) {
  const role = h('select', {}, ROLES.map(r =>
    h('option', { value: r, selected: user.role === r }, r)
  ));
  await modal({
    title: `Rol de ${user.displayName || user.email}`,
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Rol'), role]),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'admin: acceso total · comprador: gestiona compras · almacenista: captura en almacén · ingeniero: captura en estimaciones')
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      await updateUserRole(uid, role.value);
      toast('Rol actualizado', 'ok');
      renderAdmin();
      return true;
    }
  });
}

async function assignmentsDialog(uid, user, obras) {
  const assigned = user.obrasAsignadas || {};
  const checks = {};
  const list = h('div', { style: { maxHeight: '300px', overflow: 'auto' } }, Object.entries(obras).map(([oid, o]) => {
    checks[oid] = h('input', { type: 'checkbox', checked: !!assigned[oid] });
    return h('label', { class: 'row', style: { padding: '6px 0', cursor: 'pointer' } }, [
      checks[oid], h('span', {}, o.meta?.nombre || oid.slice(0, 6))
    ]);
  }));

  await modal({
    title: `Asignar obras a ${user.displayName || user.email}`,
    body: list, confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        await Promise.all(Object.entries(checks).map(([oid, cb]) =>
          setUserAssignment(uid, oid, cb.checked)
        ));
        toast('Asignaciones actualizadas', 'ok');
        renderAdmin();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

function randomPwd() {
  const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
