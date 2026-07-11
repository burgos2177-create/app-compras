import { h, toast, modal } from '../util/dom.js?v=20260711g';
import { renderShell } from './shell.js?v=20260711g';
import { state, setState } from '../state/store.js?v=20260711g';
import {
  getObraMetaLegacy, getSubcontrato, updateSubcontratoMeta,
  addSubcontratoConcepto, addSubcontratoConceptosBulk,
  removeSubcontratoConcepto, updateSubcontratoConcepto,
  addSubcontratoLicitante, updateSubcontratoLicitante, removeSubcontratoLicitante,
  setSubcontratoLicitantePrecio,
  adjudicarSubcontrato, desadjudicarSubcontrato,
  loadCatalogoConceptos,
  listProveedoresObra, listProveedoresGlobal, mergeProveedorObraConGlobal
} from '../services/db.js?v=20260711g';
import { navigate } from '../state/router.js?v=20260711g';
import { dateMx, num, num0, money } from '../util/format.js?v=20260711g';
import { estadoSCBadge } from './subcontratos.js?v=20260711g';
import {
  exportLicitanteXlsxCompras, exportLicitantePdfCompras,
  parseLicitanteXlsxCompras,
  exportComparativaXlsxCompras, exportComparativaPdfCompras
} from '../services/subcontrato-export.js?v=20260711g';

// Helpers tolerantes al shape del catálogo unificado.
// El catálogo en /shared/catalogos/{obraId}/conceptos usa snake_case
// (precio_unitario), pero algunos lectores viejos tenían camelCase. Esto
// soporta ambos sin que nada se rompa si el shape varía.
function precioUnitarioOf(con) {
  if (!con) return 0;
  return Number(con.precio_unitario ?? con.precioUnitario) || 0;
}
// Un concepto es "cotizable" si:
//   - tipo='precio_unitario' explícito, o
//   - es un agrupador CON precio o cantidad propios (común en OPUS: Z1 puede
//     ser agrupador que envuelve sub-zapatas Z1-001/Z1-002 y a la vez tener
//     su propia entrada cotizable. El usuario decide si subcontrata Z1 como
//     bloque o sus sub-conceptos por separado).
//   - sin tipo definido pero con precio o cantidad (defensa contra registros
//     mal etiquetados).
function esConceptoCotizable(con) {
  if (!con) return false;
  if (con.tipo === 'precio_unitario') return true;
  const tieneValor = precioUnitarioOf(con) > 0 || Number(con.cantidad) > 0;
  if (con.tipo === 'agrupador') return tieneValor;
  return tieneValor;
}

// Precio comparable de un licitante para un concepto del subcontrato.
// - Subcontrato completo: el precio capturado.
// - Destajo: precio capturado + costoMaterialSogrub del concepto del alcance.
// Devuelve { precio, comparable, esDestajo, materialSogrub }.
function precioComparable(lic, conceptoEnAlcance) {
  const precio = Number(lic?.precios?.[conceptoEnAlcance?.conceptoId]) || 0;
  const esDestajo = lic?.tipoSubcontratacion === 'destajo';
  const materialSogrub = Number(conceptoEnAlcance?.costoMaterialSogrub) || 0;
  return {
    precio,
    materialSogrub,
    esDestajo,
    comparable: esDestajo ? precio + materialSogrub : precio
  };
}

// Detalle de subcontrato con 3 tabs:
//   - Alcance: conceptos OPUS + cantidades
//   - Licitantes: tabla comparativa de precios por concepto, con ahorro % vs
//     catálogo y CTA "Cotizar con un proveedor existente"
//   - Adjudicación: ranking de licitantes por total, botón "Adjudicar"

export async function renderSubcontratoDetalle({ params, query }) {
  const obraId = params.id;
  const scId = params.scid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, sc, catCon, { items: provObra }, globales] = await Promise.all([
    getObraMetaLegacy(obraId),
    getSubcontrato(obraId, scId),
    loadCatalogoConceptos(obraId),
    listProveedoresObra(obraId),
    listProveedoresGlobal()
  ]);

  if (!sc) {
    renderShell(crumbs(obraId, meta?.nombre, '...'),
      h('div', { class: 'empty' }, 'Subcontrato no encontrado.'));
    return;
  }

  const conceptos = catCon?.conceptos || {};   // catálogo OPUS de la obra
  const scMeta = sc.meta || {};
  const scConceptos = sc.conceptos || {};
  const scLicitantes = sc.licitantes || {};
  const proveedoresObra = provObra.map(p => mergeProveedorObraConGlobal(p, globales));
  const tab = query?.tab || 'alcance';

  const editable = scMeta.estado !== 'cerrado';
  const adjudicado = scMeta.estado === 'adjudicado';

  // === Header ===
  const head = h('div', { class: 'row' }, [
    h('h1', {}, [scMeta.nombre || 'Subcontrato', ' ', estadoSCBadge(scMeta.estado)]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', {
      class: 'btn ghost',
      onClick: () => onEditarMeta(obraId, scId, scMeta)
    }, '✎ Editar datos'),
    adjudicado && h('button', {
      class: 'btn danger ghost',
      onClick: () => onDesadjudicar(obraId, scId)
    }, '↺ Desadjudicar')
  ]);

  const datosCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos del subcontrato'),
    h('div', { class: 'grid-3' }, [
      kv('Nombre', scMeta.nombre),
      kv('Estado', scMeta.estado),
      kv('Creado', dateMx(scMeta.createdAt)),
      adjudicado && kv('Adjudicado', dateMx(scMeta.adjudicadoAt)),
      adjudicado && scMeta.licitanteAdjudicadoId && kv(
        'Ganador',
        h('b', { style: { color: 'var(--ok)' } },
          scLicitantes[scMeta.licitanteAdjudicadoId]?.nombre || '—')),
      adjudicado && kv('Importe total', money(totalLicitante(scLicitantes[scMeta.licitanteAdjudicadoId], scConceptos)))
    ]),
    scMeta.descripcion && h('div', { style: { marginTop: '8px' } }, [
      h('label', { class: 'muted', style: { fontSize: '12px' } }, 'Descripción'),
      h('div', {}, scMeta.descripcion)
    ])
  ]);

  // === Tab bar ===
  const tabBar = h('div', { class: 'row', style: { marginBottom: '14px', gap: '4px' } }, [
    tabBtn('alcance',      '📋 Alcance',                Object.keys(scConceptos).length),
    tabBtn('licitantes',   '💬 Licitantes',             Object.keys(scLicitantes).length),
    tabBtn('adjudicacion', '🏆 Adjudicación',           adjudicado ? '✓' : '—')
  ]);

  function tabBtn(id, label, badge) {
    return h('button', {
      class: 'btn sm ' + (tab === id ? 'primary' : 'ghost'),
      onClick: () => navigate(`/obras/${obraId}/subcontratos/${scId}?tab=${id}`)
    }, [label, ' ', h('span', { class: 'tag muted' }, String(badge))]);
  }

  let tabBody;
  if (tab === 'alcance') {
    tabBody = renderAlcance(obraId, scId, scConceptos, conceptos, editable);
  } else if (tab === 'licitantes') {
    tabBody = renderLicitantes(obraId, scId, scConceptos, scLicitantes, conceptos, proveedoresObra, editable, scMeta, meta);
  } else {
    tabBody = renderAdjudicacion(obraId, scId, scConceptos, scLicitantes, conceptos, scMeta, editable);
  }

  renderShell(crumbs(obraId, meta?.nombre, scMeta.nombre),
    h('div', {}, [head, datosCard, tabBar, tabBody]));
}

// ====================== TAB: ALCANCE ======================

