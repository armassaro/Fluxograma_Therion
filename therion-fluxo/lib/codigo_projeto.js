'use strict';
/** Código legível do projeto: P-<ano>-<seq 4 dígitos> (ex.: P-2026-0042). A sequência vem de `sequencias_codigo`. */
function gerarCodigo(ano, seq) {
  if (!Number.isInteger(ano) || ano < 2000 || ano > 9999) throw new Error(`ano inválido: ${ano}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`sequência inválida: ${seq}`);
  return `P-${ano}-${String(seq).padStart(4, '0')}`;
}
const REGEX_CODIGO = /^P-(\d{4})-(\d{4,})$/;
function lerCodigo(codigo) {
  const m = REGEX_CODIGO.exec(String(codigo || '').trim().toUpperCase());
  return m ? { ano: Number(m[1]), seq: Number(m[2]) } : null;
}
module.exports = { gerarCodigo, lerCodigo, REGEX_CODIGO };
