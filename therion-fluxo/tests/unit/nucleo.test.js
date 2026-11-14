'use strict';
/** Testes unitários das funções puras de lib/ (sem banco). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { lerTemplates } = require('../../scripts/carregar_fluxos');
const { validarTemplate, normalizarTemplate, transicoesDisponiveis, ACOES_GLOBAIS } = require('../../lib/templates');
const { podeExecutar } = require('../../lib/autorizacao');
const { converterValor, validarCampos, parseNumeroBr, parseData } = require('../../lib/validacao');
const { parseComando, parseCampos, extrairCodigoProjeto } = require('../../lib/comandos');
const { normalizarTelegram } = require('../../lib/normalizadores');
const { avaliarGuarda, parseGuarda } = require('../../lib/guardas');
const { escolherResponsavel } = require('../../lib/rodizio');
const { projetarEstado } = require('../../lib/projecao');
const { montarEnvios, dividirTexto } = require('../../lib/render');
const { resolverCanal } = require('../../lib/notificacoes');
const { validarLinhas, telefoneE164 } = require('../../lib/membros');
const { lerConfig } = require('../../lib/config');
const { chaveOrdenacao, fmtMoeda } = require('../../lib/texto');

const cfg = lerConfig({});
const templates = lerTemplates();
const website = templates.find((t) => t.tipo_servico === 'website');

test('templates: os YAML do repositório são válidos e completos', () => {
  assert.deepEqual(templates.map((t) => t.tipo_servico), ['impressao_modelagem_3d', 'website']);
  for (const t of templates) {
    assert.deepEqual(validarTemplate(t), []);
    // toda transição tem rótulo (vira botão) e `de` normalizado em lista
    for (const tr of t.transicoes) { assert.ok(tr.rotulo, tr.acao); assert.ok(Array.isArray(tr.de)); }
  }
  assert.deepEqual(transicoesDisponiveis(website, 'negociacao').map((t) => t.acao).sort(),
    ['cliente_recusou', 'renegociar_escopo', 'renegociar_valor']);
});

test('templates: erros de grafo e de definição são detectados', () => {
  const quebrar = (f) => { const t = normalizarTemplate(website); f(t); return validarTemplate(t).join(' | '); };
  assert.match(quebrar((t) => { t.etapa_inicial = 'nada'; }), /etapa_inicial/);
  assert.match(quebrar((t) => { t.transicoes[0].para = 'inexistente'; }), /destino "inexistente" não existe/);
  assert.match(quebrar((t) => { t.transicoes = t.transicoes.filter((x) => x.acao !== 'enviar_escopo'); }), /inalcançável/);
  assert.match(quebrar((t) => { t.transicoes.push({ acao: 'reabrir', de: ['concluido'], para: 'execucao', campos: [] }); }), /terminal "concluido" não pode ter saída/);
  assert.match(quebrar((t) => { t.transicoes[0].acao = 'pausar'; }), /reservado/);
  assert.match(quebrar((t) => { t.etapas.execucao.diretoria = 'marketing'; }), /diretoria inválida/);
  assert.match(quebrar((t) => { t.transicoes[0].campos.push({ nome: 'x', tipo: 'enum' }); }), /sem opcoes/);
  assert.match(quebrar((t) => { t.transicoes[0].guarda = 'process.exit()'; }), /guarda inválida/);
  assert.match(quebrar((t) => { delete t.etapas.abandonado; }), /abandonado/);
  assert.match(quebrar((t) => { t.transicoes[0].acao = 'a'.repeat(60); }), /longo demais/);
});

test('autorização: matriz diretoria × etapa × ação', () => {
  const m = (diretoria, extra = {}) => ({ id: `m-${diretoria}`, ativo: true, diretoria, cargo: 'membro', is_admin: false, ...extra });
  const etapa = { diretoria_responsavel: 'financeiro', responsavel_atribuido_id: 'm-outro', responsavel_nome: 'Ana', terminal: false };
  const ativo = { status: 'ativo' }, pausado = { status: 'pausado' }, concluido = { status: 'concluido' };
  const tr = { tipo: 'aprovar_orcamento_interno', classe: 'transicao' };
  const g = (tipo) => ({ tipo, classe: 'global' });
  const ok = (...a) => podeExecutar(...a).ok;

  assert.equal(ok(m('financeiro'), ativo, etapa, tr, cfg), true);
  assert.equal(ok(m('projetos'), ativo, etapa, tr, cfg), false);
  assert.equal(ok(m('projetos', { is_admin: true }), ativo, etapa, tr, cfg), true);
  assert.equal(ok(m('presidencia'), ativo, etapa, tr, cfg), true);
  assert.equal(ok(m('financeiro', { ativo: false }), ativo, etapa, tr, cfg), false);
  assert.equal(ok(m('financeiro'), pausado, etapa, tr, cfg), false);
  assert.equal(ok(m('presidencia'), pausado, etapa, tr, cfg), false, 'nem admin avança projeto pausado');
  assert.equal(ok(m('financeiro'), concluido, { ...etapa, terminal: true }, tr, cfg), false);
  const negado = podeExecutar(m('projetos'), ativo, etapa, tr, cfg);
  assert.match(negado.quemPode, /Financeiro.*Ana/);

  // responsável atribuído exigido
  const rigido = lerConfig({ EXIGIR_RESPONSAVEL_ATRIBUIDO: 'true' });
  assert.equal(ok(m('financeiro'), ativo, etapa, tr, rigido), false);
  assert.equal(ok({ ...m('financeiro'), id: 'm-outro' }, ativo, etapa, tr, rigido), true);
  assert.equal(ok(m('financeiro', { cargo: 'diretor' }), ativo, etapa, tr, rigido), true);

  // globais
  assert.equal(ok(m('comercial'), ativo, etapa, g('pausar'), cfg), true);
  assert.equal(ok(m('projetos'), ativo, etapa, g('pausar'), cfg), false);
  assert.equal(ok(m('financeiro'), ativo, etapa, g('retomar'), cfg), false, 'retomar exige pausado');
  assert.equal(ok(m('financeiro'), pausado, etapa, g('retomar'), cfg), true);
  assert.equal(ok(m('projetos'), pausado, etapa, g('comentar'), cfg), true);
  assert.equal(ok(m('projetos'), concluido, etapa, g('comentar'), cfg), false);
  assert.equal(ok(m('projetos'), ativo, etapa, g('reatribuir'), cfg), false);
  assert.equal(ok(m('financeiro'), ativo, etapa, g('reatribuir'), cfg), true);

  // reverter: autor dentro da janela, ou admin
  const agora = new Date('2026-11-13T12:00:00Z');
  const alvo = (h, membro_id = 'm-financeiro') => ({ membro_id, nome_responsavel: 'X', criado_em: new Date(agora - h * 3600000).toISOString() });
  assert.equal(ok(m('financeiro'), ativo, etapa, g('reverter'), cfg, { alvoReversao: alvo(1), agora }), true);
  assert.equal(ok(m('financeiro'), ativo, etapa, g('reverter'), cfg, { alvoReversao: alvo(49), agora }), false);
  assert.equal(ok(m('financeiro'), ativo, etapa, g('reverter'), cfg, { alvoReversao: alvo(1, 'outro'), agora }), false);
  assert.equal(ok(m('presidencia'), ativo, etapa, g('reverter'), cfg, { alvoReversao: alvo(999, 'outro'), agora }), true);
  assert.equal(ok(m('financeiro'), concluido, { ...etapa, terminal: true }, g('reverter'), cfg, { alvoReversao: alvo(1), agora }), false);
  assert.equal(ok(m('presidencia'), ativo, etapa, g('reverter'), lerConfig({ FEATURE_REVERSAO: 'false' }), { alvoReversao: alvo(1), agora }), false);
});

test('validação: conversão de números, dinheiro, datas e enum', () => {
  assert.equal(parseNumeroBr('1.234,56'), 1234.56);
  assert.equal(parseNumeroBr('R$ 1.200'), 1200);
  assert.equal(parseNumeroBr('12.5'), 12.5);
  assert.equal(parseNumeroBr('3200'), 3200);
  assert.ok(Number.isNaN(parseNumeroBr('quarenta')));
  assert.ok(Number.isNaN(parseNumeroBr('1.2.3')));
  assert.equal(parseData('25/12/2026'), '2026-12-25');
  assert.equal(parseData('2026-02-28'), '2026-02-28');
  assert.equal(parseData('31/02/2026'), null);
  assert.deepEqual(converterValor({ nome: 'v', tipo: 'money' }, '10,999'), { ok: true, valor: 11 });
  assert.deepEqual(converterValor({ nome: 'm', tipo: 'enum', opcoes: ['PLA', 'PETG'] }, ' petg '), { ok: true, valor: 'PETG' });
  assert.equal(converterValor({ nome: 'm', tipo: 'enum', opcoes: ['PLA'] }, 'abs').ok, false);
  assert.equal(converterValor({ nome: 'h', tipo: 'number', min: 1 }, '0').ok, false);

  const defs = [
    { nome: 'escopo', tipo: 'text', obrigatorio: true },
    { nome: 'horas', tipo: 'number', obrigatorio: true },
    { nome: 'doc', tipo: 'arquivo', obrigatorio: true },
    { nome: 'extra', tipo: 'text', obrigatorio: false },
  ];
  let v = validarCampos(defs, { escopo: 'x' }, [], cfg);
  assert.deepEqual(v.faltantes.map((f) => f.nome), ['horas', 'doc']);
  v = validarCampos(defs, { escopo: 'x', horas: '8' }, [{ campo: 'doc', nome: 'a.exe', tamanho: 10 }], cfg);
  assert.match(v.erros[0].mensagem, /não permitido/);
  v = validarCampos(defs, { escopo: 'x', horas: '8' }, [{ campo: 'doc', nome: 'a.PDF', tamanho: 99 * 1024 * 1024 }], cfg);
  assert.match(v.erros[0].mensagem, /maior que/);
  v = validarCampos(defs, { escopo: 'x', horas: '8' }, [{ campo: 'doc', nome: 'a.pdf', tamanho: 10 }], cfg);
  assert.equal(v.ok, true);
  assert.deepEqual(v.normalizados, { escopo: 'x', horas: 8 });
});

test('comandos: com e sem barra, aspas, acentos e código no meio do texto', () => {
  assert.equal(extrairCodigoProjeto('sobre o p-2026-0042 hoje'), 'P-2026-0042');
  assert.deepEqual(parseCampos(`a=1 b="x y" c='z w' d=3,5`), { a: '1', b: 'x y', c: 'z w', d: '3,5' });
  let p = parseComando('/acao P-2026-0042 enviar_escopo estimativa_horas=40 escopo="5 páginas" obs=urgente');
  assert.equal(p.comando, 'acao'); assert.equal(p.comBarra, true);
  assert.deepEqual(p.args.projeto_codigo, 'P-2026-0042');
  assert.equal(p.args.tipo_acao, 'enviar_escopo');
  assert.deepEqual(p.args.campos, { estimativa_horas: '40', escopo: '5 páginas', observacoes: 'urgente' });
  p = parseComando('Ação p-2026-0001 Quitar');
  assert.equal(p.comando, 'acao'); assert.equal(p.comBarra, false); assert.equal(p.args.tipo_acao, 'quitar');
  p = parseComando('/pausar P-2026-0001 cliente viajou até março');
  assert.equal(p.comando, 'acao'); assert.equal(p.args.tipo_acao, 'pausar');
  assert.equal(p.args.campos.motivo, 'cliente viajou até março');
  p = parseComando('/comentar P-2026-0001 liguei, sem resposta');
  assert.equal(p.args.campos.comentario, 'liguei, sem resposta');
  assert.equal(parseComando('/meus@TherionBot').comando, 'meus');
  assert.equal(parseComando('/start').comando, 'ajuda');
  assert.equal(parseComando('Histórico P-2026-0001').comando, 'historico');
  assert.equal(parseComando('/vincular Ana@EJ.com').args.resto, 'Ana@EJ.com');
  assert.equal(parseComando('bom dia, tudo bem?').comando, null);
  assert.equal(parseComando('').comando, null);
});

test('normalizador do Telegram: texto, documento, foto, botão e o que é ignorado', () => {
  const de = { id: 42, is_bot: false, first_name: 'Ana', last_name: 'Souza' };
  const chat = { id: 42, type: 'private' };
  let c = normalizarTelegram({ update_id: 7, message: { message_id: 1, from: de, chat, date: 1794000000, text: ' /meus ' } });
  assert.equal(c.idempotency_key, 'telegram:update:7');
  assert.equal(c.canal, 'telegram'); assert.equal(c.id_externo_remetente, '42'); assert.equal(c.chat_id, '42');
  assert.equal(c.texto, '/meus'); assert.equal(c.nome_remetente, 'Ana Souza'); assert.equal(c.callback, null);
  c = normalizarTelegram({ update_id: 8, message: { message_id: 2, from: de, chat, date: 1, caption: '/acao P-2026-0001 x', document: { file_id: 'F1', file_name: 'c.pdf', mime_type: 'application/pdf', file_size: 9 } } });
  assert.deepEqual(c.arquivos, [{ origem: 'telegram', file_id: 'F1', nome: 'c.pdf', mime: 'application/pdf', tamanho: 9 }]);
  assert.equal(c.texto, '/acao P-2026-0001 x');
  c = normalizarTelegram({ update_id: 9, message: { message_id: 3, from: de, chat, date: 1, photo: [{ file_id: 'p', file_size: 1 }, { file_id: 'G', file_size: 5 }] } });
  assert.equal(c.arquivos[0].file_id, 'G'); assert.equal(c.arquivos[0].nome, 'foto_3.jpg');
  c = normalizarTelegram({ update_id: 10, callback_query: { id: 'cb', from: de, data: 'proj:P-2026-0001', message: { message_id: 4, chat } } });
  assert.deepEqual(c.callback, { id: 'cb', dados: 'proj:P-2026-0001' }); assert.equal(c.texto, '');
  // ignorados: grupo, bot, edição, lixo
  assert.equal(normalizarTelegram({ update_id: 11, message: { message_id: 5, from: de, chat: { id: -100, type: 'group' }, text: '/meus' } }), null);
  assert.equal(normalizarTelegram({ update_id: 12, message: { message_id: 6, from: { id: 1, is_bot: true }, chat, text: 'x' } }), null);
  assert.equal(normalizarTelegram({ update_id: 13, edited_message: { message_id: 7, from: de, chat, text: 'x' } }), null);
  assert.equal(normalizarTelegram(null), null);
  assert.equal(normalizarTelegram({}), null);
});

test('guardas: soma/conta/projeto, sem eval', () => {
  const acoes = [
    { tipo_acao: 'registrar_parcela', dados: { valor_pago: 1000.1 } },
    { tipo_acao: 'registrar_parcela', dados: { valor_pago: 999.9 } },
    { tipo_acao: 'registrar_parcela', dados: { valor_pago: 5000 }, revertida_por_id: 'x' },
  ];
  const g = 'soma(registrar_parcela.valor_pago) >= projeto.valor_contratado';
  assert.equal(avaliarGuarda(g, { acoes, projeto: { valor_contratado: 2000 } }).ok, true);
  assert.equal(avaliarGuarda(g, { acoes, projeto: { valor_contratado: 2000.01 } }).ok, false);
  assert.equal(avaliarGuarda(g, { acoes, projeto: { valor_contratado: null } }).ok, false);
  assert.equal(avaliarGuarda('conta(registrar_parcela) == 2', { acoes, projeto: {} }).ok, true);
  assert.throws(() => parseGuarda('projeto.constructor.constructor("x")() > 1'), /inválid/);
  assert.throws(() => parseGuarda('1 + 1'), /inválid/);
});

test('rodízio: ordem alfabética sem acento, circular, pulando indisponíveis', () => {
  const ms = [
    { id: 'c', nome: 'Paulo' }, { id: 'a', nome: 'Bruno' }, { id: 'b', nome: 'Érica' },
    { id: 'd', nome: 'Zeca', disponivel: false }, { id: 'e', nome: 'Alan', ativo: false },
  ];
  assert.equal(chaveOrdenacao('  Érica  ALVES '), 'erica alves');
  assert.equal(escolherResponsavel(ms, null).nome, 'Bruno');
  assert.equal(escolherResponsavel(ms, 'a').nome, 'Érica');
  assert.equal(escolherResponsavel(ms, 'b').nome, 'Paulo');
  assert.equal(escolherResponsavel(ms, 'c').nome, 'Bruno', 'volta ao início (Zeca indisponível)');
  assert.equal(escolherResponsavel(ms, 'e').nome, 'Bruno', 'último era inativo: segue pela ordem do nome');
  assert.equal(escolherResponsavel(ms.map((m) => ({ ...m, disponivel: false })), 'a'), null);
  assert.equal(escolherResponsavel([{ id: 'x', nome: 'Só' }], 'x').nome, 'Só');
});

test('projeção: avançar 3, reverter 2', () => {
  const acoes = [
    { seq: 1, tipo_acao: 'criar_projeto', status_novo: 'ativo', etapa_destino_chave: 'registro_lead', dados: {} },
    { seq: 2, tipo_acao: 'enviar_para_escopo', status_novo: 'ativo', etapa_destino_chave: 'definicao_escopo', dados: {} },
    { seq: 3, tipo_acao: 'enviar_escopo', status_novo: 'ativo', etapa_destino_chave: 'elaboracao_orcamento', dados: { estimativa_horas: 40 }, revertida_por_id: 'r6' },
    { seq: 4, tipo_acao: 'orcamento_rascunho_pronto', status_novo: 'ativo', etapa_destino_chave: 'validacao_orcamento', dados: {}, revertida_por_id: 'r5' },
    { seq: 5, tipo_acao: 'reverter', status_novo: 'ativo', etapa_destino_chave: 'elaboracao_orcamento', dados: {} },
    { seq: 6, tipo_acao: 'reverter', status_novo: 'ativo', etapa_destino_chave: 'definicao_escopo', dados: {} },
  ];
  const e = projetarEstado(acoes);
  assert.equal(e.etapa_chave, 'definicao_escopo');
  assert.equal(e.estimativa_horas, null);
  assert.equal(e.status, 'ativo');
  assert.equal(projetarEstado(acoes.slice(0, 4).map((a) => ({ ...a, revertida_por_id: null }))).estimativa_horas, 40);
});

test('render e canais: limites do Telegram e escolha do canal', () => {
  const longo = Array.from({ length: 300 }, (_, i) => `linha ${i} ${'x'.repeat(30)}`).join('\n');
  const partes = dividirTexto(longo);
  assert.ok(partes.length > 1 && partes.every((p) => p.length <= 4096));
  assert.equal(partes.join('\n'), longo);
  const envios = montarEnvios([
    { canal: 'telegram', destino: '42', texto: longo, botoes: [{ rotulo: 'Ver', dados: 'proj:P-2026-0001' }] },
    { canal: 'email', destino: 'a@b.c', assunto: 'S', texto: 'oi' },
    { canal: 'telegram', destino: '', texto: 'sem destino' },
  ], { id: 'cb1' });
  assert.equal(envios[0].telegram.metodo, 'answerCallbackQuery');
  const tg = envios.filter((e) => e.telegram && e.telegram.metodo === 'sendMessage');
  assert.equal(tg.length, partes.length);
  assert.equal(tg[0].telegram.corpo.reply_markup, undefined);
  assert.equal(tg.at(-1).telegram.corpo.reply_markup.inline_keyboard[0][0].callback_data, 'proj:P-2026-0001');
  assert.deepEqual(envios.at(-1).email, { para: 'a@b.c', assunto: 'S', texto: 'oi' });

  const d = { email: 'a@b.c', telegram_user_id: 9, canal_preferido: 'telegram', canais_habilitados: ['email', 'telegram'] };
  assert.equal(resolverCanal(d, cfg), 'telegram');
  assert.equal(resolverCanal({ ...d, telegram_user_id: null }, cfg), 'email');
  assert.equal(resolverCanal({ ...d, canal_preferido: 'email' }, cfg), 'email');
  assert.equal(resolverCanal(d, lerConfig({ NOTIFICACAO_TELEGRAM_ATIVA: 'false' })), 'email');
  assert.equal(resolverCanal({ ...d, telegram_user_id: null }, lerConfig({ NOTIFICACAO_EMAIL_ATIVA: 'false' })), null);
  assert.equal(fmtMoeda(1234567.5), 'R$ 1.234.567,50');
});

test('planilha de membros: normaliza cabeçalhos e rejeita linhas ruins', () => {
  assert.equal(telefoneE164('(11) 98888-7777'), '+5511988887777');
  assert.equal(telefoneE164('+351 912 345 678'), '+351912345678');
  assert.equal(telefoneE164('123'), undefined);
  const { validas, erros } = validarLinhas([
    { Nome: ' Érica Alves ', 'E-mail': 'Erica@EJ.com', Diretoria: 'Projetos', Cargo: 'Diretor', 'Is Admin': 'SIM', Telefone: '11 98888-7777', 'Canal preferido': 'Telegram' },
    { nome: 'Sem Diretoria', email: 'x@ej.com', diretoria: 'marketing' },
    { nome: 'Duplicada', email: 'erica@ej.com', diretoria: 'projetos' },
    { nome: '', email: '' },
    { nome: 'Fora', email: 'fora@ej.com', diretoria: 'comercial', ativo: 'não', telefone: '999' },
  ]);
  assert.equal(validas.length, 2);
  assert.deepEqual(validas[0], {
    nome: 'Érica Alves', nome_ordenacao: 'erica alves', email: 'erica@ej.com', telefone_e164: '+5511988887777',
    diretoria: 'projetos', cargo: 'diretor', is_admin: true, ativo: true, disponivel: true,
    canal_preferido: 'telegram', canais_habilitados: ['email', 'telegram'],
  });
  assert.equal(validas[1].ativo, false); assert.equal(validas[1].telefone_e164, null);
  assert.deepEqual(erros.map((e) => e.linha), [3, 4, 6]);
});

test('ações globais têm os campos esperados', () => {
  assert.deepEqual(Object.keys(ACOES_GLOBAIS).sort(), ['abandonar', 'comentar', 'pausar', 'reatribuir', 'retomar', 'reverter']);
  assert.equal(ACOES_GLOBAIS.pausar.campos[0].obrigatorio, true);
});

test('reatribuir: admin designa responsável de outra diretoria, que passa a poder agir na etapa', () => {
  const { candidatosMembro } = require('../../lib/motor');
  const dir = [{ id: 'f1', nome: 'Fin 1' }];
  const todos = [...dir, { id: 'p1', nome: 'Proj 1' }];
  const admin = { id: 'a1', ativo: true, diretoria: 'comercial', is_admin: true };
  const comum = { id: 'f2', ativo: true, diretoria: 'financeiro', is_admin: false };
  assert.deepEqual(candidatosMembro(admin, 'reatribuir', dir, todos), todos);
  assert.deepEqual(candidatosMembro(comum, 'reatribuir', dir, todos), dir);
  assert.deepEqual(candidatosMembro(admin, 'outra_acao', dir, todos), dir);

  const etapa = { diretoria_responsavel: 'financeiro', responsavel_atribuido_id: 'p1', responsavel_nome: 'Proj 1', terminal: false };
  const tr = { tipo: 'qualquer_transicao', classe: 'transicao' };
  const p1 = { id: 'p1', ativo: true, diretoria: 'projetos' };
  assert.equal(podeExecutar(p1, { status: 'ativo' }, etapa, tr, cfg).ok, true);
  assert.equal(podeExecutar({ ...p1, id: 'p2' }, { status: 'ativo' }, etapa, tr, cfg).ok, false);
  assert.equal(podeExecutar(p1, { status: 'pausado' }, etapa, tr, cfg).ok, false, 'pré-condição de status vale');
});
