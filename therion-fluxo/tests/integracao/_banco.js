'use strict';
/**
 * Apoio dos testes de integração: cria um banco descartável por arquivo de teste num Postgres
 * real (as funções PL/pgSQL não rodam em bancos simulados).
 *
 *   docker run -d --name therion-test-pg -e POSTGRES_PASSWORD=teste -e POSTGRES_USER=ej \
 *     -e POSTGRES_DB=ej_fluxo -p 127.0.0.1:55432:5432 postgres:16-alpine
 *
 * Outro servidor: TEST_DATABASE_URL=postgres://usuario:senha@host:porta/banco
 */
const { Client } = require('pg');
const { migrar } = require('../../scripts/migrar');
const { carregarFluxos } = require('../../scripts/carregar_fluxos');
const { executar } = require('../../scripts/pipeline');
const { normalizarTelegram } = require('../../lib/normalizadores');
const { lerConfig } = require('../../lib/config');
const { chaveOrdenacao } = require('../../lib/texto');

const URL_BASE = process.env.TEST_DATABASE_URL || 'postgres://ej:teste@127.0.0.1:55432/ej_fluxo';

async function criarBanco() {
  const admin = new Client({ connectionString: URL_BASE });
  try { await admin.connect(); } catch (e) {
    throw new Error(`Sem Postgres de teste em ${URL_BASE.replace(/:[^:@/]+@/, ':***@')} (${e.message}). Veja tests/integracao/_banco.js.`);
  }
  const nome = `teste_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`CREATE DATABASE ${nome}`);
  const url = new URL(URL_BASE); url.pathname = `/${nome}`;
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  await migrar(db);
  await carregarFluxos(db);
  return {
    db, url: url.toString(),
    async fechar() {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Membros de teste. `tg` = id do Telegram já vinculado. */
const MEMBROS = [
  { nome: 'Carla Souza', email: 'carla@ej.test', diretoria: 'comercial', tg: 101 },
  { nome: 'Caio Braga', email: 'caio@ej.test', diretoria: 'comercial', tg: 102 },
  { nome: 'Bruno Lima', email: 'bruno@ej.test', diretoria: 'projetos', tg: 201 },
  { nome: 'Érica Alves', email: 'erica@ej.test', diretoria: 'projetos', tg: 202 },
  { nome: 'Paulo Reis', email: 'paulo@ej.test', diretoria: 'projetos', tg: 203, cargo: 'diretor' },
  { nome: 'Fábio Nunes', email: 'fabio@ej.test', diretoria: 'financeiro', tg: 301 },
  { nome: 'Helena Dias', email: 'helena@ej.test', diretoria: 'financeiro', tg: 302 },
  { nome: 'Alice Prado', email: 'alice@ej.test', diretoria: 'administrativo', tg: 401 },
  { nome: 'Diego Melo', email: 'diego@ej.test', diretoria: 'administrativo', tg: 402 },
  { nome: 'Pietra Rocha', email: 'pietra@ej.test', diretoria: 'presidencia', tg: 501 },
  { nome: 'Ada Admin', email: 'ada@ej.test', diretoria: 'projetos', tg: 601, is_admin: true, disponivel: false },
];

async function semear(db, membros = MEMBROS) {
  for (const m of membros) {
    await db.query(
      `INSERT INTO membros (nome, nome_ordenacao, email, diretoria, cargo, is_admin, disponivel, telegram_user_id, canal_preferido, canais_habilitados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{email,telegram}')`,
      [m.nome, chaveOrdenacao(m.nome), m.email, m.diretoria, m.cargo || 'membro', !!m.is_admin,
        m.disponivel !== false, m.tg || null, m.tg ? 'telegram' : 'email']);
  }
}

let proximoUpdate = 1000;
/** Monta um Update do Telegram como o que chega no webhook. */
function update(tgId, texto, { arquivo, callback, updateId } = {}) {
  const id = updateId || ++proximoUpdate;
  const de = { id: tgId, is_bot: false, first_name: `U${tgId}` };
  const chat = { id: tgId, type: 'private' };
  if (callback) return { update_id: id, callback_query: { id: `cb${id}`, from: de, data: callback, message: { message_id: 1, chat } } };
  const message = { message_id: id, from: de, chat, date: Math.floor(Date.now() / 1000) };
  if (arquivo) { message.document = { file_id: `file${id}`, file_name: arquivo, mime_type: 'application/pdf', file_size: 1234 }; message.caption = texto; } else message.text = texto;
  return { update_id: id, message };
}

/** Cliente de teste: `await bot.diz(101, '/meus')` devolve o resultado do pipeline. */
function criarBot(db, env = {}) {
  const cfg = lerConfig({ FEATURE_DRIVE: 'false', RATE_LIMIT_POR_MIN: '1000', ...env });
  const enviar = (u) => executar(db, normalizarTelegram(u), cfg);
  return {
    cfg,
    diz: (tg, texto, extra) => enviar(update(tg, texto, extra)),
    clica: (tg, dados) => enviar(update(tg, '', { callback: dados })),
    enviar,
    /** Envia o comando, pula as perguntas opcionais e confirma; devolve o resultado final. */
    async faz(tg, texto, extra) {
      let r = await enviar(update(tg, texto, extra));
      for (let i = 0; i < 10 && r.final.resposta.codigo === 'CAMPOS_FALTANTES' && /opcional/.test(r.final.resposta.mensagem); i++) {
        r = await enviar(update(tg, '', { callback: 'pular' }));
      }
      if (r.final.resposta.codigo !== 'CONFIRMACAO_PENDENTE') return r;
      return enviar(update(tg, 'confirmar'));
    },
  };
}

async function projeto(db, codigo) {
  const r = await db.query('SELECT carregar_dados($1::jsonb) AS r', [JSON.stringify({ membro_id: (await db.query('SELECT id FROM membros WHERE is_sistema')).rows[0].id, projeto_codigo: codigo })]);
  return r.rows[0].r;
}

module.exports = { criarBanco, semear, criarBot, update, projeto, MEMBROS };