function renderAlcance(obraId, scId, scConceptos, conceptos, editable) {
  const entries = Object.entries(scConceptos);
  let totalCatalogo = 0;
  for (const [, c] of entries) {
    const con = conceptos[c.conceptoId];
    if (con) totalCatalogo += (Number(c.cantidad) || 0) * precioUnitarioOf(con);
  }

  const head = h('div', { class: 'row' }, [
    h('h3', { style: { margin: 0, flex: 1 } },
      `Alcance (${num0(entries.length)} concepto${entries.length === 1 ? '' : 's'})`),
    entries.length > 0 && h('span', { class: 'muted', style: { fontSize: '12px' } },
      `Importe a precios catálogo: ${money(totalCatalogo)}`),
    editable && h('button', {
      class: 'btn sm primary',
      onClick: () => onAgregarConcepto(obraId, scId, scConceptos, conceptos)
    }, '+ Agregar concepto')
  ]);

  if (entries.length === 0) {
    return h('div', { class: 'card' }, [
      head,
      h('div', { class: 'empty', style: { marginTop: '10px' } }, [
        h('div', { class: 'ico' }, '📋'),
        h('div', {}, 'Sin conceptos en el alcance.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Agrega los conceptos OPUS que cubre este subcontrato con su cantidad.')
      ])
    ]);
  }

  // Ordenar por orden secuencial OPUS del catálogo (preserva la jerarquía
  // tal como aparece en el XLS original — las partidas van apareciendo en
  // orden natural).
  const sorted = entries.sort(([, a], [, b]) => {
    const oa = conceptos[a.conceptoId]?.orden ?? Number.MAX_SAFE_INTEGER;
    const ob = conceptos[b.conceptoId]?.orden ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    // fallback por clave
    const ca = conceptos[a.conceptoId]?.clave || '';
    const cb = conceptos[b.conceptoId]?.clave || '';
    return ca.localeCompare(cb);
  });

  // Construir filas con headers de partida cuando cambia el path de ancestros
  const colspanCount = editable ? 9 : 8;
  const filas = [];
  let lastPath = [];   // ancestros (sin el propio concepto)
  for (const [cid, c] of sorted) {
    const con = conceptos[c.conceptoId];
    const ancestros = (con?.path || []).slice(0, -1);
    // Encontrar primer índice donde la nueva ruta diverge de la última
    let primerDif = 0;
    while (
      primerDif < lastPath.length && primerDif < ancestros.length
      && lastPath[primerDif].clave === ancestros[primerDif].clave
      && lastPath[primerDif].descripcion === ancestros[primerDif].descripcion
    ) primerDif++;
    // Emitir headers para los ancestros nuevos
    for (let i = primerDif; i < ancestros.length; i++) {
      filas.push(headerPartidaRow(ancestros[i], i, colspanCount));
    }
    lastPath = ancestros;
    filas.push(conceptoAlcanceRow(obraId, scId, cid, c, conceptos, editable));
  }

  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 4px' } }, head),
    h('div', { class: 'muted', style: { padding: '0 18px 8px', fontSize: '11px' } },
      'Si vas a considerar destajistas (solo mano de obra), captura el costo de material/equipo que pondría SOGRUB por concepto. La comparativa lo sumará al precio del destajista para compararlo justo contra subcontratistas completos.'),
    h('table', { class: 'tbl' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, 'Clave'),
        h('th', {}, 'Descripción'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'P.U. catálogo'),
        h('th', { class: 'num', title: 'Costo de material/equipo que SOGRUB pondría si se contrata un destajista' }, 'Material SOGRUB'),
        h('th', { class: 'num' }, 'Importe ref.'),
        h('th', {}, 'Notas'),
        editable && h('th', {}, '')
      ])),
      h('tbody', {}, filas)
    ])
  ]);
}

// Fila de header de partida (agrupador) en la tabla del alcance.
// Estilo: banda con fondo de acento si es nivel 0, gris suave en niveles
// internos. Indentación visual según nivel.
function headerPartidaRow(ancestor, nivel, colspan) {
  const bg = nivel === 0
    ? 'rgba(106, 169, 255, 0.10)'
    : 'rgba(108, 115, 132, 0.06)';
  return h('tr', {}, h('td', {
    colspan: colspan,
    style: {
      background: bg,
      padding: '6px 10px 6px ' + (10 + nivel * 16) + 'px',
      borderBottom: '1px solid var(--border-strong)',
      borderTop: '1px solid var(--border-strong)'
    }
  }, [
    h('span', {
      class: 'mono',
      style: { fontSize: '11px', color: 'var(--accent)', fontWeight: '600', marginRight: '10px' }
    }, ancestor.clave || ''),
    h('span', {
      style: { fontSize: '12px', fontWeight: '600', color: 'var(--text-0)', textTransform: 'uppercase', letterSpacing: '0.3px' }
    }, ancestor.descripcion || '—')
  ]));
}

function conceptoAlcanceRow(obraId, scId, cid, c, conceptos, editable) {
  const con = conceptos[c.conceptoId];
  const precioCat = precioUnitarioOf(con);
  const cantidad = Number(c.cantidad) || 0;
  const importe = cantidad * precioCat;
  const costoMat = Number(c.costoMaterialSogrub) || 0;

  const conLabel = con
    ? h('div', {}, [
      h('span', {}, (con.descripcion || '').slice(0, 80)),
      (con.descripcion || '').length > 80 && '…'
    ])
    : h('div', { class: 'tag warn' }, '⚠ Concepto no existe en catálogo');

  // Input inline para costoMaterialSogrub con autosave debounced
  const matInput = h('input', {
    type: 'number', step: '0.01', min: '0',
    value: costoMat > 0 ? String(costoMat) : '',
    placeholder: '$',
    style: { width: '90px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '12px' },
    disabled: !editable
  });
  let matTimer = null;
  matInput.addEventListener('input', () => {
    clearTimeout(matTimer);
    const v = Number(matInput.value) || 0;
    matTimer = setTimeout(() => {
      updateSubcontratoConcepto(obraId, scId, cid, { costoMaterialSogrub: v })
        .catch(err => toast('Error: ' + err.message, 'danger'));
    }, 600);
  });

  return h('tr', {}, [
    h('td', { class: 'mono', style: { fontSize: '11px' } }, con?.clave || c.conceptoId.slice(0, 10)),
    h('td', { style: { maxWidth: '380px' } }, conLabel),
    h('td', {}, con?.unidad || '—'),
    h('td', { class: 'num' }, num(cantidad)),
    h('td', { class: 'num muted' }, precioCat > 0 ? money(precioCat) : '—'),
    h('td', { class: 'num', style: { padding: '4px 6px' } }, matInput),
    h('td', { class: 'num' }, importe > 0 ? money(importe) : '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, c.notas || ''),
    editable && h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', { class: 'btn sm ghost', onClick: () => onEditarConcepto(obraId, scId, cid, c, conceptos) }, '✎'),
      h('button', { class: 'btn sm danger', onClick: () => onQuitarConcepto(obraId, scId, cid) }, '🗑')
    ]))
  ]);
}

