'use strict';
/**
 * Validação das linhas da planilha "Membros EJ" antes do sync (WF-09).
 * Colunas esperadas (cabeçalho, sem diferenciar maiúsculas/acentos):
 *   nome | email | telefone | diretoria | cargo | is_admin | ativo | disponivel | canal_preferido | canais_habilitados
 */
const { normalizar, chaveOrdenacao } = require('./texto');

const DIRETORIAS = ['comercial', 'projetos', 'financeiro', 'administrativo', 'presidencia'];
const CANAIS = ['telegram', 'email', 'whatsapp'];

function bool(v, padrao) {
  const s = normalizar(v);
  if (s === '') return padrao;
  return ['true', 'verdadeiro', 'sim', 's', 'x', '1', 'yes'].includes(s);
}

/** "(11) 99999-9999" -> "+5511999999999"; null se não parecer telefone brasileiro/E.164. */
function telefoneE164(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+') && d.length >= 10 && d.length <= 15) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return `+${d}`;
  return undefined; // presente, mas inválido
}

/** Aceita cabeçalhos como "E-mail", "Diretoria ", "Canal preferido". */
function chaveColuna(k) { return normalizar(k).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

/**
 * @param {object[]} linhas  objetos {cabeçalho: valor} lidos da planilha
 * @returns {{validas: object[], erros: {linha:number, email:string, erro:string}[]}}
 */
function validarLinhas(linhas) {
  const validas = [], erros = [], vistos = new Set(), telefones = new Set();
  (linhas || []).forEach((bruta, i) => {
    const l = {};
    for (const [k, v] of Object.entries(bruta || {})) l[chaveColuna(k)] = typeof v === 'string' ? v.trim() : v;
    const numLinha = i + 2; // +1 do cabeçalho, +1 porque planilhas começam em 1
    const email = String(l.email ?? l.e_mail ?? '').toLowerCase();
    const nome = String(l.nome ?? '').trim();
    if (!nome && !email) return; // linha em branco
    const falha = (erro) => erros.push({ linha: numLinha, email, erro });

    if (!nome) return falha('nome vazio');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return falha('e-mail inválido');
    if (vistos.has(email)) return falha('e-mail duplicado na planilha');
    const diretoria = normalizar(l.diretoria);
    if (!DIRETORIAS.includes(diretoria)) return falha(`diretoria inválida: "${l.diretoria ?? ''}"`);
    const cargo = normalizar(l.cargo) || 'membro';
    if (!['membro', 'diretor'].includes(cargo)) return falha(`cargo inválido: "${l.cargo}" (use membro ou diretor)`);

    let telefone = telefoneE164(l.telefone);
    if (telefone === undefined) { falha('telefone inválido (ignorado; membro importado sem telefone)'); telefone = null; }
    if (telefone && telefones.has(telefone)) { falha('telefone repetido (ignorado)'); telefone = null; }
    if (telefone) telefones.add(telefone);

    let canais = String(l.canais_habilitados ?? '').split(/[,;\s]+/).map(normalizar).filter((c) => CANAIS.includes(c));
    if (!canais.length) canais = ['email', 'telegram'];
    let preferido = normalizar(l.canal_preferido);
    if (!CANAIS.includes(preferido)) preferido = 'email';

    vistos.add(email);
    validas.push({
      nome, nome_ordenacao: chaveOrdenacao(nome), email, telefone_e164: telefone, diretoria, cargo,
      is_admin: bool(l.is_admin, false), ativo: bool(l.ativo, true), disponivel: bool(l.disponivel, true),
      canal_preferido: preferido, canais_habilitados: canais,
    });
  });
  return { validas, erros };
}

module.exports = { validarLinhas, telefoneE164 };
