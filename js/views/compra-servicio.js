import { h, toast, modal } from '../util/dom.js?v=20260711h';
import { renderShell } from './shell.js?v=20260711h';
import { state, setState } from '../state/store.js?v=20260711h';
import {
  getObraMetaLegacy, loadCatalogoConceptos,
  listProveedoresObra, listProveedoresGlobal, mergeProveedorObraConGlobal,
  createOC, getOC, updateOC, pushBuzonItem
} from '../services/db.js?v=20260711h';
import { navigate } from '../state/router.js?v=20260711h';
import { money, num0, ocFolio } from '../util/format.js?v=20260711h';
import { deriveTotales } from '../services/totales.js?v=20260711h';

// Compra de CONCEPTO / SERVICIO originada en compras (sin requisición de
// materiales). Ej: renta de baño portátil. Compras la crea y cotiza directo,
// emite la OC y la publica al buzón para contabilidad.
//
// Contrato acordado con contabilidad (appsogrub): mismo tipo 'oc_materiales'
// con discriminador claseCompra:'servicio', + categoría contable, ámbito de
// indirecto, retenciones estructuradas y desglose por concepto OPUS.

const CATEGORIAS = ['Indirecto', 'Material', 'Mano de Obra', 'Subcontratista'];
const AMBITOS = ['oficina', 'campo'];
const RET_TIPOS = [
  { tipo: 'ISR', label: 'ISR', tasa: 0.10 },
  { tipo: 'IVA_RET', label: 'IVA retenido', tasa: 0.106667 },
  { tipo: 'subcontratacion', label: 'Subcontratación', tasa: 0.06 },
  { tipo: 'otro', label: 'Otro', tasa: 0 }
];

