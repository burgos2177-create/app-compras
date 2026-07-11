import { h, toast, modal } from '../util/dom.js?v=20260711';
import { renderShell } from './shell.js?v=20260711';
import { state, setState } from '../state/store.js?v=20260711';
import {
  getObraMetaLegacy,
  loadCatalogoConceptos, loadCatalogoMateriales,
  getOC, getBuzonItem, cancelarOC, updateOC,
  getFacturacion, setFacturacion
} from '../services/db.js?v=20260711';
import { navigate } from '../state/router.js?v=20260711';
import { dateMx, num, num0, money, ocFolio, reqFolio } from '../util/format.js?v=20260711';
import { estadoOCBadge } from './oc.js?v=20260711';
import { exportOcPdf, exportOcDoc, usoCfdiEfectivo } from '../services/oc-export.js?v=20260711';

const ESTADOS_CANCELABLES = new Set(['borrador', 'enviada_buzon', 'aprobada', 'rechazada', 'huerfana']);

// Catálogo SAT c_UsoCFDI (los relevantes para una persona moral que compra).
const USOS_CFDI = [
  ['G01', 'Adquisición de mercancías'],
  ['G02', 'Devoluciones, descuentos o bonificaciones'],
  ['G03', 'Gastos en general'],
  ['I01', 'Construcciones'],
  ['I02', 'Mobiliario y equipo de oficina por inversiones'],
  ['I03', 'Equipo de transporte'],
  ['I04', 'Equipo de cómputo y accesorios'],
  ['I05', 'Dados, troqueles, moldes, matrices y herramental'],
  ['I06', 'Comunicaciones telefónicas'],
  ['I07', 'Comunicaciones satelitales'],
  ['I08', 'Otra maquinaria y equipo'],
  ['S01', 'Sin efectos fiscales'],
  ['CP01', 'Pagos']
];

// Select del uso CFDI. Guarda el valor como "CLAVE Descripción" (ej. "G03 Gastos
// en general") para que la leyenda lo muestre tal cual. Conserva un valor manual
// previo que no esté en el catálogo.
function usoCfdiSelect(current, emptyLabel) {
  const opts = [h('option', { value: '' }, emptyLabel)];
  let matched = false;
  for (const [code, label] of USOS_CFDI) {
    const val = `${code} ${label}`;
    const sel = current === val || current === code;
    if (sel) matched = true;
    opts.push(h('option', { value: val, selected: sel }, `${code} · ${label}`));
  }
  if (current && !matched) opts.splice(1, 0, h('option', { value: current, selected: true }, current + ' (personalizado)'));
  return h('select', {}, opts);
}

// Detalle de OC: read-only. Muestra estado de la OC y estado real del item
// del buzón en bitácora (porque al aprobar/pagar/cerrar contabilidad mueve el
// item del buzón y eso no se sincroniza automático a la OC todavía — se
// haría con un hook bidireccional como ya tienen estimaciones/caja chica).

