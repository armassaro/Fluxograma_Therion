'use strict';
/**
 * Motor de fluxo — parte pura (§17 WF-04, passo de pré-validação).
 *
 * planejarAcao() recebe o contexto já carregado do banco e devolve:
 *   - um erro de negócio ({ok:false, codigo, mensagem, ...}), ou
 *   - o "plano" ({ok:true, operacao}) que sql/registrar_acao.sql grava de forma atômica.
 * Não acessa banco nem rede.
 */
const { definicaoAcao, transicoesDisponiveis, etapaTerminal } = require('./templates');
const { podeExecutar } = require('./autorizacao');
const { validarCampos } = require('./validacao');
const { avaliarGuarda } = require('./guardas');
const { fmtMoeda } = require('./texto');

const NAO_REVERSIVEIS = ['reverter', 'criar_projeto', 'comentar', 'reatribuir'];

/** Última ação efetiva ainda não revertida (mesma regra do SQL). */
function alvoReversao(acoes) {
  return [...(acoes || [])]
    .sort((a, b) => b.seq - a.seq)
    .find((a) => !a.revertida_por_id && !NAO_REVERSIVEIS.includes(a.tipo_acao)) || null;
}

/** Etapa atual do projeto com a marca `terminal` vinda do template. */
function etapaAtual(projeto, template) {
  return { ...projeto.etapa, terminal: etapaTerminal(template, projeto.etapa?.chave) };
}

/** Troca campos `tipo: membro` por um enum com os nomes dos membros da diretoria responsável. */
function resolverCamposMembro(campos, membrosDiretoria) {
  return campos.map((c) => (c.tipo === 'membro'
    ? { ...c, tipo: 'enum', opcoes: (membrosDiretoria || []).map((m) => m.nome), _membro: true }
    : c));
}

/**
 * Membros que podem ser escolhidos num campo `membro` (ex.: novo responsável no `reatribuir`):
 * sempre os membros ativos da diretoria responsável pela etapa atual — inclusive para admin.
 */
function candidatosMembro(membrosDiretoria) {
  return membrosDiretoria || [];
}

/**
 * @param {object} ctx
 * @param {object}   ctx.membro            quem está agindo
 * @param {object}   ctx.projeto           _projeto_json (com .etapa e .versao)
 * @param {object}   ctx.template          definição do fluxo do projeto
 * @param {object[]} ctx.acoes             histórico (para guardas e reversão)
 * @param {object[]} [ctx.membrosDiretoria]
 * @param {string}   ctx.tipoAcao
 * @param {object}   [ctx.campos]          valores informados
 * @param {object[]} [ctx.arquivos]        [{campo, nome, ...}]
 * @param {string}   [ctx.observacoes]
 * @param {string}   ctx.canal
 * @param {string}   ctx.idempotencyKey
 * @param {object}   ctx.cfg               lerConfig()
 * @param {Date}     [ctx.agora]
 */
