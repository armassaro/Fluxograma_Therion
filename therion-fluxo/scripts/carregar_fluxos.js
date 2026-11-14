#!/usr/bin/env node
'use strict';
/**
 * Valida os templates de fluxos/*.yaml e grava em templates_fluxo.
 * - Conteúdo igual ao da última versão no banco: nada a fazer.
 * - Conteúdo diferente: exige `versao` MAIOR que a do banco (projetos existentes ficam na versão antiga).
 * Uso: node scripts/carregar_fluxos.js [--validar]   (--validar não toca no banco)
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { normalizarTemplate, validarTemplate } = require('../lib/templates');
const { validarSchema } = require('../lib/jsonschema');
const { criarCliente } = require('./db');

const DIR = path.join(__dirname, '..', 'fluxos');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(DIR, 'schema.json'), 'utf8'));

/** Lê e valida todos os YAML. Lança erro listando todos os problemas. */
function lerTemplates(dir = DIR) {
  const templates = [], problemas = [];
  for (const arq of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    let bruto, t;
    try { bruto = YAML.parse(fs.readFileSync(path.join(dir, arq), 'utf8')); } catch (e) {
      problemas.push(`${arq}: YAML inválido — ${e.message}`); continue;
    }
    const estrutura = validarSchema(SCHEMA, bruto);   // fluxos/schema.json: forma do documento
    if (estrutura.length) { estrutura.forEach((x) => problemas.push(`${arq}: ${x}`)); continue; }
    t = normalizarTemplate(bruto);
    const erros = validarTemplate(t);                  // regras de grafo e de negócio
    if (t.tipo_servico && `${t.tipo_servico}.yaml` !== arq.replace(/\.yml$/, '.yaml')) erros.push(`o arquivo deveria se chamar ${t.tipo_servico}.yaml`);
    for (const e of erros) problemas.push(`${arq}: ${e}`);
    templates.push(t);
  }
  if (problemas.length) throw new Error(`Templates inválidos:\n- ${problemas.join('\n- ')}`);
  return templates;
}

async function carregarFluxos(db, templates = lerTemplates()) {
  const relatorio = [];
  for (const t of templates) {
    const atual = (await db.query(
      'SELECT versao, definicao FROM templates_fluxo WHERE tipo_servico = $1 ORDER BY versao DESC LIMIT 1', [t.tipo_servico])).rows[0];
    if (atual && JSON.stringify(ordenar(atual.definicao)) === JSON.stringify(ordenar(t))) {
      relatorio.push(`${t.tipo_servico}: v${atual.versao} já está atualizada`); continue;
    }
    if (atual && t.versao <= atual.versao) {
      throw new Error(`${t.tipo_servico}: o conteúdo mudou, mas "versao" (${t.versao}) não é maior que a do banco (${atual.versao}). Aumente a versão no YAML.`);
    }
    await db.query('INSERT INTO templates_fluxo (tipo_servico, versao, definicao) VALUES ($1, $2, $3::jsonb)',
      [t.tipo_servico, t.versao, JSON.stringify(t)]);
    relatorio.push(`${t.tipo_servico}: v${t.versao} carregada`);
  }
  return relatorio;
}

/** Ordena chaves recursivamente para comparar JSON independente da ordem. */
function ordenar(v) {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])]));
  return v;
}

if (require.main === module) {
  (async () => {
    const templates = lerTemplates();
    console.log(`${templates.length} template(s) válidos: ${templates.map((t) => `${t.tipo_servico} v${t.versao}`).join(', ')}`);
    if (process.argv.includes('--validar')) return;
    const db = criarCliente();
    await db.connect();
    try { (await carregarFluxos(db, templates)).forEach((l) => console.log(l)); } finally { await db.end(); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { lerTemplates, carregarFluxos };