export async function renderOCDetalle({ params }) {
  const obraId = params.id;
  const ocId = params.ocid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', ocId), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, oc, catCon, catMat, factur] = await Promise.all([
    getObraMetaLegacy(obraId),
    getOC(obraId, ocId),
    loadCatalogoConceptos(obraId),
    loadCatalogoMateriales(obraId),
    getFacturacion()
  ]);
  if (!oc) {
    renderShell(crumbs(obraId, meta?.nombre, null),
      h('div', { class: 'empty' }, 'OC no encontrada.'));
    return;
  }

  const buzonItem = oc.buzonId ? await getBuzonItem(oc.buzonId) : null;
  const conceptos = catCon?.conceptos || {};
  const materiales = catMat?.items || {};

  // Estado efectivo: el del buzón es la fuente de verdad cuando difiere del
  // espejo local de la OC. Si está stale, lo arreglamos en background
  // (self-heal) para que la lista de OC tampoco mienta.
  const estadoBuzonToOC = {
    aprobado: 'aprobada', pagado: 'pagada', cobrado: 'pagada',
    cerrado: 'cerrada', rechazado: 'rechazada', huerfano: 'huerfana',
    en_revision: 'enviada_buzon', recibido: 'enviada_buzon'
  };
  const estadoEfectivo = (buzonItem && estadoBuzonToOC[buzonItem.estado]) || oc.estado;
  if (oc.estado !== estadoEfectivo && oc.estado !== 'cancelada') {
    updateOC(obraId, ocId, { estado: estadoEfectivo, actualizadoAt: Date.now() })
      .catch(err => console.warn('[OC self-heal]', err));
  }

  const folio = ocFolio(oc.numero);

  const ocParaExport = { ...oc, numero: oc.numero, folio };
  const obraParaExport = { meta: meta || {} };
  const isAdmin = state.user?.role === 'admin';

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [folio, ' ', estadoOCBadge(estadoEfectivo)]),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => exportOcPdf(obraParaExport, ocParaExport, factur), title: 'Descargar PDF de la OC' }, '⬇ PDF'),
    h('button', { class: 'btn ghost', onClick: () => exportOcDoc(obraParaExport, ocParaExport, factur), title: 'Descargar Word (.doc) editable de la OC' }, '⬇ Word'),
    isAdmin && h('button', { class: 'btn ghost', onClick: () => datosFacturaDialog(factur, obraId, ocId), title: 'Datos fiscales de SOGRUB para la leyenda de factura (se guardan globales, aplican a todas las OC)' }, '⚙ Datos factura'),
    ESTADOS_CANCELABLES.has(estadoEfectivo) && h('button', {
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

  // Uso del CFDI por OC: vacío usa el global/default; lo que se ponga aquí solo
  // aplica a esta OC.
  const usoEfectivo = usoCfdiEfectivo(oc, factur);
  const usoSel = usoCfdiSelect(oc.usoCfdi || '', '— usa el global/default —');
  usoSel.style.minWidth = '320px';
  const usoBtn = h('button', { class: 'btn sm ghost' }, 'Guardar');
  usoBtn.addEventListener('click', async () => {
    try {
      await updateOC(obraId, ocId, { usoCfdi: usoSel.value });
      toast('Uso del CFDI actualizado para esta OC', 'ok');
      renderOCDetalle({ params: { id: obraId, ocid: ocId } });
    } catch (err) { toast('Error: ' + err.message, 'danger'); }
  });
  const usoCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Uso del CFDI (esta OC)'),
    h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
      usoSel, usoBtn,
      h('span', { class: 'muted', style: { fontSize: '12px' } }, `Efectivo: ${usoEfectivo}`)
    ]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
      'Déjalo vacío para usar el global (default G03 Gastos en general). Lo que pongas aquí solo aplica a esta OC.')
  ]);

  const buzonCard = buzonItem && renderBuzonCard(buzonItem);

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
    head, datosCard, usoCard, buzonCard, itemsCard, totalesCard, reqsCard
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

