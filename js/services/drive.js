// Subida de documentos de proveedores al Google Drive de proveedores.sogrubgc,
// vía un Google Apps Script publicado como Web App (ver apps-script/proveedores-drive.gs).
//
// Se manda el archivo en base64 con Content-Type text/plain para evitar el
// preflight CORS (petición "simple"); el Apps Script lo lee de e.postData.

const MAX_BYTES = 15 * 1024 * 1024;   // 15 MB

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('No se pudo leer el archivo'));
    r.readAsDataURL(file);
  });
}

// Sube un documento y devuelve { url, fileId, name, folder }.
export async function uploadProveedorDoc({ endpoint, clasificacion, proveedor, proveedorId, tipo, tipoLabel, file }) {
  if (!endpoint) throw new Error('Falta configurar el endpoint de Drive');
  if (!file) throw new Error('No hay archivo');
  if (file.size > MAX_BYTES) throw new Error(`El archivo pesa ${(file.size / 1048576).toFixed(1)} MB (máx. 15 MB)`);

  const dataBase64 = await fileToBase64(file);
  const payload = {
    clasificacion: clasificacion || 'Sin clasificacion',
    proveedor, proveedorId, tipo, tipoLabel,
    filename: file.name, mimeType: file.type || 'application/octet-stream',
    dataBase64
  };

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new Error('No se pudo conectar con Drive (revisa el endpoint): ' + err.message);
  }
  let out;
  try { out = await resp.json(); }
  catch { throw new Error('Respuesta inválida del servidor de Drive'); }
  if (!out || !out.ok) throw new Error(out?.error || 'Error del servidor de Drive');
  return out;
}
