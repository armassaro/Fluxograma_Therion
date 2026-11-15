'use strict';
/**
 * Leitura e validação da planilha de membros da EJ (WF-09).
 *
 * Aba = ano atual (ex.: "2026"). Colunas (posição fixa):
 *   A Nome | B E-mail UTFPR | C E-mail Therion | D CPF | E RG | F Telefone | G Endereço |
 *   H Data de nascimento | I R.A. | J Data de entrada | K Data de saída | L Tempo de permanência |
 *   M Cargo | N Diretoria
 *
 * Minimização (LGPD): o WF-09 lê SÓ as faixas de FAIXAS_PLANILHA (A:C, F, K, M:N). CPF, RG, endereço,
 * nascimento e R.A. nunca saem do Google, nem passam pelo n8n.
 *
 * Regras:
 *   - e-mail do membro = E-mail Therion (ou E-mail UTFPR se o primeiro estiver vazio);
 *   - "Egresso" no cargo ou data de saída já passada => inativo (não é usuário válido);
 *   - cargo com "diretor"/"presidente" => admin (is_admin=true, cargo='diretor').
 */
const { normalizar, chaveOrdenacao } = require('./texto');
const { parseData } = require('./validacao');

const DIRETORIAS = ['comercial', 'projetos', 'financeiro', 'administrativo', 'presidencia'];

/** Faixas lidas da aba (sem o cabeçalho). A ordem importa para montarLinhas. */
const FAIXAS_PLANILHA = ['A2:C', 'F2:F', 'K2:K', 'M2:N'];

/** Termos (normalizados) que tornam o cargo administrador. "vice-presidente" também casa com "presidente". */
const CARGOS_ADMIN = ['diretor', 'presidente'];

/** Sinônimos de diretoria (texto normalizado contém a chave). Testados em ordem. */
const SINONIMOS_DIRETORIA = [
  ['presid', 'presidencia'],
  ['comerc', 'comercial'],
  ['marketing', 'comercial'],
  ['projet', 'projetos'],
  ['administr', 'administrativo'],
  ['adm', 'administrativo'],
  ['financ', 'financeiro'],
];

/** "(11) 99999-9999" -> "+5511999999999"; null se vazio; undefined se presente mas inválido. */
function telefoneE164(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+') && d.length >= 10 && d.length <= 15) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return `+${d}`;
  return undefined;
}

/** `SYNC_MAPA_DIRETORIAS="gestao de pessoas=administrativo; mkt=comercial"` -> [[texto, diretoria]] */
function lerMapaDiretorias(texto) {
  return String(texto ?? '').split(/[;\n]/).map((par) => par.split('='))
    .filter((p) => p.length === 2)
    .map(([k, v]) => [normalizar(k), normalizar(v)])
    .filter(([k, v]) => k && DIRETORIAS.includes(v));
}

/** Texto livre da planilha -> diretoria do sistema, ou null. O mapa do .env tem prioridade. */
function mapearDiretoria(bruto, mapaExtra = []) {
  const s = normalizar(bruto);
  if (!s) return null;
  for (const [k, v] of mapaExtra) if (s === k) return v;
  if (DIRETORIAS.includes(s)) return s;
  for (const [k, v] of mapaExtra) if (s.includes(k)) return v;
  for (const [k, v] of SINONIMOS_DIRETORIA) if (s.includes(k)) return v;
  return null;
}

/**
 * Junta as faixas do `values:batchGet` (na ordem de FAIXAS_PLANILHA) em linhas.
 * O Sheets omite células vazias no fim de cada linha e linhas vazias no fim da faixa.
 * @param {string[][][]} faixas  [valores A:C, valores F, valores K, valores M:N]
 */
