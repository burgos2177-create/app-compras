import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { getObraMetaLegacy } from '../services/db.js';

// Placeholder de Fase 3 — la captura de cotizaciones se implementa después
// de validar que el inbox lee correctamente y que materiales publica al buzón.

export async function renderCotizaciones({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  const meta = await getObraMetaLegacy(obraId);

  renderShell([
    { label: 'Obras', to: '/' },
    { label: meta?.nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Cotizaciones' }
  ], h('div', {}, [
    h('h1', {}, 'Cotizaciones'),
    h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '💬'),
      h('div', {}, 'Módulo en construcción.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Aquí se capturarán las cotizaciones de proveedores antes de emitir cada OC.')
    ])
  ]));
}
