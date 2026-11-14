'use strict';
/** Testes de lib/seguranca, lib/sla, lib/codigo_projeto, fluxos/schema.json e fixtures reais do Telegram. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const crypto = require('crypto');
const { normalizarTelegram } = require('../../lib/normalizadores');
const { compararSegredo, verificarHmac, verificarMeta, rateLimit } = require('../../lib/seguranca');
const { calcularPrazo, etapasVencidas, dentroHorario } = require('../../lib/sla');
const { gerarCodigo, lerCodigo } = require('../../lib/codigo_projeto');
const { validarSchema } = require('../../lib/jsonschema');
const { prelude } = require('../../scripts/build_workflows');

const FIX = path.join(__dirname, '..', 'fixtures', 'telegram');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));

test('normalizador Telegram com fixtures reais', () => {
  const t = normalizarTelegram(fixture('texto'));
  assert.equal(t.idempotency_key, 'telegram:update:900000001');
  assert.equal(t.id_externo_remetente, '123456789');
  assert.equal(t.nome_remetente, 'Ana Souza');
  assert.equal(t.texto, '/acao P-2026-0001 enviar_para_escopo');
  assert.equal(t.recebido_em, new Date(1763100000 * 1000).toISOString());

  const d = normalizarTelegram(fixture('documento'));
  assert.deepEqual(d.arquivos, [{ origem: 'telegram', file_id: 'BQACAgEAAxkBAAIBZ2abc', nome: 'escopo v2.pdf', mime: 'application/pdf', tamanho: 482113 }]);
  assert.equal(d.texto, 'segue o escopo');

  const f = normalizarTelegram(fixture('foto'));
  assert.equal(f.arquivos[0].file_id, 'AgACgrande');   // maior resolução

  const c = normalizarTelegram(fixture('callback'));
  assert.deepEqual(c.callback, { id: '4382bfdwdsb323b2d9', dados: 'a:P-2026-0001:enviar_escopo' });
  assert.equal(c.id_externo_remetente, '123456789');  // quem clicou, não o bot

  assert.equal(normalizarTelegram(fixture('grupo')), null);
  assert.equal(normalizarTelegram(fixture('editada')), null);
});

test('segurança: segredo em tempo constante, HMAC e assinatura da Meta', () => {
  assert.equal(compararSegredo('abc', 'abc'), true);
  assert.equal(compararSegredo('abc', 'abd'), false);
  assert.equal(compararSegredo('', ''), false);
  assert.equal(compararSegredo(undefined, 'x'), false);

  const corpo = '{"form_id":"1","response_id":"r"}';
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3gr3d0').update(corpo).digest('hex');
  assert.equal(verificarHmac(corpo, sig, 's3gr3d0'), true);
  assert.equal(verificarHmac(corpo + ' ', sig, 's3gr3d0'), false);
  assert.equal(verificarHmac(corpo, sig, 'outro'), false);
  assert.equal(verificarHmac(corpo, 'sha256=zz', 's3gr3d0'), false);
  assert.equal(verificarHmac(corpo, sig, ''), false);
  assert.equal(verificarMeta(Buffer.from(corpo), sig.toUpperCase().replace('SHA256=', 'sha256='), 's3gr3d0'), true);
});

test('rate limit: janela deslizante de 1 minuto', () => {
  const agora = Date.parse('2026-11-14T12:00:00Z');
  const hist = [50, 40, 30, 20, 10].map((s) => agora - s * 1000);
  assert.deepEqual(rateLimit(hist, 6, agora), { ok: true, restantes: 0, tentarEmS: 0 });
  const r = rateLimit(hist, 5, agora);
  assert.equal(r.ok, false);
  assert.equal(r.tentarEmS, 10);                         // a mais antiga (50 s atrás) sai em 10 s
  assert.equal(rateLimit([agora - 61000], 1, agora).ok, true);
});

test('SLA: prazo soma pausas, vencidas respeitam intervalo e escalonamento', () => {
  const e = '2026-11-02T12:00:00Z';
  assert.equal(calcularPrazo(e, 48), '2026-11-04T12:00:00.000Z');
  assert.equal(calcularPrazo(e, 48, [{ inicio: '2026-11-03T00:00:00Z', fim: '2026-11-03T10:00:00Z' }]), '2026-11-04T22:00:00.000Z');
  assert.equal(calcularPrazo(e, 48, [{ inicio: '2026-11-03T00:00:00Z' }]), null);   // ainda pausado
  assert.equal(calcularPrazo(e, null), null);

  const agora = '2026-11-10T12:00:00Z';
  const etapas = [
    { id: 1, prazo_sla: '2026-11-09T12:00:00Z' },
    { id: 2, prazo_sla: '2026-11-11T12:00:00Z' },                                 // não venceu
    { id: 3, prazo_sla: '2026-11-01T12:00:00Z', status_projeto: 'pausado' },      // pausado: congela
    { id: 4, prazo_sla: '2026-11-01T12:00:00Z', ultimo_lembrete: '2026-11-10T06:00:00Z', lembretes: 1 },  // lembrou há 6 h
    { id: 5, prazo_sla: '2026-11-01T12:00:00Z', ultimo_lembrete: '2026-11-09T06:00:00Z', lembretes: 2 },
  ];
  const v = etapasVencidas(etapas, agora, { lembreteIntervaloHoras: 24, escalonarAposLembretes: 2 });
  assert.deepEqual(v.map((x) => [x.id, x.atraso_horas, x.escalonar]), [[1, 24, false], [5, 216, true]]);
});

test('SLA: janela de notificação no fuso de São Paulo', () => {
  const cfg = { tz: 'America/Sao_Paulo', horarioInicio: '08:00', horarioFim: '21:00', notificarFimDeSemana: false };
  assert.equal(dentroHorario('2026-11-13T13:00:00Z', cfg), true);    // sex 10:00 BRT
  assert.equal(dentroHorario('2026-11-13T10:30:00Z', cfg), false);   // sex 07:30 BRT
  assert.equal(dentroHorario('2026-11-14T00:30:00Z', cfg), false);   // sex 21:30 BRT
  assert.equal(dentroHorario('2026-11-14T13:00:00Z', cfg), false);   // sábado
  assert.equal(dentroHorario('2026-11-14T13:00:00Z', { ...cfg, notificarFimDeSemana: true }), true);
});

test('código de projeto', () => {
  assert.equal(gerarCodigo(2026, 42), 'P-2026-0042');
  assert.equal(gerarCodigo(2026, 12345), 'P-2026-12345');
  assert.deepEqual(lerCodigo(' p-2026-0042 '), { ano: 2026, seq: 42 });
  assert.equal(lerCodigo('P-26-1'), null);
  assert.throws(() => gerarCodigo(2026, 0));
});

test('fluxos/schema.json: aceita os templates e barra erros de estrutura', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fluxos', 'schema.json'), 'utf8'));
  const web = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fluxos', 'website.yaml'), 'utf8'));
  assert.deepEqual(validarSchema(schema, web), []);
  const ruim = JSON.parse(JSON.stringify(web));
  ruim.etapas.registro_lead.diretoria = 'marketing';
  ruim.transicoes[0].campos[0].tipo = 'textão';
  ruim.transicoes[1].cor = 'azul';
  delete ruim.versao;
  const erros = validarSchema(schema, ruim).join('\n');
  assert.match(erros, /falta "versao"/);
  assert.match(erros, /marketing/);
  assert.match(erros, /textão/);
  assert.match(erros, /propriedade desconhecida "cor"/);
});

test('build: módulos embutidos resolvem built-ins do Node (crypto)', async () => {
  const js = `${prelude(['seguranca'])}return __req('./seguranca').compararSegredo('a', 'a');`;
  const fn = new Function('require', js);
  assert.equal(fn(require), true);
});

test('acao_na_criacao: precisa ser transição a partir da etapa inicial', () => {
  const { validarTemplate, normalizarTemplate } = require('../../lib/templates');
  const web = normalizarTemplate(YAML.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fluxos', 'website.yaml'), 'utf8')));
  assert.equal(web.acao_na_criacao, 'enviar_para_escopo');
  assert.deepEqual(validarTemplate(web), []);
  assert.match(validarTemplate({ ...web, acao_na_criacao: 'enviar_escopo' }).join(), /etapa inicial/);
  const sem = { ...web }; delete sem.acao_na_criacao;
  assert.deepEqual(validarTemplate(sem), []);                 // opcional
});
