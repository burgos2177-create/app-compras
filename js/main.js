import { onAuth, getUserProfile } from './services/auth.js?v=20260617';
import { state, setState } from './state/store.js?v=20260617';
import { route, startRouter, navigate } from './state/router.js?v=20260617';
import { renderLogin } from './views/login.js?v=20260617';
import { renderObrasList } from './views/obras.js?v=20260617';
import { renderObra } from './views/obra.js?v=20260617';
import { renderAdmin } from './views/admin.js?v=20260617';
import { renderInbox } from './views/inbox.js?v=20260617';
import { renderInboxDetalle } from './views/inbox-detalle.js?v=20260617';
import { renderCotizaciones } from './views/cotizaciones.js?v=20260617';
import { renderCotizacionDetalle } from './views/cotizacion-detalle.js?v=20260617';
import { renderOCList } from './views/oc.js?v=20260617';
import { renderOCDetalle } from './views/oc-detalle.js?v=20260617';
import { renderProveedores } from './views/proveedores.js?v=20260617';
import { renderProveedoresObra } from './views/proveedores-obra.js?v=20260617';
import { renderProveedorObraDetalle } from './views/proveedor-obra-detalle.js?v=20260617';
import { renderCatalogoPrecios } from './views/catalogo-precios.js?v=20260617';
import { renderSolicitarCotizacion } from './views/solicitar-cotizacion.js?v=20260617';
import { renderCompraServicio } from './views/compra-servicio.js?v=20260617';
import { renderSubcontratos } from './views/subcontratos.js?v=20260617';
import { renderSubcontratoDetalle } from './views/subcontrato.js?v=20260617';
import { h, mount } from './util/dom.js?v=20260617';

route('/',                                  () => renderObrasList());
route('/admin',                             () => renderAdmin());
route('/proveedores',                       () => renderProveedores());
route('/obras/:id',                         renderObra);
route('/obras/:id/inbox',                   renderInbox);
route('/obras/:id/inbox/:buzonid',          renderInboxDetalle);
route('/obras/:id/cotizaciones',            renderCotizaciones);
route('/obras/:id/cotizaciones/nueva',      renderCotizacionDetalle);
route('/obras/:id/cotizaciones/:cotid',     renderCotizacionDetalle);
route('/obras/:id/oc',                      renderOCList);
route('/obras/:id/oc/:ocid',                renderOCDetalle);
route('/obras/:id/proveedores',             renderProveedoresObra);
route('/obras/:id/proveedores/:provid',     renderProveedorObraDetalle);
route('/obras/:id/catalogo-precios',        renderCatalogoPrecios);
route('/obras/:id/solicitar-cotizacion',    renderSolicitarCotizacion);
route('/obras/:id/compra-servicio',         renderCompraServicio);
route('/obras/:id/subcontratos',            renderSubcontratos);
route('/obras/:id/subcontratos/:scid',      renderSubcontratoDetalle);

let started = false;

onAuth(async (fbUser) => {
  if (!fbUser) {
    setState({ user: null });
    renderLogin();
    return;
  }
  let profile = null;
  try { profile = await getUserProfile(fbUser.uid); }
  catch (err) { console.error('No se pudo leer /legacy/estimaciones/users/{uid}', err); }

  if (!profile) {
    mount('#app', h('div', { class: 'login-shell' }, h('div', { class: 'login-card' }, [
      h('h1', {}, 'Sin acceso'),
      h('p', { class: 'sub' }, 'Tu cuenta existe pero no tienes un perfil registrado en la suite.'),
      h('p', { class: 'sub muted', style: { fontSize: '12px' } },
        'Pide al administrador que te dé de alta en la app de estimaciones o aquí mismo.'),
      h('button', { class: 'btn', onClick: async () => {
        const { logout } = await import('./services/auth.js?v=20260617');
        logout();
      } }, 'Salir')
    ])));
    return;
  }
  setState({ user: { uid: fbUser.uid, email: fbUser.email, ...profile } });
  if (!started) { startRouter(); started = true; }
  else { navigate('/'); }
});
