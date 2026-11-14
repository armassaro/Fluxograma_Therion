'use strict';
/**
 * Interpretação do texto digitado nos canais (§11). Sem regra de negócio.
 */
const { normalizar } = require('./texto');

/** palavra normalizada -> comando canônico */
const ALIASES = {
  ajuda: 'ajuda', help: 'ajuda', start: 'ajuda', comandos: 'ajuda', menu: 'ajuda',
  meus: 'meus', pendentes: 'meus',
  projetos: 'projetos', listar: 'projetos',
  projeto: 'projeto', detalhes: 'projeto',
  novo: 'novo',
  acao: 'acao',
  historico: 'historico',
  fluxograma: 'fluxograma',
  reverter: 'reverter', desfazer: 'reverter',
  pausar: 'pausar', retomar: 'retomar', abandonar: 'abandonar',
  comentar: 'comentar', reatribuir: 'reatribuir',
  canal: 'canal', ausente: 'ausente', disponivel: 'disponivel',
  vincular: 'vincular', codigo: 'codigo',
  cancelar: 'cancelar', nao: 'cancelar',
  confirmar: 'confirmar', confirmo: 'confirmar', sim: 'confirmar', ok: 'confirmar',
};
/** Comandos que são atalhos de `/acao <projeto> <tipo>`. */
const ACOES_DIRETAS = ['reverter', 'pausar', 'retomar', 'abandonar', 'comentar', 'reatribuir'];

const RE_CODIGO = /\bP-\d{4}-\d{4,6}\b/i;
const RE_CAMPO = /([a-zA-Z_][a-zA-Z0-9_]*)=("([^"]*)"|'([^']*)'|(\S+))/g;

/** Primeiro código de projeto encontrado no texto (maiúsculo) ou null. */
function extrairCodigoProjeto(texto) {
  const m = RE_CODIGO.exec(String(texto ?? ''));
  return m ? m[0].toUpperCase() : null;
}

/** `a=1 b="x y" c='z'` -> {a:'1', b:'x y', c:'z'} */
function parseCampos(texto) {
  const campos = {};
  for (const m of String(texto ?? '').matchAll(RE_CAMPO)) {
    campos[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5];
  }
  return campos;
}

/**
 * @returns {{comando:string|null, comBarra:boolean, texto:string,
 *            args:{projeto_codigo?:string, tipo_acao?:string, campos:object, resto:string}}}
 *          comando=null quando o texto não começa com um comando conhecido (texto livre).
 */
function parseComando(textoBruto) {
  const texto = String(textoBruto ?? '').trim();
  const vazio = { comando: null, comBarra: false, texto, args: { campos: {}, resto: texto } };
  if (!texto) return vazio;

  const m = /^(\/?)(\S+)([\s\S]*)$/.exec(texto);
  const comBarra = m[1] === '/';
  const palavra = normalizar(m[2].split('@')[0]);   // "/meus@TherionBot" -> "meus"
  let comando = ALIASES[palavra] || null;
  if (!comando) return { ...vazio, comBarra };

  let resto = m[3].trim();
  const args = { campos: {}, resto: '' };
  args.projeto_codigo = extrairCodigoProjeto(resto) || undefined;
  if (args.projeto_codigo) resto = resto.replace(RE_CODIGO, ' ').trim();

  if (comando === 'acao' || ACOES_DIRETAS.includes(comando)) {
    args.campos = parseCampos(resto);
    resto = resto.replace(RE_CAMPO, ' ').replace(/\s+/g, ' ').trim();
    if (comando === 'acao') {
      const [tipo, ...sobra] = resto.split(' ').filter(Boolean);
      if (tipo) args.tipo_acao = normalizar(tipo).replace(/[^a-z0-9_]/g, '');
      resto = sobra.join(' ');
    } else {
      args.tipo_acao = comando;
      // Texto solto vira o campo principal: `/pausar P-.. cliente viajou` ou `/comentar P-.. liguei hoje`.
      if (resto) {
        if (comando === 'comentar' && !args.campos.comentario) args.campos.comentario = resto;
        if ((comando === 'pausar' || comando === 'abandonar') && !args.campos.motivo) args.campos.motivo = resto;
      }
      comando = 'acao';
    }
    if (args.campos.obs !== undefined) { args.campos.observacoes = args.campos.obs; delete args.campos.obs; }
  }
  args.resto = resto;
  return { comando, comBarra, texto, args };
}

module.exports = { parseComando, parseCampos, extrairCodigoProjeto, ALIASES };
