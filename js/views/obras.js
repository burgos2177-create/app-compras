import { h, toast } from '../util/dom.js?v=20260803a';
import { renderShell } from './shell.js?v=20260711o';
import { state, setState } from '../state/store.js?v=20260711o';
import { listObrasForUser, listBuzon, filtrarBuzon, getEstadoObras } from '../services/db.js?v=20260803b';
import { navigate } from '../state/router.js?v=20260711o';
import { dateMx, num0 } from '../util/format.js?v=20260711o';

// Estados del proyecto contable que sacan a la obra del listado: sólo se
// compra para las activas. La obra sigue existiendo y su URL /obras/{id} sigue
// funcionando; sólo deja de estorbar. Se administra desde la consola de la
// suite (no desde aquí).
const ESTADOS_OCULTOS = ['pausa', 'terminado'];
const ETIQUETA_ESTADO = { pausa: '⏸ En pausa', terminado: '✓ Terminada' };

// Mostrar también las ocultas (lo prende el usuario con "Ver todas"). Vive
// fuera de la función para sobrevivir al re-render.
let _verOcultas = false;

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

  // El estado vive en bitácora. Si no se puede leer (permisos, red caída), se
  // muestran TODAS: es preferible mostrar de más que dejar a alguien sin sus
  // obras por un fallo de lectura ajeno a esta app.
  let estados = {};
  try {
    estados = await getEstadoObras();
  } catch (err) {
    console.warn('[Obras] no se pudo leer el estado de los proyectos; se muestran todas', err);
  }

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
  // Sin estado (obra no vinculada aún) = activa. Nunca esconder por omisión.
  const ocultas  = ids.filter(id => ESTADOS_OCULTOS.includes(estados[id]));
  const visibles = _verOcultas ? ids : ids.filter(id => !ESTADOS_OCULTOS.includes(estados[id]));

  const grid = visibles.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🛒'),
      ocultas.length > 0
        ? h('div', {}, `No hay obras activas (${ocultas.length} en pausa o terminada${ocultas.length === 1 ? '' : 's'}).`)
        : h('div', {}, isAdmin
          ? 'No hay obras aún. Las obras se crean desde la app de estimaciones.'
          : 'No tienes obras asignadas. Pídele al admin que te asigne.')
    ])
    : h('div', { class: 'obras-grid' }, visibles.map(id => obraCard(id, obras[id], reqsPendientesPorObra[id] || 0, estados[id])));

  // Pie discreto: deja ver las no activas sin que estorben. Sin esto, una obra
  // en pausa o terminada quedaría inalcanzable desde la interfaz.
  const pie = ocultas.length === 0 ? null : h('div', {
    class: 'muted',
    style: { marginTop: '18px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }
  }, [
    h('span', {}, `${ocultas.length} obra${ocultas.length === 1 ? '' : 's'} en pausa o terminada${ocultas.length === 1 ? '' : 's'}`),
    h('button', {
      class: 'btn ghost sm',
      onClick: () => { _verOcultas = !_verOcultas; renderObrasList(); }
    }, _verOcultas ? 'Ver sólo activas' : 'Ver todas')
  ]);

  renderShell([{ label: 'Obras' }], h('div', {}, [head, grid, pie]));
}

function obraCard(id, obra, pendientes, estado) {
  const m = obra.meta || {};
  return h('div', {
    class: 'obra-card',
    // Atenuada cuando se muestra por "Ver todas", para que se note que no está activa.
    style: ESTADOS_OCULTOS.includes(estado) ? { opacity: '.55' } : {},
    onClick: () => navigate('/obras/' + id)
  }, [
    h('h3', {}, [
      m.nombre || 'Sin nombre',
      ESTADOS_OCULTOS.includes(estado)
        ? h('span', {
            class: estado === 'terminado' ? 'tag' : 'tag warn',
            style: { marginLeft: '8px', fontSize: '11px' }
          }, ETIQUETA_ESTADO[estado] || estado)
        : null
    ]),
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
