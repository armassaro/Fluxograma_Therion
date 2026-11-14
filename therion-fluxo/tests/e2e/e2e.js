#!/usr/bin/env node
'use strict';
/**
 * Teste ponta a ponta dos workflows no n8n de verdade (chamado por tests/e2e/rodar.sh).
 * Entra pelo webhook do Telegram e confere o que o n8n mandou para o Telegram/SMTP falsos e
 * o que ficou gravado no Postgres. O Drive fica desligado (FEATURE_DRIVE=false): WF-06 e a
 * leitura da planilha do WF-09 dependem de credenciais reais do Google e NÃO são cobertos aqui.
 */
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { chaveOrdenacao } = require('../../lib/texto');

const N8N = process.env.N8N_URL || 'http://127.0.0.1:5678';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:18081';
const SEGREDO = process.env.TELEGRAM_WEBHOOK_SECRET || 'segredo-e2e';
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

let updateId = Math.floor(Date.now() / 1000);
function update(tg, texto, { callback, arquivo, id } = {}) {
  const uid = id || ++updateId, de = { id: tg, is_bot: false, first_name: `U${tg}` }, chat = { id: tg, type: 'private' };
  if (callback) return { update_id: uid, callback_query: { id: `cb${uid}`, from: de, data: callback, message: { message_id: 1, chat } } };
  const message = { message_id: uid, from: de, chat, date: Math.floor(Date.now() / 1000) };
  if (arquivo) { message.document = { file_id: `f${uid}`, file_name: arquivo, file_size: 100 }; message.caption = texto; } else message.text = texto;
  return { update_id: uid, message };
}
async function webhook(u, segredo = SEGREDO) {
  const r = await fetch(`${N8N}/webhook/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': segredo }, body: JSON.stringify(u) });
  return r.status;
}
let acumulado = [];
/** Espera até aparecer um sendMessage para `chat` cujo texto case com `re`; devolve a chamada. */
async function esperarMensagem(chat, re, ms = 20000) {
  const fim = Date.now() + ms;
  for (;;) {
    acumulado.push(...await (await fetch(`${MOCK}/__chamadas`)).json());
    const i = acumulado.findIndex((c) => c.metodo === 'sendMessage' && String(c.corpo.chat_id) === String(chat) && re.test(c.corpo.text));
    if (i >= 0) return acumulado.splice(i, 1)[0];
    if (Date.now() > fim) throw new Error(`Sem mensagem para ${chat} casando ${re}. Recebidas: ${JSON.stringify(acumulado.map((c) => [c.metodo, c.corpo.chat_id, String(c.corpo.text || '').slice(0, 80)]))}`);
    await pausa(300);
  }
}
/** Envia e espera a resposta ao próprio remetente. */
async function diz(tg, texto, re, extra) { assert.equal(await webhook(update(tg, texto, extra)), 200); return esperarMensagem(tg, re); }
const clica = (tg, dados, re) => diz(tg, '', re, { callback: dados });

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const passos = [];
  const passo = async (nome, f) => { await f(); passos.push(nome); console.log(`  ✔ ${nome}`); };
  try {
    // n8n pronto?
    for (let i = 0; ; i++) { try { if ((await fetch(`${N8N}/healthz`)).ok) break; } catch { /* subindo */ } if (i > 120) throw new Error('n8n não respondeu'); await pausa(1000); }
    // Espera o webhook de produção ser registrado (num n8n recém-criado leva alguns segundos; antes disso dá 404).
    for (let i = 0; ; i++) { if ((await webhook({}, 'errado')) === 200) break; if (i > 90) throw new Error('webhook /webhook/telegram não foi registrado'); await pausa(1000); }

    await db.query('TRUNCATE acoes, etapas, projetos, clientes, sessoes_chat, notificacoes, requisicoes_processadas, vinculos_pendentes, rodizio, sequencias_codigo CASCADE');
    await db.query('DELETE FROM membros WHERE NOT is_sistema');
    for (const [nome, email, dir, tg] of [['Carla Souza', 'carla@ej.test', 'comercial', 101], ['Caio Braga', 'caio@ej.test', 'projetos', 403403],
      ['Bruno Lima', 'bruno@ej.test', 'projetos', 201], ['Nina Novata', 'nina@ej.test', 'projetos', null]]) {
      await db.query(`INSERT INTO membros (nome, nome_ordenacao, email, diretoria, telegram_user_id, canal_preferido) VALUES ($1,$2,$3,$4,$5,$6)`,
        [nome, chaveOrdenacao(nome), email, dir, tg, tg ? 'telegram' : 'email']);
    }
    await fetch(`${MOCK}/__chamadas`); await fetch(`${MOCK}/__emails`);

    await passo('segredo errado no webhook é ignorado (nada é enviado nem gravado)', async () => {
      await webhook(update(101, '/meus'), 'errado');
      await pausa(2500);
      assert.equal((await (await fetch(`${MOCK}/__chamadas`)).json()).length, 0);
      assert.equal((await db.query('SELECT count(*)::int n FROM requisicoes_processadas')).rows[0].n, 0);
    });

    await passo('membro identificado recebe resposta de /meus', async () => {
      await diz(101, '/meus', /Nenhum projeto aguardando a diretoria Comercial/);
    });

    await passo('desconhecido é orientado a vincular; código chega por e-mail; /codigo vincula', async () => {
      await diz(9001, '/meus', /Não reconheci você/);
      await diz(9001, '/vincular nina@ej.test', /Se este e-mail estiver cadastrado/);
      let emails = [];
      for (let i = 0; i < 40 && !emails.length; i++) { await pausa(300); emails = await (await fetch(`${MOCK}/__emails`)).json(); }
      assert.equal(emails.length, 1, 'e-mail com o código não chegou ao SMTP');
      assert.deepEqual(emails[0].para, ['nina@ej.test']);
      const corpo = emails[0].dados.replace(/=\r\n/g, '');
      const codigo = /(\d{6})/.exec(corpo.split(/\r\n\r\n/).slice(1).join('\n'))[1];
      await diz(9001, `/codigo ${codigo}`, /Conta vinculada\. Bem-vindo\(a\), Nina Novata/);
      assert.equal(Number((await db.query("SELECT telegram_user_id t FROM membros WHERE email = 'nina@ej.test'")).rows[0].t), 9001);
      assert.equal((await db.query("SELECT count(*)::int n FROM notificacoes WHERE payload::text LIKE '%' || $1 || '%'", [codigo])).rows[0].n, 0, 'código de vínculo não pode ficar gravado');
    });

    let cod;
    await passo('diálogo /novo cria o projeto já encaminhado a Projetos e notifica o responsável', async () => {
      const r = await diz(101, '/novo', /Tipo de serviço: escolha uma opção/);
      assert.deepEqual(r.corpo.reply_markup.inline_keyboard.map((l) => l[0].callback_data), ['val:impressao_modelagem_3d', 'val:website', 'cancelar']);
      await clica(101, 'val:website', /Nome do projeto/);
      await diz(101, 'Site Padaria Sol', /Nome do cliente/);
      await diz(101, 'Padaria Sol', /Contato do cliente/);
      await diz(101, 'contato@padariasol.test', /Nome do lead/);
      await clica(101, 'pular', /Descrição da demanda/);
      await diz(101, 'Projeto de site institucional', /Prazo desejado/);
      await clica(101, 'pular', /Confirme: Novo projeto/);
      // Confirmação por texto, entregue duas vezes pelo "Telegram": só um projeto/ação.
      const u = update(101, 'confirmar');
      assert.equal(await webhook(u), 200);
      const fim = await esperarMensagem(101, /Projeto P-\d{4}-0001 criado e enviado para Projetos[\s\S]*Definição de escopo \(Projetos\) — responsável: Bruno Lima/);
      cod = /P-\d{4}-0001/.exec(fim.corpo.text)[0];
      const n = await esperarMensagem(201, /Você é o responsável por esta etapa/);
      assert.match(n.corpo.text, new RegExp(`\\[${cod}\\] Site Padaria Sol`));
      assert.equal(n.corpo.reply_markup.inline_keyboard[0][0].callback_data, `proj:${cod}`);
      assert.ok(acumulado.some((c) => c.metodo === 'answerCallbackQuery'));   // cliques respondidos
      assert.equal(await webhook(u), 200);                                     // reentrega
      await pausa(2500);
      acumulado.push(...await (await fetch(`${MOCK}/__chamadas`)).json());
      assert.equal(acumulado.filter((c) => c.metodo === 'sendMessage' && /criado e enviado/.test(c.corpo.text)).length, 0);   // nada novo após a reentrega
      assert.equal((await db.query('SELECT count(*)::int n FROM acoes')).rows[0].n, 2);   // criar + encaminhar
      const env = (await db.query("SELECT count(*)::int n FROM notificacoes WHERE status = 'enviada' AND canal = 'telegram'")).rows[0].n;
      assert.ok(env >= 1);
    });

    await passo('falha de entrega (bot bloqueado) fica registrada em notificacoes', async () => {
      // Caio (Projetos, id 403403) passa a ser o responsável; o Telegram falso responde 403 para ele.
      await diz(201, `/acao ${cod} reatribuir novo_responsavel="Caio Braga"`, /Confirme/);
      await clica(201, 'ok', /responsável agora é Caio Braga/);
      let linha;
      for (let i = 0; i < 40 && !linha; i++) { await pausa(300); linha = (await db.query("SELECT status, erro FROM notificacoes WHERE status = 'falhou'")).rows[0]; }
      assert.ok(linha, 'notificação com falha não foi registrada');
      assert.match(linha.erro, /blocked/);
    });

    await passo('outra diretoria é barrada; ação com arquivo funciona sem Drive', async () => {
      await diz(101, `/acao ${cod} enviar_escopo escopo=x estimativa_horas=10`, /Esta etapa é da diretoria Projetos[\s\S]*Quem pode agir/);
      await diz(201, `/acao ${cod} enviar_escopo escopo="5 páginas" estimativa_horas=40`, /Confirme: Escopo definido/, { arquivo: 'escopo.pdf' });
      await clica(201, 'ok', /seguiu para: Elaboração do orçamento/);
      const a = (await db.query("SELECT arquivos, dados FROM acoes WHERE tipo_acao = 'enviar_escopo'")).rows[0];
      assert.equal(a.arquivos[0].nome, 'escopo.pdf');
      assert.equal(a.dados.estimativa_horas, 40);
      await clica(201, `proj:${cod}`, /Estimativa: 40 h/);
    });

    await passo('texto longo de histórico e /cancelar', async () => {
      await clica(101, `hist:${cod}`, /#4 .*Escopo definido \(Bruno Lima\)/);
      await diz(101, `/pausar ${cod}`, /Motivo da pausa/);
      await diz(101, '/cancelar', /Operação cancelada/);
      assert.equal((await db.query('SELECT count(*)::int n FROM sessoes_chat')).rows[0].n, 0);
    });

    await passo('falha interna: usuário é avisado e os administradores recebem alerta', async () => {
      await db.query('ALTER FUNCTION ctx_entrada(jsonb) RENAME TO ctx_entrada_quebrada');
      try {
        assert.equal(await webhook(update(101, '/meus')), 200);
        await esperarMensagem(101, /erro interno.*\(ref: \d+\)/);
        const alerta = await esperarMensagem(777000, /Falha no roteador/);
        assert.ok(!/carla|Carla/.test(alerta.corpo.text), 'alerta não deve levar dados pessoais');
      } finally { await db.query('ALTER FUNCTION ctx_entrada_quebrada(jsonb) RENAME TO ctx_entrada'); }
      await diz(101, '/meus', /Nenhum projeto aguardando|Projetos aguardando/);
    });

    console.log(`\nE2E OK: ${passos.length} cenários.`);
  } finally { await db.end(); }
})().catch((e) => { console.error(`\nE2E FALHOU: ${e.stack || e.message}`); process.exit(1); });