async function onAgregarConcepto(obraId, scId, scConceptos, conceptos) {
  const yaEnAlcance = new Set(Object.values(scConceptos).map(c => c.conceptoId));

  // Construir lista ordenada de TODOS los conceptos del catálogo (agrupadores
  // + PU) respetando orden secuencial OPUS — eso preserva la jerarquía visual.
  const todos = Object.entries(conceptos)
    .map(([cid, con]) => ({ cid, ...con }))
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));

  // Mapa "agrupador → lista de PUs descendientes" para botón "Agregar partida".
  // Un PU "pertenece" a un agrupador si el agrupador está en su path.
  const pusPorAgrupador = new Map();   // agrupadorCid → [puCid, ...]
  for (const con of todos) {
    if (!esConceptoCotizable(con)) continue;
    if (yaEnAlcance.has(con.cid)) continue;
    // Buscar todos los agrupadores ancestros en `todos` (mismo path)
    for (const ag of (con.path || []).slice(0, -1)) {   // path incluye al propio PU al final
      // Buscar agrupador por clave en `todos`
      const agNode = todos.find(x => x.tipo === 'agrupador' && x.clave === ag.clave && x.descripcion === ag.descripcion);
      if (!agNode) continue;
      if (!pusPorAgrupador.has(agNode.cid)) pusPorAgrupador.set(agNode.cid, []);
      pusPorAgrupador.get(agNode.cid).push(con.cid);
    }
  }

  // Estado de selección: cid → { cantidad: number }
  const seleccionados = new Map();
  // Estado de filtros
  let busqueda = '';
  let soloPendientes = true;

  // Refs DOM
  const search = h('input', { placeholder: 'Buscar por clave o descripción…', autofocus: true });
  const soloPendCb = h('input', { type: 'checkbox', checked: true });
  const lista = h('div', { style: { maxHeight: '52vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-2)' } });
  const contadorEl = h('div', { class: 'muted', style: { fontSize: '12px' } }, '');

  search.addEventListener('input', () => { busqueda = search.value.trim().toLowerCase(); render(); });
  soloPendCb.addEventListener('change', () => { soloPendientes = soloPendCb.checked; render(); });

  const actualizarContador = () => {
    const total = seleccionados.size;
    const importe = Array.from(seleccionados.entries()).reduce((sum, [cid, sel]) => {
      const con = conceptos[cid];
      const pu = precioUnitarioOf(con);
      return sum + (Number(sel.cantidad) || 0) * pu;
    }, 0);
    contadorEl.textContent = total === 0
      ? 'Selecciona conceptos para agregar al alcance.'
      : `${total} concepto${total === 1 ? '' : 's'} seleccionado${total === 1 ? '' : 's'} · importe a catálogo: $${importe.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (confirmarBtn) {
      confirmarBtn.disabled = total === 0;
      confirmarBtn.textContent = total === 0
        ? 'Agregar 0 conceptos'
        : `Agregar ${total} concepto${total === 1 ? '' : 's'}`;
    }
  };

  function render() {
    lista.innerHTML = '';
    let visibles = 0;
    for (const con of todos) {
      // Filtros — el match aplica a agrupadores Y PUs. Si un PU matchea, también
      // mostramos su agrupador padre para no perder contexto.
      const yaIncluido = yaEnAlcance.has(con.cid);
      if (esConceptoCotizable(con)) {
        if (soloPendientes && yaIncluido) continue;
        if (busqueda && !(`${con.clave || ''} ${con.descripcion || ''}`.toLowerCase().includes(busqueda))) continue;
        lista.appendChild(filaPU(con, yaIncluido));
        visibles++;
      } else if (con.tipo === 'agrupador') {
        // Agrupador: mostrarlo si tiene al menos un PU visible bajo él, o si su
        // propia descripción matchea la búsqueda
        const matchPropio = !busqueda || `${con.clave || ''} ${con.descripcion || ''}`.toLowerCase().includes(busqueda);
        const descendientesDisponibles = (pusPorAgrupador.get(con.cid) || [])
          .filter(puCid => {
            const pu = conceptos[puCid];
            if (!pu) return false;
            if (busqueda && !(`${pu.clave || ''} ${pu.descripcion || ''}`.toLowerCase().includes(busqueda))) return false;
            return true;
          });
        if (!matchPropio && descendientesDisponibles.length === 0) continue;
        lista.appendChild(filaAgrupador(con, descendientesDisponibles));
        visibles++;
      }
    }
    if (visibles === 0) {
      lista.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
        h('div', { class: 'muted' }, 'Sin coincidencias.')));
    }
    actualizarContador();
  }

  function filaAgrupador(ag, pusDisponibles) {
    const lvl = ag.nivel || 0;
    const numSeleccionados = pusDisponibles.filter(cid => seleccionados.has(cid)).length;
    const totalDisponibles = pusDisponibles.length;
    const btn = h('button', {
      class: 'btn sm ' + (numSeleccionados === totalDisponibles && totalDisponibles > 0 ? '' : 'primary'),
      style: { fontSize: '11px', whiteSpace: 'nowrap' },
      disabled: totalDisponibles === 0
    },
      numSeleccionados === 0 ? `+ Partida (${totalDisponibles})`
      : numSeleccionados === totalDisponibles ? `✕ Quitar partida`
      : `+ Resto (${totalDisponibles - numSeleccionados})`
    );
    btn.addEventListener('click', () => {
      if (numSeleccionados === totalDisponibles && totalDisponibles > 0) {
        // Quitar todos
        for (const cid of pusDisponibles) seleccionados.delete(cid);
      } else {
        // Agregar los que falten, cada uno con su cantidad de catálogo
        for (const cid of pusDisponibles) {
          if (!seleccionados.has(cid)) {
            const pu = conceptos[cid];
            seleccionados.set(cid, { cantidad: Number(pu?.cantidad) || 0 });
          }
        }
      }
      render();
    });

    return h('div', {
      style: {
        padding: '8px 10px 8px ' + (10 + lvl * 14) + 'px',
        background: lvl === 0 ? 'rgba(106, 169, 255, 0.07)' : 'rgba(108, 115, 132, 0.05)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '10px'
      }
    }, [
      h('div', { style: { flex: 1, minWidth: 0 } }, [
        h('div', { style: { fontSize: '11px', color: 'var(--accent)', fontFamily: 'var(--mono)', fontWeight: '600' } }, ag.clave || ''),
        h('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--text-0)' } }, ag.descripcion || '—')
      ]),
      h('div', { class: 'muted', style: { fontSize: '11px', whiteSpace: 'nowrap' } },
        totalDisponibles + ' concepto' + (totalDisponibles === 1 ? '' : 's')),
      btn
    ]);
  }

  function filaPU(pu, yaIncluido) {
    const lvl = pu.nivel || 0;
    const esAgrupadorCotizable = pu.tipo === 'agrupador';
    const sel = seleccionados.get(pu.cid);
    const checked = !!sel;
    const cb = h('input', { type: 'checkbox', checked, disabled: yaIncluido });
    const cantInput = h('input', {
      type: 'number', step: '0.01', min: '0',
      value: sel ? String(sel.cantidad) : String(Number(pu.cantidad) || 0),
      style: { width: '80px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '12px' },
      disabled: !checked
    });
    cb.addEventListener('change', () => {
      if (cb.checked) {
        seleccionados.set(pu.cid, { cantidad: Number(cantInput.value) || Number(pu.cantidad) || 0 });
        cantInput.disabled = false;
        if (Number(cantInput.value) === 0) cantInput.value = String(Number(pu.cantidad) || 0);
      } else {
        seleccionados.delete(pu.cid);
        cantInput.disabled = true;
      }
      actualizarContador();
    });
    cantInput.addEventListener('input', () => {
      const v = Number(cantInput.value);
      if (seleccionados.has(pu.cid)) {
        seleccionados.set(pu.cid, { cantidad: v });
        actualizarContador();
      }
    });

    const opusCant = Number(pu.cantidad) || 0;
    const opusPU = precioUnitarioOf(pu);
    const opusTotal = opusCant * opusPU;

    return h('div', {
      style: {
        padding: '6px 10px 6px ' + (10 + lvl * 14) + 'px',
        borderBottom: '1px solid var(--border)',
        display: 'grid',
        gridTemplateColumns: '24px 70px 1fr 60px 110px 90px 110px',
        gap: '8px', alignItems: 'center',
        opacity: yaIncluido ? 0.4 : 1
      },
      onClick: (e) => {
        // Click en cualquier parte (excepto en los inputs) alterna selección
        if (yaIncluido) return;
        if (e.target.tagName === 'INPUT') return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      }
    }, [
      cb,
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, [
        pu.clave || pu.cid.slice(0, 10),
        esAgrupadorCotizable && h('span', {
          class: 'tag',
          style: { marginLeft: '4px', fontSize: '9px', padding: '0 4px' },
          title: 'Es un agrupador con precio propio. Lo puedes contratar como bloque o por sus sub-conceptos.'
        }, 'BLOQUE')
      ]),
      h('div', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: pu.descripcion },
        (pu.descripcion || '').slice(0, 80) +
        (yaIncluido ? ' · ya en alcance' : '')),
      h('div', { class: 'muted', style: { fontSize: '11px', fontFamily: 'var(--mono)' } }, pu.unidad || ''),
      h('div', { class: 'muted', style: { fontSize: '11px', textAlign: 'right', fontFamily: 'var(--mono)' } },
        'Cat: ' + (opusCant ? opusCant.toLocaleString('es-MX', { maximumFractionDigits: 2 }) : '—')),
      cantInput,
      h('div', { class: 'muted', style: { fontSize: '11px', textAlign: 'right', fontFamily: 'var(--mono)' } },
        opusTotal ? '$' + opusTotal.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')
    ]);
  }

  // Header con columnas del listado (alineado con grid de filaPU)
  const headerCols = h('div', {
    style: {
      padding: '6px 10px',
      background: 'var(--bg-3)',
      borderBottom: '1px solid var(--border-strong)',
      display: 'grid',
      gridTemplateColumns: '24px 70px 1fr 60px 110px 90px 110px',
      gap: '8px',
      fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.3px', color: 'var(--text-1)',
      fontWeight: '600'
    }
  }, [
    h('div', {}, ''),
    h('div', {}, 'Clave'),
    h('div', {}, 'Descripción'),
    h('div', {}, 'Unidad'),
    h('div', { style: { textAlign: 'right' } }, 'Cant. catálogo'),
    h('div', { style: { textAlign: 'right' } }, 'Cant. a contratar'),
    h('div', { style: { textAlign: 'right' } }, 'Importe ref.')
  ]);
  lista.appendChild(headerCols);

  const confirmarBtn = h('button', { class: 'btn primary', disabled: true }, 'Agregar 0 conceptos');
  confirmarBtn.addEventListener('click', async () => {
    if (seleccionados.size === 0) return;
    const items = Array.from(seleccionados.entries()).map(([cid, sel]) => ({
      conceptoId: cid,
      cantidad: Number(sel.cantidad) || 0,
      notas: ''
    }));
    // Permitimos cantidad 0 (a veces se cotiza pero no se sabe cantidad final)
    confirmarBtn.disabled = true;
    confirmarBtn.textContent = 'Guardando...';
    try {
      await addSubcontratoConceptosBulk(obraId, scId, items);
      toast(`${items.length} concepto${items.length === 1 ? '' : 's'} agregado${items.length === 1 ? '' : 's'} al alcance`, 'ok');
      // Cerrar modal manualmente y refrescar (modal usa promise + onConfirm)
      document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
      navigate(`/obras/${obraId}/subcontratos/${scId}?tab=alcance`);
    } catch (err) {
      toast('Error: ' + err.message, 'danger');
      confirmarBtn.disabled = false;
    }
  });

  render();

  // Modal custom: el modal helper no soporta footer custom complejo, así que
  // armamos uno propio con backdrop.
  const root = document.getElementById('modal-root');
  const card = h('div', { class: 'modal full' }, [
    h('h2', {}, 'Agregar conceptos al alcance'),
    h('div', { class: 'row', style: { gap: '10px', marginBottom: '10px' } }, [
      h('div', { style: { flex: 1 } }, search),
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer', fontSize: '13px' } }, [
        soloPendCb, h('span', {}, 'Ocultar los que ya están en el alcance')
      ])
    ]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '6px' } },
      'Tip: usa "+ Partida (N)" para agregar todos los conceptos de un agrupador con sus cantidades del catálogo, o marca individualmente. La cantidad se pre-carga con la del catálogo OPUS — edítala si vas a subcontratar más o menos.'),
    lista,
    h('div', { class: 'actions', style: { justifyContent: 'space-between' } }, [
      contadorEl,
      h('div', { class: 'row' }, [
        h('button', { class: 'btn ghost', onClick: () => { backdrop.remove(); } }, 'Cancelar'),
        confirmarBtn
      ])
    ])
  ]);
  const backdrop = h('div', {
    class: 'modal-backdrop',
    onClick: (e) => { if (e.target === e.currentTarget) backdrop.remove(); }
  }, card);
  root.appendChild(backdrop);
}

async function onEditarConcepto(obraId, scId, cid, c, conceptos) {
  const con = conceptos[c.conceptoId];
  const cantidad = h('input', { type: 'number', step: '0.01', min: '0', value: String(c.cantidad || 0), autofocus: true });
  const costoMat = h('input', { type: 'number', step: '0.01', min: '0', value: String(c.costoMaterialSogrub || 0) });
  const notas = h('input', { value: c.notas || '' });
  await modal({
    title: `Editar concepto: ${con?.clave || ''}`,
    body: h('div', {}, [
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'Cantidad'), cantidad]),
        h('div', { class: 'field' }, [
          h('label', {}, 'Material SOGRUB (P.U.)'),
          costoMat,
          h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } },
            'Costo de material/equipo si se contrata destajista (solo MO).')
        ])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      await updateSubcontratoConcepto(obraId, scId, cid, {
        cantidad: Number(cantidad.value) || 0,
        costoMaterialSogrub: Number(costoMat.value) || 0,
        notas: notas.value.trim()
      });
      toast('Concepto actualizado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}?tab=alcance`);
      return true;
    }
  });
}

