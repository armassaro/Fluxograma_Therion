'use strict';
/**
 * Textos e formatadores pt-BR mostrados aos membros. Tudo em texto puro (sem Markdown/HTML),
 * para que a mesma mensagem sirva a qualquer canal; lib/render.js adapta ao canal.
 */
const { fmtDataHora, fmtMoeda, nomeDiretoria, nomeStatus } = require('./texto');
const { ACOES_GLOBAIS } = require('./templates');

/** Resposta padrão (§12). `botoes`: [{rotulo, dados}] */
function resp(ok, codigo, mensagem, botoes = []) {
  return { ok, codigo, mensagem, botoes };
}

const AJUDA = [
  'Comandos disponíveis:',
  '/meus — projetos aguardando a sua diretoria',
  '/projetos [filtro] — todos os projetos em andamento',
  '/projeto P-AAAA-NNNN — detalhes e ações',
  '/novo — registrar um novo projeto (Comercial)',
  '/acao P-AAAA-NNNN <ação> [campo=valor ...] — executar uma ação',
  '/historico P-AAAA-NNNN — histórico de ações',
  '/comentar P-AAAA-NNNN <texto>',
  '/pausar, /retomar, /abandonar, /reverter, /reatribuir P-AAAA-NNNN',
  '/canal telegram|email — onde receber notificações',
  '/ausente e /disponivel — sair/voltar do rodízio',
  '/cancelar — cancelar a operação em andamento',
].join('\n');

const NAO_IDENTIFICADO = [
  'Não reconheci você como membro da EJ.',
  'Para vincular esta conta, envie:  /vincular seu.email@dominio',
  'Você receberá um código por e-mail; depois envie:  /codigo 123456',
  'Se o seu e-mail não estiver na planilha de membros, fale com a diretoria.',
].join('\n');

const ERROS = {
  CONFLITO: (cod) => `O projeto foi alterado por outra pessoa agora há pouco. Confira com /projeto ${cod || ''} e tente de novo.`,
  DUPLICADA: () => 'Esta ação já tinha sido registrada.',
  NAO_AUTORIZADO: () => 'Você não tem permissão para esta ação.',
  TRANSICAO_INVALIDA: (cod) => `Esta ação não é mais possível no estado atual do projeto. Confira com /projeto ${cod || ''}.`,
  NADA_A_REVERTER: () => 'Não há nenhuma ação para reverter neste projeto.',
  PROJETO_NAO_ENCONTRADO: () => 'Projeto não encontrado. Use /projetos para ver os códigos.',
  RESPONSAVEL_INVALIDO: () => 'O novo responsável precisa ser um membro ativo da diretoria responsável pela etapa (administradores e Presidência podem escolher qualquer membro ativo).',
  TIPO_INVALIDO: () => 'Tipo de serviço inexistente ou desativado.',
  CAMPOS_FALTANTES: () => 'Faltam informações obrigatórias.',
  VINCULO_INEXISTENTE: () => 'Não há pedido de vínculo em aberto (ou ele expirou). Envie /vincular seu.email@dominio de novo.',
  CODIGO_INVALIDO: () => 'Código incorreto. Confira o e-mail e tente de novo (após 5 erros é preciso pedir outro código).',
  CANAL_NAO_SUPORTADO: () => 'O vínculo por este canal ainda não está disponível.',
};
function mensagemErro(codigo, projetoCodigo) {
  return (ERROS[codigo] || (() => `Não foi possível concluir (${codigo}).`))(projetoCodigo);
}

function rotuloAcao(tipo, template) {
  if (ACOES_GLOBAIS[tipo]) return ACOES_GLOBAIS[tipo].rotulo;
  if (tipo === 'criar_projeto') return 'Projeto criado';
  const tr = (template?.transicoes || []).find((t) => t.acao === tipo);
  return tr?.rotulo || tipo;
}

function linhaProjeto(p) {
  const resp_ = p.responsavel_nome ? ` — ${p.responsavel_nome}` : '';
  const pausa = p.status === 'pausado' ? ' ⏸' : '';
  return `${p.codigo}${pausa} ${p.nome}\n   ${p.etapa_nome} (${nomeDiretoria(p.diretoria)})${resp_}`;
}

