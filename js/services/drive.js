// Subida de documentos de proveedores a Google Drive, 100% en el navegador,
// con Google Identity Services (GIS) + Drive API REST (mismo mecanismo que
// appsogrub, sin backend ni SDKs de Google).
//
// Requisitos (una vez):
//   - <script src="https://accounts.google.com/gsi/client"> en index.html.
//   - Un OAuth Client ID (tipo "Web") con el origen de esta app en
//     "Authorized JavaScript origins" (localhost y el dominio de GitHub Pages).
//   - Se configura el Client ID en la app (Proveedores → ⚙ Drive).
//
// Scope drive.file: la app solo ve/gestiona lo que ELLA crea. Los archivos van
// al Drive de la cuenta con la que se autorice el popup (usa la de proveedores).
//
// OJO: OAuth NO funciona en navegadores envoltorio (Ferdium/Electron) — el popup
// abre el navegador externo y el token nunca vuelve. Sube desde Chrome/Edge real.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'compras:gdrive:token';
const ROOT_FOLDER = 'Proveedores SOGRUB';
const MAX_BYTES = 15 * 1024 * 1024;

const _folderCache = new Map();   // `${parentId}/${name}` -> folderId

export function gisReady() {
  return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
}

function loadToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.access_token && t.expiresAt > Date.now()) return t.access_token;
  } catch { /* ignore */ }
  return null;
}
function saveToken(access_token, expires_in) {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      access_token, expiresAt: Date.now() + ((Number(expires_in) || 3600) - 60) * 1000
    }));
  } catch { /* ignore */ }
}
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

// Mensaje amable para los errores típicos de GIS.
function friendlyOauthError(type) {
  if (type === 'popup_failed_to_open')
    return 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes (popups) para este sitio y vuelve a intentar. No funciona dentro de Ferdium/Electron: usa Chrome o Edge.';
  if (type === 'popup_closed')
    return 'Cerraste la ventana de Google sin autorizar. Vuelve a intentar y elige la cuenta de proveedores.';
  return type || 'OAuth cancelado';
}

// Pide un access_token con GIS. prompt 'select_account' = popup selector de cuenta.
// IMPORTANTE: requestAccessToken DEBE llamarse de forma síncrona dentro del gesto
// del usuario (clic / selección de archivo); si no, el navegador bloquea el popup.
function requestToken(clientId, prompt) {
  return new Promise((resolve, reject) => {
    if (!gisReady()) return reject(new Error('Google Identity no cargó (revisa conexión / bloqueadores)'));
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp && resp.access_token) { saveToken(resp.access_token, resp.expires_in); resolve(resp.access_token); }
        else reject(new Error(friendlyOauthError(resp?.error)));
      },
      error_callback: (err) => reject(new Error(friendlyOauthError(err?.type || err?.message)))
    });
    try { client.requestAccessToken({ prompt }); }
    catch (err) { reject(err); }
  });
}

// Devuelve un access_token. Si hay uno válido en cache (guardado ~1h) no abre
// nada. Si no, hace UN SOLO requestAccessToken interactivo — sin un intento
// silencioso con `await` previo, porque ese await consume el gesto del usuario y
// el navegador bloquea el popup (popup_failed_to_open). Así el popup abre dentro
// del mismo gesto (el clic/selección de archivo que dispara la subida).
async function getAccessToken(clientId, { forceInteractive = false } = {}) {
  if (!forceInteractive) {
    const cached = loadToken();
    if (cached) return cached;
  }
  return requestToken(clientId, 'select_account');
}

// fetch a Drive con Bearer; en 401 limpia token y reintenta una vez (interactivo).
async function driveFetch(clientId, url, opts = {}, retry = true) {
  const token = await getAccessToken(clientId);
  const doFetch = (t) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
  let resp = await doFetch(token);
  if (resp.status === 401 && retry) {
    clearToken();
    resp = await doFetch(await getAccessToken(clientId, { forceInteractive: true }));
  }
  return resp;
}