async function onQuitarConcepto(obraId, scId, cid) {
  await modal({
    title: 'Quitar concepto del alcance',
    body: h('div', {}, '¿Quitar este concepto? Si algún licitante había capturado precio para él, ese precio se conserva pero queda huérfano.'),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeSubcontratoConcepto(obraId, scId, cid);
      toast('Concepto quitado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}?tab=alcance`);
      return true;
    }
  });
}

// ====================== TAB: LICITANTES ======================

function renderLicitantes(obraId, scId, scConceptos, scLicitantes, conceptos, proveedoresObra, editable, scMeta, obraMeta) {
  const conceptoEntries = Object.entries(scConceptos);
  const licEntries = Object.entries(scLicitantes);
  const adjudicadoId = scMeta.licitanteAdjudicadoId;

  // Construir objetos para los exports (shape esperado por el módulo)
  const subParaExport = {
    meta: scMeta,
    conceptos: scConceptos,
    licitantes: scLicitantes
  };
  const obraParaExport = { meta: obraMeta || {} };

  const head = h('div', { class: 'row' }, [
    h('h3', { style: { margin: 0, flex: 1 } },
      `Licitantes (${num0(licEntries.length)})`),
    // Exports siempre disponibles
    conceptoEntries.length > 0 && h('button', {
      class: 'btn sm ghost',
      onClick: () => exportLicitantePdfCompras(obraParaExport, subParaExport, conceptos),
      title: 'PDF de invitación a cotizar (formato carta para mandar al proveedor)'
    }, '📄 PDF invitación'),
    conceptoEntries.length > 0 && h('button', {
      class: 'btn sm ghost',
      onClick: () => exportLicitanteXlsxCompras(obraParaExport, subParaExport, scId, conceptos),
      title: 'XLSX template para que el licitante llene precios'
    }, '📊 XLSX template'),
    licEntries.length > 0 && h('button', {
      class: 'btn sm ghost',
      onClick: () => exportComparativaXlsxCompras(obraParaExport, subParaExport, conceptos)
    }, '⬇ Comparativa XLSX'),
    licEntries.length > 0 && h('button', {
      class: 'btn sm ghost',
      onClick: () => exportComparativaPdfCompras(obraParaExport, subParaExport, conceptos)
    }, '⬇ Comparativa PDF'),
    editable && conceptoEntries.length > 0 && h('button', {
      class: 'btn sm ghost',
      onClick: () => importLicitanteXlsxFlow(obraId, scId, subParaExport, conceptos),
      title: 'Importar respuesta de licitante (XLSX que mandaste y te devolvió lleno)'
    }, '📥 Importar XLSX'),
    editable && h('button', {
      class: 'btn sm primary',
      onClick: () => onAgregarLicitante(obraId, scId, scConceptos, scLicitantes, proveedoresObra)
    }, '+ Agregar licitante')
  ]);

  if (conceptoEntries.length === 0) {
    return h('div', { class: 'card' }, [
      head,
      h('div', { class: 'empty', style: { marginTop: '10px' } },
        'Define primero el alcance del subcontrato. Sin conceptos no se pueden cotizar precios.')
    ]);
  }
  if (licEntries.length === 0) {
    return h('div', { class: 'card' }, [
      head,
      h('div', { class: 'empty', style: { marginTop: '10px' } }, [
        h('div', { class: 'ico' }, '💬'),
        h('div', {}, 'Sin licitantes todavía.'),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Agrega proveedores (o crea nuevos) y captura sus precios por concepto.')
      ])
    ]);
  }

  // Ordenar conceptos por orden secuencial OPUS para que la jerarquía
  // (las partidas) salga en el orden natural del XLS.
  const sortedConceptos = conceptoEntries.sort(([, a], [, b]) => {
    const oa = conceptos[a.conceptoId]?.orden ?? Number.MAX_SAFE_INTEGER;
    const ob = conceptos[b.conceptoId]?.orden ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    const ca = conceptos[a.conceptoId]?.clave || '';
    const cb = conceptos[b.conceptoId]?.clave || '';
    return ca.localeCompare(cb);
  });

  // Pre-calcular: por concepto, mejor precio comparable (normalizado sin IVA,
  // incluye material SOGRUB sumado si el licitante es destajo)
  const mejorPorConcepto = {};
  for (const [cid, c] of sortedConceptos) {
    let minNorm = Infinity, mejorLic = null;
    for (const [licId, lic] of licEntries) {
      const pc = precioComparable(lic, c);
      if (pc.precio <= 0) continue;     // si no cotizó, no entra
      // Normalizar al espacio sin IVA si el licitante es +IVA
      const norm = lic.aceptaSinIva !== false ? pc.comparable : (pc.comparable / 1.16);
      if (norm < minNorm) { minNorm = norm; mejorLic = licId; }
    }
    mejorPorConcepto[cid] = mejorLic;
  }

  // Pre-calcular: total comparable por licitante (suma precio_comparable × cantidad)
  const totalesLic = {};
  for (const [licId, lic] of licEntries) {
    let t = 0;
    for (const [, c] of sortedConceptos) {
      const pc = precioComparable(lic, c);
      if (pc.precio <= 0) continue;
      t += pc.comparable * (Number(c.cantidad) || 0);
    }
    totalesLic[licId] = t;
  }

  // Total a catálogo
  let totalCatalogo = 0;
  for (const [, c] of sortedConceptos) {
    const con = conceptos[c.conceptoId];
    totalCatalogo += (Number(c.cantidad) || 0) * precioUnitarioOf(con);
  }

  // Si hay al menos un destajista, mostramos columna "Mat. SOGRUB" para
  // que el comprador vea explícitamente qué se está sumando al precio
  // del destajo cuando lo evaluamos como comparable.
  const hayDestajo = licEntries.some(([_, l]) => l.tipoSubcontratacion === 'destajo');

  // Construir filas con headers de partida insertados cuando cambia el path
  const colspanCount = (hayDestajo ? 4 : 3) + licEntries.length;
  const filas = [];
  let lastPath = [];
  for (const [cid, c] of sortedConceptos) {
    const con = conceptos[c.conceptoId];
    const ancestros = (con?.path || []).slice(0, -1);
    let primerDif = 0;
    while (
      primerDif < lastPath.length && primerDif < ancestros.length
      && lastPath[primerDif].clave === ancestros[primerDif].clave
      && lastPath[primerDif].descripcion === ancestros[primerDif].descripcion
    ) primerDif++;
    for (let i = primerDif; i < ancestros.length; i++) {
      filas.push(headerPartidaRow(ancestros[i], i, colspanCount));
    }
    lastPath = ancestros;
    filas.push(licitanteFila(obraId, scId, cid, c, conceptos, licEntries, mejorPorConcepto[cid], editable, adjudicadoId, hayDestajo));
  }

  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 4px' } }, head),
    h('div', { class: 'muted', style: { fontSize: '11px', padding: '0 18px 8px' } }, [
      'Captura precios unitarios por celda. La celda en verde es el mejor precio de la fila (normalizado sin IVA si aplica). Ahorro % vs catálogo OPUS.',
      hayDestajo && h('span', { style: { marginLeft: '6px', color: 'var(--warn)' } },
        '· "Mat. SOGRUB" se suma a los precios de destajistas para comparar.')
    ]),
    h('div', { style: { overflow: 'auto', maxHeight: '70vh' } },
      h('table', { class: 'tbl' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { style: { position: 'sticky', left: 0, background: 'var(--bg-2)', zIndex: 2, minWidth: '280px' } }, 'Concepto'),
          h('th', { class: 'num' }, 'Cantidad'),
          h('th', { class: 'num' }, 'P.U. Catálogo'),
          hayDestajo && h('th', {
            class: 'num',
            style: { background: 'rgba(245, 196, 81, 0.06)' },
            title: 'Costo de material/equipo que SOGRUB pondría si se contrata destajo (de la pestaña Alcance)'
          }, 'Mat. SOGRUB'),
          ...licEntries.map(([licId, lic]) =>
            licColumnHeader(obraId, scId, licId, lic, totalesLic[licId], totalCatalogo, adjudicadoId === licId, editable))
        ])),
        h('tbody', {}, filas)
      ])
    )
  ]);
}

