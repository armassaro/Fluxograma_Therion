'use strict';
/**
 * Guardas de transição: mini-linguagem segura (sem eval) usada no campo `guarda` do template.
 *
 *   <termo> <op> <termo>          op: >= <= > < == !=
 *   termo:  123.45
 *         | projeto.<campo>               valor numérico do projeto
 *         | soma(<acao>.<campo>)          soma do campo nas ações NÃO revertidas daquele tipo
 *         | conta(<acao>)                 quantidade de ações não revertidas daquele tipo
 *
 * Ex.: "soma(registrar_parcela.valor_pago) >= projeto.valor_contratado"
 */

const RE_GUARDA = /^\s*(.+?)\s*(>=|<=|==|!=|>|<)\s*(.+?)\s*$/;
const RE_NUM = /^-?\d+(\.\d+)?$/;
const RE_PROJETO = /^projeto\.([a-z_][a-z0-9_]*)$/;
const RE_SOMA = /^soma\(\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\)$/;
const RE_CONTA = /^conta\(\s*([a-z_][a-z0-9_]*)\s*\)$/;

function parseTermo(t) {
  let m;
  if (RE_NUM.test(t)) return { tipo: 'numero', valor: Number(t) };
  if ((m = RE_PROJETO.exec(t))) return { tipo: 'projeto', campo: m[1] };
  if ((m = RE_SOMA.exec(t))) return { tipo: 'soma', acao: m[1], campo: m[2] };
  if ((m = RE_CONTA.exec(t))) return { tipo: 'conta', acao: m[1] };
  throw new Error(`termo de guarda inválido: "${t}"`);
}

/** Lança erro se a expressão for inválida (usado na validação do template). */
function parseGuarda(expr) {
  const m = RE_GUARDA.exec(String(expr ?? ''));
  if (!m) throw new Error(`guarda inválida: "${expr}"`);
  return { esquerda: parseTermo(m[1]), op: m[2], direita: parseTermo(m[3]) };
}

function valorTermo(t, estado) {
  const efetivas = (estado.acoes || []).filter((a) => !a.revertida_por_id && a.tipo_acao !== 'reverter');
  switch (t.tipo) {
    case 'numero': return t.valor;
    case 'projeto': {
      const v = estado.projeto ? estado.projeto[t.campo] : null;
      return v === null || v === undefined || v === '' ? null : Number(v);
    }
    case 'soma':
      return efetivas.filter((a) => a.tipo_acao === t.acao)
        .reduce((s, a) => s + (Number(a.dados?.[t.campo]) || 0), 0);
    case 'conta': return efetivas.filter((a) => a.tipo_acao === t.acao).length;
    default: return null;
  }
}

/**
 * @param {string} expr
 * @param {{acoes: object[], projeto: object}} estado
 * @returns {{ok: boolean, esquerda: number|null, direita: number|null}}
 *          ok=false também quando algum lado não tem valor (ex.: valor_contratado ainda vazio)
 */
function avaliarGuarda(expr, estado) {
  const g = parseGuarda(expr);
  const e = valorTermo(g.esquerda, estado);
  const d = valorTermo(g.direita, estado);
  if (e === null || d === null || Number.isNaN(e) || Number.isNaN(d)) return { ok: false, esquerda: e, direita: d };
  const a = Math.round(e * 100), b = Math.round(d * 100); // compara em centavos (evita erro de ponto flutuante)
  const ok = { '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b, '==': a === b, '!=': a !== b }[g.op];
  return { ok, esquerda: e, direita: d };
}

module.exports = { parseGuarda, avaliarGuarda };
