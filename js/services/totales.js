// Cálculo de totales para cotizaciones y OC.
//
// Modelo:
//   items: [{ cantidad, costoUnitario, ... }]
//   incluyeIva: bool — si true, los costos ya incluyen IVA (precio bruto);
//                      si false, el IVA se suma sobre el subtotal.
//   ivaPct: número decimal (0.16 default).
//   retenciones: [{ concepto: 'ISR'|'IVA Ret', pct }] (opcional).
//
// Este modelo es el mismo que ya entiende bitácora para la rama
// estimacion_subcontratista (incluye_iva flag respetado al aprobar).
//
// Decisión 6: compras captura los importes finales y bitácora los respeta —
// no recalcula nada al aprobar. Por eso el cálculo aquí es la fuente
// autoritativa de la OC.

export function calcSubtotalItems(items) {
  return Object.values(items || {}).reduce((s, it) => {
    return s + (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);
  }, 0);
}

// Cuando incluyeIva=true, "subtotal de items" ya trae IVA. Para reportar
// limpiamente, derivamos el subtotal sin IVA: bruto / (1 + ivaPct).
export function deriveTotales({ items, incluyeIva = true, ivaPct = 0.16, retenciones = [] }) {
  const importeBruto = calcSubtotalItems(items); // Σ cantidad × costoUnitario
  let subtotal, ivaImporte;
  if (incluyeIva) {
    subtotal = importeBruto / (1 + ivaPct);
    ivaImporte = importeBruto - subtotal;
  } else {
    subtotal = importeBruto;
    ivaImporte = subtotal * ivaPct;
  }
  // Retenciones se calculan sobre el subtotal sin IVA (regla CFDI 4.0 común).
  const retencionesAplicadas = (retenciones || []).map(r => ({
    concepto: r.concepto,
    pct: Number(r.pct) || 0,
    importe: subtotal * (Number(r.pct) || 0)
  }));
  const retencionesTotal = retencionesAplicadas.reduce((s, r) => s + r.importe, 0);
  const total = subtotal + ivaImporte - retencionesTotal;
  return {
    importeBruto,
    subtotal,
    ivaPct,
    ivaImporte,
    retenciones: retencionesAplicadas,
    retencionesTotal,
    total
  };
}
