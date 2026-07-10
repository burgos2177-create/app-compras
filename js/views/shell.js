import { h, mount } from '../util/dom.js?v=20260620';
import { state } from '../state/store.js?v=20260620';
import { logout } from '../services/auth.js?v=20260620';
import { navigate } from '../state/router.js?v=20260620';

export function renderShell(crumbs, body) {
  const top = h('header', { class: 'topbar' }, [
    h('div', { class: 'logo', onClick: () => navigate('/'), style: { cursor: 'pointer' } }, 'Compras'),
    crumbsView(crumbs),
    h('div', { class: 'spacer' }),
    h('div', { class: 'userchip' }, [
      h('span', {}, state.user?.displayName || state.user?.email || ''),
      h('span', { class: 'role' }, state.user?.role || ''),
      h('button', { class: 'btn ghost sm', onClick: () => logout() }, 'Salir')
    ])
  ]);
  const main = h('main', { class: 'page' }, body);
  mount('#app', h('div', { class: 'app-layout' }, [top, main]));
}

function crumbsView(crumbs) {
  const items = (crumbs || []).filter(Boolean);
  const out = [];
  items.forEach((c, i) => {
    if (i > 0) out.push(h('span', { class: 'sep' }, '/'));
    if (c.to) out.push(h('a', { href: '#' + c.to }, c.label));
    else out.push(h('span', {}, c.label));
  });
  return h('nav', { class: 'crumbs' }, out);
}
