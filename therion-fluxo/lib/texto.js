'use strict';
/**
 * Utilitários de texto e formatação (pt-BR). Sem dependências.
 */

const TZ_PADRAO = 'America/Sao_Paulo';

/** Remove acentos: "João" -> "Joao". */
function semAcento(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Forma canônica para comparar textos digitados por pessoas (sem acento/caixa/espaços extras). */
function normalizar(s) {
  return semAcento(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Chave de ordenação alfabética de nomes usada pelo rodízio (coluna membros.nome_ordenacao).
 * É a ÚNICA fonte dessa normalização: o SQL apenas ordena pelo valor gravado.
 */
function chaveOrdenacao(nome) {
  return normalizar(nome);
}

/** "2026-11-13T17:03:00Z" -> "13/11 14:03" no fuso da EJ. */
function fmtDataHora(iso, tz = TZ_PADRAO) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** 1234.5 -> "R$ 1.234,50". */
function fmtMoeda(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const [int, dec] = Number(n).toFixed(2).split('.');
  return `R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

const NOMES_DIRETORIA = {
  comercial: 'Comercial', projetos: 'Projetos', financeiro: 'Financeiro',
  administrativo: 'Administrativo', presidencia: 'Presidência',
};
function nomeDiretoria(d) { return NOMES_DIRETORIA[d] || String(d ?? '—'); }

const NOMES_STATUS = { ativo: 'ativo', pausado: 'pausado', concluido: 'concluído', abandonado: 'abandonado' };
function nomeStatus(s) { return NOMES_STATUS[s] || String(s ?? '—'); }

module.exports = { semAcento, normalizar, chaveOrdenacao, fmtDataHora, fmtMoeda, nomeDiretoria, nomeStatus, TZ_PADRAO };
