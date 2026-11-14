'use strict';
/**
 * Autorização (§8.1): quem pode executar qual ação em qual etapa.
 * Função pura; o SQL repete o mínimo (membro ativo + diretoria) como defesa em profundidade.
 */
const { nomeDiretoria, nomeStatus } = require('./texto');

/** Admin e Presidência podem agir em qualquer etapa. */
function ehSuper(membro) { return !!membro && (membro.is_admin === true || membro.diretoria === 'presidencia'); }

function descreverQuemPode(etapa, extra = '') {
  const resp = etapa?.responsavel_nome ? ` (responsável: ${etapa.responsavel_nome})` : '';
  return `diretoria ${nomeDiretoria(etapa?.diretoria_responsavel)}${resp}${extra}, administradores ou Presidência`;
}

/**
 * @param {object} membro   linha de `membros`
 * @param {object} projeto  {status, ...}
 * @param {object} etapa    etapa atual {diretoria_responsavel, responsavel_atribuido_id, responsavel_nome, terminal}
 * @param {{tipo:string, classe:'global'|'transicao'}} acao
 * @param {object} cfg      lerConfig()
 * @param {{alvoReversao?:object, agora?:Date}} extra
 * @returns {{ok:true} | {ok:false, motivo:string, quemPode:string}}
 */
function podeExecutar(membro, projeto, etapa, acao, cfg, extra = {}) {
  const negar = (motivo, quemPode = descreverQuemPode(etapa)) => ({ ok: false, motivo, quemPode });
  if (!membro || membro.ativo === false) return negar('Seu cadastro não está ativo.', 'membros ativos da EJ');

  const superUsuario = ehSuper(membro);
  const daDiretoria = membro.diretoria === etapa.diretoria_responsavel;
  const st = projeto.status;
  const emAndamento = st === 'ativo' || st === 'pausado';

  // --- pré-condições de status (valem para todos, inclusive admin)
  const exigeStatus = (ok, texto) => (ok ? null : negar(`O projeto está ${nomeStatus(st)}; ${texto}`));
  let e = null;
  switch (acao.tipo) {
    case 'retomar': e = exigeStatus(st === 'pausado', 'só é possível retomar um projeto pausado.'); break;
    case 'pausar': e = exigeStatus(st === 'ativo' && !etapa.terminal, 'só é possível pausar um projeto ativo.'); break;
    case 'abandonar': e = exigeStatus(emAndamento && !etapa.terminal, 'ele já está encerrado.'); break;
    case 'comentar': e = exigeStatus(emAndamento, 'não aceita mais comentários.'); break;
    case 'reatribuir': e = exigeStatus(emAndamento && !etapa.terminal, 'não há responsável a trocar.'); break;
    case 'reverter': break;
    default: e = exigeStatus(st === 'ativo', st === 'pausado' ? 'retome o projeto antes de avançar.' : 'ele já está encerrado.');
  }
  if (e) return e;

  // --- regras por tipo de ação
  switch (acao.tipo) {
    case 'comentar':
      return { ok: true };

    case 'pausar': case 'retomar': case 'abandonar':
      if (superUsuario || daDiretoria || membro.diretoria === 'comercial') return { ok: true };
      return negar('Você não pode executar esta ação nesta etapa.', descreverQuemPode(etapa, ', diretoria Comercial'));

    case 'reatribuir':
      if (superUsuario || daDiretoria) return { ok: true };
      return negar('Só a diretoria responsável pode trocar o responsável da etapa.');

    case 'reverter': {
      if (cfg?.features && cfg.features.reversao === false) return negar('A reversão de ações está desativada.', 'ninguém (função desligada)');
      if (superUsuario) return { ok: true };
      const quem = 'o autor da última ação (dentro do prazo), administradores ou Presidência';
      if (etapa.terminal) return negar('Projeto encerrado: só administradores podem reabrir.', 'administradores ou Presidência');
      const alvo = extra.alvoReversao;
      if (!alvo) return negar('Não há ação para reverter.', quem);
      if (alvo.membro_id !== membro.id) return negar(`A última ação foi feita por ${alvo.nome_responsavel}.`, quem);
      const horas = ((extra.agora || new Date()) - new Date(alvo.criado_em)) / 3600000;
      const janela = cfg?.janelaReversaoHoras ?? 48;
      if (horas > janela) return negar(`O prazo de ${janela}h para reverter esta ação já passou.`, 'administradores ou Presidência');
      return { ok: true };
    }

    default: { // transição do template
      const designado = !!etapa.responsavel_atribuido_id && etapa.responsavel_atribuido_id === membro.id;
      if (designado) return { ok: true };   // responsável designado (inclusive de outra diretoria, por admin)
      if (!superUsuario && !daDiretoria) return negar(`Esta etapa é da diretoria ${nomeDiretoria(etapa.diretoria_responsavel)}.`);
      if (cfg?.exigirResponsavelAtribuido && etapa.responsavel_atribuido_id && !superUsuario
          && etapa.responsavel_atribuido_id !== membro.id && membro.cargo !== 'diretor') {
        return negar(`Esta etapa está atribuída a ${etapa.responsavel_nome || 'outra pessoa'}.`,
          `${etapa.responsavel_nome || 'o responsável atribuído'}, o diretor da área ou administradores`);
      }
      return { ok: true };
    }
  }
}

module.exports = { podeExecutar, ehSuper, descreverQuemPode };
