export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k in el && typeof el[k] !== 'function') el[k] = v;
    else el.setAttribute(k, v);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent, children) {
  if (children == null || children === false) return;
  if (Array.isArray(children)) { children.forEach(c => appendChildren(parent, c)); return; }
  if (children instanceof Node) { parent.appendChild(children); return; }
  parent.appendChild(document.createTextNode(String(children)));
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function mount(rootSelector, node) {
  const root = typeof rootSelector === 'string' ? document.querySelector(rootSelector) : rootSelector;
  clear(root);
  root.appendChild(node);
  return root;
}

export function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  if (!root.classList.contains('toast-root')) root.className = 'toast-root';
  const t = h('div', { class: `toast ${kind}` }, msg);
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2700);
  setTimeout(() => t.remove(), 3100);
}

// Soporta modales anidados: cada llamada agrega su propio backdrop como hijo
// de #modal-root. Cerrar uno solo remueve su backdrop, no limpia los demás.
export function modal({ title, body, onConfirm, confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false, size = '' }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    let backdrop;
    const close = (val) => { if (backdrop) backdrop.remove(); resolve(val); };
    const card = h('div', { class: 'modal' + (size ? ' ' + size : '') }, [
      h('h2', {}, title),
      typeof body === 'string' ? h('div', {}, body) : body,
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn ghost', onClick: () => close(false) }, cancelLabel),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: async () => { const r = onConfirm ? await onConfirm() : true; close(r); } }, confirmLabel)
      ])
    ]);
    backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === e.currentTarget) close(false); } }, card);
    root.appendChild(backdrop);
  });
}
