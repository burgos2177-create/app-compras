import { onAuth, getUserProfile } from './services/auth.js';
import { state, setState } from './state/store.js';
import { route, startRouter, navigate } from './state/router.js';
import { renderLogin } from './views/login.js';
import { renderObrasList } from './views/obras.js';
import { renderObra } from './views/obra.js';
import { renderAdmin } from './views/admin.js';
import { renderInbox } from './views/inbox.js';
import { renderInboxDetalle } from './views/inbox-detalle.js';
import { renderCotizaciones } from './views/cotizaciones.js';
import { renderCotizacionDetalle } from './views/cotizacion-detalle.js';
import { renderOCList } from './views/oc.js';
import { renderOCDetalle } from './views/oc-detalle.js';
import { renderProveedores } from './views/proveedores.js';
import { renderProveedoresObra } from './views/proveedores-obra.js';
import { renderProveedorObraDetalle } from './views/proveedor-obra-detalle.js';
import { h, mount } from './util/dom.js';

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
        const { logout } = await import('./services/auth.js');
        logout();
      } }, 'Salir')
    ])));
    return;
  }
  setState({ user: { uid: fbUser.uid, email: fbUser.email, ...profile } });
  if (!started) { startRouter(); started = true; }
  else { navigate('/'); }
});