function licColumnHeader(obraId, scId, licId, lic, total, totalCat, esAdj, editable) {
  const ahorro = totalCat > 0 ? (totalCat - total) / totalCat : 0;
  const ahorroColor = ahorro > 0 ? 'var(--ok)' : 'var(--danger)';
  const esDestajo = lic.tipoSubcontratacion === 'destajo';
  return h('th', {
    class: 'num',
    style: {
      minWidth: '160px',
      background: esAdj ? 'rgba(93, 211, 158, 0.08)' : undefined,
      borderTop: esAdj ? '2px solid var(--ok)' : undefined
    },
    title: lic.nombre +
      (lic.aceptaSinIva !== false ? ' · sin IVA' : ' · +IVA') +
      (esDestajo ? ' · destajo (solo MO)' : ' · subcontrato completo')
  }, [
    h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '4px' } }, [
      h('div', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, [
        (lic.nombre || '').slice(0, 16),
        esAdj && h('span', { style: { marginLeft: '4px', color: 'var(--ok)' } }, '🏆')
      ]),
      editable && h('button', {
        class: 'btn ghost',
        style: { padding: '0 4px', fontSize: '10px', textTransform: 'none', letterSpacing: 0 },
        onClick: (e) => { e.stopPropagation(); onQuitarLicitante(obraId, scId, licId, lic); }
      }, '✕')
    ]),
    h('div', { style: { fontSize: '10px', fontWeight: 'normal', textTransform: 'none', letterSpacing: 0, display: 'flex', gap: '4px', flexWrap: 'wrap' } }, [
      lic.aceptaSinIva !== false
        ? h('span', { style: { color: 'var(--ok)' } }, 'sin IVA')
        : h('span', { style: { color: 'var(--warn)' } }, '+ IVA'),
      editable
        ? h('button', {
          class: 'btn ghost',
          style: { padding: '0 5px', fontSize: '9px', textTransform: 'none', letterSpacing: 0, color: esDestajo ? 'var(--warn)' : 'var(--text-2)', fontWeight: esDestajo ? '700' : '400' },
          title: esDestajo
            ? 'Destajo (solo MO): el comparativo suma el material SOGRUB del alcance. Clic para cambiar a Subcontrato completo.'
            : 'Subcontrato completo (su P.U. ya incluye material). Clic para marcar Destajo (solo MO) y que se sume el material SOGRUB del alcance.',
          onClick: (e) => { e.stopPropagation(); onToggleTipoLicitante(obraId, scId, licId, lic); }
        }, esDestajo ? '· DESTAJO' : '· subcontrato')
        : (esDestajo && h('span', { style: { color: 'var(--warn)', fontWeight: '600' } }, '· DESTAJO'))
    ]),
    h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-0)', marginTop: '2px' } }, money(total)),
    esDestajo && total > 0 && h('div', {
      style: { fontSize: '9px', color: 'var(--text-2)', textTransform: 'none', letterSpacing: 0 }
    }, 'MO + material SOGRUB'),
    total > 0 && totalCat > 0 && h('div', {
      style: { fontSize: '10px', fontWeight: 'normal', color: ahorroColor, textTransform: 'none', letterSpacing: 0 }
    }, `${ahorro > 0 ? '−' : '+'}${Math.abs(ahorro * 100).toFixed(1)}%`)
  ]);
}

