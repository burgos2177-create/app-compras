import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { getObraMetaLegacy, listOC, getBuzonItem } from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx, num0, money, ocFolio } from '../util/format.js';

// Lista de OC por obra. La emisión se hace desde el detalle de cotización.

export async function renderOCList({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbsList(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, ocs] = await Promise.all([
    getObraMetaLegacy(obraId),
    listOC(obraId)
  ]);

  const ids = Object.keys(ocs);
  ids.sort((a, b) => (ocs[b].numero || 0) - (ocs[a].numero || 0));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Órdenes de compra'),
    h('div', { style: { flex: 1 } })
  ]);

  let body;
  if (ids.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📄'),
      h('div', {}, 'Sin órdenes de compra todavía.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Las OC se emiten desde una cotización marcada como recibida.')
    ]);
  } else {
    body = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, '#'),
          h('th', {}, 'Fecha'),
          h('th', {}, 'Proveedor'),
          h('th', { class: 'num' }, 'Items'),
          h('th', { class: 'num' }, 'Total'),
          h('th', {}, 'Estado'),
          h('th', {}, 'En contabilidad')
        ])]),
        h('tbody', {}, ids.map(id => ocRow(obraId, id, ocs[id])))
      ])
    ]);
  }

  renderShell(crumbsList(obraId, meta?.nombre), h('div', {}, [head, body]));
}

function ocRow(obraId, ocId, oc) {
  const itemsCount = oc.items ? Object.keys(oc.items).length : 0;
  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/oc/${ocId}`)
  }, [
    h('td', { class: 'mono' }, ocFolio(oc.numero)),
    h('td', {}, dateMx(oc.fechaEmision || oc.createdAt)),
    h('td', {}, h('b', {}, oc.proveedor?.nombre || '—')),
    h('td', { class: 'num' }, num0(itemsCount)),
    h('td', { class: 'num' }, money(oc.total || 0)),
    h('td', {}, estadoOCBadge(oc.estado)),
    h('td', {}, estadoBuzonOcBadge(oc))
  ]);
}

export function estadoOCBadge(estado) {
  if (estado === 'borrador')      return h('span', { class: 'tag warn' }, '✎ Borrador');
  if (estado === 'enviada_buzon') return h('span', { class: 'tag ok' }, '↗ Enviada a contabilidad');
  if (estado === 'aprobada')      return h('span', { class: 'tag ok' }, '✓ Aprobada por contador');
  if (estado === 'pagada')        return h('span', { class: 'tag ok' }, '💵 Pagada');
  if (estado === 'cerrada')       return h('span', { class: 'tag muted' }, '🔒 Cerrada');
  if (estado === 'rechazada')     return h('span', { class: 'tag danger' }, '✕ Rechazada');
  if (estado === 'cancelada')     return h('span', { class: 'tag muted' }, '✕ Cancelada');
  return h('span', { class: 'tag muted' }, estado || '—');
}

function estadoBuzonOcBadge(oc) {
  if (!oc.buzonId) return h('span', { class: 'muted' }, '—');
  // Lectura síncrona del estado: para la tabla mostraríamos el snapshot de
  // la OC. Para ver el último estado del buzón, el detalle hace getBuzonItem.
  return h('span', { class: 'muted', style: { fontSize: '12px' } }, oc.buzonId.slice(0, 8));
}

function crumbsList(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Órdenes de compra' }
  ];
}
