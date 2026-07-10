import {
  ref, get, set, update, push, remove, onValue, off
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import { db } from './firebase.js?v=20260619';
import { APP_BASE_PATH } from '../config/firebase-config.js?v=20260619';

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

// OAuth Client ID (Google Identity Services) para subir documentos de proveedor
// a Drive desde el navegador. Vive en /shared/compras/config/googleClientId.
export async function getGoogleClientId() {
  return (await rread('config/googleClientId')) || '';
}
export async function setGoogleClientId(id) {
  return rset('config/googleClientId', (id || '').trim());
}

// Datos fiscales de SOGRUB para la leyenda "solicitud de factura" en las OC.
// { razonSocial, rfc, regimen, domicilio, usoCfdi, correoFacturas }
export async function getFacturacion() {
  return (await rread('config/facturacion')) || {};
}
export async function setFacturacion(data) {
  return rset('config/facturacion', data || {});
}

export async function getProveedor(provId) {
  const list = await listProveedoresGlobal();
  return list.find(p => p.id === provId) || null;
}

export async function addProveedorGlobal({
  nombre, rfc = '', telefono = '', email = '', notas = '',
  clasificacion = '', clabe = '', medioPago = '', documentos = {}
}) {
  const list = await listProveedoresGlobal();
  const id = crypto.randomUUID();
  const item = { id, nombre, rfc, telefono, email, notas, clasificacion, clabe, medioPago, documentos };
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

// === Proveedores por obra (sogrub_proy_proveedores) ===
//
// Bitácora maneja la relación proveedor↔proyecto en /legacy/bitacora/sogrub_proy_proveedores
// como ARRAY de { id, proyecto_id, nombre, proveedor_global_id?, rfc?, ...}.
// Compras escribe el mismo path para mantener consistencia. La traducción
// obraId → proyectoId pasa por /shared/obraLinks (mismo patrón que bitácora).

export async function getProyectoIdByObraId(obraId) {
  if (!obraId) return null;
  return await rread(`/shared/obraLinks/${obraId}`);
}

export async function listProveedoresProy(proyectoId) {
  const all = await rread('/legacy/bitacora/sogrub_proy_proveedores');
  if (!Array.isArray(all)) return [];
  return all.filter(p => p && p.proyecto_id === proyectoId);
}

// Lista por obra resolviendo el proyecto contable. Devuelve [] si la obra no
// está vinculada a ningún proyecto (común al inicio).
export async function listProveedoresObra(obraId) {
  const proyectoId = await getProyectoIdByObraId(obraId);
  if (!proyectoId) return { proyectoId: null, items: [] };
  const items = await listProveedoresProy(proyectoId);
  return { proyectoId, items };
}

async function _saveProyProveedoresArray(arr) {
  await rset('/legacy/bitacora/sogrub_proy_proveedores', arr);
}

export async function addProveedorAObra(obraId, data) {
  const proyectoId = await getProyectoIdByObraId(obraId);
  if (!proyectoId) throw new Error('Esta obra no está vinculada a un proyecto contable');
  const all = (await rread('/legacy/bitacora/sogrub_proy_proveedores')) || [];
  const arr = Array.isArray(all) ? [...all] : [];
  const id = crypto.randomUUID();
  const item = {
    id,
    proyecto_id: proyectoId,
    nombre: data.nombre,
    rfc: data.rfc || '',
    telefono: data.telefono || '',
    email: data.email || '',
    contacto: data.contacto || '',
    notas: data.notas || '',
    // Régimen fiscal: si el proveedor acepta vender sin factura (sin IVA),
    // sus precios se comparan directo contra el catálogo OPUS. Si no
    // (Home Depot, etc.), sus precios YA incluyen IVA y se comparan contra
    // catálogo OPUS × 1.16. Default true para backward compat.
    aceptaSinIva: data.aceptaSinIva !== false,
    proveedor_global_id: data.proveedor_global_id || null,
    creadoAt: Date.now(),
    creadoPorApp: 'compras'
  };
  arr.push(item);
  await _saveProyProveedoresArray(arr);
  return item;
}

export async function updateProveedorObra(provObraId, patch) {
  const all = (await rread('/legacy/bitacora/sogrub_proy_proveedores')) || [];
  const arr = Array.isArray(all) ? [...all] : [];
  const idx = arr.findIndex(p => p.id === provObraId);
  if (idx === -1) throw new Error('Proveedor de obra no encontrado');
  arr[idx] = { ...arr[idx], ...patch, actualizadoAt: Date.now() };
  await _saveProyProveedoresArray(arr);
  return arr[idx];
}

export async function removeProveedorObra(provObraId) {
  const all = (await rread('/legacy/bitacora/sogrub_proy_proveedores')) || [];
  const arr = Array.isArray(all) ? [...all] : [];
  const filtered = arr.filter(p => p.id !== provObraId);
  if (filtered.length === arr.length) return false;
  await _saveProyProveedoresArray(filtered);
  return true;
}

export async function getProveedorObra(provObraId) {
  const all = await rread('/legacy/bitacora/sogrub_proy_proveedores');
  if (!Array.isArray(all)) return null;
  return all.find(p => p.id === provObraId) || null;
}

// Merge proveedor de obra + catálogo global. Si el proveedor de obra está
// vinculado al global (proveedor_global_id), los datos canónicos
// (nombre, RFC, teléfono, email) salen del global — el catálogo global es
// la fuente de verdad para identidad fiscal y contacto principal.
// Los campos `contacto` y `notas` pueden ser overrides locales (específicos
// de la obra); si están vacíos, también se cae al global.
//
// Estructura resultante:
//   { ...provObra, nombre, rfc, telefono, email, contacto, notas,
//     _fuenteCanonica: 'global' | 'obra',
//     _global: <objeto del global o null> }
export function mergeProveedorObraConGlobal(provObra, globales) {
  if (!provObra) return null;
  // Régimen fiscal: si la obra tiene la propiedad definida, gana lo de obra
  // (puede variar por relación comercial). Si no, fallback al global. Si
  // ningún lado lo tiene, default true (acepta sin IVA — backward compat).
  const resolveAceptaSinIva = (g) => {
    if (typeof provObra.aceptaSinIva === 'boolean') return provObra.aceptaSinIva;
    if (g && typeof g.aceptaSinIva === 'boolean') return g.aceptaSinIva;
    return true;
  };
  const g = provObra.proveedor_global_id
    ? (globales || []).find(x => x.id === provObra.proveedor_global_id)
    : null;
  if (!g) {
    return { ...provObra, aceptaSinIva: resolveAceptaSinIva(null), _fuenteCanonica: 'obra', _global: null };
  }
  const pickGlobal = (key) => g[key] || provObra[key] || '';
  const pickObraFirst = (key) => provObra[key] || g[key] || '';
  return {
    ...provObra,
    nombre:   g.nombre || provObra.nombre,
    rfc:      pickGlobal('rfc'),
    telefono: pickGlobal('telefono'),
    email:    pickGlobal('email'),
    contacto: pickObraFirst('contacto'),
    notas:    pickObraFirst('notas'),
    aceptaSinIva: resolveAceptaSinIva(g),
    _fuenteCanonica: 'global',
    _global: g
  };
}

// Importar uno o varios proveedores globales como proveedores de obra.
// Si un proveedor global ya está vinculado a la obra (mismo proveedor_global_id
// o mismo nombre), se omite para evitar duplicados.
export async function importarProveedoresGlobales(obraId, globalIds) {
  const proyectoId = await getProyectoIdByObraId(obraId);
  if (!proyectoId) throw new Error('Esta obra no está vinculada a un proyecto contable');
  const globales = await listProveedoresGlobal();
  const all = (await rread('/legacy/bitacora/sogrub_proy_proveedores')) || [];
  const arr = Array.isArray(all) ? [...all] : [];
  const yaEnProy = new Set(arr
    .filter(p => p.proyecto_id === proyectoId)
    .map(p => p.proveedor_global_id || p.nombre));

  const importados = [];
  for (const gid of globalIds) {
    const g = globales.find(x => x.id === gid);
    if (!g) continue;
    if (yaEnProy.has(g.id) || yaEnProy.has(g.nombre)) continue;
    const item = {
      id: crypto.randomUUID(),
      proyecto_id: proyectoId,
      proveedor_global_id: g.id,
      nombre: g.nombre,
      rfc: g.rfc || '',
      telefono: g.telefono || '',
      email: g.email || '',
      contacto: '',
      notas: g.notas || '',
      creadoAt: Date.now(),
      creadoPorApp: 'compras'
    };
    arr.push(item);
    importados.push(item);
  }
  if (importados.length > 0) await _saveProyProveedoresArray(arr);
  return importados;
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

// === Subcontratos ===
//
// Path: /shared/compras/obras/{obraId}/subcontratos/{scId}
//
// Un subcontrato es como una OC pero para conceptos OPUS (no materiales del
// almacén): cubre mano de obra + materiales + equipo de un alcance específico,
// y se ejecuta a lo largo del tiempo en estimaciones parciales que las hace
// la app de estimaciones (lectora del subcontrato adjudicado).
//
// Shape:
//   meta: { nombre, descripcion, estado: 'cotizando'|'adjudicado'|'cerrado',
//           licitanteAdjudicadoId, adjudicadoAt, createdAt, updatedAt, autor }
//   conceptos: { [cid]: { conceptoId, cantidad, notas? } }
//   licitantes: {
//     [licId]: {
//       provId,                  // id del proveedor (global o de obra)
//       nombre, rfc, email, telefono, contacto,
//       precios: { [conceptoId]: precio_unitario },
//       notas, fechaCotizacion, archivado,
//       aceptaSinIva               // heredado del proveedor al agregar
//     }
//   }
//
// El catálogo de licitantes es la lista de proveedores de obra: para agregar
// un licitante, el comprador elige un proveedor existente (o crea uno nuevo,
// que se da de alta como proveedor de obra). Mantenemos snapshot de datos
// del proveedor en el licitante para no romper si después se borra del
// catálogo global.

export async function listSubcontratos(obraId) {
  return (await rread(`obras/${obraId}/subcontratos`)) || {};
}
export async function getSubcontrato(obraId, scId) {
  return await rread(`obras/${obraId}/subcontratos/${scId}`);
}
export async function createSubcontrato(obraId, data, autor) {
  return rpush(`obras/${obraId}/subcontratos`, {
    meta: {
      nombre: data.nombre || 'Subcontrato',
      descripcion: data.descripcion || '',
      estado: 'cotizando',
      licitanteAdjudicadoId: null,
      adjudicadoAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autor: autor || null
    },
    conceptos: data.conceptos || {},
    licitantes: data.licitantes || {}
  });
}
export async function updateSubcontratoMeta(obraId, scId, patch) {
  return rupdate(`obras/${obraId}/subcontratos/${scId}/meta`,
    { ...patch, updatedAt: Date.now() });
}
export async function deleteSubcontrato(obraId, scId) {
  return rremove(`obras/${obraId}/subcontratos/${scId}`);
}

// Conceptos del alcance
export async function setSubcontratoConceptos(obraId, scId, conceptos) {
  await rset(`obras/${obraId}/subcontratos/${scId}/conceptos`, conceptos);
  await updateSubcontratoMeta(obraId, scId, {});  // touch updatedAt
}
export async function addSubcontratoConcepto(obraId, scId, data) {
  const id = 'cn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  await rset(`obras/${obraId}/subcontratos/${scId}/conceptos/${id}`, {
    conceptoId: data.conceptoId,
    cantidad: Number(data.cantidad) || 0,
    // Costo aproximado de material/equipo que SOGRUB pondría si se contrata
    // a un destajista (solo MO). Se suma al precio del destajista para
    // comparar justo contra subcontratistas completos.
    costoMaterialSogrub: Number(data.costoMaterialSogrub) || 0,
    notas: data.notas || ''
  });
  await updateSubcontratoMeta(obraId, scId, {});
  return id;
}

export async function addSubcontratoConceptosBulk(obraId, scId, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const ids = [];
  await Promise.all(items.map(async (data) => {
    const id = 'cn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    await rset(`obras/${obraId}/subcontratos/${scId}/conceptos/${id}`, {
      conceptoId: data.conceptoId,
      cantidad: Number(data.cantidad) || 0,
      costoMaterialSogrub: Number(data.costoMaterialSogrub) || 0,
      notas: data.notas || ''
    });
    ids.push(id);
  }));
  await updateSubcontratoMeta(obraId, scId, {});
  return ids;
}
export async function updateSubcontratoConcepto(obraId, scId, cid, patch) {
  await rupdate(`obras/${obraId}/subcontratos/${scId}/conceptos/${cid}`, patch);
  await updateSubcontratoMeta(obraId, scId, {});
}
export async function removeSubcontratoConcepto(obraId, scId, cid) {
  await rremove(`obras/${obraId}/subcontratos/${scId}/conceptos/${cid}`);
  await updateSubcontratoMeta(obraId, scId, {});
}