async function getOrCreateFolder(clientId, name, parentId) {
  const cacheKey = (parentId || 'root') + '/' + name;
  if (_folderCache.has(cacheKey)) return _folderCache.get(cacheKey);

  const parts = [`name='${name.replace(/'/g, "\\'")}'`, "mimeType='application/vnd.google-apps.folder'", 'trashed=false'];
  if (parentId) parts.push(`'${parentId}' in parents`);
  const q = encodeURIComponent(parts.join(' and '));
  const listResp = await driveFetch(clientId, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
  if (!listResp.ok) throw new Error('Drive (listar carpeta): ' + listResp.status);
  const data = await listResp.json();
  let id = data.files?.[0]?.id;

  if (!id) {
    const body = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) body.parents = [parentId];
    const cr = await driveFetch(clientId, 'https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!cr.ok) throw new Error('Drive (crear carpeta): ' + cr.status);
    id = (await cr.json()).id;
  }
  _folderCache.set(cacheKey, id);
  return id;
}

function sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'sin-nombre';
}

// Para el botón "Probar acceso": fuerza el popup y valida client_id + orígenes.
export async function requestAccessTokenTest(clientId) {
  clearToken();
  return getAccessToken(clientId, { forceInteractive: true });
}

// ¿Hay un token de Drive válido en cache? (para saber si la subida necesitará
// abrir el popup o no).
export function driveTokenValido() { return !!loadToken(); }

// Conecta Drive: obtiene el token (popup si hace falta). DEBE llamarse desde un
// clic de botón directo — el popup de Google solo abre bien así, no desde la
// selección de archivo. Una vez conectado, las subidas usan el token cacheado
// (~1h) sin volver a abrir popup.
export async function ensureDriveToken(clientId) {
  if (!clientId) throw new Error('Falta el Client ID de Google (⚙ Drive)');
  return getAccessToken(clientId);
}

// Sube (o reemplaza con PATCH si hay prevFileId) un documento del proveedor.
// Devuelve { url, fileId, name, folderId }.
//
// folderId: si se pasa (el que ya guardamos del proveedor), se usa DIRECTO sin
// buscar por nombre. Esto evita carpetas duplicadas: la búsqueda de Drive es
// eventualmente consistente, así que buscar por nombre justo tras crear puede
// no encontrar la carpeta y crear otra. Con el id guardado eso no pasa.
export async function uploadProveedorDoc({ clientId, clasificacion, proveedor, tipo, tipoLabel, file, prevFileId, folderId }) {
  if (!clientId) throw new Error('Falta el Client ID de Google (⚙ Drive)');
  if (!file) throw new Error('No hay archivo');
  if (file.size > MAX_BYTES) throw new Error(`El archivo pesa ${(file.size / 1048576).toFixed(1)} MB (máx. 15 MB)`);

  // Carpeta del proveedor: reusa el id guardado; si no hay, crea la jerarquía
  // Proveedores SOGRUB / <clasificación> / <proveedor> / y devuelve su id.
  let provFolderId = folderId;
  if (!provFolderId) {
    const rootId = await getOrCreateFolder(clientId, ROOT_FOLDER, null);
    const clasId = await getOrCreateFolder(clientId, sanitize(clasificacion || 'Sin clasificacion'), rootId);
    provFolderId = await getOrCreateFolder(clientId, sanitize(proveedor), clasId);
  }

  const name = `${sanitize(tipoLabel)} — ${file.name}`;
  const form = new FormData();

  let url, method;
  if (prevFileId) {
    // Reemplaza contenido y nombre del archivo previo (mismo id, misma carpeta).
    url = `https://www.googleapis.com/upload/drive/v3/files/${prevFileId}?uploadType=multipart&fields=id,webViewLink`;
    method = 'PATCH';
    form.append('metadata', new Blob([JSON.stringify({ name })], { type: 'application/json' }));
  } else {
    url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
    method = 'POST';
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [provFolderId] })], { type: 'application/json' }));
  }
  form.append('file', file);

  const resp = await driveFetch(clientId, url, { method, body: form });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('Drive (subir ' + resp.status + '): ' + txt.slice(0, 140));
  }
  const out = await resp.json();
  return { url: out.webViewLink, fileId: out.id, name, folderId: provFolderId };
}
