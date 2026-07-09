import { h, toast, modal } from '../util/dom.js?v=20260609';
import { renderShell } from './shell.js?v=20260609';
import { state, setState } from '../state/store.js?v=20260609';
import {
  getObraMetaLegacy, listSubcontratos, createSubcontrato,
  deleteSubcontrato,
  listSubcontratosLegacyCandidatos, migrarSubcontratosLegacy
} from '../services/db.js?v=20260609';
import { navigate } from '../state/router.js?v=20260609';
import { dateMx, num0, money } from '../util/format.js?v=20260609';

// Lista de subcontratos de la obra. Cada subcontrato cubre conceptos OPUS
// con un alcance (concepto + cantidad), licitantes con sus precios y, al
// adjudicar, queda como "compromiso" que la app de estimaciones consume
// para emitir estimaciones parciales hacia bitácora.

export async function renderSubcontratos({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, scs, legacyCandidatos] = await Promise.all([
    getObraMetaLegacy(obraId),
    listSubcontratos(obraId),
    listSubcontratosLegacyCandidatos(obraId)
  ]);

  const ids = Object.keys(scs);
  ids.sort((a, b) => (scs[b].meta?.createdAt || 0) - (scs[a].meta?.createdAt || 0));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Subcontratos'),
    h('div', { style: { flex: 1 } }),
    legacyCandidatos.length > 0 && h('button', {
      class: 'btn ghost',
      onClick: () => onMigrarLegacy(obraId, legacyCandidatos)
    }, `📥 Importar de estimaciones (${legacyCandidatos.length})`),
    h('button', { class: 'btn primary', onClick: () => onNuevo(obraId) }, '+ Nuevo subcontrato')
  ]);

  // Banner sutil cuando hay candidatos para migrar
  const migracionBanner = legacyCandidatos.length > 0
    ? h('div', {
      style: {
        padding: '10px 14px', marginBottom: '12px',
        background: 'rgba(106, 169, 255, 0.07)',
        border: '1px solid rgba(106, 169, 255, 0.3)',
        borderRadius: '6px', fontSize: '12px',
        display: 'flex', alignItems: 'center', gap: '10px'
      }
    }, [
      h('span', { style: { fontSize: '16px' } }, '📥'),
      h('span', { style: { flex: 1 } }, [
        'Detectamos ',
        h('b', {}, `${legacyCandidatos.length} subcontrato${legacyCandidatos.length === 1 ? '' : 's'}`),
        ' que se crearon en la app de estimaciones antes de mover la licitación a compras. ',
        'Puedes importarlos para gestionarlos desde aquí. Las estimaciones parciales existentes se preservan.'
      ]),
      h('button', {
        class: 'btn sm primary',
        onClick: () => onMigrarLegacy(obraId, legacyCandidatos)
      }, 'Revisar e importar')
    ])
    : null;

  let body;
  if (ids.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🔧'),
      h('div', {}, 'Sin subcontratos todavía.'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Un subcontrato define un alcance de conceptos OPUS, recibe precios de varios licitantes y se adjudica al ganador. Después la app de estimaciones genera las estimaciones parciales con base en este subcontrato.')
    ]);
  } else {
    body = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, h('tr', {}, [
          h('th', {}, 'Nombre'),
          h('th', {}, 'Estado'),
          h('th', { class: 'num' }, 'Conceptos'),
          h('th', { class: 'num' }, 'Licitantes'),
          h('th', {}, 'Ganador'),
          h('th', { class: 'num' }, 'Importe adjudicado'),
          h('th', {}, 'Última edición'),
          h('th', {}, '')
        ])),
        h('tbody', {}, ids.map(id => scRow(obraId, id, scs[id])))
      ])
    ]);
  }

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, migracionBanner, body]));
}

