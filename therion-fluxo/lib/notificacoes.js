'use strict';
/**
 * Decide por qual canal cada pessoa é avisada e monta as mensagens de notificação (§9).
 * Saída: lista de "mensagens" neutras; lib/render.js converte em chamadas de cada canal.
 *   { membro_id, canal, destino, assunto, texto, botoes }
 */
const { textoNotificacao } = require('./mensagens');

/**
 * Canal efetivo para um destinatário: o preferido, se estiver habilitado para ele e ligado
 * no sistema; senão o outro disponível (fallback). null = não há como avisar.
 */
function resolverCanal(dest, cfg) {
  const habilitados = dest.canais_habilitados || [];
  const pode = {
    telegram: cfg.notificacoes.telegram && !!dest.telegram_user_id && habilitados.includes('telegram'),
    email: cfg.notificacoes.email && !!dest.email && habilitados.includes('email'),
  };
  if (pode[dest.canal_preferido]) return dest.canal_preferido;
  if (pode.telegram) return 'telegram';
  if (pode.email) return 'email';
  // Último recurso: e-mail mesmo que o membro não o tenha listado, para ninguém ficar sem aviso.
  if (cfg.notificacoes.email && dest.email) return 'email';
  return null;
}

/**
 * @param {object} resultado  retorno de registrar_acao/criar_projeto (ok=true)
 * @param {{rotulo:string}} meta
 * @param {object} cfg
 */
function montarNotificacoes(resultado, meta, cfg) {
  const p = resultado.projeto;
  const mensagens = [];
  for (const d of resultado.destinatarios || []) {
    const canal = resolverCanal(d, cfg);
    if (!canal) continue;
    mensagens.push({
      membro_id: d.membro_id,
      canal,
      destino: canal === 'telegram' ? String(d.telegram_user_id) : d.email,
      assunto: `[${p.codigo}] ${p.nome} — ${p.etapa?.nome || ''}`,
      texto: textoNotificacao(resultado, { rotulo: meta.rotulo, motivo: d.motivo }),
      botoes: canal === 'telegram' ? [{ rotulo: 'Ver projeto e ações', dados: `proj:${p.codigo}` }] : [],
    });
  }
  return mensagens;
}

module.exports = { resolverCanal, montarNotificacoes };
