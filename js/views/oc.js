import { h } from '../util/dom.js?v=20260617';
import { renderShell } from './shell.js?v=20260617';
import { state, setState } from '../state/store.js?v=20260617';
import { getObraMetaLegacy, listOC, listBuzon, filtrarBuzon } from '../services/db.js?v=20260617';
import { navigate } from '../state/router.js?v=20260617';
import { dateMx, num0, money, ocFolio } from '../util/format.js?v=20260617';

// Lista de OC por obra con tabs por estado.

const TABS = [
  { id: 'pendientes', label: 'Pendientes contador', estados: ['enviada_buzon'] },
  { id: 'aprobadas',  label: 'Aprobadas',           estados: ['aprobada'] },
  { id: 'pagadas',    label: 'Pagadas',             estados: ['pagada'] },
  { id: 'cerradas',   label: 'Cerradas',            estados: ['cerrada'] },
  { id: 'rechazadas', label: 'Rechazadas',          estados: ['rechazada', 'huerfana'] },
  { id: 'canceladas', label: 'Canceladas',          estados: ['cancelada'] },
  { id: 'borradores', label: 'Borradores',          estados: ['borrador'] },
  { id: 'todas',      label: 'Todas',               estados: null }
];

export async function renderOCList({ params, query }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbsList(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, ocs, buzon] = await Promise.all([
    getObraMetaLegacy(obraId),
    listOC(obraId),
    listBuzon()
  ]);

  // Estado efectivo desde el buzón (fuente de verdad). El espejo local
  // puede estar stale si bitácora rechazó/marcó huérfano sin pasar por
  // las funciones que sincronizan al espejo.
  const estadoBuzonToOC = {
    aprobado: 'aprobada', pagado: 'pagada', cobrado: 'pagada',
    cerrado: 'cerrada', rechazado: 'rechazada', huerfano: 'huerfana',
    en_revision: 'enviada_buzon', recibido: 'enviada_buzon'
  };
  for (const [, oc] of Object.entries(ocs)) {
    if (oc.estado === 'cancelada') continue;   // Cancelada local manda
    if (!oc.buzonId) continue;
    const buzonItem = buzon[oc.buzonId];
    if (!buzonItem) continue;
    const estadoBuzon = estadoBuzonToOC[buzonItem.estado];
    if (estadoBuzon && estadoBuzon !== oc.estado) {
      oc._estadoEfectivo = estadoBuzon;  // Solo para render; no persistimos en bulk
    }
  }

  const tabId = query?.tab || 'pendientes';
  const tab = TABS.find(t => t.id === tabId) || TABS[0];

  // Para el filtrado por tab usamos el estado efectivo (no el cached).
  const estadoOf = oc => oc._estadoEfectivo || oc.estado;
  const allEntries = Object.entries(ocs);
  const filtered = tab.estados
    ? allEntries.filter(([, oc]) => tab.estados.includes(estadoOf(oc)))
    : allEntries;
  filtered.sort((a, b) => (b[1].numero || 0) - (a[1].numero || 0));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Órdenes de compra'),
    h('div', { style: { flex: 1 } })
  ]);

  const tabBar = h('div', { class: 'row', style: { marginBottom: '14px', gap: '4px' } },
    TABS.map(t => {
      const count = (t.estados
        ? allEntries.filter(([, oc]) => t.estados.includes(estadoOf(oc)))
        : allEntries).length;
      return h('button', {
        class: 'btn sm ' + (t.id === tabId ? 'primary' : 'ghost'),
        onClick: () => navigate(`/obras/${obraId}/oc?tab=${t.id}`)
      }, [t.label, ' ', h('span', { class: 'tag muted' }, num0(count))]);
    }));

  let body;
  if (filtered.length === 0) {
    if (allEntries.length === 0) {
      body = h('div', { class: 'empty' }, [
        h('div', { class: 'ico' }, '📄'),
        h('div', {}, 'Sin órdenes de compra todavía.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Las OC se emiten desde una cotización marcada como recibida.')
      ]);
    } else {
      body = h('div', { class: 'empty' }, [
        h('div', {}, `Sin OC en "${tab.label}".`),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          `Hay ${allEntries.length} OC en otros estados.`)
      ]);
    }
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
          h('th', {}, 'Folio contable')
        ])]),
        h('tbody', {}, filtered.map(([id, oc]) => ocRow(obraId, id, oc)))
      ])
    ]);
  }

  renderShell(crumbsList(obraId, meta?.nombre), h('div', {}, [head, tabBar, body]));
}

function ocRow(obraId, ocId, oc) {
  const itemsCount = oc.items ? Object.keys(oc.items).length : 0;
  const estado = oc._estadoEfectivo || oc.estado;
  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/oc/${ocId}`)
  }, [
    h('td', { class: 'mono' }, ocFolio(oc.numero)),
    h('td', {}, dateMx(oc.fechaEmision || oc.createdAt)),
    h('td', {}, h('b', {}, oc.proveedor?.nombre || '—')),
    h('td', { class: 'num' }, num0(itemsCount)),
    h('td', { class: 'num' }, money(oc.total || 0)),
    h('td', {}, estadoOCBadge(estado)),
    h('td', { class: 'mono', style: { fontSize: '12px' } }, oc.folioContable || '—')
  ]);
}

export function estadoOCBadge(estado) {
  if (estado === 'borrador')      return h('span', { class: 'tag warn' }, '✎ Borrador');
  if (estado === 'enviada_buzon') return h('span', { class: 'tag warn' }, '↗ Enviada');
  if (estado === 'aprobada')      return h('span', { class: 'tag ok' }, '✓ Aprobada');
  if (estado === 'pagada')        return h('span', { class: 'tag ok' }, '💵 Pagada');
  if (estado === 'cerrada')       return h('span', { class: 'tag muted' }, '🔒 Cerrada');
  if (estado === 'rechazada')     return h('span', { class: 'tag danger' }, '✕ Rechazada');
  if (estado === 'cancelada')     return h('span', { class: 'tag muted', style: { textDecoration: 'line-through' } }, '✕ Cancelada');
  if (estado === 'huerfana')      return h('span', { class: 'tag warn' }, '⚠ Huérfana');
  return h('span', { class: 'tag muted' }, estado || '—');
}

function crumbsList(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Órdenes de compra' }
  ];
}
