#!/usr/bin/env node
'use strict';
/**
 * Aplica os SQL idempotentes (schema, funções, consultas nomeadas e views).
 * Uso: node scripts/migrar.js [--seed]   (--seed: membros fictícios para dev/homologação)
 * Conexão via POSTGRES_* ou DATABASE_URL.
 */
const fs = require('fs');
const path = require('path');
const { criarCliente } = require('./db');

async function migrar(db, { seed = false } = {}) {
  const arquivos = ['schema.sql', 'registrar_acao.sql', 'consultas.sql', 'views.sql'];
  if (seed) arquivos.push('seed.sql');
  for (const arq of arquivos) {
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'sql', arq), 'utf8'));
  }
}

if (require.main === module) {
  (async () => {
    const db = criarCliente();
    await db.connect();
    try { await migrar(db, { seed: process.argv.includes('--seed') }); console.log('Banco migrado.'); } finally { await db.end(); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { migrar };
