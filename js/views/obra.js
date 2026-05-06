import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, listBuzon, filtrarBuzon,
  listCotizaciones, listOC,
  loadCatalogoConceptos, loadCatalogoMateriales,
  listProveedoresObra
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { num0, money } from '../util/format.js';

export async function renderObra({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando obra…'));

  const [meta, buzon, cotizaciones, ocs, catCon, catMat, provObra] = await Promise.all([
    getObraMetaLegacy(obraId),
    listBuzon(),
    listCotizaciones(obraId),
    listOC(obraId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId),
    listProveedoresObra(obraId)
  ]);

  if (!meta) {
    renderShell(crumbs(obraId, '...'),
      h('div', { class: 'empty' }, 'Obra no encontrada en el catálogo central.'));
    return;
  }

  setState({ conceptos: catCon?.conceptos || null, materiales: catMat?.items || null });

  const reqsPendientes = filtrarBuzon(buzon, {
    tipo: 'requisicion_materiales',
    obraId,
    estadosIn: ['recibido', 'en_revision']
  });
  const reqsCotizando = filtrarBuzon(buzon, {
    tipo: 'requisicion_materiales',
    obraId,
    estado: 'aprobado'      // aprobado por compras = listo para consolidar en OC
  });

  const numCotizaciones = Object.keys(cotizaciones).length;
  const numOC = Object.keys(ocs).length;
  const totalOC = Object.values(ocs).reduce((s, o) => s + (Number(o.total) || 0), 0);

  const headerCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos de la obra'),
    h('div', { class: 'grid-3' }, [
      kv('Nombre', meta.nombre),
      kv('Contrato', meta.contratoNo),
      kv('Cliente', meta.cliente),
      kv('Constructora', meta.construye),
      kv('Ubicación', `${meta.ubicacion || ''}${meta.municipio ? ', ' + meta.municipio : ''}`),
      kv('Monto C/IVA', money(meta.montoContratoCIVA))
    ]),
    h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
      'Estos datos se administran desde la app de estimaciones — aquí son solo lectura.')
  ]);

  const numProvs = (provObra?.items || []).length;
  const tilesCard = h('div', { class: 'grid-2', style: { marginTop: '14px' } }, [
    tileCard('Inbox de requisiciones',
      Object.keys(reqsPendientes).length, 'pendientes',
      `/obras/${obraId}/inbox`,
      'Requisiciones que materiales envió y esperan ser cotizadas.'),
    tileCard('Proveedores de obra',
      numProvs, numProvs === 1 ? 'asignado' : 'asignados',
      `/obras/${obraId}/proveedores`,
      'Proveedores que trabajan en esta obra. Catálogo vs cotizado.'),
    tileCard('Cotizaciones',
      numCotizaciones, 'totales',
      `/obras/${obraId}/cotizaciones`,
      'Cotizaciones capturadas con proveedores.'),
    tileCard('Órdenes de compra',
      numOC, `· ${money(totalOC)}`,
      `/obras/${obraId}/oc`,
      'OC emitidas y enviadas a contabilidad.')
  ]);

  const refsCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Catálogos vinculados'),
    h('div', { class: 'grid-2' }, [
      h('div', {}, [
        h('div', {}, [h('b', {}, num0(catCon?.conceptos ? Object.keys(catCon.conceptos).length : 0)),
          ' conceptos OPUS']),
        h('div', { class: 'muted', style: { fontSize: '12px' } },
          'Lectura desde /shared/catalogos. Los carga estimaciones.')
      ]),
      h('div', {}, [
        h('div', {}, [h('b', {}, num0(catMat?.items ? Object.keys(catMat.items).length : 0)),
          ' materiales']),
        h('div', { class: 'muted', style: { fontSize: '12px' } },
          'Lectura desde /shared/materiales. Los carga el almacenista.')
      ])
    ])
  ]);

  renderShell(crumbs(obraId, meta.nombre), h('div', {}, [
    headerCard, tilesCard, refsCard
  ]));
}

function tileCard(title, big, sub, to, desc) {
  return h('div', {
    class: 'card',
    style: { cursor: 'pointer' },
    onClick: () => navigate(to)
  }, [
    h('h3', {}, title),
    h('div', { style: { fontSize: '28px', fontWeight: '600', color: 'var(--accent)' } }, [
      String(big), h('span', { style: { fontSize: '12px', color: 'var(--text-2)', marginLeft: '6px', fontWeight: 'normal' } }, sub)
    ]),
    h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, desc)
  ]);
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6) }
  ];
}
