import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy,
  loadCatalogoConceptos, loadCatalogoMateriales,
  getOC, getBuzonItem, cancelarOC
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx, num, num0, money, ocFolio, reqFolio } from '../util/format.js';
import { estadoOCBadge } from './oc.js';

const ESTADOS_CANCELABLES = new Set(['borrador', 'enviada_buzon', 'aprobada', 'rechazada', 'huerfana']);

// Detalle de OC: read-only. Muestra estado de la OC y estado real del item
// del buzón en bitácora (porque al aprobar/pagar/cerrar contabilidad mueve el
// item del buzón y eso no se sincroniza automático a la OC todavía — se
// haría con un hook bidireccional como ya tienen estimaciones/caja chica).

export async function renderOCDetalle({ params }) {
  const obraId = params.id;
  const ocId = params.ocid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', ocId), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, oc, catCon, catMat] = await Promise.all([
    getObraMetaLegacy(obraId),
    getOC(obraId, ocId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId)
  ]);
  if (!oc) {
    renderShell(crumbs(obraId, meta?.nombre, null),
      h('div', { class: 'empty' }, 'OC no encontrada.'));
    return;
  }

  const buzonItem = oc.buzonId ? await getBuzonItem(oc.buzonId) : null;
  const conceptos = catCon?.conceptos || {};
  const materiales = catMat?.items || {};

  const folio = ocFolio(oc.numero);

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [folio, ' ', estadoOCBadge(oc.estado)]),
    h('div', { style: { flex: 1 } }),
    ESTADOS_CANCELABLES.has(oc.estado) && h('button', {
      class: 'btn danger',
      onClick: () => onCancelar(obraId, ocId, oc)
    }, '✕ Cancelar OC')
  ]);

  const datosCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos de la OC'),
    h('div', { class: 'grid-3' }, [
      kv('Folio', folio),
      kv('Fecha emisión', dateMx(oc.fechaEmision)),
      kv('Estado', oc.estado),
      kv('Proveedor', oc.proveedor?.nombre),
      kv('RFC', oc.proveedor?.rfc),
      kv('Condiciones de pago', oc.condicionesPago),
      kv('Emite', oc.autor?.displayName || oc.autor?.email)
    ])
  ]);

  const buzonCard = buzonItem && h('div', { class: 'card' }, [
    h('h3', {}, 'Estado en contabilidad'),
    h('div', { class: 'row' }, [
      buzonEstadoBadge(buzonItem.estado),
      buzonItem.folio && h('span', { class: 'mono', style: { fontSize: '12px' } }, buzonItem.folio),
      h('span', { class: 'muted', style: { fontSize: '12px' } },
        buzonItem.actualizadoAt ? `actualizado ${new Date(buzonItem.actualizadoAt).toLocaleString('es-MX')}` : `recibido ${new Date(buzonItem.creadoAt).toLocaleString('es-MX')}`)
    ]),
    buzonItem.estado === 'rechazado' && buzonItem.motivoRechazo && h('div', {
      class: 'tag danger',
      style: { marginTop: '8px', whiteSpace: 'normal', maxWidth: '100%' }
    }, [h('b', {}, 'Motivo: '), buzonItem.motivoRechazo])
  ]);

  const itemsCard = renderItemsCard(oc, materiales, conceptos);
  const totalesCard = renderTotalesCard(oc);

  const reqsCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Requisiciones que cubre'),
    (oc.reqIds || []).length === 0
      ? h('div', { class: 'muted' }, 'Sin requisiciones vinculadas.')
      : h('ul', { style: { margin: '0', paddingLeft: '20px' } },
        (oc.reqIds || []).map(rid =>
          h('li', {}, h('a', { href: `#/obras/${obraId}/inbox/${rid}` }, `Requisición ${rid.slice(0, 6)}`))
        ))
  ]);

  renderShell(crumbs(obraId, meta?.nombre, folio), h('div', {}, [
    head, datosCard, buzonCard, itemsCard, totalesCard, reqsCard
  ]));
}

function renderItemsCard(oc, materiales, conceptos) {
  const entries = Object.entries(oc.items || {});
  if (entries.length === 0) {
    return h('div', { class: 'card' }, [h('h3', {}, 'Items'), h('div', { class: 'empty' }, 'Sin items.')]);
  }
  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 0' } }, h('h3', {}, [
      'Items ', h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } }, `(${num0(entries.length)})`)
    ])),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'Costo unit.'),
        h('th', { class: 'num' }, 'Importe'),
        h('th', {}, 'Concepto OPUS')
      ])]),
      h('tbody', {}, entries.map(([id, it]) => itemRow(it, conceptos)))
    ])
  ]);
}