// Licitantes (snapshot de proveedor + sus precios para los conceptos del alcance)
//
// tipoSubcontratacion:
//   'subcontrato' (default): licitante suministra mano de obra + material + equipo.
//                            Su precio cotizado se compara directo contra catálogo.
//   'destajo':               licitante solo suministra mano de obra. SOGRUB pone
//                            material y equipo. Su precio cotizado es solo MO y
//                            para comparar se le suma el costoMaterialSogrub
//                            capturado por concepto en el alcance.
export async function addSubcontratoLicitante(obraId, scId, data) {
  const r = await rpush(`obras/${obraId}/subcontratos/${scId}/licitantes`, {
    provId: data.provId || null,
    nombre: data.nombre || '',
    rfc: data.rfc || '',
    email: data.email || '',
    telefono: data.telefono || '',
    contacto: data.contacto || '',
    aceptaSinIva: data.aceptaSinIva !== false,
    tipoSubcontratacion: data.tipoSubcontratacion || 'subcontrato',
    precios: data.precios || {},
    notas: data.notas || '',
    fechaCotizacion: data.fechaCotizacion || Date.now(),
    archivado: false
  });
  await updateSubcontratoMeta(obraId, scId, {});
  return r;
}
export async function updateSubcontratoLicitante(obraId, scId, licId, patch) {
  await rupdate(`obras/${obraId}/subcontratos/${scId}/licitantes/${licId}`, patch);
  await updateSubcontratoMeta(obraId, scId, {});
}
export async function setSubcontratoLicitantePrecio(obraId, scId, licId, conceptoId, precio) {
  await rset(`obras/${obraId}/subcontratos/${scId}/licitantes/${licId}/precios/${conceptoId}`,
    Number(precio) || 0);
  await updateSubcontratoMeta(obraId, scId, {});
}
export async function setSubcontratoLicitantePrecios(obraId, scId, licId, precios) {
  await rset(`obras/${obraId}/subcontratos/${scId}/licitantes/${licId}/precios`, precios || {});
  await updateSubcontratoMeta(obraId, scId, {});
}
export async function removeSubcontratoLicitante(obraId, scId, licId) {
  await rremove(`obras/${obraId}/subcontratos/${scId}/licitantes/${licId}`);
  await updateSubcontratoMeta(obraId, scId, {});
}

