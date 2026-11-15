'use strict';
/**
 * Fluxograma visual do projeto (§15, WF-08) — parte pura.
 *
 * gerarDot() monta um grafo Graphviz (DOT) com:
 *   - cabeçalho: código, nome, tipo, status e dias em andamento;
 *   - todas as etapas do template: visitadas (verde), atual (amarelo, com responsável e prazo),
 *     futuras (cinza), terminais (azul = concluído, vermelho = abandonado);
 *   - em cada etapa visitada: diretoria, responsável, entrada/saída;
 *   - transições do template (cinza tracejado) e caminho percorrido (sólido, "#seq ação — autor, dd/mm");
 *     ações revertidas em vermelho tracejado;
 *   - tabela com as últimas ações (inclui comentários, pausas, reatribuições etc.).
 * O PNG é renderizado pelo Kroki (container local, `KROKI_URL`) no WF-05. Não acessa banco nem rede.
 */
const { fmtDataHora, nomeDiretoria, nomeStatus, TZ_PADRAO } = require('./texto');
const { rotuloAcao } = require('./mensagens');

const CORES = {
  visitada: { fill: '#d8f0d8', borda: '#2e7d32' },
  atual: { fill: '#fff1a8', borda: '#b8860b' },
  futura: { fill: '#f2f2f2', borda: '#b0b0b0' },
  concluido: { fill: '#cfe2ff', borda: '#1d4ed8' },
  abandonado: { fill: '#f8d7da', borda: '#b02a37' },
};
const MAX_ACOES_TABELA = 15;

/** Escapa texto para labels HTML do Graphviz. */
function esc(s, max = 60) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const id = (chave) => `"${String(chave).replace(/[^a-zA-Z0-9_]/g, '_')}"`;
const fmtDia = (iso, tz) => (iso ? fmtDataHora(iso, tz).split(' ')[0] : '');

function diasEntre(inicio, fim) {
  const ms = new Date(fim) - new Date(inicio);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400000)) : 0;
}

/**
 * @param {object} p
 * @param {object}   p.projeto   _projeto_json (com .etapa)
 * @param {object}   p.template  definição do fluxo
 * @param {object[]} p.acoes     histórico (com etapa_origem_chave / etapa_destino_chave)
 * @param {object[]} p.etapas    passagens pelas etapas [{chave, responsavel_nome, data_entrada, data_saida, prazo_sla}]
 * @param {{agora?:Date, tz?:string, mostrarRevertidas?:boolean}} [opc]
 * @returns {string} fonte DOT
 */
