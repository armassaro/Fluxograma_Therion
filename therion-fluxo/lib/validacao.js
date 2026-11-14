'use strict';
/**
 * Validação e conversão dos campos de uma ação (§8.2).
 * Os valores chegam como texto digitado num chat; saem tipados para gravar em acoes.dados.
 */
const { normalizar } = require('./texto');

const PULAR = ['pular', '-', 'nenhum', 'nenhuma', 'n/a'];
function ehPular(texto) { return PULAR.includes(normalizar(texto)); }

/** "1.234,56" | "R$ 1200" | "1234.56" | "1.234" -> número. Retorna NaN se não entender. */
function parseNumeroBr(bruto) {
  if (typeof bruto === 'number') return bruto;
  let s = String(bruto ?? '').replace(/r\$/i, '').replace(/\s/g, '');
  if (!s || !/^-?[\d.,]+$/.test(s)) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "1.234" = mil duzentos e trinta e quatro
  if ((s.match(/\./g) || []).length > 1) return NaN;
  return Number(s);
}

/** "25/12/2026" | "2026-12-25" -> "2026-12-25". Retorna null se inválida. */
function parseData(bruto) {
  const s = String(bruto ?? '').trim();
  let a, m, d;
  let r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (r) [d, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Converte um valor bruto conforme a definição do campo.
 * @returns {{ok:true, valor:any} | {ok:false, erro:string}}
 */
function converterValor(def, bruto) {
  const rot = def.rotulo || def.nome;
  switch (def.tipo) {
    case 'text': {
      const v = String(bruto ?? '').trim();
      if (!v) return { ok: false, erro: `${rot}: informe um texto.` };
      if (v.length > 2000) return { ok: false, erro: `${rot}: texto longo demais (máx. 2000 caracteres).` };
      return { ok: true, valor: v };
    }
    case 'number':
    case 'money': {
      let n = parseNumeroBr(bruto);
      if (!Number.isFinite(n)) return { ok: false, erro: `${rot}: informe um número (ex.: ${def.tipo === 'money' ? '1.250,00' : '40'}).` };
      if (def.tipo === 'money') n = Math.round(n * 100) / 100;
      if (def.min !== undefined && n < def.min) return { ok: false, erro: `${rot}: o mínimo é ${def.min}.` };
      if (def.max !== undefined && n > def.max) return { ok: false, erro: `${rot}: o máximo é ${def.max}.` };
      return { ok: true, valor: n };
    }
    case 'date': {
      const d = parseData(bruto);
      return d ? { ok: true, valor: d } : { ok: false, erro: `${rot}: informe uma data válida (dd/mm/aaaa).` };
    }
    case 'enum': {
      const alvo = normalizar(bruto);
      const op = (def.opcoes || []).find((o) => normalizar(o) === alvo);
      return op !== undefined
        ? { ok: true, valor: op }
        : { ok: false, erro: `${rot}: escolha uma das opções: ${(def.opcoes || []).join(', ')}.` };
    }
    default:
      return { ok: false, erro: `${rot}: tipo de campo não suportado (${def.tipo}).` };
  }
}

/**
 * Valida um arquivo recebido contra o campo e os limites globais.
 * @returns {string|null} mensagem de erro ou null
 */
function validarArquivo(def, arq, cfg) {
  const rot = def.rotulo || def.nome;
  const ext = (/\.([a-z0-9]+)$/i.exec(arq.nome || '') || [])[1]?.toLowerCase() || '';
  const permitidas = (def.extensoes || cfg.arquivoExtensoes || []).map((x) => String(x).toLowerCase());
  if (permitidas.length && !permitidas.includes(ext)) {
    return `${rot}: tipo de arquivo não permitido (.${ext || '?'}). Aceitos: ${permitidas.join(', ')}.`;
  }
  const max = (cfg.arquivoTamanhoMaxMb || 20) * 1024 * 1024;
  if (arq.tamanho && arq.tamanho > max) return `${rot}: arquivo maior que ${cfg.arquivoTamanhoMaxMb} MB.`;
  return null;
}

/**
 * Valida o conjunto de campos de uma ação.
 * @param {object[]} defs      definições (do template ou das ações globais)
 * @param {object}   campos    valores informados (texto ou já tipados)
 * @param {object[]} arquivos  [{campo, nome, mime, tamanho, ...}]
 * @returns {{ok:boolean, faltantes:object[], erros:{campo:string,mensagem:string}[], normalizados:object}}
 */
function validarCampos(defs, campos = {}, arquivos = [], cfg = {}) {
  const faltantes = [], erros = [], normalizados = {};
  for (const def of defs) {
    if (def.tipo === 'arquivo') {
      const arq = arquivos.find((a) => a.campo === def.nome);
      if (!arq) { if (def.obrigatorio) faltantes.push(def); continue; }
      const erro = validarArquivo(def, arq, cfg);
      if (erro) erros.push({ campo: def.nome, mensagem: erro });
      continue;
    }
    const bruto = campos[def.nome];
    if (bruto === undefined || bruto === null || String(bruto).trim() === '') {
      if (def.obrigatorio) faltantes.push(def);
      continue;
    }
    const r = converterValor(def, bruto);
    if (r.ok) normalizados[def.nome] = r.valor;
    else erros.push({ campo: def.nome, mensagem: r.erro });
  }
  return { ok: !faltantes.length && !erros.length, faltantes, erros, normalizados };
}

module.exports = { validarCampos, converterValor, validarArquivo, parseNumeroBr, parseData, ehPular };