// === Migración legacy de subcontratos (Fase 3) ===
//
// app-estimaciones fue el escritor original de subcontratos antes de que
// compras tomara el control. Los datos viejos viven en
// /legacy/estimaciones/obras/{obraId}/subcontratos/ con shape distinto:
//   conceptos: [{ conceptoId, cantidadSub }]
//   licitantes: { [licId]: { nombre, email, precios, ... } }   (sin tipoSub, sin RFC)
//
// La migración copia cada subcontrato legacy NO migrado a
// /shared/compras/obras/{obraId}/subcontratos/{scId} preservando el mismo
// scId — eso es crítico para que las estimaciones parciales (que se quedan
// viviendo en el path legacy) sigan ligadas al subcontrato adaptado.
//
// Marcamos el legacy con `meta.migradoACompras=<scId>` para no migrar dos
// veces y para que la app de estimaciones sepa que ese registro ya es solo
// histórico del shape viejo (loadObra ya prioriza el del shared).

export async function listSubcontratosLegacy(obraId) {
  return (await rread(`/legacy/estimaciones/obras/${obraId}/subcontratos`)) || {};
}

export async function listSubcontratosLegacyCandidatos(obraId) {
  const [legacy, shared] = await Promise.all([
    listSubcontratosLegacy(obraId),
    rread(`obras/${obraId}/subcontratos`)
  ]);
  const yaEnShared = new Set(Object.keys(shared || {}));
  const out = [];
  for (const [scId, sc] of Object.entries(legacy)) {
    if (!sc) continue;
    if (yaEnShared.has(scId)) continue;
    if (sc.meta?.migradoACompras) continue;
    out.push({ scId, sub: sc });
  }
  return out;
}