function scRow(obraId, scId, sc) {
  const m = sc.meta || {};
  const conceptos = sc.conceptos || {};
  const licitantes = sc.licitantes || {};
  const adjudicado = m.licitanteAdjudicadoId ? licitantes[m.licitanteAdjudicadoId] : null;

  // Importe adjudicado: para destajistas suma precio+materialSogrub × cantidad;
  // para subcontratos suma precio × cantidad. Refleja el costo real para SOGRUB.
  let importeAdj = 0;
  if (adjudicado) {
    const esDestajo = adjudicado.tipoSubcontratacion === 'destajo';
    for (const c of Object.values(conceptos)) {
      const precio = Number(adjudicado.precios?.[c.conceptoId]) || 0;
      if (precio <= 0) continue;
      const matSogrub = Number(c.costoMaterialSogrub) || 0;
      const comparable = esDestajo ? precio + matSogrub : precio;
      importeAdj += comparable * (Number(c.cantidad) || 0);
    }
  }

  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/subcontratos/${scId}`)
  }, [
    h('td', {}, [
      h('div', { style: { fontWeight: '600' } }, m.nombre || '(sin nombre)'),
      m.descripcion && h('div', { class: 'muted', style: { fontSize: '11px' } },
        m.descripcion.slice(0, 80) + (m.descripcion.length > 80 ? '…' : ''))
    ]),
    h('td', {}, estadoSCBadge(m.estado)),
    h('td', { class: 'num' }, num0(Object.keys(conceptos).length)),
    h('td', { class: 'num' }, num0(Object.keys(licitantes).length)),
    h('td', { style: { fontSize: '12px' } },
      adjudicado
        ? h('b', { style: { color: 'var(--ok)' } }, adjudicado.nombre)
        : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'num' }, adjudicado ? money(importeAdj) : '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, dateMx(m.updatedAt || m.createdAt)),
    h('td', {},
      m.estado !== 'adjudicado' && h('button', {
        class: 'btn sm danger',
        onClick: (e) => { e.stopPropagation(); onBorrar(obraId, scId, m); }
      }, '🗑'))
  ]);
}

export function estadoSCBadge(estado) {
  if (estado === 'cotizando')  return h('span', { class: 'tag warn' }, '💬 Cotizando');
  if (estado === 'adjudicado') return h('span', { class: 'tag ok' }, '🏆 Adjudicado');
  if (estado === 'cerrado')    return h('span', { class: 'tag muted' }, '🔒 Cerrado');
  return h('span', { class: 'tag muted' }, estado || '—');
}

async function onNuevo(obraId) {
  const nombre = h('input', { autofocus: true, placeholder: 'p.ej. Cimentación · estructura · acabados' });
  const descripcion = h('textarea', { rows: 2, placeholder: 'Notas, condiciones especiales, etc.' });
  await modal({
    title: 'Nuevo subcontrato',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
      h('div', { class: 'field' }, [h('label', {}, 'Descripción'), descripcion]),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
        'Al crearlo entras al detalle para capturar el alcance (conceptos OPUS + cantidades) y empezar a recibir cotizaciones de licitantes.')
    ]),
    confirmLabel: 'Crear',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Captura un nombre', 'danger'); return false; }
      try {
        const u = state.user;
        const id = await createSubcontrato(obraId, {
          nombre: n,
          descripcion: descripcion.value.trim()
        }, { uid: u.uid, displayName: u.displayName || '', email: u.email || '' });
        toast('Subcontrato creado', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${id}`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onMigrarLegacy(obraId, candidatos) {
  if (candidatos.length === 0) {
    toast('No hay subcontratos legacy pendientes de importar', 'warn');
    return;
  }

  const checks = {};
  const list = h('div', { style: { maxHeight: '440px', overflow: 'auto' } },
    candidatos.map(({ scId, sub }) => {
      const meta = sub.meta || {};
      const conceptos = sub.conceptos || [];
      const lics = Object.values(sub.licitantes || {}).filter(l => !l.archivado);
      const estados = {
        cotizando: '💬 Cotizando',
        adjudicado: '🏆 Adjudicado',
        ejecutando: '🔧 Ejecutando',
        cerrado: '🔒 Cerrado'
      };
      const cb = h('input', { type: 'checkbox', checked: true });
      checks[scId] = cb;
      return h('label', {
        class: 'row',
        style: {
          padding: '10px 12px', cursor: 'pointer',
          borderBottom: '1px solid var(--border)', gap: '10px'
        }
      }, [
        cb,
        h('div', { style: { flex: 1 } }, [
          h('div', { style: { fontWeight: '600' } }, meta.nombre || '(sin nombre)'),
          h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, [
            estados[meta.estado] || meta.estado || '—',
            ` · ${conceptos.length} concepto${conceptos.length === 1 ? '' : 's'}`,
            ` · ${lics.length} licitante${lics.length === 1 ? '' : 's'}`,
            meta.adjudicadoAt && ' · ✓ ya adjudicado'
          ])
        ])
      ]);
    }));

  await modal({
    title: `Importar subcontratos de estimaciones (${candidatos.length})`,
    body: h('div', {}, [
      h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
        'Selecciona cuáles quieres traer a compras. Para cada uno se copia: alcance, licitantes con sus precios y la adjudicación si la tenía. Las estimaciones parciales (avances ya capturados) se quedan en su lugar y siguen ligadas — solo se mueve el "compromiso" para que la edición ahora viva aquí.'),
      list,
      h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '10px', padding: '8px 10px', background: 'var(--bg-2)', borderRadius: '6px' } }, [
        h('b', {}, 'Defaults aplicados a licitantes legacy: '),
        'tipo "subcontrato" (no destajo), "acepta sin IVA" marcado, sin RFC. ',
        'Puedes ajustarlo después en el detalle de cada subcontrato.'
      ])
    ]),
    confirmLabel: 'Importar', size: 'lg',
    onConfirm: async () => {
      const seleccionados = Object.entries(checks)
        .filter(([, cb]) => cb.checked)
        .map(([scId]) => scId);
      if (seleccionados.length === 0) { toast('Selecciona al menos uno', 'danger'); return false; }
      try {
        const migrados = await migrarSubcontratosLegacy(obraId, seleccionados);
        toast(`${migrados.length} subcontrato${migrados.length === 1 ? '' : 's'} importado${migrados.length === 1 ? '' : 's'}`, 'ok');
        renderSubcontratos({ params: { id: obraId } });
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function onBorrar(obraId, scId, meta) {
  await modal({
    title: 'Borrar subcontrato',
    body: h('div', {}, [
      h('p', {}, `¿Borrar "${meta.nombre}"? Esta acción no se puede deshacer.`),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Se borra el alcance y todas las cotizaciones de licitantes. Solo se puede borrar mientras no esté adjudicado.')
    ]),
    confirmLabel: 'Borrar', danger: true,
    onConfirm: async () => {
      await deleteSubcontrato(obraId, scId);
      toast('Subcontrato borrado', 'ok');
      renderSubcontratos({ params: { id: obraId } });
      return true;
    }
  });
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Subcontratos' }
  ];
}
