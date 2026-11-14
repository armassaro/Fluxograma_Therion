'use strict';
/** Conexão com o Postgres a partir das variáveis de ambiente (ou DATABASE_URL). */
const { Client } = require('pg');

function criarCliente(env = process.env) {
  if (env.DATABASE_URL) return new Client({ connectionString: env.DATABASE_URL });
  return new Client({
    host: env.POSTGRES_HOST || 'localhost',
    port: Number(env.POSTGRES_PORT || 5432),
    database: env.POSTGRES_DB || 'ej_fluxo',
    user: env.POSTGRES_USER || 'ej',
    password: env.POSTGRES_PASSWORD || '',
  });
}

/** Chama uma função SQL que recebe e devolve jsonb. */
async function chamar(db, fn, arg) {
  if (!/^[a-z_]+$/.test(fn)) throw new Error(`nome de função inválido: ${fn}`);
  const r = await db.query(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(arg)]);
  return r.rows[0].r;
}

module.exports = { criarCliente, chamar };
