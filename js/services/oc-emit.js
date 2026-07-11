// Emisión de OC centralizada — la usan tanto el detalle de cotización (emitir
// la cotización ganadora completa) como el tablero de la requisición (emitir
// por reparto material-por-material, una OC por proveedor).
//
// Mantiene INTACTO el contrato del buzón hacia contabilidad (appsogrub):
// tipo:'oc_materiales' + claseCompra + items + desglose por concepto OPUS +
// totales + ocNumero/ocFolio. Cualquier cambio de contrato debe pasar por aquí.

import {
  createOC, getOC, updateOC, listOC,
  updateCotizacion,
  pushBuzonItem, getBuzonItem, updateBuzonItem, setRequisicionOcRef,
  calcularCoberturaReq
} from './db.js?v=20260711b';
import { deriveTotales } from './totales.js?v=20260711b';
import { ocFolio } from '../util/format.js?v=20260711b';

// Emite UNA OC a un proveedor con un conjunto de items.
//
// params:
//   reqIds            [buzonId,...] requisiciones que cubre
//   proveedor         { id?, nombre, rfc?, ... }
//   items             { itemId: { materialKey, clave, descripcion, unidad,
//                                 cantidad, costoUnitario, conceptoKey?, origen?, notas? } }
//   incluyeIva        bool (default true) — si los costos ya traen IVA
//   ivaPct            número (default 0.16)
//   retenciones       [{ concepto, pct }] (default [])
//   condicionesPago   string
//   comentarios       string
//   cotizacionGanadoraId  id de la cotización que ganó (para marcarla) | null
//   claseCompra       'material' (default)
//   autor             { uid, displayName, email, app }
//
// Devuelve { ocId, buzonOcId, ocNumero, ocFolio, totales }.
export async function emitirOC(obraId, params) {
  const {
    reqIds = [],
    proveedor,
    items,
    incluyeIva = true,
    ivaPct = 0.16,
    retenciones = [],
    condicionesPago = '',
    comentarios = '',
    cotizacionGanadoraId = null,
    claseCompra = 'material',
    autor
  } = params;

  const totales = deriveTotales({ items, incluyeIva, ivaPct, retenciones });

  // 1. Crear OC
  const ocPayload = {
    reqIds: reqIds || [],
    cotizacionGanadoraId: cotizacionGanadoraId || null,
    proveedor,
    fechaEmision: Date.now(),
    fechaEntregaEstimada: null,
    condicionesPago: condicionesPago || '',
    items,
    incluyeIva: !!incluyeIva,
    ivaPct: ivaPct ?? 0.16,
    importeBruto: totales.importeBruto,
    subtotal: totales.subtotal,
    ivaImporte: totales.ivaImporte,
    retenciones: totales.retenciones,
    retencionesTotal: totales.retencionesTotal,
    total: totales.total,
    comentariosCompras: comentarios || '',
    estado: 'enviada_buzon',
    autor
  };
  const ocId = await createOC(obraId, ocPayload);
  const ocNumero = (await getOC(obraId, ocId))?.numero || 0;
  const folioOC = ocFolio(ocNumero);

  // 2. Desglose por concepto OPUS para bitácora (monto sin IVA por concepto).
  //    Cada línea sigue siendo por concepto → la trazabilidad se conserva.
  const desglose = Object.values(items)
    .filter(it => it.conceptoKey)
    .map(it => ({
      conceptoKey: it.conceptoKey,
      conceptoClave: it.clave || '',
      conceptoDescripcion: it.descripcion || '',
      monto: ((Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0)) * (incluyeIva
        ? 1 / (1 + (ivaPct ?? 0.16))
        : 1)
    }));

  // 3. Push al buzón (contrato con contabilidad)
  const buzonItem = {
    tipo: 'oc_materiales',
    claseCompra: claseCompra || 'material',
    origenApp: 'compras',
    obraId,
    ocId,
    ocNumero,
    ocFolio: folioOC,
    proveedor,
    reqIds: reqIds || [],
    fechaEmision: ocPayload.fechaEmision,
    condicionesPago: ocPayload.condicionesPago,
    items: Object.values(items).map(it => ({
      materialKey: it.materialKey,
      clave: it.clave,
      descripcion: it.descripcion,
      unidad: it.unidad,
      cantidad: it.cantidad,
      costoUnitario: it.costoUnitario,
      importe: (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0),
      conceptoKey: it.conceptoKey || null,
      origen: it.origen || 'opus',
      notas: it.notas || ''
    })),
    incluyeIva: !!incluyeIva,
    ivaPct: ivaPct ?? 0.16,
    importeBruto: totales.importeBruto,
    subtotal: totales.subtotal,
    ivaImporte: totales.ivaImporte,
    retenciones: totales.retenciones,
    retencionesTotal: totales.retencionesTotal,
    total: totales.total,
    desglose,
    comentariosCompras: comentarios || '',
    autor,
    estado: 'recibido'
  };
  const buzonOcId = await pushBuzonItem(buzonItem);

  // 4. Referencia al buzón en la OC
  await updateOC(obraId, ocId, { buzonId: buzonOcId, enviadaBuzonAt: Date.now() });

  // 5. Marcar la cotización ganadora (si aplica)
  if (cotizacionGanadoraId) {
    await updateCotizacion(obraId, cotizacionGanadoraId, {
      estado: 'ganadora',
      ocId,
      ocBuzonId: buzonOcId,
      ganadoraAt: Date.now()
    });
  }

  // 6. Actualizar cobertura de cada req; cerrar solo al 100%.
  const ocsActualizadas = await listOC(obraId);
  for (const reqBuzonId of (reqIds || [])) {
    const reqItem = await getBuzonItem(reqBuzonId);
    if (!reqItem) continue;

    const cobertura = calcularCoberturaReq({ ...reqItem, id: reqBuzonId }, ocsActualizadas);
    const ocBuzonIds = Array.from(new Set([...(reqItem.ocBuzonIds || []), buzonOcId]));
    const ocIds = Array.from(new Set([...(reqItem.ocIds || []), ocId]));

    const patch = {
      ocBuzonIds, ocIds,
      coberturaPct: cobertura.pct,
      ocBuzonId: reqItem.ocBuzonId || buzonOcId,
      ocId: reqItem.ocId || ocId
    };
    if (cobertura.completa) {
      patch.estado = 'cerrado';
      patch.cerradoAt = Date.now();
      patch.cerradoPor = autor;
    }
    await updateBuzonItem(reqBuzonId, patch);

    if (reqItem.reqId && reqItem.obraId) {
      await setRequisicionOcRef(reqItem.obraId, reqItem.reqId, {
        ocBuzonIds, ocIds, coberturaPct: cobertura.pct,
        ocBuzonId: reqItem.ocBuzonId || buzonOcId,
        ocId: reqItem.ocId || ocId
      });
    }
  }

  return { ocId, buzonOcId, ocNumero, ocFolio: folioOC, totales };
}
