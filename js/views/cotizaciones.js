import { h, toast, modal } from '../util/dom.js?v=20260612';
import { renderShell } from './shell.js?v=20260612';
import { state, setState } from '../state/store.js?v=20260612';
import {
  getObraMetaLegacy, listCotizaciones, listBuzon, filtrarBuzon,
  deleteCotizacion
} from '../services/db.js?v=20260612';
import { navigate } from '../state/router.js?v=20260612';
import { dateMx, num0, money, reqFolio } from '../util/format.js?v=20260612';

// Lista de cotizaciones por obra. Cada cotización pertenece a una requisición
// aprobada (o varias) y a un proveedor. La emisión de OC sale del detalle
// de cotización.

export async function renderCotizaciones({ params, query }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbsList(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, cotizaciones, buzon] = await Promise.all([
    getObraMetaLegacy(obraId),
    listCotizaciones(obraId),
    listBuzon()
  ]);

  // Si entra con ?req=<buzonId>, lanza captura nueva pre-cargada.
  if (query?.req) {
    navigate(`/obras/${obraId}/cotizaciones/nueva?req=${query.req}`);
    return;
  }

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Cotizaciones'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => onNuevaSinReq(obraId, buzon) },
      '+ Nueva cotización')
  ]);

  const ids = Object.keys(cotizaciones);
  ids.sort((a, b) => (cotizaciones[b].createdAt || 0) - (cotizaciones[a].createdAt || 0));

  let body;
  if (ids.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '💬'),
      h('div', {}, 'Sin cotizaciones todavía.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Captura una cotización contra una requisición aprobada para empezar.')
    ]);
  } else {
    body = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Fecha'),
          h('th', {}, 'Proveedor'),
          h('th', {}, 'Requisiciones'),
          h('th', { class: 'num' }, 'Items'),
          h('th', { class: 'num' }, 'Total'),
          h('th', {}, 'Estado'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, ids.map(id => cotRow(obraId, id, cotizaciones[id], buzon)))
      ])
    ]);
  }

  renderShell(crumbsList(obraId, meta?.nombre), h('div', {}, [head, body]));
}

function cotRow(obraId, cotId, c, buzon) {
  const itemsCount = c.items ? Object.keys(c.items).length : 0;
  const reqLabels = (c.reqIds || []).map(rid => {
    const it = buzon[rid];
    return it ? reqFolio(it.numero) : rid.slice(0, 6);
  }).join(', ');
  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/cotizaciones/${cotId}`)
  }, [
    h('td', {}, dateMx(c.fechaCotizacion || c.createdAt)),
    h('td', {}, h('b', {}, c.proveedor?.nombre || '—')),
    h('td', { class: 'mono', style: { fontSize: '12px' } }, reqLabels || '—'),
    h('td', { class: 'num' }, num0(itemsCount)),
    h('td', { class: 'num' }, money(c.total || 0)),
    h('td', {}, estadoCotBadge(c.estado)),
    h('td', {},
      c.estado !== 'ganadora' && h('button', {
        class: 'btn sm danger',
        onClick: (e) => { e.stopPropagation(); confirmDelete(obraId, cotId, c); }
      }, '🗑'))
  ]);
}

export function estadoCotBadge(estado) {
  if (estado === 'borrador')   return h('span', { class: 'tag warn' }, '✎ Borrador');
  if (estado === 'recibida')   return h('span', { class: 'tag ok' }, '📩 Recibida');
  if (estado === 'ganadora')   return h('span', { class: 'tag ok' }, '🏆 Ganadora · OC emitida');
  if (estado === 'descartada') return h('span', { class: 'tag muted', style: { textDecoration: 'line-through' } }, '✕ Descartada');
  return h('span', { class: 'tag muted' }, estado || '—');
}

async function onNuevaSinReq(obraId, buzon) {
  // Lista de requisiciones aprobadas en esta obra para escoger.
  const aprobadas = filtrarBuzon(buzon, {
    tipo: 'requisicion_materiales',
    obraId,
    estado: 'aprobado'
  });
  const ids = Object.keys(aprobadas);
  if (ids.length === 0) {
    await modal({
      title: 'Sin requisiciones aprobadas',
      body: h('div', {}, [
        h('p', {}, 'No hay requisiciones aprobadas en esta obra.'),
        h('p', { class: 'muted', style: { fontSize: '12px' } },
          'Para capturar una cotización, primero ve al inbox y aprueba una requisición.')
      ]),
      confirmLabel: 'Ir al inbox',
      onConfirm: () => { navigate(`/obras/${obraId}/inbox`); return true; }
    });
    return;
  }

  const select = h('select', {}, [
    h('option', { value: '' }, '— elige requisición —'),
    ...ids.map(id => {
      const it = aprobadas[id];
      const c = it.items ? Object.keys(it.items).length : 0;
      return h('option', { value: id }, `${reqFolio(it.numero)} · ${c} item${c === 1 ? '' : 's'}`);
    })
  ]);
  await modal({
    title: 'Nueva cotización',
    body: h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', {}, 'Requisición'),
        select
      ]),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'La cotización se captura contra una requisición aprobada. Después se podrán consolidar varias cotizaciones bajo una OC.')
    ]),
    confirmLabel: 'Continuar',
    onConfirm: () => {
      if (!select.value) { toast('Elige una requisición', 'danger'); return false; }
      navigate(`/obras/${obraId}/cotizaciones/nueva?req=${select.value}`);
      return true;
    }
  });
}

async function confirmDelete(obraId, cotId, c) {
  await modal({
    title: 'Borrar cotización',
    body: h('div', {}, '¿Borrar esta cotización? Esta acción no se puede deshacer.'),
    confirmLabel: 'Borrar', danger: true,
    onConfirm: async () => {
      await deleteCotizacion(obraId, cotId);
      toast('Cotización borrada', 'ok');
      renderCotizaciones({ params: { id: obraId } });
      return true;
    }
  });
}

function crumbsList(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Cotizaciones' }
  ];
}