// Convierte un subcontrato legacy al shape de compras y lo escribe con el
// MISMO scId. Las estimaciones parciales no se tocan — siguen en
// /legacy/estimaciones/obras/{obraId}/subcontratos/{scId}/estimaciones y
// estimaciones las hidrata transparentemente al cargar la obra.
export async function migrarSubcontratoLegacy(obraId, scId, legacySub) {
  // Conceptos: array → objeto. Generamos IDs estables basados en el conceptoId
  // para que re-migraciones produzcan las mismas keys (idempotente).
  const conceptosObj = {};
  for (const cs of (legacySub.conceptos || [])) {
    if (!cs?.conceptoId) continue;
    const cid = 'cn_mig_' + String(cs.conceptoId).replace(/[^a-z0-9]/gi, '').slice(0, 16);
    // Evitar colisiones si el mismo conceptoId aparece dos veces
    let suffix = 0;
    let finalKey = cid;
    while (conceptosObj[finalKey]) {
      suffix++;
      finalKey = `${cid}_${suffix}`;
    }
    conceptosObj[finalKey] = {
      conceptoId: cs.conceptoId,
      cantidad: Number(cs.cantidadSub) || 0,
      costoMaterialSogrub: 0,
      notas: cs.notas || ''
    };
  }

  // Licitantes: preservar keys. Agregar campos nuevos con defaults sensatos
  // (subcontrato completo, sin IVA, sin provId — el comprador puede vincular
  // al catálogo de proveedores después).
  const licitantesObj = {};
  for (const [licId, lic] of Object.entries(legacySub.licitantes || {})) {
    if (!lic) continue;
    licitantesObj[licId] = {
      provId: null,
      nombre: lic.nombre || '',
      rfc: lic.rfc || '',
      email: lic.email || '',
      telefono: lic.telefono || '',
      contacto: lic.contacto || '',
      aceptaSinIva: true,
      tipoSubcontratacion: 'subcontrato',
      precios: lic.precios || {},
      notas: lic.notas || '',
      fechaCotizacion: lic.fechaCotizacion || Date.now(),
      archivado: !!lic.archivado,
      licCatalogId: lic.licCatalogId || null   // referencia al catálogo viejo, audit
    };
  }

  const adjudicado = legacySub.meta?.estado === 'adjudicado' && legacySub.meta?.licitanteAdjudicadoId;
  await rset(`obras/${obraId}/subcontratos/${scId}`, {
    meta: {
      nombre: legacySub.meta?.nombre || 'Subcontrato (migrado)',
      descripcion: legacySub.meta?.descripcion || '',
      estado: adjudicado ? 'adjudicado' : 'cotizando',
      licitanteAdjudicadoId: legacySub.meta?.licitanteAdjudicadoId || null,
      adjudicadoAt: legacySub.meta?.adjudicadoAt || null,
      createdAt: legacySub.meta?.createdAt || Date.now(),
      updatedAt: Date.now(),
      migradoDesdeLegacy: true,
      migradoAt: Date.now()
    },
    conceptos: conceptosObj,
    licitantes: licitantesObj
  });

  // Marcar el legacy para no re-migrar
  await rupdate(`/legacy/estimaciones/obras/${obraId}/subcontratos/${scId}/meta`, {
    migradoACompras: scId,
    migradoAt: Date.now()
  });

  return scId;
}