function gerarDot({ projeto, template, acoes = [], etapas = [] }, opc = {}) {
  const tz = opc.tz || TZ_PADRAO;
  const agora = opc.agora || new Date();
  const mostrarRevertidas = opc.mostrarRevertidas !== false;
  const defs = template?.etapas || {};
  const atual = projeto?.etapa?.chave;

  // Última passagem por etapa (uma etapa pode ser revisitada após reversão/negociação).
  const passagens = {};
  for (const e of [...etapas].sort((a, b) => new Date(a.data_entrada) - new Date(b.data_entrada))) {
    passagens[e.chave] = { ...e, vezes: (passagens[e.chave]?.vezes || 0) + 1 };
  }

  // "Abandonado" só aparece se o projeto foi abandonado (qualquer etapa pode levar a ele).
  const oculta = (chave) => chave === 'abandonado' && !passagens.abandonado && atual !== 'abandonado';

  const L = [];
  L.push('digraph fluxo {');
  L.push('  graph [rankdir=TB, bgcolor="white", pad="0.4", nodesep="0.35", ranksep="0.45", fontname="Helvetica", labelloc="t", fontsize=20];');
  L.push('  node [shape=plain, fontname="Helvetica", fontsize=11];');
  L.push('  edge [fontname="Helvetica", fontsize=9, color="#b0b0b0", fontcolor="#555555", arrowsize=0.7];');

  const fim = projeto?.data_final || agora;
  const titulo = `${esc(projeto?.codigo)} — ${esc(projeto?.nome, 50)}`;
  const sub = `${esc(template?.nome_exibicao || projeto?.tipo)} · ${esc(nomeStatus(projeto?.status))}`
    + ` · ${diasEntre(projeto?.data_inicio, fim)} dia(s) em andamento`
    + (projeto?.cliente?.nome ? ` · Cliente: ${esc(projeto.cliente.nome, 40)}` : '');
  L.push(`  label=<<b>${titulo}</b><br/><font point-size="12" color="#444444">${sub}</font><br/> >;`);

  // --- nós
  for (const [chave, d] of Object.entries(defs)) {
    const ps = passagens[chave];
    const ehAtual = chave === atual;
    if (oculta(chave)) continue;
    let estilo = ps ? 'visitada' : 'futura';
    if (ehAtual) estilo = 'atual';
    if (d.terminal && (ps || ehAtual)) estilo = chave === 'abandonado' || d.status_projeto === 'abandonado' ? 'abandonado' : 'concluido';
    const c = CORES[estilo];
    const cinza = estilo === 'futura';
    const cor = (t) => (cinza ? `<font color="#8a8a8a">${t}</font>` : t);
    const linhas = [];
    const marca = ehAtual && !d.terminal ? 'ETAPA ATUAL · ' : '';
    linhas.push(`<tr><td><b>${cor(esc(`${marca}${d.nome || chave}`))}</b></td></tr>`);
    if (!d.terminal) linhas.push(`<tr><td>${cor(`<font point-size="10">${esc(nomeDiretoria(d.diretoria))}</font>`)}</td></tr>`);
    if (ps && !d.terminal) {
      const resp = ehAtual ? projeto?.etapa?.responsavel_nome : ps.responsavel_nome;
      linhas.push(`<tr><td><font point-size="10">Responsável: ${esc(resp || 'toda a diretoria', 40)}</font></td></tr>`);
      const saida = ehAtual ? 'em andamento' : fmtDataHora(ps.data_saida, tz);
      linhas.push(`<tr><td><font point-size="9" color="#444444">${esc(fmtDataHora(ps.data_entrada, tz))} → ${esc(saida)}`
        + `${ps.vezes > 1 ? ` (${ps.vezes}x)` : ''}</font></td></tr>`);
      if (ehAtual && ps.prazo_sla) {
        const vencido = new Date(ps.prazo_sla) < agora;
        linhas.push(`<tr><td><font point-size="10" color="${vencido ? '#b02a37' : '#7a5c00'}">`
          + `<b>Prazo: ${esc(fmtDataHora(ps.prazo_sla, tz))}${vencido ? ' (vencido)' : ''}</b></font></td></tr>`);
      }
    } else if (ps && d.terminal) {
      linhas.push(`<tr><td><font point-size="9">${esc(fmtDataHora(ps.data_entrada, tz))}</font></td></tr>`);
    }
    const borda = ehAtual ? 3 : 1;
    L.push(`  ${id(chave)} [label=<<table border="${borda}" cellborder="0" cellspacing="2" cellpadding="4" style="rounded" `
      + `bgcolor="${c.fill}" color="${c.borda}">${linhas.join('')}</table>>];`);
  }

  // --- arestas: caminho percorrido (ações que mudaram de etapa)
  const percorridas = new Set();
  const ordenadas = [...acoes].sort((a, b) => a.seq - b.seq);
  for (const a of ordenadas) {
    const de = a.etapa_origem_chave, para = a.etapa_destino_chave;
    if (!de || !para || de === para || !defs[de] || !defs[para]) continue;
    if (oculta(para)) continue;
    const revertida = !!a.revertida_por_id;
    if (revertida && !mostrarRevertidas) continue;
    const rot = `#${a.seq} ${rotuloAcao(a.tipo_acao, template)}\\n${a.nome_responsavel || ''}, ${fmtDia(a.criado_em, tz)}`;
    const estilo = revertida
      ? 'color="#b02a37", fontcolor="#b02a37", style=dashed, penwidth=1.2'
      : (a.tipo_acao === 'reverter' ? 'color="#6f42c1", fontcolor="#6f42c1", style=bold' : 'color="#2e7d32", fontcolor="#1b5e20", penwidth=2');
    L.push(`  ${id(de)} -> ${id(para)} [label="${rot.replace(/"/g, '\\"')}${revertida ? ' (revertida)' : ''}", ${estilo}];`);
    if (!revertida) percorridas.add(`${de}>${para}`);
  }

  // --- arestas do template ainda não percorridas (o "mapa" do fluxo)
  const vistas = new Set();
  for (const t of template?.transicoes || []) {
    for (const de of [].concat(t.de || [])) {
      const k = `${de}>${t.para}`;
      if (de === t.para || percorridas.has(k) || vistas.has(k) || !defs[de] || !defs[t.para] || oculta(t.para)) continue;
      vistas.add(k);
      L.push(`  ${id(de)} -> ${id(t.para)} [style=dashed, label="${esc(t.rotulo || t.acao, 30).replace(/"/g, '\\"')}"];`);
    }
  }

  // --- tabela de ações (inclui as que não mudam de etapa: comentários, pausas, reatribuições...)
  const ultimas = ordenadas.slice(-MAX_ACOES_TABELA);
  if (ultimas.length) {
    const linhas = [`<tr><td colspan="4" bgcolor="#e9ecef"><b>Ações registradas${ordenadas.length > ultimas.length ? ` (últimas ${ultimas.length} de ${ordenadas.length})` : ''}</b></td></tr>`,
      '<tr><td align="left"><b>#</b></td><td align="left"><b>Quando</b></td><td align="left"><b>Ação</b></td><td align="left"><b>Por</b></td></tr>'];
    for (const a of ultimas) {
      const extra = a.revertida_por_id ? ' (revertida)' : '';
      const dest = a.etapa_destino_nome && a.etapa_destino_chave !== a.etapa_origem_chave ? ` → ${a.etapa_destino_nome}` : '';
      const cor = a.revertida_por_id ? '#b02a37' : '#222222';
      linhas.push(`<tr><td align="left">${a.seq}</td><td align="left">${esc(fmtDataHora(a.criado_em, tz))}</td>`
        + `<td align="left"><font color="${cor}">${esc(`${rotuloAcao(a.tipo_acao, template)}${dest}${extra}`, 70)}</font></td>`
        + `<td align="left">${esc(a.nome_responsavel, 30)}</td></tr>`);
    }
    L.push(`  acoes_tabela [label=<<table border="1" cellborder="0" cellspacing="0" cellpadding="3" color="#adb5bd" bgcolor="#ffffff">`
      + `${linhas.join('')}</table>>];`);
    L.push('  { rank=sink; acoes_tabela; }');   // rodapé, abaixo de todo o fluxo
  }

  // --- legenda
  L.push('  legenda [label=<<table border="0" cellspacing="3"><tr>'
    + `<td bgcolor="${CORES.visitada.fill}">  concluída  </td><td bgcolor="${CORES.atual.fill}">  atual  </td>`
    + `<td bgcolor="${CORES.futura.fill}">  futura  </td><td><font color="#2e7d32">━ caminho</font></td>`
    + '<td><font color="#6f42c1">━ reversão</font></td><td><font color="#b02a37">┅ revertida</font></td><td><font color="#8a8a8a">┅ possível</font></td></tr></table>>];');
  L.push(`  { rank=source; legenda; }`);
  L.push('}');
  return L.join('\n');
}

/** Pedido de imagem anexado a uma resposta: lib/render.js e o WF-05 transformam em sendPhoto. */
function pedidoImagem(dados, cfg) {
  if (!cfg?.features?.fluxograma || !dados?.projeto || !dados?.template) return null;
  return {
    tipo: 'graphviz',
    fonte: gerarDot(dados, { tz: cfg.sla?.tz, mostrarRevertidas: cfg.fluxoMostrarRevertidas }),
    legenda: `Fluxograma — ${dados.projeto.codigo} ${dados.projeto.nome}`.slice(0, 1000),
    arquivo: `fluxograma_${dados.projeto.codigo}.png`,
  };
}

module.exports = { gerarDot, pedidoImagem, esc };
