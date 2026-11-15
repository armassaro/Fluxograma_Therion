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

test('planilha de membros (aba do ano): só colunas permitidas, egressos, admins e linhas ruins', () => {
  const { montarLinhas, mapearDiretoria, abaMembros, faixasBatchGet, relatorioSync } = require('../../lib/membros');
  assert.equal(telefoneE164('(11) 98888-7777'), '+5511988887777');
  assert.equal(telefoneE164('+351 912 345 678'), '+351912345678');
  assert.equal(telefoneE164('123'), undefined);
  assert.deepEqual(faixasBatchGet('2026'), ["'2026'!A2:C", "'2026'!F2:F", "'2026'!K2:K", "'2026'!M2:N"], 'nunca lê D, E, G, H, I, J, L');
  assert.equal(abaMembros({}, new Date('2026-06-01T12:00:00Z')), '2026');
  assert.equal(abaMembros({ SHEETS_MEMBROS_ABA: 'Membros' }), 'Membros');
  assert.equal(mapearDiretoria('Diretoria de Projetos'), 'projetos');
  assert.equal(mapearDiretoria('Gestão de Pessoas'), null);
  assert.equal(mapearDiretoria('Gestão de Pessoas', [['gestao de pessoas', 'administrativo']]), 'administrativo');

  // Faixas como o batchGet devolve (células vazias no fim são omitidas).
  const faixas = [
    [['Érica Alves', 'erica@utfpr.edu.br', 'Erica@Therion.com'], ['Bia Lima', 'bia@utfpr.edu.br'], ['Caio Egresso', '', 'caio@therion.com'],
     ['Duda', '', 'duda@therion.com'], ['Edu', '', 'edu@therion.com'], [''], ['Fabi', '', 'fabi@therion.com'], ['Gui', '', 'gui@therion.com']],
    [['(11) 98888-7777'], ['999'], [], [], [], [], [], []],
    [[], [], [], [], ['10/01/2020'], [], ['31/02/2026'], []],
    [['Diretora de Projetos', 'Projetos'], ['Assessora', 'Comercial'], ['Egresso', 'Projetos'], ['Assessor', 'Marketing Digital'],
     ['Assessor', 'Financeiro'], [], ['Assessor', 'Financeiro'], ['Presidente']],
  ];
  const linhas = montarLinhas(faixas);
  assert.equal(linhas.length, 8);
  assert.equal(linhas[0].linha, 2);
  for (const l of linhas) assert.deepEqual(Object.keys(l).sort(), ['cargo', 'data_saida', 'diretoria', 'email_therion', 'email_utfpr', 'linha', 'nome', 'telefone']);

  const { validas, erros, preservar } = validarLinhas(linhas, { mapaDiretorias: 'marketing digital=comercial', hoje: new Date('2026-11-14') });
  const por = Object.fromEntries(validas.map((v) => [v.email, v]));
  assert.deepEqual(por['erica@therion.com'], { nome: 'Érica Alves', nome_ordenacao: 'erica alves', email: 'erica@therion.com',
    telefone_e164: '+5511988887777', diretoria: 'projetos', cargo: 'diretor', is_admin: true, ativo: true });
  assert.equal(por['bia@utfpr.edu.br'].ativo, true, 'sem e-mail Therion usa o da UTFPR');
  assert.equal(por['bia@utfpr.edu.br'].is_admin, false);
  assert.equal(por['bia@utfpr.edu.br'].telefone_e164, null);
  assert.equal(por['caio@therion.com'].ativo, false, 'egresso não é usuário válido');
  assert.equal(por['caio@therion.com'].is_admin, false);
  assert.equal(por['duda@therion.com'].diretoria, 'comercial', 'mapa do .env');
  assert.equal(por['edu@therion.com'].ativo, false, 'data de saída passada');
  assert.equal(por['gui@therion.com'].diretoria, 'presidencia');
  assert.equal(por['gui@therion.com'].is_admin, true);
  assert.ok(!por['fabi@therion.com']);
  assert.deepEqual(preservar, ['fabi@therion.com'], 'linha com erro não desativa a pessoa');
  assert.ok(erros.some((e) => e.linha === 8 && /data de saída/.test(e.erro)));
  for (const v of validas) assert.ok(!('disponivel' in v) && !('canal_preferido' in v), 'campos do app não vêm da planilha');

  const rel = relatorioSync({ ok: true, simulado: true, novos: [{ nome: 'A', email: 'a@x.com' }], desativados: [], admins_alterados: [], erros: [] }, erros);
  assert.match(rel.texto, /Prévia/);
  assert.deepEqual(rel.botoes.map((b) => b.dados), ['sync:aplicar', 'cancelar']);
  assert.match(relatorioSync({ ok: false, codigo: 'DESATIVACAO_EM_MASSA', qtd_desativacoes: 9, ativos: 10, desativados: [] }).texto, /sync forcar/);
  assert.equal(parseComando('/sync forcar').comando, 'sync');
});

test('ações globais têm os campos esperados', () => {
  assert.deepEqual(Object.keys(ACOES_GLOBAIS).sort(), ['abandonar', 'comentar', 'pausar', 'reatribuir', 'retomar', 'reverter']);
  assert.equal(ACOES_GLOBAIS.pausar.campos[0].obrigatorio, true);
});