function licitanteFila(obraId, scId, cid, c, conceptos, licEntries, mejorLicId, editable, adjudicadoId, hayDestajo) {
  const con = conceptos[c.conceptoId];
  const precioCat = precioUnitarioOf(con);
  const matSogrub = Number(c.costoMaterialSogrub) || 0;
  return h('tr', {}, [
    h('td', { style: { maxWidth: '280px', position: 'sticky', left: 0, background: 'var(--bg-1)', zIndex: 1 } }, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, con?.clave || c.conceptoId.slice(0, 10)),
      h('div', { style: { fontSize: '12px' } }, (con?.descripcion || '').slice(0, 60) + ((con?.descripcion || '').length > 60 ? '…' : '')),
      h('div', { class: 'muted', style: { fontSize: '10px' } }, con?.unidad || '')
    ]),
    h('td', { class: 'num' }, num(c.cantidad)),
    h('td', { class: 'num muted' }, precioCat > 0 ? money(precioCat) : '—'),
    hayDestajo && h('td', {
      class: 'num',
      style: {
        background: 'rgba(245, 196, 81, 0.04)',
        color: matSogrub > 0 ? 'var(--text-1)' : 'var(--text-2)',
        fontWeight: matSogrub > 0 ? '600' : 'normal'
      },
      title: 'Material/equipo SOGRUB que se suma a destajistas para comparar. Edita en pestaña Alcance.'
    }, matSogrub > 0 ? money(matSogrub) : '—'),
    ...licEntries.map(([licId, lic]) =>
      precioCelda(obraId, scId, licId, lic, c, precioCat, licId === mejorLicId, editable, adjudicadoId === licId))
  ]);
}

function precioCelda(obraId, scId, licId, lic, c, precioCat, esMejor, editable, esAdj) {
  const pc = precioComparable(lic, c);
  const precio = pc.precio;
  const comparable = pc.comparable;
  const esDestajo = pc.esDestajo;
  const matSogrub = pc.materialSogrub;

  // Para la colorización, comparamos el precio COMPARABLE contra el catálogo
  // (ajustado por IVA si el licitante es +IVA).
  const refPrecio = lic.aceptaSinIva !== false ? precioCat : (precioCat * 1.16);
  const cantidad = Number(c.cantidad) || 0;
  const importeComparable = comparable * cantidad;
  const ahorro = refPrecio > 0 && comparable > 0 ? (refPrecio - comparable) / refPrecio : 0;

  const input = h('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    value: precio > 0 ? String(precio) : '',
    placeholder: esDestajo ? 'MO $' : '$',
    style: {
      width: '90px', textAlign: 'right', fontFamily: 'var(--mono)',
      background: esAdj ? 'rgba(93, 211, 158, 0.05)' : 'var(--bg-1)'
    }
  });
  if (!editable) input.disabled = true;

  function colorize() {
    const v = Number(input.value) || 0;
    if (!v) {
      input.style.color = 'var(--text-0)';
      input.style.borderColor = 'var(--border)';
      input.style.fontWeight = 'normal';
      return;
    }
    // Comparación usa el precio comparable, no solo el cotizado.
    const vComparable = esDestajo ? v + matSogrub : v;
    if (esMejor) {
      input.style.color = 'var(--ok)';
      input.style.borderColor = 'rgba(93, 211, 158, 0.4)';
      input.style.fontWeight = '600';
    } else if (refPrecio > 0 && vComparable < refPrecio) {
      input.style.color = 'var(--ok)';
      input.style.borderColor = 'var(--border)';
      input.style.fontWeight = 'normal';
    } else if (refPrecio > 0 && vComparable > refPrecio) {
      input.style.color = 'var(--danger)';
      input.style.borderColor = 'var(--border)';
      input.style.fontWeight = 'normal';
    } else {
      input.style.color = 'var(--text-0)';
      input.style.borderColor = 'var(--border)';
      input.style.fontWeight = 'normal';
    }
  }
  colorize();

  let timer = null;
  input.addEventListener('input', () => {
    colorize();
    clearTimeout(timer);
    const v = Number(input.value) || 0;
    timer = setTimeout(() => {
      setSubcontratoLicitantePrecio(obraId, scId, licId, c.conceptoId, v)
        .catch(err => toast('Error guardando: ' + err.message, 'danger'));
    }, 600);
  });

  // Sub-líneas en la celda según tipo
  const subLineas = [];
  if (precio > 0) {
    if (esDestajo && matSogrub > 0) {
      subLineas.push(h('div', { style: { fontSize: '9px', color: 'var(--text-2)', marginTop: '2px' } },
        `MO ${money(precio)} + mat ${money(matSogrub)}`));
      subLineas.push(h('div', { style: { fontSize: '10px', color: 'var(--text-1)', fontWeight: '600' } },
        '= ' + money(comparable)));
    } else if (esDestajo) {
      subLineas.push(h('div', { style: { fontSize: '9px', color: 'var(--warn)', marginTop: '2px' } },
        '⚠ falta capt. material'));
    }
    subLineas.push(h('div', { style: { fontSize: '10px', color: 'var(--text-2)', marginTop: '2px' } },
      'Imp: ' + money(importeComparable)));
  }

  const titleParts = [];
  if (precio > 0) {
    if (esDestajo) {
      titleParts.push(`MO ${money(precio)} + material SOGRUB ${money(matSogrub)} = ${money(comparable)} comparable`);
    } else {
      titleParts.push(`Precio ${money(precio)}`);
    }
    titleParts.push(`Importe ${money(importeComparable)}`);
    if (refPrecio > 0) titleParts.push(`ahorro ${(ahorro * 100).toFixed(1)}%`);
  }

  return h('td', {
    class: 'num',
    style: {
      padding: '4px 6px',
      background: esAdj ? 'rgba(93, 211, 158, 0.04)' : undefined
    },
    title: titleParts.join(' · ')
  }, [input, ...subLineas]);
}

