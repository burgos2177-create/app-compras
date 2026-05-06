import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, getBuzonItem, updateBuzonItem,
  getRequisicionMateriales,
  loadCatalogoConceptos, loadCatalogoMateriales
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx, num, num0, reqFolio } from '../util/format.js';
import { estadoBuzonBadge } from './inbox.js';

// Detalle de una requisición que llegó al inbox de compras (item del buzón
// con tipo='requisicion_materiales'). Acciones del comprador:
//   - Tomar (recibido → en_revision): marca que esta requisición ya está
//     siendo trabajada — útil si hay varios compradores.
//   - Aprobar (en_revision → aprobado): habilita capturar cotizaciones y
//     emitir OC contra esta requisición.
//   - Rechazar (cualquier → rechazado): con motivo. Notifica a materiales.
//   - Reabrir (rechazado/aprobado → en_revision): para corregir decisiones.
//
// "Cerrado" lo establece el flujo de OC al consolidar la requisición en una
// orden de compra emitida (no se cierra a mano desde aquí).

export async function renderInboxDetalle({ params }) {
  const obraId = params.id;
  const buzonId = params.buzonid;
  setState({ obraActual: obraId });
  renderShell(crumbsView(obraId, '...', '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, buzonItem, catCon, catMat] = await Promise.all([
    getObraMetaLegacy(obraId),
    getBuzonItem(buzonId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId)
  ]);
  setState({ conceptos: catCon?.conceptos || null, materiales: catMat?.items || null });

  if (!buzonItem) {
    renderShell(crumbsView(obraId, meta?.nombre, '...'),
      h('div', { class: 'empty' }, 'Item no encontrado en el buzón.'));
    return;
  }

  // Hidratar con la requisición viva si está disponible (por si hubo edición).
  const reqViva = buzonItem.reqId
    ? await getRequisicionMateriales(obraId, buzonItem.reqId)
    : null;

  const folio = reqFolio(buzonItem.numero);
  const conceptos = catCon?.conceptos || {};
  const materiales = catMat?.items || {};

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [folio, ' ', estadoBuzonBadge(buzonItem.estado)]),
    h('div', { style: { flex: 1 } }),
    ...renderActions(obraId, buzonId, buzonItem)
  ]);

  const metaCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos de la requisición'),
    h('div', { class: 'grid-3' }, [
      kv('Folio almacén', folio),
      kv('Estado en compras', buzonItem.estado),
      kv('Solicita', buzonItem.autor?.displayName || buzonItem.autor?.email || '—'),
      kv('Fecha', dateMx(buzonItem.fechaSolicitud || buzonItem.creadoAt)),
      kv('Recibido', dateMx(buzonItem.creadoAt)),
      kv('Última actualización', dateMx(buzonItem.actualizadoAt))
    ]),
    reqViva && reqViva.estado !== 'enviada' && h('div', {
      class: 'tag warn',
      style: { marginTop: '8px' }
    }, `⚠ La requisición original cambió de estado a "${reqViva.estado}" en materiales.`)
  ]);

  const items = buzonItem.items || {};
  const itemsCard = renderItemsCard(items, materiales, conceptos);

  renderShell(crumbsView(obraId, meta?.nombre, folio), h('div', {}, [
    head, metaCard, itemsCard
  ]));
}

function renderActions(obraId, buzonId, item) {
  const estado = item.estado;
  const acts = [];

  if (estado === 'recibido') {
    acts.push(h('button', {
      class: 'btn',
      onClick: () => onTomar(obraId, buzonId)
    }, '👁 Tomar (en revisión)'));
  }

  if (estado === 'recibido' || estado === 'en_revision') {
    acts.push(h('button', {
      class: 'btn primary',
      onClick: () => onAprobar(obraId, buzonId)
    }, '✓ Aprobar y cotizar'));
    acts.push(h('button', {
      class: 'btn ghost',
      onClick: () => onRechazar(obraId, buzonId)
    }, '✕ Rechazar'));
  }

  if (estado === 'aprobado') {
    acts.push(h('button', {
      class: 'btn primary',
      onClick: () => navigate(`/obras/${obraId}/cotizaciones?req=${buzonId}`)
    }, '+ Capturar cotización'));
    acts.push(h('button', {
      class: 'btn',
      onClick: () => navigate(`/obras/${obraId}/oc/nueva?req=${buzonId}`)
    }, '↗ Emitir OC'));
    acts.push(h('button', {
      class: 'btn ghost',
      onClick: () => onReabrir(obraId, buzonId)
    }, '↺ Reabrir'));
  }

  if (estado === 'rechazado') {
    acts.push(h('button', {
      class: 'btn',
      onClick: () => onReabrir(obraId, buzonId)
    }, '↺ Reabrir'));
  }

  return acts;
}