function montarLinhas(faixas) {
  const [abc = [], f = [], k = [], mn = []] = faixas || [];
  const total = Math.max(abc.length, f.length, k.length, mn.length);
  const linhas = [];
  for (let i = 0; i < total; i++) {
    const [nome, emailUtfpr, emailTherion] = abc[i] || [];
    const [cargo, diretoria] = mn[i] || [];
    linhas.push({
      linha: i + 2,                       // linha real na planilha (1 = cabeçalho)
      nome: nome ?? '', email_utfpr: emailUtfpr ?? '', email_therion: emailTherion ?? '',
      telefone: (f[i] || [])[0] ?? '', data_saida: (k[i] || [])[0] ?? '',
      cargo: cargo ?? '', diretoria: diretoria ?? '',
    });
  }
  return linhas;
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VAZIOS = ['', '-', '--', 'n/a', 'na', 'nenhuma', 'atual', 'ativo', 'em andamento'];

/**
 * @param {object[]} linhas  saída de montarLinhas
 * @param {{mapaDiretorias?:string, hoje?:Date}} [opc]
 * @returns {{validas:object[], erros:{linha:number,email:string,erro:string}[], preservar:string[]}}
 *   preservar = e-mails de linhas com erro: o sync NÃO os desativa por ausência.
 */
function validarLinhas(linhas, opc = {}) {
  const mapa = lerMapaDiretorias(opc.mapaDiretorias);
  const hoje = (opc.hoje || new Date()).toISOString().slice(0, 10);
  const validas = [], erros = [], preservar = [], vistos = new Set(), telefones = new Set();

  for (const l of linhas || []) {
    const nome = String(l.nome ?? '').replace(/\s+/g, ' ').trim();
    const therion = String(l.email_therion ?? '').trim().toLowerCase();
    const utfpr = String(l.email_utfpr ?? '').trim().toLowerCase();
    const email = therion || utfpr;
    if (!nome && !email) continue;   // linha em branco
    const falha = (erro, preserva = true) => {
      erros.push({ linha: l.linha, email, erro });
      if (preserva && RE_EMAIL.test(email)) preservar.push(email);
    };

    if (!nome) { falha('nome vazio'); continue; }
    if (!email) { falha('sem e-mail (Therion ou UTFPR)', false); continue; }
    if (!RE_EMAIL.test(email)) { falha(`e-mail inválido: "${email}"`, false); continue; }
    if (vistos.has(email)) { falha('e-mail repetido na planilha'); continue; }

    const cargoTxt = normalizar(l.cargo);
    const egresso = cargoTxt.includes('egresso');
    const admin = !egresso && CARGOS_ADMIN.some((c) => cargoTxt.includes(c));

    // Data de saída: vazia/placeholder => ainda na EJ; data passada => saiu; ilegível => erro (preserva).
    const saidaTxt = String(l.data_saida ?? '').trim();
    let saiu = false;
    if (!VAZIOS.includes(normalizar(saidaTxt))) {
      const iso = parseData(saidaTxt);
      if (!iso) { falha(`data de saída ilegível: "${saidaTxt}" (use dd/mm/aaaa)`); continue; }
      saiu = iso <= hoje;
    }
    const ativo = !egresso && !saiu;

    let diretoria = mapearDiretoria(l.diretoria, mapa);
    if (!diretoria && cargoTxt.includes('presidente')) diretoria = 'presidencia';
    if (!diretoria) {
      // Egresso sem diretoria reconhecível não precisa de diretoria: só será desativado.
      if (!ativo) diretoria = null;   // o SQL mantém a diretoria que já estava no banco
      else { falha(`diretoria não reconhecida: "${l.diretoria ?? ''}" (ajuste SYNC_MAPA_DIRETORIAS)`); continue; }
    }

    let telefone = telefoneE164(l.telefone);
    if (telefone === undefined) { erros.push({ linha: l.linha, email, erro: 'telefone inválido (importado sem telefone)' }); telefone = null; }
    if (telefone && telefones.has(telefone)) { erros.push({ linha: l.linha, email, erro: 'telefone repetido (importado sem telefone)' }); telefone = null; }
    if (telefone) telefones.add(telefone);

    vistos.add(email);
    validas.push({
      nome, nome_ordenacao: chaveOrdenacao(nome), email, telefone_e164: telefone, diretoria,
      cargo: admin ? 'diretor' : 'membro', is_admin: admin, ativo,
    });
  }
  return { validas, erros, preservar: [...new Set(preservar)].filter((e) => !vistos.has(e)) };
}

/** Nome da aba: SHEETS_MEMBROS_ABA ou o ano atual no fuso da EJ. */
function abaMembros(env = {}, agora = new Date()) {
  if (env.SHEETS_MEMBROS_ABA) return String(env.SHEETS_MEMBROS_ABA);
  return new Intl.DateTimeFormat('en', { timeZone: env.TZ || 'America/Sao_Paulo', year: 'numeric' }).format(agora);
}

/** Faixas A1 completas para o batchGet, com a aba entre aspas simples. */
function faixasBatchGet(aba) {
  const nome = `'${String(aba).replace(/'/g, "''")}'`;
  return FAIXAS_PLANILHA.map((f) => `${nome}!${f}`);
}

const lista = (titulo, itens, fmt) => (itens && itens.length ? [`${titulo} (${itens.length}):`, ...itens.slice(0, 40).map((x) => `  • ${fmt(x)}`), ...(itens.length > 40 ? [`  … e mais ${itens.length - 40}`] : [])] : []);

/**
 * Texto do relatório do sync (sem dados sensíveis: só nome, e-mail e o erro da linha).
 * @param {object} r            retorno de sync_membros
 * @param {object[]} errosPlanilha  erros de validarLinhas
 * @param {{aba?:string}} [opc]
 * @returns {{texto:string, botoes:object[], houveMudanca:boolean}}
 */
function relatorioSync(r, errosPlanilha = [], opc = {}) {
  const L = [];
  const aba = opc.aba ? ` (aba ${opc.aba})` : '';
  const botoes = [];
  if (!r || !r.ok) {
    if (r && r.codigo === 'DESATIVACAO_EM_MASSA') {
      L.push(`⛔ Sync bloqueado${aba}: ${r.qtd_desativacoes} de ${r.ativos} membros ativos seriam desativados.`,
        'Nada foi alterado. Confira se a aba e a planilha estão corretas.',
        ...lista('Seriam desativados', r.desativados, (x) => `${x.nome} — ${x.motivo || ''}`),
        '', 'Se estiver tudo certo, envie /sync forcar.');
    } else {
      L.push(`⚠️ Sync NÃO aplicado${aba}: ${r ? r.codigo : 'ERRO'} (a aba está vazia ou ilegível?). Nada foi alterado.`);
    }
    L.push(...lista('Linhas com problema na planilha', errosPlanilha, (e) => `linha ${e.linha} (${e.email || 'sem e-mail'}): ${e.erro}`));
    return { texto: L.join('\n'), botoes, houveMudanca: false };
  }
  const houveMudanca = [r.novos, r.desativados, r.admins_alterados, r.erros].some((x) => x && x.length) || errosPlanilha.length > 0;
  L.push(r.simulado ? `👥 Prévia do sync de membros${aba} — nada foi alterado ainda.` : `👥 Sync de membros aplicado${aba}.`);
  L.push(...lista('Novos/reativados', r.novos, (x) => `${x.nome} <${x.email}>`));
  L.push(...lista('Desativados', r.desativados, (x) => `${x.nome} — ${x.motivo || ''}`));
  L.push(...lista('Mudança de admin', r.admins_alterados, (x) => `${x.nome}: ${x.admin ? 'passa a ser admin' : 'deixa de ser admin'}`));
  L.push(...lista('Linhas com problema na planilha (essas pessoas NÃO são desativadas)', errosPlanilha, (e) => `linha ${e.linha} (${e.email || 'sem e-mail'}): ${e.erro}`));
  L.push(...lista('Erros ao gravar', r.erros, (e) => `${e.email}: ${e.erro}`));
  if (r.ignorados && r.ignorados.length) L.push(`Egressos/saídas ignorados (nunca usaram o sistema): ${r.ignorados.length}`);
  if (!houveMudanca) L.push('Nenhuma mudança: o sistema já está igual à planilha.');
  if (r.simulado && houveMudanca) {
    botoes.push({ rotulo: '✅ Aplicar', dados: opc.forcar ? 'sync:aplicarforcado' : 'sync:aplicar' }, { rotulo: '❌ Cancelar', dados: 'cancelar' });
  }
  return { texto: L.join('\n'), botoes, houveMudanca };
}

module.exports = {
  relatorioSync,
  validarLinhas, montarLinhas, telefoneE164, mapearDiretoria, lerMapaDiretorias,
  abaMembros, faixasBatchGet, FAIXAS_PLANILHA,
};
