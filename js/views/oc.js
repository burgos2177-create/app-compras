import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { getObraMetaLegacy } from '../services/db.js';

// Placeholder de Fase 4. El listado y emisión de OC se implementan después
// de tener cotizaciones y de cerrar el contrato `oc_materiales` con bitácora.

export async function renderOCList({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  const meta = await getObraMetaLegacy(obraId);

  renderShell([
    { label: 'Obras', to: '/' },
    { label: meta?.nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Órdenes de compra' }
  ], h('div', {}, [
    h('h1', {}, 'Órdenes de compra'),
    h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📄'),
      h('div', {}, 'Módulo en construcción.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Aquí se emitirán las OC consolidando una o varias requisiciones aprobadas.')
    ])
  ]));
}
