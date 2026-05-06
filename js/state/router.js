// Hash router: #/path/sub → handler({ path, params })
const routes = [];
let currentHandler = null;

export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ pattern, re, keys, handler });
}

export function navigate(path) {
  if (location.hash !== '#' + path) location.hash = path;
  else dispatch();
}

export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  dispatch();
}

export function dispatch() {
  const raw = (location.hash || '#/').slice(1) || '/';
  const qIdx = raw.indexOf('?');
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const queryStr = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
  const query = Object.fromEntries(new URLSearchParams(queryStr).entries());
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      currentHandler = r.handler;
      r.handler({ path, params, query });
      return;
    }
  }
  navigate('/');
}

export function currentPath() { return (location.hash || '#/').slice(1) || '/'; }
