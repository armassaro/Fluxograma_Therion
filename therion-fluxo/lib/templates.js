'use strict';
/**
 * Templates de fluxo (máquina de estados por tipo de serviço) e ações globais.
 * Um template é o conteúdo de fluxos/<tipo>.yaml já convertido em objeto.
 */
const { parseGuarda } = require('./guardas');

const DIRETORIAS = ['comercial', 'projetos', 'financeiro', 'administrativo'];
const TIPOS_CAMPO = ['text', 'number', 'money', 'date', 'enum', 'arquivo'];
const STATUS_TERMINAIS = ['concluido', 'abandonado'];

/**
 * Ações globais: valem em qualquer etapa não-terminal e não aparecem no YAML (§6).
 * `tipo: membro` é resolvido pelo motor contra os membros da diretoria responsável.
 */
const ACOES_GLOBAIS = {
  pausar: {
    rotulo: 'Pausar projeto',
    campos: [{ nome: 'motivo', rotulo: 'Motivo da pausa', tipo: 'text', obrigatorio: true }],
  },
  retomar: { rotulo: 'Retomar projeto', campos: [] },
  abandonar: {
    rotulo: 'Abandonar projeto',
    campos: [{
      nome: 'motivo', rotulo: 'Motivo do abandono', tipo: 'text', obrigatorio: true,
      // Viram botões no Telegram; o usuário também pode digitar um motivo próprio.
      sugestoes: [
        'Cliente cancelou o projeto',
        'Orçamento muito alto para o cliente',
        'Tempo estimado em escopo muito alto',
      ],
    }],
  },
  reverter: { rotulo: 'Reverter última ação', campos: [] },
  comentar: {
    rotulo: 'Comentar',
    campos: [
      { nome: 'comentario', rotulo: 'Comentário', tipo: 'text', obrigatorio: true },
      { nome: 'anexo', rotulo: 'Anexo', tipo: 'arquivo', obrigatorio: false },
    ],
  },
  reatribuir: {
    rotulo: 'Trocar responsável',
    campos: [{ nome: 'novo_responsavel', rotulo: 'Novo responsável (pule para usar o rodízio)', tipo: 'membro', obrigatorio: false }],
  },
};

/** Deixa o template numa forma única: `de` sempre lista, `campos`/`efeitos` sempre presentes. */
function normalizarTemplate(def) {
  const t = JSON.parse(JSON.stringify(def));
  t.transicoes = (t.transicoes || []).map((tr) => ({
    ...tr,
    de: Array.isArray(tr.de) ? tr.de : [tr.de],
    campos: tr.campos || [],
    efeitos: tr.efeitos || [],
  }));
  return t;
}

/**
 * Valida um template já normalizado.
 * @returns {string[]} lista de erros (vazia = válido)
 */