async function importLicitanteXlsxFlow(obraId, scId, subParaExport, conceptos) {
  // Picker de archivo nativo
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.style.display = 'none';
  document.body.appendChild(input);

  const file = await new Promise((resolve) => {
    input.addEventListener('change', () => resolve(input.files?.[0] || null));
    input.click();
  });
  input.remove();
  if (!file) return;

  let parsed;
  try {
    parsed = await parseLicitanteXlsxCompras(file, subParaExport, conceptos);
  } catch (err) {
    toast('No se pudo parsear el archivo: ' + err.message, 'danger');
    return;
  }

  if (parsed.foundCount === 0) {
    toast('El archivo no tenía precios válidos para los conceptos del alcance', 'danger');
    return;
  }

  // Mostrar resumen y permitir editar datos del licitante antes de guardar
  const nombreIn = h('input', { value: parsed.nombre || '', placeholder: 'Nombre del licitante *' });
  const rfcIn = h('input', { value: parsed.rfc || '', placeholder: 'RFC (opcional)' });
  const emailIn = h('input', { type: 'email', value: parsed.email || '' });
  const telIn = h('input', { value: parsed.telefono || '' });
  const contactoIn = h('input', { value: parsed.contacto || '' });
  const tipoSel = h('select', {}, [
    h('option', { value: 'subcontrato', selected: parsed.tipoSubcontratacion !== 'destajo' }, 'Subcontrato (MO + material + equipo)'),
    h('option', { value: 'destajo', selected: parsed.tipoSubcontratacion === 'destajo' }, 'Destajo (solo MO)')
  ]);
  const ivaCb = h('input', { type: 'checkbox', checked: true });

  await modal({
    title: 'Importar respuesta de licitante',
    size: 'lg',
    body: h('div', {}, [
      h('div', {
        class: 'tag ok',
        style: { display: 'block', marginBottom: '12px', whiteSpace: 'normal' }
      }, [
        `✓ Se leyeron `, h('b', {}, num0(parsed.foundCount)),
        ` precios válidos`, parsed.isOurTemplate ? ' del template generado por compras' : ' del archivo'
      ]),
      parsed.unmatched.length > 0 && h('div', {
        class: 'tag warn',
        style: { display: 'block', marginBottom: '12px', whiteSpace: 'normal' }
      }, [
        `⚠ ${parsed.unmatched.length} clave${parsed.unmatched.length === 1 ? '' : 's'} en el archivo no `,
        `corresponde${parsed.unmatched.length === 1 ? '' : 'n'} a ningún concepto del alcance: `,
        h('span', { class: 'mono', style: { fontSize: '11px' } }, parsed.unmatched.slice(0, 8).join(', ')),
        parsed.unmatched.length > 8 ? '…' : ''
      ]),
      h('h3', { style: { marginTop: '4px' } }, 'Datos del licitante'),
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombreIn]),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'RFC'), rfcIn]),
        h('div', { class: 'field' }, [h('label', {}, 'Teléfono'), telIn])
      ]),
      h('div', { class: 'grid-2' }, [
        h('div', { class: 'field' }, [h('label', {}, 'Email'), emailIn]),
        h('div', { class: 'field' }, [h('label', {}, 'Contacto'), contactoIn])
      ]),
      h('div', { class: 'field' }, [
        h('label', {}, 'Tipo de cotización'),
        tipoSel,
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
          parsed.tipoSubcontratacion === 'destajo'
            ? 'Detectado como destajo en el archivo. Verifica.'
            : 'Si es destajo (solo MO), cámbialo aquí — los precios sumarán el Material SOGRUB del alcance.')
      ]),
      h('div', { style: { padding: '8px 10px', background: 'var(--bg-2)', borderRadius: '6px', marginTop: '8px' } }, [
        h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
          ivaCb,
          h('span', {}, h('b', {}, 'Acepta transacciones sin IVA'))
        ])
      ])
    ]),
    confirmLabel: 'Importar como licitante',
    onConfirm: async () => {
      const nombre = nombreIn.value.trim();
      if (!nombre) { toast('Captura el nombre', 'danger'); return false; }
      try {
        await addSubcontratoLicitante(obraId, scId, {
          provId: null,
          nombre,
          rfc: rfcIn.value.trim(),
          email: emailIn.value.trim(),
          telefono: telIn.value.trim(),
          contacto: contactoIn.value.trim(),
          aceptaSinIva: ivaCb.checked,
          tipoSubcontratacion: tipoSel.value,
          precios: parsed.precios,
          notas: parsed.unmatched.length > 0
            ? `Importado de XLSX. ${parsed.unmatched.length} claves del archivo no se encontraron en el alcance.`
            : 'Importado de XLSX.'
        });
        toast(`Licitante "${nombre}" importado con ${parsed.foundCount} precio${parsed.foundCount === 1 ? '' : 's'}`, 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=licitantes`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onAgregarLicitante(obraId, scId, scConceptos, scLicitantes, proveedoresObra) {
  const yaProvIds = new Set(Object.values(scLicitantes).map(l => l.provId).filter(Boolean));
  const disponibles = proveedoresObra.filter(p =>
    !yaProvIds.has(p.proveedor_global_id || p.id)
  );

  if (disponibles.length === 0) {
    await modal({
      title: 'Sin proveedores disponibles',
      body: h('div', {}, [
        h('p', {}, 'Todos los proveedores de la obra ya están como licitantes en este subcontrato.'),
        h('p', { class: 'muted', style: { fontSize: '12px' } },
          'Para agregar más, primero asigna proveedores adicionales a la obra desde 🏷️ Proveedores.')
      ]),
      confirmLabel: 'Ir a proveedores',
      onConfirm: () => {
        navigate(`/obras/${obraId}/proveedores`);
        return true;
      }
    });
    return;
  }

  const provSel = h('select', {}, [
    h('option', { value: '' }, '— elige proveedor de la obra —'),
    ...disponibles
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      .map(p => h('option', {
        value: p.proveedor_global_id || p.id,
        dataset: {
          nombre: p.nombre, rfc: p.rfc || '', email: p.email || '',
          telefono: p.telefono || '', contacto: p.contacto || '',
          aceptaSinIva: p.aceptaSinIva !== false ? '1' : '0'
        }
      }, p.nombre + (p.aceptaSinIva !== false ? ' (sin IVA)' : ' (+ IVA)')))
  ]);
  const tipoSubSel = h('select', {}, [
    h('option', { value: 'subcontrato' }, 'Subcontrato (MO + material + equipo)'),
    h('option', { value: 'destajo' }, 'Destajo (solo mano de obra)')
  ]);
  const notas = h('input', { placeholder: 'Notas (opcional)' });

  await modal({
    title: 'Agregar licitante',
    body: h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', {}, 'Proveedor *'),
        provSel,
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, [
          '¿No está en la lista? ',
          h('a', { href: `#/obras/${obraId}/proveedores` }, 'Agrégalo primero a la obra'),
          ' y vuelve aquí.'
        ])
      ]),
      h('div', { class: 'field' }, [
        h('label', {}, 'Tipo de contratación'),
        tipoSubSel,
        h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
          'Si es destajo, sus precios se suman al "Material SOGRUB" capturado en el alcance para compararlos justamente contra subcontratistas completos.')
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Notas iniciales'), notas])
    ]),
    confirmLabel: 'Agregar',
    onConfirm: async () => {
      if (!provSel.value) { toast('Elige un proveedor', 'danger'); return false; }
      const opt = provSel.options[provSel.selectedIndex];
      try {
        await addSubcontratoLicitante(obraId, scId, {
          provId: provSel.value,
          nombre: opt.dataset.nombre,
          rfc: opt.dataset.rfc,
          email: opt.dataset.email,
          telefono: opt.dataset.telefono,
          contacto: opt.dataset.contacto,
          aceptaSinIva: opt.dataset.aceptaSinIva === '1',
          tipoSubcontratacion: tipoSubSel.value,
          notas: notas.value.trim()
        });
        toast('Licitante agregado', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=licitantes`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onQuitarLicitante(obraId, scId, licId, lic) {
  await modal({
    title: 'Quitar licitante',
    body: h('div', {}, [
      h('p', {}, `¿Quitar a "${lic.nombre}" del subcontrato?`),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Se pierden los precios que capturaste. El proveedor sigue en la obra.')
    ]),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeSubcontratoLicitante(obraId, scId, licId);
      toast('Licitante quitado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}?tab=licitantes`);
      return true;
    }
  });
}

// Cambia el tipo del licitante Subcontrato ⇄ Destajo. En destajo, el comparativo
// suma el material SOGRUB del alcance al precio de mano de obra (comparación justa).
async function onToggleTipoLicitante(obraId, scId, licId, lic) {
  const nuevo = lic.tipoSubcontratacion === 'destajo' ? 'subcontrato' : 'destajo';
  try {
    await updateSubcontratoLicitante(obraId, scId, licId, { tipoSubcontratacion: nuevo });
    toast(nuevo === 'destajo'
      ? 'Marcado como Destajo: el comparativo suma el material SOGRUB del alcance'
      : 'Marcado como Subcontrato completo', 'ok');
    navigate(`/obras/${obraId}/subcontratos/${scId}?tab=licitantes`);
  } catch (err) {
    toast('Error al cambiar el tipo: ' + err.message, 'danger');
  }
}

// ====================== TAB: ADJUDICACIÓN ======================