function renderItemsCard(items, materiales, conceptos) {
  const entries = Object.entries(items);
  if (entries.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, 'Items'),
      h('div', { class: 'empty' }, 'Sin items.')
    ]);
  }
  const totalCant = entries.reduce((s, [, it]) => s + (Number(it.cantidad) || 0), 0);
  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 0' } }, h('h3', {}, [
      'Items ', h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } },
        `(${num0(entries.length)} · ${num(totalCant)} unidades)`)
    ])),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', {}, 'Concepto destino'),
        h('th', {}, 'Notas')
      ])]),
      h('tbody', {}, entries.map(([itemId, it]) => itemRow(it, materiales, conceptos)))
    ])
  ]);
}

function itemRow(it, materiales, conceptos) {
  const m = materiales[it.materialKey];
  const matLabel = m
    ? h('div', {}, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave),
      h('div', {}, m.descripcion),
      m.marca && h('div', { class: 'muted', style: { fontSize: '11px' } }, m.marca)
    ])
    : h('div', { class: 'tag warn' }, [
      h('div', { class: 'mono' }, it.materialKey || '—'),
      h('div', {}, '⚠ Material no encontrado en el catálogo')
    ]);

  const conceptoLabel = it.conceptoKey
    ? (conceptos[it.conceptoKey]
      ? h('span', { title: conceptos[it.conceptoKey].descripcion }, [
        h('span', { class: 'mono', style: { fontSize: '11px' } }, conceptos[it.conceptoKey].clave),
        h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } },
          (conceptos[it.conceptoKey].descripcion || '').slice(0, 30))
      ])
      : h('span', { class: 'tag warn' }, '⚠ Concepto eliminado'))
    : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—');

  return h('tr', {}, [
    h('td', { style: { maxWidth: '380px' } }, matLabel),
    h('td', {}, m?.unidad || ''),
    h('td', { class: 'num' }, num(it.cantidad, 2)),
    h('td', {}, conceptoLabel),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, it.notas || '')
  ]);
}

// === Acciones del comprador ===

async function onTomar(obraId, buzonId) {
  await updateBuzonItem(buzonId, {
    estado: 'en_revision',
    enRevisionAt: Date.now(),
    enRevisionPor: actorPayload()
  });
  toast('Requisición tomada para revisión', 'ok');
  navigate(`/obras/${obraId}/inbox/${buzonId}`);
}

async function onAprobar(obraId, buzonId) {
  await modal({
    title: 'Aprobar requisición',
    body: h('div', {}, [
      h('p', {}, 'Aprobarla habilita capturar cotizaciones y emitir órdenes de compra.'),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'El almacenista verá que ya está siendo procesada en compras. La requisición original queda bloqueada para edición.')
    ]),
    confirmLabel: 'Aprobar',
    onConfirm: async () => {
      await updateBuzonItem(buzonId, {
        estado: 'aprobado',
        aprobadoAt: Date.now(),
        aprobadoPor: actorPayload()
      });
      toast('Requisición aprobada', 'ok');
      navigate(`/obras/${obraId}/inbox/${buzonId}`);
      return true;
    }
  });
}

async function onRechazar(obraId, buzonId) {
  const motivo = h('textarea', { rows: 3, placeholder: 'Razón del rechazo (visible para el almacenista)' });
  await modal({
    title: 'Rechazar requisición',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Motivo'), motivo])
    ]),
    confirmLabel: 'Rechazar', danger: true,
    onConfirm: async () => {
      const m = motivo.value.trim();
      if (!m) { toast('Captura un motivo', 'danger'); return false; }
      await updateBuzonItem(buzonId, {
        estado: 'rechazado',
        motivoRechazo: m,
        rechazadoAt: Date.now(),
        rechazadoPor: actorPayload()
      });
      toast('Requisición rechazada', 'ok');
      navigate(`/obras/${obraId}/inbox/${buzonId}`);
      return true;
    }
  });
}

async function onReabrir(obraId, buzonId) {
  await modal({
    title: 'Reabrir requisición',
    body: h('div', {}, 'Vuelve al estado "en revisión" para volver a tomar decisión.'),
    confirmLabel: 'Reabrir',
    onConfirm: async () => {
      await updateBuzonItem(buzonId, {
        estado: 'en_revision',
        reabiertaAt: Date.now(),
        reabiertaPor: actorPayload()
      });
      toast('Requisición reabierta', 'ok');
      navigate(`/obras/${obraId}/inbox/${buzonId}`);
      return true;
    }
  });
}

function actorPayload() {
  const u = state.user;
  return { uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras' };
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function crumbsView(obraId, nombre, folio) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Inbox', to: `/obras/${obraId}/inbox` },
    { label: folio || '...' }
  ];
}
