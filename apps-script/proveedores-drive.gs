/**
 * SOGRUB — Subida de documentos de proveedores (PLD / anti-lavado) a Google Drive.
 *
 * Recibe un archivo desde app-compras y lo guarda en el Drive de la cuenta que
 * ejecuta este script, ordenado en carpetas:
 *
 *     Proveedores SOGRUB / <clasificación> / <proveedor> / <documento>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESPLIEGUE (hazlo con la sesión de proveedores.sogrubgc@gmail.com):
 *   1. Ve a https://script.google.com  → Nuevo proyecto.
 *   2. Pega este archivo completo en Code.gs y guarda.
 *   3. Implementar → Nueva implementación → tipo "Aplicación web".
 *        - Descripción: "Subida documentos proveedores"
 *        - Ejecutar como: "Yo (proveedores.sogrubgc@gmail.com)"
 *        - Quién tiene acceso: "Cualquiera"
 *   4. Autoriza los permisos de Drive que pida.
 *   5. Copia la URL de la app web (termina en /exec) y pégala en la app de
 *      compras (Proveedores → botón "⚙ Drive").
 *
 * Para probar: abre la URL /exec en el navegador; debe responder un JSON
 * { ok:true, service:"proveedores-drive" }.
 * ─────────────────────────────────────────────────────────────────────────────
 */

var ROOT_FOLDER_NAME = 'Proveedores SOGRUB';

function doGet() {
  return json_({ ok: true, service: 'proveedores-drive' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'sin cuerpo' });
    }
    var body = JSON.parse(e.postData.contents);
    var proveedor = String(body.proveedor || '').trim();
    var tipoLabel = String(body.tipoLabel || body.tipo || 'Documento').trim();
    var dataBase64 = body.dataBase64;
    if (!proveedor) return json_({ ok: false, error: 'falta proveedor' });
    if (!dataBase64) return json_({ ok: false, error: 'falta archivo' });

    var clasificacion = sanitize_(body.clasificacion || 'Sin clasificacion');
    var root = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
    var clasFolder = getOrCreateFolder_(root, clasificacion);
    var provFolder = getOrCreateFolder_(clasFolder, sanitize_(proveedor));

    var filename = String(body.filename || 'archivo');
    var ext = filename.indexOf('.') >= 0 ? filename.substring(filename.lastIndexOf('.')) : '';
    var finalName = sanitize_(tipoLabel) + ' — ' + filename;

    // Reemplazar el documento previo del mismo tipo (mismo prefijo).
    var prefix = sanitize_(tipoLabel) + ' — ';
    var existing = provFolder.getFiles();
    while (existing.hasNext()) {
      var f = existing.next();
      if (f.getName().indexOf(prefix) === 0) f.setTrashed(true);
    }

    var mime = body.mimeType || 'application/octet-stream';
    var blob = Utilities.newBlob(Utilities.base64Decode(dataBase64), mime, finalName);
    var file = provFolder.createFile(blob);
    file.setDescription('Subido desde app-compras el ' + new Date().toISOString());

    return json_({
      ok: true,
      url: file.getUrl(),
      fileId: file.getId(),
      name: file.getName(),
      folder: provFolder.getUrl()
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function sanitize_(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'sin-nombre';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
