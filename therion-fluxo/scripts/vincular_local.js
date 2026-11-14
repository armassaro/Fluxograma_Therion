#!/usr/bin/env node
'use strict';
/**
 * Modo local (sem SMTP/planilha): cadastra um membro e vincula ao Telegram de quem já falou com o bot.
 *
 *   node --env-file=.env scripts/vincular_local.js --listar
 *       mostra quem mandou mensagem ao bot e ainda não está vinculado
 *   node --env-file=.env scripts/vincular_local.js --telegram 123456789 --nome "Fulano" \
 *       --email fulano@ej.com --diretoria comercial [--diretor] [--admin]
 *
 * Diretorias: comercial, projetos, financeiro, administrativo, presidencia.
 * Em produção, use a planilha de membros (WF-09) + /vincular.
 */
const { criarCliente } = require('./db');
const { chaveOrdenacao } = require('../lib/texto');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(`--${n}`);

(async () => {
  const db = criarCliente({ ...process.env, POSTGRES_HOST: process.env.POSTGRES_HOST_LOCAL || 'localhost' });
  await db.connect();
  try {
    if (flag('listar') || !opt('telegram')) {
      const r = await db.query(`
        SELECT r.id_externo, max(r.criado_em) AS ultima, count(*) AS msgs
          FROM requisicoes_processadas r
         WHERE r.canal = 'telegram'
           AND NOT EXISTS (SELECT 1 FROM membros m WHERE m.telegram_user_id::text = r.id_externo)
         GROUP BY r.id_externo ORDER BY ultima DESC`);
      if (!r.rows.length) console.log('Ninguém pendente. Mande qualquer mensagem (ex.: /start) ao bot e rode de novo.');
      for (const l of r.rows) console.log(`telegram ${l.id_externo}  — ${l.msgs} msg(s), última em ${l.ultima.toISOString()}`);
      const m = await db.query("SELECT nome, email, diretoria, telegram_user_id FROM membros WHERE NOT is_sistema ORDER BY nome");
      console.log('\nMembros cadastrados:');
      for (const x of m.rows) console.log(`  ${x.nome} <${x.email}> ${x.diretoria}  telegram=${x.telegram_user_id ?? '—'}`);
      return;
    }
    const tg = opt('telegram'), nome = opt('nome'), email = (opt('email') || '').toLowerCase();
    const diretoria = opt('diretoria') || 'presidencia';
    if (!/^\d+$/.test(tg) || !nome || !email) throw new Error('Informe --telegram <id> --nome "..." --email ... [--diretoria ...]');
    await db.query('UPDATE membros SET telegram_user_id = NULL WHERE telegram_user_id = $1', [tg]);
    await db.query(`
      INSERT INTO membros (nome, nome_ordenacao, email, diretoria, cargo, is_admin, telegram_user_id, canal_preferido)
      VALUES ($1, $2, $3, $4::diretoria_t, $5, $6, $7, 'telegram')
      ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome, nome_ordenacao = EXCLUDED.nome_ordenacao,
        diretoria = EXCLUDED.diretoria, cargo = EXCLUDED.cargo, is_admin = EXCLUDED.is_admin,
        telegram_user_id = EXCLUDED.telegram_user_id, canal_preferido = 'telegram', ativo = true`,
      [nome, chaveOrdenacao(nome), email, diretoria, flag('diretor') ? 'diretor' : 'membro', flag('admin'), tg]);
    await db.query("DELETE FROM sessoes_chat WHERE canal = 'telegram' AND id_externo = $1", [tg]);
    console.log(`${nome} (${diretoria}) vinculado ao Telegram ${tg}. Mande /ajuda ao bot.`);
  } finally { await db.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