// Migra todos (o un subset) de los subcontratos legacy candidatos.
// `scIds` es opcional: si se omite, migra TODOS los candidatos.
export async function migrarSubcontratosLegacy(obraId, scIds = null) {
  const candidatos = await listSubcontratosLegacyCandidatos(obraId);
  const target = scIds
    ? candidatos.filter(c => scIds.includes(c.scId))
    : candidatos;
  const migrados = [];
  for (const { scId, sub } of target) {
    try {
      await migrarSubcontratoLegacy(obraId, scId, sub);
      migrados.push({ scId, nombre: sub.meta?.nombre || '' });
    } catch (err) {
      console.error(`[migración] fallo en ${scId}:`, err);
    }
  }
  return migrados;
}

// Adjudicación
export async function adjudicarSubcontrato(obraId, scId, licId) {
  await updateSubcontratoMeta(obraId, scId, {
    estado: 'adjudicado',
    licitanteAdjudicadoId: licId,
    adjudicadoAt: Date.now()
  });
}
export async function desadjudicarSubcontrato(obraId, scId) {
  await updateSubcontratoMeta(obraId, scId, {
    estado: 'cotizando',
    licitanteAdjudicadoId: null,
    adjudicadoAt: null
  });
}

// === Solicitudes de cotización (presets) ===
//
// Path: /shared/compras/obras/{obraId}/solicitudesCotizacion/{solId}
//
// Persistencia de listas armadas en la vista "Solicitar cotización" para
// poder reabrirlas, editarlas o regenerar el PDF sin volver a llenar todo.
// No están vinculadas al flujo formal — son utilidades del comprador.
//
// Shape:
//   { nombre, destinatario: {...}, terminos: {...},
//     items: { [materialKey]: { cantidad, notasItem } },
//     creadoAt, actualizadoAt, autor, pdfGeneradoAt? }

