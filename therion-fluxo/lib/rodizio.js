'use strict';
/**
 * Rodízio de responsáveis (§8.5): round robin sobre a lista em ordem alfabética.
 *
 * Implementação de referência, pura. A atribuição real acontece dentro da transação, em
 * sql/registrar_acao.sql#_proximo_rodizio, com o MESMO algoritmo; tests/integracao compara os dois.
 */
const { chaveOrdenacao } = require('./texto');

function chave(m) { return m.nome_ordenacao ?? chaveOrdenacao(m.nome); }
function comparar(a, b) {
  const ka = chave(a), kb = chave(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param {Array<{id:string,nome:string,nome_ordenacao?:string,ativo?:boolean,disponivel?:boolean,is_sistema?:boolean}>} membros
 *        todos os membros da diretoria (inclusive inativos, para localizar o último atribuído)
 * @param {string|null} ultimoId  id do último membro que recebeu uma etapa nesse rodízio
 * @returns {object|null} próximo membro, ou null se ninguém estiver disponível
 */
function escolherResponsavel(membros, ultimoId) {
  const candidatos = membros
    .filter((m) => m.ativo !== false && m.disponivel !== false && !m.is_sistema)
    .sort(comparar);
  if (!candidatos.length) return null;
  const ultimo = membros.find((m) => m.id === ultimoId);
  if (!ultimo) return candidatos[0];
  // Compara pelo NOME (não pela posição) para que entradas/saídas de membros não baguncem a vez.
  return candidatos.find((m) => comparar(m, ultimo) > 0) || candidatos[0];
}

module.exports = { escolherResponsavel };
