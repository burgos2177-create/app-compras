import {
  ref, get, set, update, push, remove, onValue, off
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import { db } from './firebase.js';
import { APP_BASE_PATH } from '../config/firebase-config.js';

// Prefija toda path relativa con APP_BASE_PATH. Para escapes (rutas absolutas
// como /legacy/estimaciones/users, /shared/catalogos, /shared/materiales,
// /shared/buzon, /legacy/bitacora/sogrub_proveedores) pasar el path comenzando
// con "/" — se interpreta como absoluto.
function _resolve(path) {
  if (typeof path !== 'string') throw new Error('path debe ser string');
  if (path.startsWith('/')) return path.slice(1);
  return APP_BASE_PATH ? `${APP_BASE_PATH}/${path}` : path;
}

export function appPath(relPath) { return _resolve(relPath); }

function _ref(path) {
  const resolved = _resolve(path);
  return resolved ? ref(db, resolved) : ref(db);
}

export function rread(path) {
  return get(_ref(path)).then(s => s.exists() ? s.val() : null);
}
export function rset(path, val) { return set(_ref(path), val); }
export function rupdate(path, patch) { return update(_ref(path), patch); }
export function rpush(path, val) {
  const r = push(_ref(path));
  return set(r, val).then(() => r.key);
}
export function rremove(path) { return remove(_ref(path)); }
export function rwatch(path, cb) {
  const r = _ref(path);
  const handler = onValue(r, s => cb(s.exists() ? s.val() : null));
  return () => off(r, 'value', handler);
}

// === Usuarios y obras (lecturas a /legacy/estimaciones — fuente única) ===

export async function listUsersLegacy() {
  return (await rread('/legacy/estimaciones/users')) || {};
}
export async function getUserProfileLegacy(uid) {
  return await rread(`/legacy/estimaciones/users/${uid}`);
}
export async function listObrasLegacy() {
  return (await rread('/legacy/estimaciones/obras')) || {};
}
export async function getObraMetaLegacy(obraId) {
  return await rread(`/legacy/estimaciones/obras/${obraId}/meta`);
}

// Obras visibles para el usuario actual.
// Admin ve todas; comprador/almacenista/ingeniero solo las que tiene asignadas.
export async function listObrasForUser(user) {
  if (user.role === 'admin') return await listObrasLegacy();
  const map = await rread(`/legacy/estimaciones/users/${user.uid}/obrasAsignadas`) || {};
  const ids = Object.keys(map);
  const out = {};
  await Promise.all(ids.map(async id => {
    const meta = await getObraMetaLegacy(id);
    if (meta) out[id] = { meta };
  }));
  return out;
}

// === Catálogos cross-app (solo lectura) ===

// Conceptos OPUS — escritor: estimaciones. Lectores: materiales, compras.
export async function loadCatalogoConceptos(obraId) {
  const shared = await rread(`/shared/catalogos/${obraId}`);
  if (!shared?.conceptos) return null;
  return { meta: shared.meta, conceptos: shared.conceptos };
}

// Materiales — escritor: app-materiales. Lectores: compras (para resolver
// materialKey → desc/clave/unidad/conceptosDirectos al cotizar y emitir OC).
export async function loadCatalogoMateriales(obraId) {
  const meta = await rread(`/shared/materiales/obras/${obraId}/catalogo/meta`);
  const items = await rread(`/shared/materiales/obras/${obraId}/catalogo/items`);
  return { meta, items: items || {} };
}

// === Requisiciones (solo lectura desde compras) ===
//
// Las escribe app-materiales bajo /shared/materiales/obras/{obraId}/requisiciones.
// Compras las consume vía buzón (tipo='requisicion_materiales') una vez que
// el almacenista las "envía". Esta lectura directa es para el detalle: cuando
// compras abre un item del buzón, hidrata con los datos vivos de la requisición
// (porque el almacenista pudo haber editado items entre que envió y compras
// los toma — aunque lo correcto es bloquear edición, defendemos contra eso).

export async function getRequisicionMateriales(obraId, reqId) {
  return await rread(`/shared/materiales/obras/${obraId}/requisiciones/${reqId}`);
}
export async function setRequisicionOcRef(obraId, reqId, patch) {
  // Patch parcial: { ocBuzonId?, ocId?, estado? }. Se invoca al emitir o
  // cancelar OC para mantener referencia bidireccional.
  return rupdate(`/shared/materiales/obras/${obraId}/requisiciones/${reqId}`,
    { ...patch, updatedAt: Date.now() });
}

// === Buzón cross-app ===
//
// /shared/buzon es el bus de aprobación entre apps. Compras lo usa así:
//   - LEE items con tipo='requisicion_materiales' (publicados por materiales
//     al enviar la requisición) y los muestra en su inbox.
//   - PUBLICA items con tipo='oc_materiales' al emitir una OC para que
//     bitácora los apruebe y genere el gasto contable.

export async function listBuzon() {
  return (await rread('/shared/buzon')) || {};
}
export function watchBuzon(cb) {
  return rwatch('/shared/buzon', cb);
}
export async function getBuzonItem(itemId) {
  return await rread(`/shared/buzon/${itemId}`);
}
export async function pushBuzonItem(item) {
  return rpush('/shared/buzon', { ...item, creadoAt: Date.now() });
}
export async function updateBuzonItem(itemId, patch) {
  return rupdate(`/shared/buzon/${itemId}`, { ...patch, actualizadoAt: Date.now() });
}
export async function deleteBuzonItem(itemId) {
  return rremove(`/shared/buzon/${itemId}`);
}

// Filtra el dump del buzón por tipo y obra. Los items que esta app consume
// llevan obraId en el payload (lo pone materiales al publicar).
export function filtrarBuzon(buzon, { tipo, obraId, estado, estadosIn } = {}) {
  const out = {};
  for (const [id, item] of Object.entries(buzon || {})) {
    if (tipo && item.tipo !== tipo) continue;
    if (obraId && item.obraId !== obraId) continue;
    if (estado && item.estado !== estado) continue;
    if (estadosIn && !estadosIn.includes(item.estado)) continue;
    out[id] = item;
  }
  return out;
}

// === Proveedores (lectura/escritura compatible con bitácora) ===
//
// Decisión 2 del 2026-05-06: arrancar con lectura/escritura compatible con
// bitácora hasta que se migre a /shared/proveedores/*. Bitácora almacena
// /legacy/bitacora/sogrub_proveedores como ARRAY de objetos, donde cada
// item tiene { id: UUID, nombre, rfc, telefono, email, notas }. Las escrituras
// reescriben el array completo (mismo patrón que appsogrub/firebase.js).
//
// Para evitar inconsistencias con escrituras concurrentes (raro pero posible),
// las funciones de mutación leen-modifican-escriben en una sola operación;
// no usan transaction() porque el shape array no se presta bien.

export async function listProveedoresGlobal() {
  const raw = await rread('/legacy/bitacora/sogrub_proveedores');
  return Array.isArray(raw) ? raw : [];
}

export async function getProveedor(provId) {
  const list = await listProveedoresGlobal();
  return list.find(p => p.id === provId) || null;
}

export async function addProveedorGlobal({ nombre, rfc = '', telefono = '', email = '', notas = '' }) {
  const list = await listProveedoresGlobal();
  const id = crypto.randomUUID();
  const item = { id, nombre, rfc, telefono, email, notas };
  list.push(item);
  await rset('/legacy/bitacora/sogrub_proveedores', list);
  return item;
}

export async function updateProveedorGlobal(provId, patch) {
  const list = await listProveedoresGlobal();
  const idx = list.findIndex(p => p.id === provId);
  if (idx === -1) throw new Error('Proveedor no encontrado');
  list[idx] = { ...list[idx], ...patch };
  await rset('/legacy/bitacora/sogrub_proveedores', list);
  return list[idx];
}

export async function deleteProveedorGlobal(provId) {
  const list = await listProveedoresGlobal();
  const filtered = list.filter(p => p.id !== provId);
  if (filtered.length === list.length) return false;
  await rset('/legacy/bitacora/sogrub_proveedores', filtered);
  return true;
}

// === Material ad-hoc creado desde compras ===
//
// Decisión 5: items ad-hoc se diferencian por origen. Compras puede crear
// materiales que no estaban en el catálogo OPUS (sustituciones, agregados
// del comprador). Se persiste en /shared/materiales/obras/{obraId}/catalogo/items
// para que el almacenista los vea con badge distintivo.
//
// Nota: el catálogo de materiales lo escribe materiales como autoritativo;
// compras agrega items por excepción. Mantener `origen: 'ad_hoc_compras'` para
// que el preservador de catálogo en saveCatalogoMateriales no los borre al
// re-importar el XLS de OPUS (ya preserva todo lo que no sea 'opus').

export async function createMaterialAdHocDesdeCompras(obraId, materialKey, data, autor) {
  const item = {
    ...data,
    origen: 'ad_hoc_compras',
    creadoPor: autor || null,
    creadoAt: Date.now()
  };
  await rset(`/shared/materiales/obras/${obraId}/catalogo/items/${materialKey}`, item);
  return item;
}

// === Cotizaciones (esta app es escritor único, MVP) ===
//
// Modelo:
//   /shared/compras/obras/{obraId}/cotizaciones/{cotId}:
//     reqIds: [reqId, ...],          // requisiciones que cubre la cotización
//     proveedor: { id?, nombre, rfc?, contacto?, telefono?, email? },
//     fechaCotizacion, vigenciaDias?,
//     items: { [itemId]: { materialKey, clave?, descripcion?, unidad?,
//                          cantidad, costoUnitario, importe, conceptoKey?,
//                          origen: 'opus'|'ad_hoc_compras'|'ad_hoc_materiales',
//                          notas? } },
//     subtotal, ivaPct, ivaImporte, retenciones?, total, incluyeIva,
//     estado: 'borrador' | 'recibida' | 'ganadora' | 'descartada',
//     createdAt, updatedAt, autor: { uid, displayName, email }

export async function listCotizaciones(obraId) {
  return (await rread(`obras/${obraId}/cotizaciones`)) || {};
}
export async function getCotizacion(obraId, cotId) {
  return await rread(`obras/${obraId}/cotizaciones/${cotId}`);
}
export async function createCotizacion(obraId, data) {
  return rpush(`obras/${obraId}/cotizaciones`, {
    ...data,
    items: data.items || {},
    estado: data.estado || 'borrador',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}
export async function updateCotizacion(obraId, cotId, patch) {
  return rupdate(`obras/${obraId}/cotizaciones/${cotId}`, { ...patch, updatedAt: Date.now() });
}
export async function deleteCotizacion(obraId, cotId) {
  return rremove(`obras/${obraId}/cotizaciones/${cotId}`);
}

// === Cobertura de requisición ===
//
// Una requisición se puede satisfacer con varias cotizaciones/OC (de uno o
// varios proveedores). Esta función calcula, para una req del buzón, cuánta
// cantidad de cada material ya está comprometida en OCs activas y cuánto
// queda por cubrir.
//
// OCs "activas" = todas excepto canceladas/rechazadas. Las pagadas, aprobadas
// y enviada_buzon SÍ comprometen cantidad (ya la cubren).

const OC_ESTADOS_NO_ACTIVOS = new Set(['cancelada', 'rechazada']);

export function calcularCoberturaReq(reqBuzonItem, ocs) {
  const reqItems = reqBuzonItem?.items || {};
  const reqId = reqBuzonItem?.reqId || null;
  const reqBuzonId = reqBuzonItem?.id || null;

  // Pedido por materialKey (suma cantidades porque la req puede tener
  // 2 líneas del mismo material a distintos conceptos)
  const pedido = {};
  for (const it of Object.values(reqItems)) {
    if (!it.materialKey) continue;
    pedido[it.materialKey] = (pedido[it.materialKey] || 0) + (Number(it.cantidad) || 0);
  }

  // Cubierto por OC activas que cubren esta req
  const cubierto = {};
  for (const oc of Object.values(ocs || {})) {
    if (!oc) continue;
    if (OC_ESTADOS_NO_ACTIVOS.has(oc.estado)) continue;
    const cubreEstaReq = (oc.reqIds || []).some(rid =>
      rid === reqBuzonId || rid === reqId
    );
    if (!cubreEstaReq) continue;
    for (const it of Object.values(oc.items || {})) {
      if (!it.materialKey) continue;
      cubierto[it.materialKey] = (cubierto[it.materialKey] || 0) + (Number(it.cantidad) || 0);
    }
  }

  const byMaterial = {};
  let totalPedido = 0, totalCubierto = 0;
  for (const [mk, ped] of Object.entries(pedido)) {
    const cub = cubierto[mk] || 0;
    const cap = Math.min(cub, ped);  // No "sobrecubre" en el cálculo de %
    byMaterial[mk] = {
      pedido: ped,
      cubierto: cub,
      cubiertoCap: cap,
      restante: Math.max(0, ped - cub),
      pct: ped > 0 ? cap / ped : 0
    };
    totalPedido += ped;
    totalCubierto += cap;
  }

  return {
    byMaterial,
    pct: totalPedido > 0 ? totalCubierto / totalPedido : 0,
    totalPedido,
    totalCubierto,
    completa: totalPedido > 0 && totalCubierto >= totalPedido
  };
}

// === Órdenes de compra (esta app es escritor único) ===
//
// Modelo:
//   /shared/compras/obras/{obraId}/oc/{ocId}:
//     numero, folio: 'OC-YYYY-NNN',
//     reqIds: [reqId, ...],
//     cotizacionGanadoraId?,
//     proveedor: { id?, nombre, rfc?, ... },
//     fechaEmision, fechaEntregaEstimada?, condicionesPago,
//     items: { [itemId]: { materialKey, clave?, descripcion?, unidad?,
//                          cantidad, costoUnitario, importe, conceptoKey?,
//                          origen, notas? } },
//     subtotal, ivaPct, ivaImporte, retenciones?, total, incluyeIva,
//     comentariosCompras?,
//     estado: 'borrador' | 'enviada_buzon' | 'aprobada' | 'pagada' |
//             'cerrada' | 'rechazada' | 'cancelada',
//     buzonId?, enviadaBuzonAt?,
//     createdAt, updatedAt, autor

export async function listOC(obraId) {
  return (await rread(`obras/${obraId}/oc`)) || {};
}
export async function getOC(obraId, ocId) {
  return await rread(`obras/${obraId}/oc/${ocId}`);
}
export async function createOC(obraId, data) {
  const all = await rread(`obras/${obraId}/oc`) || {};
  const numero = Math.max(0, ...Object.values(all).map(o => o.numero || 0)) + 1;
  return rpush(`obras/${obraId}/oc`, {
    ...data,
    numero,
    items: data.items || {},
    estado: data.estado || 'borrador',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}
export async function updateOC(obraId, ocId, patch) {
  return rupdate(`obras/${obraId}/oc/${ocId}`, { ...patch, updatedAt: Date.now() });
}
export async function deleteOC(obraId, ocId) {
  return rremove(`obras/${obraId}/oc/${ocId}`);
}