function validarTemplate(t) {
  const erros = [];
  const e = (m) => erros.push(m);
  if (!t || typeof t !== 'object') return ['template vazio'];
  if (!/^[a-z][a-z0-9_]*$/.test(t.tipo_servico || '')) e('tipo_servico ausente ou inválido (use minúsculas_e_sublinhado)');
  if (!Number.isInteger(t.versao) || t.versao < 1) e('versao deve ser inteiro >= 1');
  const etapas = t.etapas && typeof t.etapas === 'object' ? t.etapas : {};
  const chaves = Object.keys(etapas);
  if (!chaves.length) e('nenhuma etapa definida');
  if (!etapas[t.etapa_inicial]) e(`etapa_inicial "${t.etapa_inicial}" não existe`);

  for (const [k, et] of Object.entries(etapas)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) e(`etapa "${k}": chave inválida`);
    if (!et.nome) e(`etapa "${k}": falta nome`);
    if (!DIRETORIAS.includes(et.diretoria)) e(`etapa "${k}": diretoria inválida "${et.diretoria}"`);
    if (et.terminal && !STATUS_TERMINAIS.includes(et.status_projeto)) e(`etapa terminal "${k}": status_projeto deve ser concluido ou abandonado`);
    if (!et.terminal && et.sla_horas !== undefined && !(Number(et.sla_horas) > 0)) e(`etapa "${k}": sla_horas inválido`);
  }
  if (!etapas.abandonado || !etapas.abandonado.terminal) e('falta a etapa terminal "abandonado" (usada pela ação global abandonar)');

  const vistos = new Set();
  for (const tr of t.transicoes || []) {
    const id = `transição "${tr.acao}"`;
    if (!/^[a-z][a-z0-9_]*$/.test(tr.acao || '')) { e(`${id}: nome de ação inválido`); continue; }
    if (ACOES_GLOBAIS[tr.acao] || tr.acao === 'criar_projeto') e(`${id}: nome reservado a uma ação global`);
    // O botão do Telegram carrega "acao:P-AAAA-NNNNNN:<acao>" e o limite do callback_data é 64 bytes.
    if (`acao:P-0000-000000:${tr.acao}`.length > 64) e(`${id}: nome longo demais para botão do Telegram`);
    if (!etapas[tr.para]) e(`${id}: etapa de destino "${tr.para}" não existe`);
    for (const de of tr.de || []) {
      if (!etapas[de]) e(`${id}: etapa de origem "${de}" não existe`);
      else if (etapas[de].terminal) e(`${id}: etapa terminal "${de}" não pode ter saída`);
      if (vistos.has(`${de}|${tr.acao}`)) e(`${id}: duplicada a partir de "${de}"`);
      vistos.add(`${de}|${tr.acao}`);
    }
    const nomes = new Set();
    for (const c of tr.campos || []) {
      if (!/^[a-z][a-z0-9_]*$/.test(c.nome || '')) e(`${id}: campo com nome inválido`);
      if (nomes.has(c.nome)) e(`${id}: campo "${c.nome}" duplicado`);
      nomes.add(c.nome);
      if (!TIPOS_CAMPO.includes(c.tipo)) e(`${id}: campo "${c.nome}" com tipo inválido "${c.tipo}"`);
      if (c.tipo === 'enum' && !(Array.isArray(c.opcoes) && c.opcoes.length)) e(`${id}: campo enum "${c.nome}" sem opcoes`);
      if (c.nome === 'observacoes') e(`${id}: "observacoes" é um campo reservado`);
    }
    if (tr.guarda) { try { parseGuarda(tr.guarda); } catch (err) { e(`${id}: ${err.message}`); } }
  }

  if (t.acao_na_criacao !== undefined) {
    const tr = (t.transicoes || []).find((x) => x.acao === t.acao_na_criacao && (x.de || []).includes(t.etapa_inicial));
    if (!tr) e(`acao_na_criacao "${t.acao_na_criacao}" não é uma transição a partir da etapa inicial "${t.etapa_inicial}"`);
    else if (tr.guarda) e(`acao_na_criacao "${t.acao_na_criacao}" não pode ter guarda`);
    else if ((tr.campos || []).some((c) => c.tipo === 'membro' || (c.sistema && c.obrigatorio))) {
      e(`acao_na_criacao "${t.acao_na_criacao}": campos do tipo membro ou de sistema obrigatórios não são suportados`);
    }
  }

  // Grafo: toda etapa deve ser alcançável a partir da inicial; toda não-terminal deve ter saída.
  if (etapas[t.etapa_inicial]) {
    const alcancadas = new Set([t.etapa_inicial, 'abandonado']);
    const fila = [t.etapa_inicial];
    while (fila.length) {
      const atual = fila.shift();
      for (const tr of t.transicoes || []) {
        if ((tr.de || []).includes(atual) && !alcancadas.has(tr.para)) { alcancadas.add(tr.para); fila.push(tr.para); }
      }
    }
    for (const k of chaves) {
      if (!alcancadas.has(k)) e(`etapa "${k}" é inalcançável a partir de "${t.etapa_inicial}"`);
      if (!etapas[k].terminal && !(t.transicoes || []).some((tr) => (tr.de || []).includes(k) && tr.para !== k)) {
        e(`etapa "${k}" não tem saída para outra etapa`);
      }
    }
    if (!chaves.some((k) => etapas[k].terminal && etapas[k].status_projeto === 'concluido' && alcancadas.has(k))) {
      e('nenhuma etapa terminal "concluido" alcançável');
    }
  }
  return erros;
}

function etapaTerminal(tpl, chave) { return !!tpl?.etapas?.[chave]?.terminal; }

/** Transições do template que partem da etapa informada. */
function transicoesDisponiveis(tpl, chaveEtapa) {
  return (tpl?.transicoes || []).filter((tr) => tr.de.includes(chaveEtapa));
}

/**
 * Definição de uma ação (global ou transição) no contexto de uma etapa.
 * @returns {{classe:'global'|'transicao', tipo:string, rotulo:string, campos:object[], para?:string, guarda?:string, efeitos:string[]}|null}
 */
function definicaoAcao(tpl, chaveEtapa, tipoAcao) {
  if (ACOES_GLOBAIS[tipoAcao]) {
    const g = ACOES_GLOBAIS[tipoAcao];
    return { classe: 'global', tipo: tipoAcao, rotulo: g.rotulo, campos: g.campos, efeitos: [] };
  }
  const tr = transicoesDisponiveis(tpl, chaveEtapa).find((x) => x.acao === tipoAcao);
  if (!tr) return null;
  return {
    classe: 'transicao', tipo: tr.acao, rotulo: tr.rotulo || tr.acao, campos: tr.campos || [],
    para: tr.para, guarda: tr.guarda, efeitos: tr.efeitos || [],
  };
}

module.exports = {
  DIRETORIAS, TIPOS_CAMPO, ACOES_GLOBAIS,
  normalizarTemplate, validarTemplate, etapaTerminal, transicoesDisponiveis, definicaoAcao,
};