function renderAdjudicacion(obraId, scId, scConceptos, scLicitantes, conceptos, scMeta, editable) {
  const conceptoArr = Object.values(scConceptos);
  const licEntries = Object.entries(scLicitantes);

  if (conceptoArr.length === 0 || licEntries.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, 'Adjudicación'),
      h('div', { class: 'empty' }, 'Necesitas al menos un concepto en el alcance y un licitante con precios capturados.')
    ]);
  }

  // Calcular total y % completado de cotización por licitante
  let totalCatalogo = 0;
  for (const c of conceptoArr) {
    totalCatalogo += (Number(c.cantidad) || 0) * precioUnitarioOf(conceptos[c.conceptoId]);
  }

  const ranking = licEntries.map(([licId, lic]) => {
    let totalComparable = 0, totalCotizado = 0, cubre = 0;
    let faltaMaterial = false;
    for (const c of conceptoArr) {
      const pc = precioComparable(lic, c);
      if (pc.precio > 0) {
        cubre++;
        totalComparable += pc.comparable * (Number(c.cantidad) || 0);
        totalCotizado += pc.precio * (Number(c.cantidad) || 0);
        if (pc.esDestajo && pc.materialSogrub === 0) faltaMaterial = true;
      }
    }
    return {
      licId, lic, total: totalComparable, totalCotizado, cubre,
      totalConceptos: conceptoArr.length,
      completo: cubre === conceptoArr.length,
      esDestajo: lic.tipoSubcontratacion === 'destajo',
      faltaMaterial,
      ahorro: totalCatalogo > 0 ? (totalCatalogo - totalComparable) / totalCatalogo : 0
    };
  }).sort((a, b) => {
    if (a.completo !== b.completo) return a.completo ? -1 : 1;
    if (b.cubre !== a.cubre) return b.cubre - a.cubre;
    return a.total - b.total;
  });

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Ranking de licitantes'),
    h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '10px' } },
      `Ordenado por: completitud de cotización, luego por menor importe. Total a catálogo OPUS: ${money(totalCatalogo)}.`),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      ranking.map(r => rankingCard(obraId, scId, r, scMeta, editable)))
  ]);
}

function rankingCard(obraId, scId, r, scMeta, editable) {
  const esAdj = scMeta.licitanteAdjudicadoId === r.licId;
  const hayOtroAdj = scMeta.licitanteAdjudicadoId && !esAdj;
  const ahorroColor = r.ahorro > 0 ? 'var(--ok)' : 'var(--danger)';

  return h('div', {
    style: {
      padding: '12px 14px',
      background: esAdj ? 'rgba(93, 211, 158, 0.08)' : 'var(--bg-2)',
      border: '1px solid ' + (esAdj ? 'var(--ok)' : 'var(--border)'),
      borderRadius: '8px'
    }
  }, [
    h('div', { class: 'row', style: { gap: '12px' } }, [
      h('div', { style: { flex: 1 } }, [
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
          esAdj && h('span', { style: { color: 'var(--ok)', fontSize: '18px' } }, '🏆'),
          h('b', { style: { fontSize: '15px' } }, r.lic.nombre),
          r.lic.aceptaSinIva !== false
            ? h('span', { class: 'tag', style: { fontSize: '10px' } }, 'sin IVA')
            : h('span', { class: 'tag warn', style: { fontSize: '10px' } }, '+ IVA'),
          r.esDestajo && h('span', { class: 'tag warn', style: { fontSize: '10px' } }, 'DESTAJO (solo MO)')
        ]),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, [
          'Cotizó ', h('b', {}, `${r.cubre}/${r.totalConceptos}`), ' conceptos',
          r.completo ? '' : ' · ⚠ cotización incompleta',
          r.lic.rfc && ' · RFC: ' + r.lic.rfc
        ]),
        r.esDestajo && r.faltaMaterial && h('div', {
          class: 'tag danger',
          style: { marginTop: '6px', whiteSpace: 'normal', display: 'block', fontSize: '11px' }
        }, '⚠ Comparación imprecisa: hay conceptos sin "Material SOGRUB" capturado en el alcance. Captúralos para que el total comparable sea justo.'),
        r.esDestajo && r.totalCotizado > 0 && h('div', {
          class: 'muted',
          style: { fontSize: '11px', marginTop: '4px' }
        }, [
          'MO cotizada: ', h('b', {}, money(r.totalCotizado)),
          ' · material SOGRUB: ', h('b', {}, money(r.total - r.totalCotizado))
        ])
      ]),
      h('div', { style: { textAlign: 'right' } }, [
        h('div', { style: { fontFamily: 'var(--mono)', fontSize: '18px', fontWeight: '600' } }, money(r.total)),
        r.esDestajo && r.totalCotizado > 0 && h('div', { style: { fontSize: '10px', color: 'var(--text-2)' } }, 'MO + material'),
        r.total > 0 && h('div', { style: { fontSize: '11px', color: ahorroColor } },
          `${r.ahorro > 0 ? '−' : '+'}${Math.abs(r.ahorro * 100).toFixed(1)}% vs catálogo`)
      ]),
      editable && (esAdj
        ? h('button', {
          class: 'btn',
          onClick: () => onDesadjudicar(obraId, scId)
        }, '↺ Desadjudicar')
        : !hayOtroAdj && r.completo
          ? h('button', {
            class: 'btn primary',
            onClick: () => onAdjudicar(obraId, scId, r.licId, r.lic)
          }, '🏆 Adjudicar')
          : !hayOtroAdj && !r.completo
            ? h('button', {
              class: 'btn',
              disabled: true,
              title: 'Captura precio para todos los conceptos antes de adjudicar'
            }, 'Incompleto')
            : null)
    ])
  ]);
}

async function onAdjudicar(obraId, scId, licId, lic) {
  await modal({
    title: 'Adjudicar subcontrato',
    body: h('div', {}, [
      h('p', {}, ['Se adjudicará el subcontrato a ', h('b', {}, lic.nombre), '.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'A partir de aquí, la app de estimaciones puede generar las estimaciones parciales con base en este subcontrato. Mientras esté adjudicado no se podrán modificar precios; si necesitas cambiarlos, primero desadjudica.')
    ]),
    confirmLabel: 'Adjudicar',
    onConfirm: async () => {
      try {
        await adjudicarSubcontrato(obraId, scId, licId);
        toast(`Subcontrato adjudicado a ${lic.nombre}`, 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=adjudicacion`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onDesadjudicar(obraId, scId) {
  await modal({
    title: 'Desadjudicar subcontrato',
    body: h('div', {}, [
      h('p', {}, '¿Desadjudicar este subcontrato? Volverá a estado "cotizando" y se podrán editar precios.'),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Si ya hay estimaciones parciales emitidas hacia bitácora, esas no se afectan — son eventos independientes que el contador procesa.')
    ]),
    confirmLabel: 'Desadjudicar', danger: true,
    onConfirm: async () => {
      try {
        await desadjudicarSubcontrato(obraId, scId);
        toast('Subcontrato desadjudicado', 'ok');
        navigate(`/obras/${obraId}/subcontratos/${scId}?tab=adjudicacion`);
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// ====================== Meta ======================

async function onEditarMeta(obraId, scId, scMeta) {
  const nombre = h('input', { value: scMeta.nombre || '', autofocus: true });
  const descripcion = h('textarea', { rows: 3 }, scMeta.descripcion || '');
  await modal({
    title: 'Editar datos del subcontrato',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre'), nombre]),
      h('div', { class: 'field' }, [h('label', {}, 'Descripción'), descripcion])
    ]),
    confirmLabel: 'Guardar',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Captura un nombre', 'danger'); return false; }
      await updateSubcontratoMeta(obraId, scId, {
        nombre: n,
        descripcion: descripcion.value.trim()
      });
      toast('Subcontrato actualizado', 'ok');
      navigate(`/obras/${obraId}/subcontratos/${scId}`);
      return true;
    }
  });
}

// ====================== Helpers ======================

function totalLicitante(lic, scConceptos) {
  if (!lic) return 0;
  let t = 0;
  for (const c of Object.values(scConceptos || {})) {
    const pc = precioComparable(lic, c);
    if (pc.precio <= 0) continue;
    t += pc.comparable * (Number(c.cantidad) || 0);
  }
  return t;
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function crumbs(obraId, nombre, scNombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Subcontratos', to: `/obras/${obraId}/subcontratos` },
    { label: scNombre || '...' }
  ];
}
