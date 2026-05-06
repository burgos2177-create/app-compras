const listeners = new Set();
export const state = {
  user: null,            // { uid, email, role, displayName }
  obras: {},             // dict obraId → { meta }
  obraActual: null,      // obraId activo
  conceptos: null,       // { conceptoKey → concepto } del obraActual (de /shared/catalogos)
  materiales: null,      // { materialKey → mat } del obraActual (de /shared/materiales)
  loading: false
};

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach(fn => fn(state));
}

export function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
