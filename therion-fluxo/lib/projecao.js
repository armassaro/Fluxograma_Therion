'use strict';
/**
 * Projeção de estado (event sourcing): reexecuta as ações NÃO revertidas, em ordem, e devolve
 * o estado que o projeto deve ter. É a definição de referência do estado; a tabela `projetos`
 * é só um cache dela. Usada em testes de consistência e no simulador.
 *
 * Cada ação precisa de: seq, tipo_acao, status_novo, dados, revertida_por_id e
 * etapa_destino_chave (como devolvido por carregar_dados()).
 */

const CAMPOS_NUMERICOS = ['estimativa_horas', 'estimativa_filamento_g', 'valor_orcado', 'valor_contratado'];

function projetarEstado(acoes) {
  const estado = { etapa_chave: null, status: 'ativo', total_pago: 0, acoes_efetivas: 0 };
  for (const c of CAMPOS_NUMERICOS) estado[c] = null;

  const ordenadas = [...acoes].sort((a, b) => a.seq - b.seq);
  for (const a of ordenadas) {
    // Ações revertidas e as próprias reversões não contam: revertem sempre do fim para o começo,
    // então ignorá-las equivale a desfazê-las.
    if (a.revertida_por_id || a.tipo_acao === 'reverter') continue;
    estado.acoes_efetivas += 1;
    if (a.etapa_destino_chave) estado.etapa_chave = a.etapa_destino_chave;
    estado.status = a.status_novo;
    for (const c of CAMPOS_NUMERICOS) {
      if (typeof a.dados?.[c] === 'number') estado[c] = a.dados[c];
    }
    if (a.tipo_acao === 'registrar_parcela') estado.total_pago += Number(a.dados?.valor_pago) || 0;
  }
  return estado;
}

/**
 * Compara a projeção com a linha de `projetos`. Devolve a lista de divergências (vazia = consistente).
 */
function divergencias(projeto, acoes) {
  const e = projetarEstado(acoes);
  const dif = [];
  if (projeto.etapa?.chave !== e.etapa_chave) dif.push(`etapa: banco=${projeto.etapa?.chave} projeção=${e.etapa_chave}`);
  if (projeto.status !== e.status) dif.push(`status: banco=${projeto.status} projeção=${e.status}`);
  for (const c of CAMPOS_NUMERICOS) {
    const b = projeto[c] === null || projeto[c] === undefined ? null : Number(projeto[c]);
    if (b !== e[c]) dif.push(`${c}: banco=${b} projeção=${e[c]}`);
  }
  return dif;
}

module.exports = { projetarEstado, divergencias, CAMPOS_NUMERICOS };