function itemRow(it, conceptos) {
  const importe = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);
  const concepto = it.conceptoKey ? conceptos[it.conceptoKey] : null;
  return h('tr', {}, [
    h('td', { style: { maxWidth: '320px' } }, [
      it.clave && h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, [
        it.clave,
        it.origen === 'ad_hoc_compras' && h('span', { class: 'tag warn', style: { marginLeft: '6px', fontSize: '10px' } }, 'AD-HOC compras')
      ]),
      h('div', {}, it.descripcion || '—'),
      it.notas && h('div', { class: 'muted', style: { fontSize: '11px' } }, it.notas)
    ]),
    h('td', {}, it.unidad || ''),
    h('td', { class: 'num' }, num(it.cantidad, 2)),
    h('td', { class: 'num' }, money(it.costoUnitario)),
    h('td', { class: 'num' }, money(importe)),
    h('td', {},
      concepto
        ? h('span', { title: concepto.descripcion }, [
          h('span', { class: 'mono', style: { fontSize: '11px' } }, concepto.clave),
          h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } },
            (concepto.descripcion || '').slice(0, 28))
        ])
        : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—'))
  ]);
}

function renderTotalesCard(oc) {
  return h('div', { class: 'card' }, [
    h('h3', {}, 'Totales'),
    h('div', { class: 'grid-3' }, [
      kv('Importe bruto', money(oc.importeBruto || 0)),
      kv('Subtotal (sin IVA)', money(oc.subtotal || 0)),
      kv(`IVA (${((oc.ivaPct || 0) * 100).toFixed(0)}%)`, money(oc.ivaImporte || 0))
    ]),
    h('div', { class: 'grid-3', style: { marginTop: '8px' } }, [
      kv('Retenciones', money(oc.retencionesTotal || 0)),
      kv('Total', h('b', { style: { fontSize: '20px', color: 'var(--accent)' } }, money(oc.total || 0))),
      kv('Régimen IVA', oc.incluyeIva ? 'Costos brutos' : 'Costos sin IVA')
    ])
  ]);
}

async function onCancelar(obraId, ocId, oc) {
  const motivo = h('textarea', { rows: 3, placeholder: 'Razón de la cancelación (visible para el almacenista y el contador)' });
  await modal({
    title: 'Cancelar orden de compra',
    body: h('div', {}, [
      h('p', {}, [`Se cancelará la OC `, h('b', {}, ocFolio(oc.numero)), ` al proveedor `, h('b', {}, oc.proveedor?.nombre || '—'), '.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'El item del buzón se marcará como rechazado y la cobertura de las requisiciones vinculadas se libera. Si alguna requisición quedó cerrada solo por esta OC, se reabrirá automáticamente para poder recotizar.'),
      h('div', { class: 'field' }, [h('label', {}, 'Motivo'), motivo])
    ]),
    confirmLabel: 'Cancelar OC', danger: true, size: 'lg',
    onConfirm: async () => {
      const m = motivo.value.trim();
      if (!m) { toast('Captura un motivo', 'danger'); return false; }
      try {
        const u = state.user;
        await cancelarOC(obraId, ocId, m, {
          uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras'
        });
        toast('OC cancelada', 'ok');
        navigate(`/obras/${obraId}/oc?tab=canceladas`);
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

function buzonEstadoBadge(estado) {
  if (estado === 'recibido')    return h('span', { class: 'tag warn' }, '📥 Recibido');
  if (estado === 'en_revision') return h('span', { class: 'tag warn' }, '👁 En revisión');
  if (estado === 'aprobado')    return h('span', { class: 'tag ok' }, '✓ Aprobado · pendiente pagar');
  if (estado === 'pagado')      return h('span', { class: 'tag ok' }, '💵 Pagado');
  if (estado === 'cerrado')     return h('span', { class: 'tag muted' }, '🔒 Cerrado');
  if (estado === 'rechazado')   return h('span', { class: 'tag danger' }, '✕ Rechazado');
  if (estado === 'huerfano')    return h('span', { class: 'tag warn' }, '⚠ Huérfano');
  return h('span', { class: 'tag muted' }, estado || '—');
}

function kv(label, val) {
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val || '—')]);
}

function crumbs(obraId, nombre, folio) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'OC', to: `/obras/${obraId}/oc` },
    { label: folio || '...' }
  ];
}