function renderBuzonCard(buzonItem) {
  const motivoRechazo = buzonItem.motivoRechazo || buzonItem.comentarioRechazo;
  const descHuerfano = buzonItem.descripcionHuerfano;
  const histEntries = Object.entries(buzonItem.estadoHistorial || {})
    .sort(([, a], [, b]) => (a.at || 0) - (b.at || 0));

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Estado en contabilidad'),
    h('div', { class: 'row' }, [
      buzonEstadoBadge(buzonItem.estado),
      buzonItem.folio && h('span', { class: 'mono', style: { fontSize: '12px' } }, buzonItem.folio),
      h('span', { class: 'muted', style: { fontSize: '12px' } },
        buzonItem.actualizadoAt
          ? `actualizado ${new Date(buzonItem.actualizadoAt).toLocaleString('es-MX')}`
          : `recibido ${new Date(buzonItem.creadoAt).toLocaleString('es-MX')}`)
    ]),

    // Mensajes contextuales según el estado
    buzonItem.estado === 'rechazado' && motivoRechazo && h('div', {
      class: 'tag danger',
      style: { marginTop: '10px', whiteSpace: 'normal', maxWidth: '100%', display: 'block' }
    }, [h('b', {}, 'Motivo del rechazo: '), motivoRechazo]),

    buzonItem.estado === 'huerfano' && h('div', {
      class: 'tag warn',
      style: { marginTop: '10px', whiteSpace: 'normal', maxWidth: '100%', display: 'block' }
    }, [
      h('b', {}, '⚠ Movimiento contable eliminado por el contador. '),
      descHuerfano || 'El movimiento ya no existe en bitácora — compras puede reemitir o cancelar la OC.'
    ]),

    buzonItem.actualizadoPorContador && (buzonItem.estado === 'aprobado' || buzonItem.estado === 'pagado') &&
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
        '✎ El contador editó manualmente el movimiento contable.'),

    // Historial de transiciones
    histEntries.length > 0 && h('details', { style: { marginTop: '10px' } }, [
      h('summary', { class: 'muted', style: { cursor: 'pointer', fontSize: '12px' } },
        `Historial (${histEntries.length} cambio${histEntries.length === 1 ? '' : 's'})`),
      h('div', { style: { marginTop: '8px', paddingLeft: '12px', borderLeft: '2px solid var(--border)' } },
        histEntries.map(([key, h2]) => h('div', { style: { fontSize: '12px', marginBottom: '4px' } }, [
          h('b', {}, h2.estado),
          h('span', { class: 'muted', style: { marginLeft: '6px' } },
            h2.at ? new Date(h2.at).toLocaleString('es-MX') : ''),
          h2.nota && h('span', { class: 'muted', style: { marginLeft: '6px', fontStyle: 'italic' } },
            ` — ${h2.nota}`)
        ])))
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

// Datos fiscales de SOGRUB (receptor) para la leyenda de factura en las OC.
// Se guardan GLOBALES (config/facturacion) y aplican a todas las OC.
async function datosFacturaDialog(current, obraId, ocId) {
  const f = current || {};
  const razonSocial = h('input', { value: f.razonSocial || '', placeholder: 'Razón social del receptor' });
  const rfc = h('input', { value: f.rfc || '', placeholder: 'RFC', style: { fontFamily: 'var(--mono)' } });
  const regimen = h('input', { value: f.regimen || '', placeholder: 'Ej. 601 General de Ley Personas Morales' });
  const usoCfdi = usoCfdiSelect(f.usoCfdi || '', '(default: G03 Gastos en general)');
  const correoFacturas = h('input', { value: f.correoFacturas || '', placeholder: 'correo para recibir CFDI' });
  // Domicilio fiscal por campos individuales (antes era un solo campo que se salía)
  const calle = h('input', { value: f.calle || '', placeholder: 'Calle' });
  const numExt = h('input', { value: f.numExt || '', placeholder: 'No. ext.' });
  const numInt = h('input', { value: f.numInt || '', placeholder: 'No. int.' });
  const colonia = h('input', { value: f.colonia || '', placeholder: 'Colonia' });
  const cp = h('input', { value: f.cp || '', placeholder: 'C.P.' });
  const municipio = h('input', { value: f.municipio || '', placeholder: 'Municipio / Alcaldía' });
  const estado = h('input', { value: f.estado || '', placeholder: 'Estado' });
  const field = (l, el) => h('div', { class: 'field' }, [h('label', {}, l), el]);
  await modal({
    title: 'Datos fiscales de SOGRUB (para pedir factura)',
    body: h('div', {}, [
      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Aparecen en la leyenda de "solicitud de factura" del PDF/Word de la OC. Son globales (aplican a todas las OC).'),
      field('Razón social', razonSocial),
      h('div', { class: 'grid-2' }, [field('RFC', rfc), field('Régimen fiscal', regimen)]),
      h('div', { class: 'grid-2' }, [field('Uso del CFDI (default)', usoCfdi), field('Correo para facturas', correoFacturas)]),
      h('h2', { style: { fontSize: '13px', margin: '14px 0 6px', color: 'var(--text-1)' } }, 'Domicilio fiscal'),
      h('div', { class: 'grid-3' }, [field('Calle', calle), field('No. ext.', numExt), field('No. int.', numInt)]),
      h('div', { class: 'grid-2' }, [field('Colonia', colonia), field('C.P.', cp)]),
      h('div', { class: 'grid-2' }, [field('Municipio', municipio), field('Estado', estado)])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        await setFacturacion({
          razonSocial: razonSocial.value.trim(), rfc: rfc.value.trim(), regimen: regimen.value.trim(),
          usoCfdi: usoCfdi.value.trim(), correoFacturas: correoFacturas.value.trim(),
          calle: calle.value.trim(), numExt: numExt.value.trim(), numInt: numInt.value.trim(),
          colonia: colonia.value.trim(), cp: cp.value.trim(), municipio: municipio.value.trim(), estado: estado.value.trim()
        });
        toast('Datos fiscales guardados (aplican a todas las OC)', 'ok');
        if (obraId && ocId) renderOCDetalle({ params: { id: obraId, ocid: ocId } });
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

function crumbs(obraId, nombre, folio) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'OC', to: `/obras/${obraId}/oc` },
    { label: folio || '...' }
  ];
}
