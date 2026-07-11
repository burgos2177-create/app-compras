import { h, toast } from '../util/dom.js?v=20260711h';
import { renderShell } from './shell.js?v=20260711h';
import { state, setState } from '../state/store.js?v=20260711h';
import {
  getObraMetaLegacy, listBuzon, filtrarBuzon,
  loadCatalogoConceptos, loadCatalogoMateriales
} from '../services/db.js?v=20260711h';
import { navigate } from '../state/router.js?v=20260711h';
import { dateMx, num, num0, reqFolio } from '../util/format.js?v=20260711h';

// Inbox de requisiciones por obra. Lee /shared/buzon filtrado por
// tipo='requisicion_materiales' y obraId. Muestra estado del item del buzón
// (recibido / en_revision / aprobado / rechazado / cerrado) con tabs.

const TABS = [
  { id: 'pendientes', label: 'Pendientes', estados: ['recibido', 'en_revision'] },
  { id: 'aprobadas', label: 'Aprobadas (cotizando)', estados: ['aprobado'] },
  { id: 'cerradas', label: 'Cerradas (con OC)', estados: ['cerrado'] },
  { id: 'rechazadas', label: 'Rechazadas', estados: ['rechazado'] },
  { id: 'todas', label: 'Todas', estados: null }
];

export async function renderInbox({ params, query }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbsView(obraId, '...'), h('div', { class: 'empty' }, 'Cargando inbox…'));

  const [meta, buzon, catCon, catMat] = await Promise.all([
    getObraMetaLegacy(obraId),
    listBuzon(),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId)
  ]);
  setState({ conceptos: catCon?.conceptos || null, materiales: catMat?.items || null });

  const tabId = query?.tab || 'pendientes';
  const tab = TABS.find(t => t.id === tabId) || TABS[0];

  const todas = filtrarBuzon(buzon, { tipo: 'requisicion_materiales', obraId });
  const items = tab.estados
    ? Object.fromEntries(Object.entries(todas).filter(([, it]) => tab.estados.includes(it.estado)))
    : todas;

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Inbox de requisiciones'),
    h('div', { style: { flex: 1 } })
  ]);

  const tabBar = h('div', { class: 'row', style: { marginBottom: '14px', gap: '4px' } },
    TABS.map(t => {
      const count = (t.estados
        ? Object.values(todas).filter(it => t.estados.includes(it.estado))
        : Object.values(todas)).length;
      return h('button', {
        class: 'btn sm ' + (t.id === tabId ? 'primary' : 'ghost'),
        onClick: () => navigate(`/obras/${obraId}/inbox?tab=${t.id}`)
      }, [t.label, ' ', h('span', { class: 'tag muted' }, num0(count))]);
    }));

  let body;
  if (Object.keys(items).length === 0) {
    body = emptyState(tabId, todas);
  } else {
    const sorted = Object.entries(items).sort(([, a], [, b]) =>
      (b.creadoAt || 0) - (a.creadoAt || 0));
    body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      sorted.map(([id, item]) => reqCard(obraId, id, item, catMat?.items || {})));
  }

  renderShell(crumbsView(obraId, meta?.nombre), h('div', {}, [head, tabBar, body]));
}

function emptyState(tabId, todas) {
  const total = Object.keys(todas).length;
  if (total === 0) {
    return h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📥'),
      h('div', {}, 'Sin requisiciones todavía para esta obra.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Cuando el almacenista envíe una requisición desde la app de materiales, aparecerá aquí.')
    ]);
  }
  const tabLabel = TABS.find(t => t.id === tabId)?.label || tabId;
  return h('div', { class: 'empty' }, [
    h('div', {}, `Sin requisiciones en "${tabLabel}".`),
    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
      `Hay ${total} requisición${total === 1 ? '' : 'es'} en otros estados.`)
  ]);
}

function reqCard(obraId, buzonId, item, materiales) {
  const folio = reqFolio(item.numero);
  const itemsCount = item.items ? Object.keys(item.items).length : 0;
  const totalCantidad = Object.values(item.items || {})
    .reduce((s, it) => s + (Number(it.cantidad) || 0), 0);

  // Pico de los 3 primeros materiales para preview
  const preview = Object.values(item.items || {}).slice(0, 3).map(it => {
    const m = materiales[it.materialKey];
    return m ? `${m.clave} · ${m.descripcion}` : '⚠ material no encontrado';
  });
  if (itemsCount > 3) preview.push(`… y ${itemsCount - 3} más`);

  return h('div', {
    class: 'req-card',
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/inbox/${buzonId}`)
  }, [
    h('div', { class: 'req-head' }, [
      h('span', { class: 'req-folio' }, folio),
      estadoBuzonBadge(item.estado),
      h('div', { style: { flex: 1 } }),
      h('span', { class: 'req-meta' }, dateMx(item.creadoAt) || '—')
    ]),
    h('div', { class: 'req-meta' }, [
      h('b', {}, num0(itemsCount)), ' material', itemsCount === 1 ? '' : 'es',
      ' · ', num(totalCantidad), ' unidades · ',
      'solicita ', item.autor?.displayName || item.autor?.email || '—'
    ]),
    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
      preview.join('  ·  ') || 'Sin items')
  ]);
}

export function estadoBuzonBadge(estado) {
  if (estado === 'recibido') return h('span', { class: 'tag warn' }, '📥 Recibido');
  if (estado === 'en_revision') return h('span', { class: 'tag warn' }, '👁 En revisión');
  if (estado === 'aprobado') return h('span', { class: 'tag ok' }, '✓ Aprobado · cotizando');
  if (estado === 'cerrado') return h('span', { class: 'tag muted' }, '🔒 Cerrado · con OC');
  if (estado === 'rechazado') return h('span', { class: 'tag danger' }, '✕ Rechazado');
  if (estado === 'huerfano') return h('span', { class: 'tag warn' }, '⚠ Huérfano');
  return h('span', { class: 'tag muted' }, estado || '—');
}

function crumbsView(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Inbox' }
  ];
}