test('reatribuir: opções restritas à diretoria da etapa; designado pode agir na etapa', () => {
  const { candidatosMembro } = require('../../lib/motor');
  const dir = [{ id: 'f1', nome: 'Fin 1' }];
  assert.deepEqual(candidatosMembro(dir), dir);
  assert.deepEqual(candidatosMembro(undefined), []);

  const etapa = { diretoria_responsavel: 'financeiro', responsavel_atribuido_id: 'p1', responsavel_nome: 'Proj 1', terminal: false };
  const tr = { tipo: 'qualquer_transicao', classe: 'transicao' };
  const p1 = { id: 'p1', ativo: true, diretoria: 'projetos' };
  assert.equal(podeExecutar(p1, { status: 'ativo' }, etapa, tr, cfg).ok, true);
  assert.equal(podeExecutar({ ...p1, id: 'p2' }, { status: 'ativo' }, etapa, tr, cfg).ok, false);
  assert.equal(podeExecutar(p1, { status: 'pausado' }, etapa, tr, cfg).ok, false, 'pré-condição de status vale');
});

test('/me: comando e perfil do membro', () => {
  const { perfilMembro } = require('../../lib/mensagens');
  assert.equal(parseComando('/me').comando, 'me');
  assert.equal(parseComando('perfil').comando, 'me');
  assert.equal(parseComando('/meus').comando, 'meus');
  const t = perfilMembro({ nome: 'Ana Souza', diretoria: 'financeiro', cargo: 'diretor', is_admin: true,
    email: 'ana@ej.test', telefone_e164: '+5543999990000', canal_preferido: 'telegram', canais_habilitados: ['telegram'], disponivel: true });
  for (const s of ['Ana Souza', 'Financeiro', 'Administrador: sim', 'ana@ej.test', '+5543999990000']) assert.ok(t.includes(s), s);
  assert.match(perfilMembro({ nome: 'X', diretoria: 'projetos' }), /Telefone: —/);
});

test('fluxograma: DOT com etapa atual, responsável, caminho, revertidas e envio como foto', () => {
  const { gerarDot, pedidoImagem } = require('../../lib/fluxograma');
  const { renderTelegram } = require('../../lib/render');
  const projeto = { id: 'p', codigo: 'P-2026-0001', nome: 'Site <A&B>', tipo: 'website', status: 'ativo',
    data_inicio: '2026-11-01T12:00:00Z', cliente: { nome: 'Cli' },
    etapa: { chave: 'elaboracao_orcamento', responsavel_nome: 'Eva Financeiro' } };
  const etapas = [
    { chave: 'registro_lead', responsavel_nome: null, data_entrada: '2026-11-01T12:00:00Z', data_saida: '2026-11-01T12:00:01Z' },
    { chave: 'definicao_escopo', responsavel_nome: 'Carla Projetos', data_entrada: '2026-11-01T12:00:01Z', data_saida: '2026-11-02T12:00:00Z' },
    { chave: 'elaboracao_orcamento', responsavel_nome: 'Eva Financeiro', data_entrada: '2026-11-02T12:00:00Z', prazo_sla: '2026-11-03T12:00:00Z' },
  ];
  const acoes = [
    { seq: 1, tipo_acao: 'criar_projeto', nome_responsavel: 'Ana', criado_em: '2026-11-01T12:00:00Z', etapa_destino_chave: 'registro_lead' },
    { seq: 2, tipo_acao: 'enviar_para_escopo', nome_responsavel: 'Ana', criado_em: '2026-11-01T12:00:01Z', etapa_origem_chave: 'registro_lead', etapa_destino_chave: 'definicao_escopo' },
    { seq: 3, tipo_acao: 'comentar', nome_responsavel: 'Carla', criado_em: '2026-11-01T13:00:00Z', etapa_origem_chave: 'definicao_escopo' },
    { seq: 4, tipo_acao: 'enviar_escopo', nome_responsavel: 'Carla', criado_em: '2026-11-02T12:00:00Z', etapa_origem_chave: 'definicao_escopo', etapa_destino_chave: 'elaboracao_orcamento', revertida_por_id: 'x' },
  ];
  const dot = gerarDot({ projeto, template: website, acoes, etapas }, { agora: new Date('2026-11-04T12:00:00Z') });
  assert.match(dot, /^digraph fluxo \{/);
  assert.ok(dot.includes('ETAPA ATUAL · Elaboração do orçamento'));
  assert.ok(dot.includes('Responsável: Eva Financeiro'));
  assert.ok(dot.includes('Responsável: Carla Projetos'));
  assert.ok(dot.includes('(vencido)'));
  assert.ok(dot.includes('Site &lt;A&amp;B&gt;'), 'escapa HTML');
  assert.ok(dot.includes('(revertida)'));
  assert.ok(dot.includes('Comentar') || dot.includes('Comentário'), 'tabela lista ações sem troca de etapa');
  assert.ok(!dot.includes('"abandonado"'), 'abandonado só aparece se aconteceu');

  const cfgOn = lerConfig({});
  assert.equal(cfgOn.features.fluxograma, true, 'ativado por padrão');
  const im = pedidoImagem({ projeto, template: website, acoes, etapas }, cfgOn);
  assert.equal(im.tipo, 'graphviz');
  assert.equal(pedidoImagem({ projeto, template: website }, lerConfig({ FEATURE_FLUXOGRAMA: 'false' })), null);
  const envios = renderTelegram({ canal: 'telegram', destino: '1', texto: 'oi', botoes: [{ rotulo: 'x', dados: 'y' }], imagem: im });
  assert.equal(envios[0].telegram.metodo, 'sendPhoto');
  assert.equal(envios[1].telegram.metodo, 'sendMessage');
  assert.ok(envios[1].telegram.corpo.reply_markup, 'botões ficam no texto, depois da foto');
  assert.equal(parseComando('/fluxograma P-2026-0001').comando, 'fluxograma');
});
