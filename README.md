# App Compras SGR

App web para el departamento de compras: recibe requisiciones de la app de
materiales, gestiona proveedores y cotizaciones, y emite **órdenes de compra**
hacia bitácora (vía `/shared/buzon`) para que el contador apruebe y pague.

Parte de la suite **sogrub-suite** (Firebase compartido con app-estimaciones,
app-materiales y appsogrub/Bitácora).

## Stack
- Vanilla JS (ES modules nativos), HTML, CSS — sin frameworks ni bundler.
- Firebase Realtime Database + Authentication (proyecto `sogrub-suite`).

## Setup local
```bash
python serve.py 8082
```
Luego abre http://localhost:8082/

(Puerto 8082 para no chocar con estimaciones en 8080 ni materiales en 8081.)

## Estado actual
- **Fase 1 — Scaffold** ✓ login, obras, admin, navegación, plumbing RTDB.
- **Fase 2 — Inbox** ✓ lectura del buzón filtrada por `tipo='requisicion_materiales'`.
  Pendiente: que app-materiales publique al buzón al enviar (requiere edit en
  `app-materiales/js/views/requisicion.js#onEnviar`).
- **Fase 3 — Cotizaciones** ⏳ placeholder.
- **Fase 4 — Órdenes de compra** ⏳ placeholder.
- **Fase 5 — Cerrar ciclo en bitácora** ⏳ pendiente (agregar
  `_aprobarOCMateriales` en `appsogrub/js/views/buzon.js`).

## Documentación
Ver memoria del proyecto en `C:/Users/Fernando/.claude/projects/D--apps-sogrub-app-compras/memory/`.