export async function listSolicitudesCotizacion(obraId) {
  return (await rread(`obras/${obraId}/solicitudesCotizacion`)) || {};
}
export async function getSolicitudCotizacion(obraId, solId) {
  return await rread(`obras/${obraId}/solicitudesCotizacion/${solId}`);
}
export async function createSolicitudCotizacion(obraId, data) {
  return rpush(`obras/${obraId}/solicitudesCotizacion`, {
    ...data,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}
export async function updateSolicitudCotizacion(obraId, solId, patch) {
  return rupdate(`obras/${obraId}/solicitudesCotizacion/${solId}`, {
    ...patch,
    updatedAt: Date.now()
  });
}
export async function deleteSolicitudCotizacion(obraId, solId) {
  return rremove(`obras/${obraId}/solicitudesCotizacion/${solId}`);
}

// === Catálogo de precios pre-cotización ===
//
// Path: /shared/compras/obras/{obraId}/preciosCatalogo/{provId}/{materialKey}
//
// Mecanismo para capturar precios de proveedor por material ANTES de que
// llegue una requisición — sirve para tener un "catálogo de precios" listo
// y deliberar rápido cuando llegan pedidos. Cada entrada:
//   { precio, fecha, capturadoPor, notas?, disponible? }
//
// disponible=false marca explícitamente que el proveedor NO maneja ese
// material (útil para distinguir "no lo tiene" de "no he preguntado").

export async function listPreciosCatalogo(obraId) {
  return (await rread(`obras/${obraId}/preciosCatalogo`)) || {};
}

export async function listPreciosCatalogoProveedor(obraId, provId) {
  return (await rread(`obras/${obraId}/preciosCatalogo/${provId}`)) || {};
}

export async function setPrecioCatalogo(obraId, provId, materialKey, data) {
  return rset(`obras/${obraId}/preciosCatalogo/${provId}/${materialKey}`, {
    ...data,
    fecha: data.fecha || Date.now()
  });
}

export async function removePrecioCatalogo(obraId, provId, materialKey) {
  return rremove(`obras/${obraId}/preciosCatalogo/${provId}/${materialKey}`);
}

// Bulk: para una matriz capturada en la vista catálogo-precios, sube los
// cambios. `updates` es un array de { provId, materialKey, data | null }
// (null = remover).
export async function bulkSavePreciosCatalogo(obraId, updates, autor) {
  await Promise.all(updates.map(u => {
    if (u.data === null) {
      return rremove(`obras/${obraId}/preciosCatalogo/${u.provId}/${u.materialKey}`);
    }
    return rset(`obras/${obraId}/preciosCatalogo/${u.provId}/${u.materialKey}`, {
      ...u.data,
      capturadoPor: u.data.capturadoPor || autor || null,
      fecha: u.data.fecha || Date.now()
    });
  }));
}

// === Sugerencia de proveedores por requisición ===
//
// Para cada proveedor de la obra (más cualquier proveedor texto-libre que
// haya cotizado), construye el set de precios conocidos por materialKey
// — usando la última cotización vista, fallback a OC si la cotización no
// tiene el material. Identidad: proveedor_global_id si está, si no nombre
// lowercase (mismo criterio que matchesProv).
//
// Devuelve un Map<id|nombre, { provId, _provObraId?, nombre, precios: {[mk]: {precio, fecha, fuente, cotId|ocId, estado}} }>

export async function buildPreciosPorProveedorObra(obraId) {
  const [cotizaciones, ocs, provObra, preciosCat] = await Promise.all([
    listCotizaciones(obraId),
    listOC(obraId),
    listProveedoresObra(obraId),
    listPreciosCatalogo(obraId)
  ]);

  // Map clave → entrada. La misma entrada puede tener 2 claves (id + nombre).
  const byKey = new Map();
  // Set de identidades únicas para deduplicar al final
  const uniques = new Map();

  function getOrCreate({ id, nombre, provObraRecord }) {
    const idKey = id || null;
    const nameKey = (nombre || '').toLowerCase();
    let entry = (idKey && byKey.get(idKey)) || (nameKey && byKey.get(nameKey));
    if (entry) return entry;
    entry = {
      provId: idKey,
      _provObraId: provObraRecord?.id || null,
      nombre: nombre || '(sin nombre)',
      _adHoc: !provObraRecord,
      precios: {}
    };
    if (idKey) byKey.set(idKey, entry);
    if (nameKey) byKey.set(nameKey, entry);
    const dedupKey = idKey || nameKey;
    if (!uniques.has(dedupKey)) uniques.set(dedupKey, entry);
    return entry;
  }

  // Sembramos con los proveedores formales de la obra (aunque no tengan
  // cotizaciones todavía aparecen en el lookup con precios={}).
  for (const p of (provObra.items || [])) {
    getOrCreate({
      id: p.proveedor_global_id || p.id,
      nombre: p.nombre,
      provObraRecord: p
    });
  }

  // Cotizaciones — más recientes primero para que ultimoPrecio sea el último visto.
  const cotEntries = Object.entries(cotizaciones).sort(([, a], [, b]) =>
    (b.fechaCotizacion || b.createdAt || 0) - (a.fechaCotizacion || a.createdAt || 0));
  for (const [cotId, c] of cotEntries) {
    const prov = getOrCreate({
      id: c.proveedor?.id,
      nombre: c.proveedor?.nombre
    });
    for (const it of Object.values(c.items || {})) {
      if (!it.materialKey) continue;
      if (prov.precios[it.materialKey]) continue;
      prov.precios[it.materialKey] = {
        precio: Number(it.costoUnitario) || 0,
        fecha: c.fechaCotizacion || c.createdAt,
        fuente: 'cotizacion',
        cotId,
        estado: c.estado
      };
    }
  }

  // OCs — fallback si la cotización no tenía el material (raro, pero posible
  // si la OC se editó manualmente).
  const ocEntries = Object.entries(ocs).sort(([, a], [, b]) =>
    (b.numero || 0) - (a.numero || 0));
  for (const [ocId, oc] of ocEntries) {
    if (oc.estado === 'cancelada' || oc.estado === 'rechazada') continue;
    const prov = getOrCreate({
      id: oc.proveedor?.id,
      nombre: oc.proveedor?.nombre
    });
    for (const it of Object.values(oc.items || {})) {
      if (!it.materialKey) continue;
      if (prov.precios[it.materialKey]) continue;
      prov.precios[it.materialKey] = {
        precio: Number(it.costoUnitario) || 0,
        fecha: oc.fechaEmision || oc.createdAt,
        fuente: 'oc',
        ocId,
        estado: oc.estado
      };
    }
  }

  // Catálogo de precios pre-cotización: fallback final para proveedores que
  // todavía no han cotizado formalmente pero sí tienen precio capturado en
  // /preciosCatalogo. La identidad de proveedor aquí es el provId (no nombre)
  // porque la vista de catálogo-precios siempre captura contra un proveedor
  // de la lista de obra (que tiene id).
  for (const [provId, mats] of Object.entries(preciosCat || {})) {
    if (!mats || typeof mats !== 'object') continue;
    const prov = getOrCreate({ id: provId, nombre: null });
    if (!prov) continue;
    // Si no encontró nombre, intenta hallarlo en la lista de obra
    if (!prov.nombre || prov.nombre === '(sin nombre)') {
      const p = (provObra.items || []).find(p => (p.proveedor_global_id || p.id) === provId);
      if (p) prov.nombre = p.nombre;
    }
    for (const [mk, entry] of Object.entries(mats)) {
      if (!entry || entry.disponible === false) continue;   // marca "no maneja"
      if (prov.precios[mk]) continue;     // cotización formal manda
      const precio = Number(entry.precio) || 0;
      if (precio <= 0) continue;
      prov.precios[mk] = {
        precio,
        fecha: entry.fecha || 0,
        fuente: 'catalogo',
        estado: 'capturado'
      };
    }
  }

  return uniques;
}

// Analiza una requisición contra los precios conocidos de proveedores.
// reqItem es el item del buzón con tipo='requisicion_materiales'.
// preciosPorProv es el resultado de buildPreciosPorProveedorObra.
// materialesCatalogo opcional para mostrar el precio OPUS de comparación.
//
// Considera la cobertura ya hecha por OCs anteriores: descuenta cantidades
// ya cubiertas para evaluar solo lo restante.
export function analizarReqVsProveedores(reqItem, preciosPorProv, materialesCatalogo, cobertura) {
  const items = reqItem?.items || {};
  const reqMateriales = {};   // materialKey → cantidad pendiente
  for (const it of Object.values(items)) {
    if (!it.materialKey) continue;
    reqMateriales[it.materialKey] = (reqMateriales[it.materialKey] || 0) + (Number(it.cantidad) || 0);
  }
  // Si hay cobertura previa, descontar
  if (cobertura?.byMaterial) {
    for (const mk of Object.keys(reqMateriales)) {
      const cov = cobertura.byMaterial[mk];
      if (cov) reqMateriales[mk] = Math.max(0, cov.restante);
    }
  }

  // Solo considerar materiales con cantidad > 0 (los completamente cubiertos
  // ya no necesitan más cotizaciones)
  const matKeys = Object.keys(reqMateriales).filter(mk => reqMateriales[mk] > 0);
  const provsArr = Array.from(preciosPorProv.values());

  // Por material: lista de ofertas ordenadas por precio
  const porMaterial = {};
  for (const mk of matKeys) {
    const cantidad = reqMateriales[mk];
    const ofertas = [];
    for (const p of provsArr) {
      const ent = p.precios[mk];
      if (!ent) continue;
      ofertas.push({
        provId: p.provId,
        nombre: p.nombre,
        precio: ent.precio,
        importe: cantidad * ent.precio,
        fuente: ent.fuente,
        fecha: ent.fecha,
        estado: ent.estado
      });
    }
    ofertas.sort((a, b) => a.precio - b.precio);
    porMaterial[mk] = {
      cantidad,
      precioCatalogo: Number(materialesCatalogo?.[mk]?.costoUnitario) || 0,
      ofertas,
      mejor: ofertas[0] || null
    };
  }

  // "Todo a un proveedor": para cada proveedor, qué cubre y costo
  const todoAUno = [];
  for (const p of provsArr) {
    if (matKeys.length === 0) break;
    let cubre = 0, totalProv = 0;
    const itemsCubre = [], itemsFalta = [];
    for (const mk of matKeys) {
      const cantidad = reqMateriales[mk];
      const ent = p.precios[mk];
      if (ent) {
        cubre++;
        totalProv += cantidad * ent.precio;
        itemsCubre.push({ materialKey: mk, cantidad, precio: ent.precio, importe: cantidad * ent.precio });
      } else {
        itemsFalta.push(mk);
      }
    }
    if (cubre > 0) {
      todoAUno.push({
        provId: p.provId,
        nombre: p.nombre,
        cubre,
        totalMateriales: matKeys.length,
        pctCobertura: cubre / matKeys.length,
        completo: cubre === matKeys.length,
        total: totalProv,
        itemsCubre,
        itemsFalta
      });
    }
  }
  // Ordenar: completos primero, luego por mayor cobertura, luego por menor total
  todoAUno.sort((a, b) => {
    if (a.completo !== b.completo) return a.completo ? -1 : 1;
    if (b.cubre !== a.cubre) return b.cubre - a.cubre;
    return a.total - b.total;
  });

  // Combinación óptima: para cada material elegir el proveedor más barato
  let optimoTotal = 0;
  const optimoCombinacion = [];
  const optimoFaltantes = [];
  for (const mk of matKeys) {
    const r = porMaterial[mk];
    if (r.mejor) {
      optimoTotal += r.mejor.importe;
      optimoCombinacion.push({
        materialKey: mk,
        cantidad: r.cantidad,
        provId: r.mejor.provId,
        nombreProv: r.mejor.nombre,
        precio: r.mejor.precio,
        importe: r.mejor.importe
      });
    } else {
      optimoFaltantes.push(mk);
    }
  }
  const optimoPorProv = {};
  for (const it of optimoCombinacion) {
    const k = it.provId || (it.nombreProv || '').toLowerCase();
    if (!optimoPorProv[k]) optimoPorProv[k] = { provId: it.provId, nombre: it.nombreProv, items: [], total: 0 };
    optimoPorProv[k].items.push(it);
    optimoPorProv[k].total += it.importe;
  }

  return {
    matKeys, reqMateriales, porMaterial,
    todoAUno,
    optimo: {
      total: optimoTotal,
      combinacion: optimoCombinacion,
      faltantes: optimoFaltantes,
      porProveedor: Object.values(optimoPorProv).sort((a, b) => b.total - a.total)
    }
  };
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

// Cancela una OC: marca la OC como cancelada, marca el item del buzón como
// rechazado/cancelado, y libera cobertura en las requisiciones de origen
// (recalcula coberturaPct sin esta OC). Si la req había llegado a 'cerrado'
// solo gracias a esta OC, vuelve a 'aprobado' para que se pueda recotizar.
export async function cancelarOC(obraId, ocId, motivo, autor) {
  const oc = await getOC(obraId, ocId);
  if (!oc) throw new Error('OC no encontrada');

  // 1. Marcar OC como cancelada
  await updateOC(obraId, ocId, {
    estado: 'cancelada',
    canceladaAt: Date.now(),
    canceladaPor: autor,
    motivoCancelacion: motivo || null
  });

  // 2. Marcar item del buzón como rechazado (si todavía existe y no lo
  // movió el contador). El estado 'cancelada' en el buzón no existe — usamos
  // 'rechazado' con motivo para que la maquinaria existente lo trate
  // correctamente (no entra al cálculo de saldos).
  if (oc.buzonId) {
    const buzonItem = await getBuzonItem(oc.buzonId);
    if (buzonItem && !['pagado', 'cerrado'].includes(buzonItem.estado)) {
      await updateBuzonItem(oc.buzonId, {
        estado: 'rechazado',
        motivoRechazo: `OC cancelada por compras${motivo ? ': ' + motivo : ''}`,
        rechazadoAt: Date.now(),
        rechazadoPor: autor
      });
    }
  }

  // 3. Recalcular cobertura en cada requisición vinculada y reabrir si quedó
  // sin cobertura completa (porque ahora esta OC ya no cuenta).
  if (Array.isArray(oc.reqIds) && oc.reqIds.length > 0) {
    const ocs = await listOC(obraId);   // Ya incluye la OC marcada como cancelada
    for (const reqBuzonId of oc.reqIds) {
      const reqItem = await getBuzonItem(reqBuzonId);
      if (!reqItem) continue;

      const cobertura = calcularCoberturaReq({ ...reqItem, id: reqBuzonId }, ocs);
      const ocBuzonIds = (reqItem.ocBuzonIds || []).filter(id => id !== oc.buzonId);
      const ocIds = (reqItem.ocIds || []).filter(id => id !== ocId);

      const patch = {
        ocBuzonIds, ocIds,
        coberturaPct: cobertura.pct
      };
      // Si la req estaba cerrada por esta OC y ya no está cubierta al 100%,
      // reabrirla a 'aprobado' para que se pueda recotizar.
      if (reqItem.estado === 'cerrado' && !cobertura.completa) {
        patch.estado = 'aprobado';
        patch.cerradoAt = null;
        patch.cerradoPor = null;
        patch.reabiertaPorCancelacionOC = ocId;
      }
      await updateBuzonItem(reqBuzonId, patch);

      if (reqItem.reqId && reqItem.obraId) {
        await setRequisicionOcRef(reqItem.obraId, reqItem.reqId, {
          ocBuzonIds, ocIds, coberturaPct: cobertura.pct
        });
      }
    }
  }
}
