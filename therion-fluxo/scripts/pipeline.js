'use strict';
/**
 * Pipeline de uma requisição em Node — o MESMO encadeamento que os workflows WF-03/WF-04 fazem
 * no n8n (ver cabeçalho de lib/app.js). Usado pelo simulador e pelos testes de integração;
 * não envia mensagens nem fala com o Drive: devolve o que seria enviado.
 */
const { preparar, processar, concluir, mensagensDeSaida } = require('../lib/app');
const { chamar } = require('./db');

/**
 * @param {import('pg').Client} db
 * @param {object} cmd  Comando Normalizado
 * @param {object} cfg  lerConfig()
 */
async function executar(db, cmd, cfg) {
  const ctx = await chamar(db, 'ctx_entrada', {
    canal: cmd.canal, id_externo: cmd.id_externo_remetente,
    idempotency_key: cmd.idempotency_key, rate_limit: cfg.rateLimitPorMin,
  });
  const pre = preparar(cmd, ctx);
  const dados = await chamar(db, 'carregar_dados', { membro_id: pre.membro_id, projeto_codigo: pre.projeto_codigo });
  const saida = processar(pre, dados, cfg);
  if (saida.silencioso) return { pre, saida, resultado: null, final: null, mensagens: [] };

  let resultado = null;
  if (saida.operacao) {
    resultado = await chamar(db, 'executar_operacao', { fn: saida.operacao.fn, payload: saida.operacao.payload });
  }
  const final = concluir(pre, saida, resultado, cfg);
  await chamar(db, 'finalizar_requisicao', {
    canal: cmd.canal, id_externo: cmd.id_externo_remetente, idempotency_key: cmd.idempotency_key,
    resposta: final.resposta || {}, sessao: final.sessao, sessao_ttl_min: cfg.sessaoTtlMin,
  });
  return { pre, saida, resultado, final, mensagens: mensagensDeSaida(pre, final) };
}

module.exports = { executar };