export async function renderCompraServicio({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '…'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, catCon, { proyectoId, items: provObra }, globales] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoConceptos(obraId),
    listProveedoresObra(obraId),
    listProveedoresGlobal()
  ]);

  const conceptos = catCon?.conceptos || {};
  const conceptoKeys = Object.keys(conceptos);
  const provs = (provObra || []).map(p => mergeProveedorObraConGlobal(p, globales))
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

  // ===== Estado en memoria =====
  const model = {
    proveedor: { id: '', nombre: '', rfc: '', contacto: '', telefono: '', email: '' },
    categoria: 'Indirecto',
    indirectoAmbito: 'oficina',
    incluyeIva: true,
    ivaPct: 0.16,
    condicionesPago: '',
    comentarios: '',
    cfdiUuid: '',
    items: [],          // { conceptoKey, clave, descripcion, unidad, cantidad, costoUnitario, periodoDesde, periodoHasta, notas }
    retenciones: []     // { tipo, tasa }
  };

  // ===== Proveedor =====
  const provSel = h('select', {}, [
    h('option', { value: '' }, '— elige proveedor de la obra —'),
    ...provs.map(p => h('option', { value: p.id }, p.nombre + (p.rfc ? ` · ${p.rfc}` : '')))
  ]);
  const provNombre = h('input', { placeholder: 'Nombre / razón social *' });
  const provRfc = h('input', { placeholder: 'RFC' });
  const provContacto = h('input', { placeholder: 'Contacto' });
  const provTel = h('input', { placeholder: 'Teléfono' });
  const provEmail = h('input', { type: 'email', placeholder: 'Email' });
  provSel.addEventListener('change', () => {
    const p = provs.find(x => x.id === provSel.value);
    if (!p) return;
    model.proveedor.id = p.proveedor_global_id || p.id;
    provNombre.value = p.nombre || '';
    provRfc.value = p.rfc || '';
    provContacto.value = p.contacto || '';
    provTel.value = p.telefono || '';
    provEmail.value = p.email || '';
  });

  // ===== Categoría / ámbito =====
  const catSel = h('select', {}, CATEGORIAS.map(c => h('option', { value: c, selected: c === model.categoria }, c)));
  const ambitoSel = h('select', {}, AMBITOS.map(a => h('option', { value: a, selected: a === model.indirectoAmbito }, a)));
  const ambitoField = h('div', { class: 'field' }, [h('label', {}, 'Ámbito del indirecto'), ambitoSel]);
  function syncAmbito() { ambitoField.style.display = catSel.value === 'Indirecto' ? '' : 'none'; }
  catSel.addEventListener('change', syncAmbito);
  syncAmbito();

  // ===== Items =====
  const itemsWrap = h('div', {});
  const totalesEl = h('div', {});

  function recalc() {
    const itemsObj = {};
    model.items.forEach((it, i) => {
      itemsObj[i] = { cantidad: it.cantidad, costoUnitario: it.costoUnitario };
    });
    const t = deriveTotales({
      items: itemsObj, incluyeIva: model.incluyeIva, ivaPct: model.ivaPct,
      retenciones: model.retenciones.map(r => ({ concepto: r.tipo, pct: r.tasa }))
    });
    totalesEl.innerHTML = '';
    const row = (k, v, strong) => h('div', { class: 'row', style: { justifyContent: 'space-between', fontWeight: strong ? '700' : 'normal' } }, [h('span', {}, k), h('span', { class: 'mono' }, v)]);
    totalesEl.appendChild(h('div', { style: { display: 'grid', gap: '4px', fontSize: '13px' } }, [
      row('Subtotal', money(t.subtotal)),
      row(`IVA (${(model.ivaPct * 100).toFixed(0)}%)`, money(t.ivaImporte)),
      ...t.retenciones.map(r => row(`− Ret. ${r.concepto} (${(r.pct * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%)`, '−' + money(r.importe))),
      row('Total (neto a pagar)', money(t.total), true)
    ]));
    return t;
  }

  function itemCard(it, idx) {
    const conceptoSel = h('select', {}, [
      h('option', { value: '' }, '— concepto OPUS (opcional) —'),
      ...conceptoKeys.map(k => {
        const c = conceptos[k];
        return h('option', { value: k, selected: it.conceptoKey === k }, `${c.clave || ''} · ${(c.descripcion || '').slice(0, 50)}`);
      })
    ]);
    const desc = h('input', { placeholder: 'Descripción del servicio/concepto *', value: it.descripcion || '', style: { width: '100%' } });
    const unidad = h('input', { placeholder: 'Unidad', value: it.unidad || '', style: { width: '80px' } });
    const cant = h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'Cant.', value: it.cantidad || '', style: { width: '90px', textAlign: 'right' } });
    const costo = h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'Costo unit.', value: it.costoUnitario || '', style: { width: '120px', textAlign: 'right' } });
    const desde = h('input', { type: 'date', value: it.periodoDesde || '' });
    const hasta = h('input', { type: 'date', value: it.periodoHasta || '' });
    const notas = h('input', { placeholder: 'Notas (opcional)', value: it.notas || '', style: { width: '100%' } });
    const impEl = h('span', { class: 'mono', style: { color: 'var(--accent)' } }, money(0));

    function sync() {
      it.descripcion = desc.value.trim();
      it.unidad = unidad.value.trim();
      it.cantidad = Number(cant.value) || 0;
      it.costoUnitario = Number(costo.value) || 0;
      it.periodoDesde = desde.value || '';
      it.periodoHasta = hasta.value || '';
      it.notas = notas.value.trim();
      impEl.textContent = money(it.cantidad * it.costoUnitario);
      recalc();
    }
    [desc, unidad, cant, costo, desde, hasta, notas].forEach(el => el.addEventListener('input', sync));
    conceptoSel.addEventListener('change', () => {
      const c = conceptos[conceptoSel.value];
      it.conceptoKey = conceptoSel.value || null;
      it.clave = c?.clave || '';
      if (c) { if (!desc.value) { desc.value = c.descripcion || ''; } if (!unidad.value) { unidad.value = c.unidad || ''; } }
      sync();
    });

    const rm = h('button', { class: 'btn sm danger', type: 'button', onClick: () => { model.items.splice(idx, 1); renderItems(); } }, '🗑');
    sync();
    return h('div', { class: 'card', style: { padding: '12px', marginBottom: '8px' } }, [
      h('div', { class: 'row', style: { gap: '10px', marginBottom: '6px' } }, [conceptoSel, h('div', { style: { flex: 1 } }), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Importe:'), impEl, rm]),
      h('div', { style: { marginBottom: '6px' } }, desc),
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
        h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Unidad'), unidad,
        h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Cantidad'), cant,
        h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Costo unit.'), costo
      ]),
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' } }, [
        h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Periodo (rentas):'),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, 'de'), desde,
        h('span', { class: 'muted', style: { fontSize: '11px' } }, 'a'), hasta
      ]),
      h('div', { style: { marginTop: '6px' } }, notas)
    ]);
  }
  function renderItems() {
    itemsWrap.innerHTML = '';
    model.items.forEach((it, i) => itemsWrap.appendChild(itemCard(it, i)));
    if (model.items.length === 0) itemsWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', padding: '8px 0' } }, 'Agrega al menos un concepto/servicio.'));
    recalc();
  }
  const addItemBtn = h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { model.items.push({ conceptoKey: null, clave: '', descripcion: '', unidad: '', cantidad: 0, costoUnitario: 0, periodoDesde: '', periodoHasta: '', notas: '' }); renderItems(); } }, '＋ Agregar concepto/servicio');

  // ===== Retenciones =====
  const retWrap = h('div', {});
  function renderRet() {
    retWrap.innerHTML = '';
    model.retenciones.forEach((r, i) => {
      const tipoSel = h('select', {}, RET_TIPOS.map(t => h('option', { value: t.tipo, selected: t.tipo === r.tipo }, t.label)));
      const tasa = h('input', { type: 'number', step: '0.0001', min: '0', value: (r.tasa * 100).toString(), style: { width: '90px', textAlign: 'right' } });
      tipoSel.addEventListener('change', () => { r.tipo = tipoSel.value; const preset = RET_TIPOS.find(t => t.tipo === r.tipo); if (preset && preset.tasa) { r.tasa = preset.tasa; tasa.value = (preset.tasa * 100).toString(); } recalc(); });
      tasa.addEventListener('input', () => { r.tasa = (Number(tasa.value) || 0) / 100; recalc(); });
      retWrap.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '4px' } }, [
        tipoSel, tasa, h('span', { class: 'muted', style: { fontSize: '12px' } }, '% sobre subtotal'),
        h('button', { class: 'btn sm danger', type: 'button', onClick: () => { model.retenciones.splice(i, 1); renderRet(); recalc(); } }, '🗑')
      ]));
    });
  }
  const addRetBtn = h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { model.retenciones.push({ tipo: 'ISR', tasa: 0.10 }); renderRet(); recalc(); } }, '＋ Agregar retención');

  // ===== IVA / condiciones =====
  const ivaCb = h('input', { type: 'checkbox', checked: model.incluyeIva });
  ivaCb.addEventListener('change', () => { model.incluyeIva = ivaCb.checked; recalc(); });
  const condiciones = h('input', { placeholder: 'Condiciones de pago (ej. crédito 30 días)' });
  const comentarios = h('textarea', { rows: 2, placeholder: 'Comentarios para contabilidad (opcional)' });
  const cfdi = h('input', { placeholder: 'UUID del CFDI (opcional)' });

  // ===== Emitir =====
  const emitirBtn = h('button', { class: 'btn primary' }, '📤 Emitir OC de servicio → contabilidad');
  emitirBtn.addEventListener('click', () => emitir());

  async function emitir() {
    const nombre = provNombre.value.trim();
    if (!nombre) { toast('Captura el proveedor', 'danger'); return; }
    const validItems = model.items.filter(it => it.descripcion && it.cantidad > 0 && it.costoUnitario > 0);
    if (validItems.length === 0) { toast('Agrega al menos un concepto con cantidad y costo', 'danger'); return; }
    if (!proyectoId) { toast('La obra no está vinculada a un proyecto contable', 'danger'); return; }
    const categoria = catSel.value;
    const indirectoAmbito = categoria === 'Indirecto' ? ambitoSel.value : null;

    emitirBtn.disabled = true; emitirBtn.textContent = 'Emitiendo…';
    try {
      const t = recalc();
      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;   // centavos
      const u = state.user;
      const autor = { uid: u.uid, displayName: u.displayName || '', email: u.email || '', app: 'compras' };
      const proveedor = {
        id: model.proveedor.id || null, nombre,
        rfc: provRfc.value.trim(), contacto: provContacto.value.trim(),
        telefono: provTel.value.trim(), email: provEmail.value.trim()
      };
      const iva = model.ivaPct;

      // items object (para el espejo de OC) y arreglo (para el buzón)
      const itemsObj = {};
      const itemsArr = validItems.map((it, i) => {
        const importe = r2((Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0));
        const linea = {
          descripcion: it.descripcion, unidad: it.unidad || '', cantidad: it.cantidad,
          costoUnitario: it.costoUnitario, importe,
          conceptoKey: it.conceptoKey || null, clave: it.clave || '',
          origen: 'ad_hoc_compras', notas: it.notas || ''
        };
        if (it.periodoDesde || it.periodoHasta) linea.periodo = { desde: it.periodoDesde || '', hasta: it.periodoHasta || '' };
        itemsObj[i] = { ...linea, materialKey: null };
        return linea;
      });

      // desglose por concepto OPUS (monto neto de IVA), como en material
      const desglose = validItems.filter(it => it.conceptoKey).map(it => {
        const bruto = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);
        return {
          conceptoKey: it.conceptoKey,
          conceptoClave: it.clave || '',
          conceptoDescripcion: it.descripcion || '',
          monto: r2(model.incluyeIva ? bruto / (1 + iva) : bruto)
        };
      });

      // Montos a centavos, conservando total = subtotal + IVA − retenciones.
      const subtotal = r2(t.subtotal);
      const ivaImporte = r2(t.ivaImporte);
      const retenciones = t.retenciones.map(r => ({ tipo: r.concepto, tasa: r.pct, base: subtotal, importe: r2(r.importe) }));
      const retencionesTotal = r2(retenciones.reduce((s, r) => s + r.importe, 0));
      const total = r2(subtotal + ivaImporte - retencionesTotal);

      // 1) OC (espejo)
      const ocPayload = {
        claseCompra: 'servicio', categoria,
        ...(indirectoAmbito ? { indirectoAmbito } : {}),
        reqIds: [], cotizacionGanadoraId: null,
        proveedor, fechaEmision: Date.now(), condicionesPago: condiciones.value.trim(),
        items: itemsObj,
        incluyeIva: model.incluyeIva, ivaPct: iva,
        importeBruto: r2(t.importeBruto), subtotal, ivaImporte,
        retenciones, retencionesTotal, total,
        ...(cfdi.value.trim() ? { cfdiUuid: cfdi.value.trim() } : {}),
        comentariosCompras: comentarios.value.trim(),
        estado: 'enviada_buzon', autor
      };
      const ocId = await createOC(obraId, ocPayload);
      const ocNumero = (await getOC(obraId, ocId))?.numero || 0;
      const folioOC = ocFolio(ocNumero);

      // 2) Buzón (contrato de contabilidad)
      const buzonItem = {
        tipo: 'oc_materiales', claseCompra: 'servicio', origenApp: 'compras',
        obraId, ocId, ocNumero, ocFolio: folioOC, proveedor, reqIds: [],
        fechaEmision: ocPayload.fechaEmision, condicionesPago: ocPayload.condicionesPago,
        categoria, ...(indirectoAmbito ? { indirectoAmbito } : {}),
        items: itemsArr,
        incluyeIva: model.incluyeIva, ivaPct: iva,
        subtotal, ivaImporte,
        retenciones, retencionesTotal, total,
        desglose,
        ...(cfdi.value.trim() ? { cfdiUuid: cfdi.value.trim() } : {}),
        comentariosCompras: comentarios.value.trim(), autor, estado: 'recibido'
      };
      const buzonOcId = await pushBuzonItem(buzonItem);
      await updateOC(obraId, ocId, { buzonId: buzonOcId, enviadaBuzonAt: Date.now() });

      toast('OC de servicio emitida y enviada a contabilidad', 'ok');
      navigate(`/obras/${obraId}/oc`);
    } catch (err) {
      console.error('[emitir servicio]', err);
      toast('Error al emitir: ' + err.message, 'danger');
      emitirBtn.disabled = false; emitirBtn.textContent = '📤 Emitir OC de servicio → contabilidad';
    }
  }

  renderItems();
  renderRet();

  const field = (label, el) => h('div', { class: 'field' }, [h('label', {}, label), el]);

  const content = h('div', {}, [
    h('div', { class: 'row', style: { marginBottom: '14px' } }, [
      h('h1', { style: { margin: 0 } }, 'Compra de servicio / concepto'),
      h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '12px' } }, 'La origina compras y va directo a contabilidad (sin requisición).')
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'card' }, [
        h('h3', {}, 'Proveedor'),
        field('De la lista de obra', provSel),
        h('div', { class: 'grid-2' }, [field('Nombre *', provNombre), field('RFC', provRfc)]),
        h('div', { class: 'grid-2' }, [field('Contacto', provContacto), field('Teléfono', provTel)]),
        field('Email', provEmail)
      ]),
      h('div', { class: 'card' }, [
        h('h3', {}, 'Clasificación contable'),
        field('Categoría', catSel),
        ambitoField,
        h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer', fontSize: '13px', marginTop: '8px' } }, [ivaCb, h('span', {}, 'Los costos ya incluyen IVA (16%)')]),
        field('Condiciones de pago', condiciones),
        field('UUID CFDI (opcional)', cfdi)
      ])
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'row' }, [h('h3', { style: { flex: 1 } }, 'Conceptos / servicios'), addItemBtn]),
      itemsWrap
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [h('h3', { style: { flex: 1 } }, 'Retenciones'), addRetBtn]),
        retWrap,
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } }, 'Se calculan sobre el subtotal (sin IVA).')
      ]),
      h('div', { class: 'card' }, [h('h3', {}, 'Totales'), totalesEl])
    ]),
    field('Comentarios para contabilidad', comentarios),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } }, [emitirBtn])
  ]);

  renderShell(crumbs(obraId, meta?.nombre), content);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Compra de servicio' }
  ];
}