function planejarAcao(ctx) {
  const { membro, projeto, template, acoes = [], cfg } = ctx;
  const etapa = etapaAtual(projeto, template);
  const def = definicaoAcao(template, etapa.chave, ctx.tipoAcao);

  if (!def) {
    const disponiveis = transicoesDisponiveis(template, etapa.chave).map((t) => t.acao);
    return {
      ok: false, codigo: 'TRANSICAO_INVALIDA',
      mensagem: `A ação "${ctx.tipoAcao}" não existe na etapa "${etapa.nome}".`
        + (disponiveis.length ? ` Ações possíveis: ${disponiveis.join(', ')}.` : ''),
    };
  }

  const alvo = def.tipo === 'reverter' ? alvoReversao(acoes) : null;
  if (def.tipo === 'reverter' && !alvo) {
    return { ok: false, codigo: 'NADA_A_REVERTER', mensagem: 'Não há nenhuma ação para reverter neste projeto.' };
  }

  const aut = podeExecutar(membro, projeto, etapa, def, cfg, { alvoReversao: alvo, agora: ctx.agora });
  if (!aut.ok) {
    return { ok: false, codigo: 'NAO_AUTORIZADO', mensagem: `${aut.motivo}\nQuem pode agir: ${aut.quemPode}.`, quemPode: aut.quemPode };
  }

  const candidatos = candidatosMembro(ctx.membrosDiretoria);
  const defsCampos = resolverCamposMembro(def.campos, candidatos);
  const nomesArquivo = defsCampos.filter((c) => c.tipo === 'arquivo').map((c) => c.nome);
  const arquivos = (ctx.arquivos || []).filter((a) => nomesArquivo.includes(a.campo));
  const v = validarCampos(defsCampos, ctx.campos || {}, arquivos, cfg);
  if (v.erros.length) {
    return { ok: false, codigo: 'CAMPOS_INVALIDOS', mensagem: v.erros.map((e) => e.mensagem).join('\n'), erros: v.erros, def };
  }
  if (v.faltantes.length) {
    return {
      ok: false, codigo: 'CAMPOS_FALTANTES', def,
      mensagem: `Faltam informações: ${v.faltantes.map((f) => f.rotulo || f.nome).join(', ')}.`,
      campos_faltantes: v.faltantes.map((f) => f.nome),
    };
  }

  if (def.guarda) {
    const g = avaliarGuarda(def.guarda, { acoes, projeto });
    if (!g.ok) {
      const fmt = (n) => (n === null ? 'não informado' : fmtMoeda(n));
      return {
        ok: false, codigo: 'GUARDA_NAO_ATENDIDA',
        mensagem: `Ainda não é possível "${def.rotulo}": a condição do fluxo não foi atendida `
          + `(${fmt(g.esquerda)} de ${fmt(g.direita)}).`,
      };
    }
  }

  const dados = { ...v.normalizados };
  let observacoes = ctx.observacoes || null;
  if (def.tipo === 'comentar') { observacoes = dados.comentario; delete dados.comentario; }
  if (def.tipo === 'reatribuir' && dados.novo_responsavel) {
    const m = candidatos.find((x) => x.nome === dados.novo_responsavel);
    dados.novo_responsavel_id = m.id;
    dados.novo_responsavel_nome = m.nome;
    delete dados.novo_responsavel;
  }

  return {
    ok: true, def, alvo,
    operacao: {
      fn: 'registrar_acao',
      payload: {
        projeto_id: projeto.id,
        versao_esperada: projeto.versao,
        tipo_acao: def.tipo,
        membro_id: membro.id,
        canal: ctx.canal,
        dados,
        observacoes,
        arquivos,
        idempotency_key: ctx.idempotencyKey,
        reverte_acao_id: alvo ? alvo.id : null,
        janela_reversao_horas: cfg.janelaReversaoHoras,
        rodizio_ativo: cfg.features.rodizio,
      },
    },
  };
}

/** Ações que o membro pode executar agora (para montar botões). */
function acoesPermitidas(membro, projeto, template, acoes, cfg) {
  const etapa = etapaAtual(projeto, template);
  const pode = (def, extra) => podeExecutar(membro, projeto, etapa, def, cfg, extra).ok;
  const transicoes = transicoesDisponiveis(template, etapa.chave)
    .filter((t) => !(t.campos || []).some((c) => c.sistema && c.obrigatorio))
    .filter((t) => pode({ tipo: t.acao, classe: 'transicao' }))
    .map((t) => ({ tipo: t.acao, rotulo: t.rotulo || t.acao }));
  const globais = [];
  for (const tipo of ['comentar', 'pausar', 'retomar', 'reatribuir', 'abandonar']) {
    if (pode({ tipo, classe: 'global' })) globais.push(tipo);
  }
  const alvo = alvoReversao(acoes);
  if (alvo && pode({ tipo: 'reverter', classe: 'global' }, { alvoReversao: alvo })) globais.push('reverter');
  return { transicoes, globais };
}

module.exports = { planejarAcao, acoesPermitidas, alvoReversao, etapaAtual, candidatosMembro };
