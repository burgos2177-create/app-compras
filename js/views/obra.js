import { h } from '../util/dom.js?v=20260606';
import { renderShell } from './shell.js?v=20260606';
import { state, setState } from '../state/store.js?v=20260606';
import {
  getObraMetaLegacy, listBuzon, filtrarBuzon,
  listCotizaciones, listOC,
  loadCatalogoConceptos, loadCatalogoMateriales,
  listProveedoresObra, listSubcontratos
} from '../services/db.js?v=20260606';
import { navigate } from '../state/router.js?v=20260606';
import { num0, money } from '../util/format.js?v=20260606';

export async function renderObra({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando obra…'));

  const [meta, buzon, cotizaciones, ocs, catCon, catMat, provObra, subcontratos] = await Promise.all([
    getObraMetaLegacy(obraId),
    listBuzon(),
    listCotizaciones(obraId),
    listOC(obraId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId),
    listProveedoresObra(obraId),
    listSubcontratos(obraId)
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
  const numMaterialesCatalogo = catMat?.items ? Object.keys(catMat.items).length : 0;
  const numSubcontratos = Object.keys(subcontratos).length;
  const numSubAdjudicados = Object.values(subcontratos).filter(sc => sc.meta?.estado === 'adjudicado').length;
  const tilesCard = h('div', { class: 'grid-3', style: { marginTop: '14px' } }, [
    tileCard('Inbox de requisiciones',
      Object.keys(reqsPendientes).length, 'pendientes',
      `/obras/${obraId}/inbox`,
      'Requisiciones que materiales envió y esperan ser cotizadas.'),
    tileCard('Proveedores de obra',
      numProvs, numProvs === 1 ? 'asignado' : 'asignados',
      `/obras/${obraId}/proveedores`,
      'Proveedores que trabajan en esta obra. Catálogo vs cotizado.'),
    tileCard('Catálogo de precios',
      numMaterialesCatalogo, 'materiales',
      `/obras/${obraId}/catalogo-precios`,
      'Captura precios por proveedor antes de que lleguen requisiciones.'),
    tileCard('🖨️ Solicitar cotización',
      '→', 'PDF rápido',
      `/obras/${obraId}/solicitar-cotizacion`,
      'Lista de materiales para mandar a una casa de materiales. Sin compromiso de compra.'),
    tileCard('Cotizaciones',
      numCotizaciones, 'totales',
      `/obras/${obraId}/cotizaciones`,
      'Cotizaciones formales que se convierten en OC.'),
    tileCard('Órdenes de compra',
      numOC, `· ${money(totalOC)}`,
      `/obras/${obraId}/oc`,
      'OC emitidas y enviadas a contabilidad.'),
    tileCard('🔧 Subcontratos',
      numSubcontratos, `${numSubAdjudicados} adjudicado${numSubAdjudicados === 1 ? '' : 's'}`,
      `/obras/${obraId}/subcontratos`,
      'Licitación y adjudicación de subcontratos por conceptos OPUS. Estimaciones los consume para emitir pagos parciales.')
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
