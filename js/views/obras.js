import { h, toast } from '../util/dom.js?v=20260711';
import { renderShell } from './shell.js?v=20260711';
import { state, setState } from '../state/store.js?v=20260711';
import { listObrasForUser, listBuzon, filtrarBuzon } from '../services/db.js?v=20260711';
import { navigate } from '../state/router.js?v=20260711';
import { dateMx, num0 } from '../util/format.js?v=20260711';

export async function renderObrasList() {
  renderShell([{ label: 'Obras' }], h('div', { class: 'empty' }, 'Cargando obras…'));

  let obras, buzon;
  try {
    [obras, buzon] = await Promise.all([listObrasForUser(state.user), listBuzon()]);
  } catch (err) {
    renderShell([{ label: 'Obras' }], h('div', { class: 'empty' }, 'Error: ' + err.message));
    return;
  }
  setState({ obras });

  const isAdmin = state.user.role === 'admin';
  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Obras'),
    h('div', { class: 'spacer', style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => navigate('/proveedores') }, '🏷️ Proveedores'),
    isAdmin && h('button', { class: 'btn ghost', onClick: () => navigate('/admin') }, '⚙ Admin')
  ]);

  // Conteo de requisiciones pendientes por obra para badge en la tarjeta.
  const reqsPendientesPorObra = {};
  const pendientes = filtrarBuzon(buzon, {
    tipo: 'requisicion_materiales',
    estadosIn: ['recibido', 'en_revision']
  });
  for (const it of Object.values(pendientes)) {
    if (!it.obraId) continue;
    reqsPendientesPorObra[it.obraId] = (reqsPendientesPorObra[it.obraId] || 0) + 1;
  }

  const ids = Object.keys(obras);
  const grid = ids.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🛒'),
      h('div', {}, isAdmin
        ? 'No hay obras aún. Las obras se crean desde la app de estimaciones.'
        : 'No tienes obras asignadas. Pídele al admin que te asigne.')
    ])
    : h('div', { class: 'obras-grid' }, ids.map(id => obraCard(id, obras[id], reqsPendientesPorObra[id] || 0)));

  renderShell([{ label: 'Obras' }], h('div', {}, [head, grid]));
}

function obraCard(id, obra, pendientes) {
  const m = obra.meta || {};
  return h('div', { class: 'obra-card', onClick: () => navigate('/obras/' + id) }, [
    h('h3', {}, m.nombre || 'Sin nombre'),
    h('div', { class: 'meta' }, [
      h('div', {}, [h('span', { class: 'muted' }, 'Contrato '), m.contratoNo || '—']),
      h('div', {}, [h('span', { class: 'muted' }, 'Cliente: '), m.cliente || '—']),
      h('div', {}, [h('span', { class: 'muted' }, 'Ubicación: '), m.ubicacion || '—', m.municipio ? `, ${m.municipio}` : ''])
    ]),
    h('div', { class: 'stats' }, [
      pendientes > 0
        ? h('div', {}, [h('b', {}, num0(pendientes)), ' requisición', pendientes === 1 ? '' : 'es', ' pendiente', pendientes === 1 ? '' : 's'])
        : h('div', { class: 'muted' }, 'Sin requisiciones pendientes')
    ])
  ]);
}