/** Texto de detalhes de um projeto (_projeto_json). */
function formatarProjeto(projeto, template) {
  const e = projeto.etapa || {};
  const linhas = [
    `📁 ${projeto.codigo} — ${projeto.nome}`,
    `Tipo: ${template?.nome_exibicao || projeto.tipo} · Status: ${nomeStatus(projeto.status)}`,
    `Cliente: ${projeto.cliente?.nome || '—'}`,
    `Etapa: ${e.nome || '—'} (${nomeDiretoria(e.diretoria_responsavel)})`,
    `Responsável: ${e.responsavel_nome || 'toda a diretoria'}`,
  ];
  if (e.prazo_sla && projeto.status === 'ativo') linhas.push(`Prazo da etapa: ${fmtDataHora(e.prazo_sla)}`);
  linhas.push(`Trazido por: ${projeto.membro_original_nome || '—'} · Início: ${fmtDataHora(projeto.data_inicio)}`);
  const nums = [];
  if (projeto.estimativa_horas != null) nums.push(`Estimativa: ${projeto.estimativa_horas} h`);
  if (projeto.estimativa_filamento_g != null) nums.push(`Filamento: ${projeto.estimativa_filamento_g} g`);
  if (projeto.valor_orcado != null) nums.push(`Orçado: ${fmtMoeda(projeto.valor_orcado)}`);
  if (projeto.valor_contratado != null) nums.push(`Contratado: ${fmtMoeda(projeto.valor_contratado)}`);
  if (nums.length) linhas.push(nums.join(' · '));
  if (projeto.link_pasta_drive) linhas.push(`Pasta: ${projeto.link_pasta_drive}`);
  return linhas.join('\n');
}

function formatarHistorico(projeto, acoes, template) {
  const linhas = [`🕓 Histórico de ${projeto.codigo} — ${projeto.nome}`];
  for (const a of acoes) {
    const destino = a.etapa_destino_nome && a.etapa_destino_id !== a.etapa_origem_id ? ` → ${a.etapa_destino_nome}` : '';
    const rev = a.revertida_por_id ? ' [revertida]' : '';
    linhas.push(`#${a.seq} ${fmtDataHora(a.criado_em)} — ${rotuloAcao(a.tipo_acao, template)} (${a.nome_responsavel})${destino}${rev}`);
    if (a.observacoes) linhas.push(`     obs: ${a.observacoes}`);
  }
  return linhas.join('\n');
}

/** Notificação padrão de mudança num projeto (§9). */
function textoNotificacao(resultado, { rotulo, motivo }) {
  const p = resultado.projeto, e = p.etapa || {}, a = resultado.acao;
  const cabecalho = {
    responsavel: '🔔 Você é o responsável por esta etapa',
    diretoria: '🔔 Há um projeto aguardando a sua diretoria',
    origem: 'ℹ️ Atualização de um projeto que você trouxe',
    reversao: '↩️ Uma ação foi revertida num projeto em que você estava',
  }[motivo] || '🔔 Atualização de projeto';
  const linhas = [
    cabecalho,
    `[${p.codigo}] ${p.nome}`,
    `Etapa: ${e.nome} (${nomeDiretoria(e.diretoria_responsavel)})` + (p.status !== 'ativo' ? ` · ${nomeStatus(p.status)}` : ''),
    ...(['concluido', 'abandonado'].includes(p.status) ? [] : [`Responsável: ${e.responsavel_nome || 'toda a diretoria'}`]),
    `Última ação: "${rotulo}" por ${a.nome_responsavel} — ${fmtDataHora(a.criado_em)}`,
  ];
  if (a.observacoes) linhas.push(`Obs: ${a.observacoes}`);
  if (e.prazo_sla && p.status === 'ativo') linhas.push(`Prazo: ${fmtDataHora(e.prazo_sla)}`);
  return linhas.join('\n');
}

module.exports = {
  resp, AJUDA, NAO_IDENTIFICADO, mensagemErro, rotuloAcao, linhaProjeto,
  formatarProjeto, formatarHistorico, textoNotificacao,
};
