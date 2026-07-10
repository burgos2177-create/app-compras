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

// Pide un access_token con GIS. prompt '' = silencioso; 'select_account' = popup.
function requestToken(clientId, prompt) {
  return new Promise((resolve, reject) => {
    if (!gisReady()) return reject(new Error('Google Identity no cargó (revisa conexión / bloqueadores)'));
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp && resp.access_token) { saveToken(resp.access_token, resp.expires_in); resolve(resp.access_token); }
        else reject(new Error(resp?.error || 'sin token'));
      },
      error_callback: (err) => reject(new Error(err?.type || err?.message || 'OAuth cancelado'))
    });
    try { client.requestAccessToken({ prompt }); }
    catch (err) { reject(err); }
  });
}

// Silencioso primero; si falla (sesión cerrada / requiere interacción), popup.
async function getAccessToken(clientId, { forceInteractive = false } = {}) {
  if (!forceInteractive) {
    const cached = loadToken();
    if (cached) return cached;
    try { return await requestToken(clientId, ''); }
    catch { /* cae a interactivo */ }
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

// Sube (o reemplaza con PATCH si hay prevFileId) un documento del proveedor.
// Devuelve { url, fileId, name }.
export async function uploadProveedorDoc({ clientId, clasificacion, proveedor, tipo, tipoLabel, file, prevFileId }) {
  if (!clientId) throw new Error('Falta el Client ID de Google (⚙ Drive)');
  if (!file) throw new Error('No hay archivo');
  if (file.size > MAX_BYTES) throw new Error(`El archivo pesa ${(file.size / 1048576).toFixed(1)} MB (máx. 15 MB)`);

  // Jerarquía: Proveedores SOGRUB / <clasificación> / <proveedor> /
  const rootId = await getOrCreateFolder(clientId, ROOT_FOLDER, null);
  const clasId = await getOrCreateFolder(clientId, sanitize(clasificacion || 'Sin clasificacion'), rootId);
  const provId = await getOrCreateFolder(clientId, sanitize(proveedor), clasId);

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
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [provId] })], { type: 'application/json' }));
  }
  form.append('file', file);

  const resp = await driveFetch(clientId, url, { method, body: form });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('Drive (subir ' + resp.status + '): ' + txt.slice(0, 140));
  }
  const out = await resp.json();
  return { url: out.webViewLink, fileId: out.id, name };
}
