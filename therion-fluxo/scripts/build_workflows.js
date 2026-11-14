#!/usr/bin/env node
'use strict';
/**
 * Gera n8n/workflows/*.json a partir de n8n/workflows-src/definicoes.js, embutindo em cada nó Code
 * os módulos de lib/ que ele declara (e as dependências deles).
 * Uso: node scripts/build_workflows.js [--checar]   (--checar falha se os JSON estiverem desatualizados)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..');
const LIB = path.join(RAIZ, 'lib');
const SAIDA = path.join(RAIZ, 'n8n', 'workflows');

/** Módulos pedidos + dependências (require('./x')), em ordem estável. */
function dependencias(nomes) {
  const vistos = new Set();
  const visitar = (n) => {
    if (vistos.has(n)) return;
    const arq = path.join(LIB, `${n}.js`);
    if (!fs.existsSync(arq)) throw new Error(`lib/${n}.js não existe`);
    vistos.add(n);
    for (const m of fs.readFileSync(arq, 'utf8').matchAll(/require\('\.\/([a-z_]+)'\)/g)) visitar(m[1]);
  };
  nomes.forEach(visitar);
  return [...vistos].sort();
}

function prelude(nomes) {
  if (!nomes.length) return '';
  const partes = [
    '// ==== Módulos de lib/ embutidos por scripts/build_workflows.js. NÃO edite aqui: edite lib/ e rode `npm run build`. ====',
    'const __mods = {}, __cache = {};',
    "function __req(n) { if (!n.startsWith('./')) return require(n); if (__cache[n]) return __cache[n].exports; if (!__mods[n]) throw new Error('módulo não embutido: ' + n); const module = { exports: {} }; __cache[n] = module; __mods[n](module, module.exports, __req); return module.exports; }",
  ];
  for (const n of dependencias(nomes)) {
    partes.push(`__mods['./${n}'] = function (module, exports, require) {\n${fs.readFileSync(path.join(LIB, `${n}.js`), 'utf8')}\n};`);
  }
  partes.push('// ==== Fim dos módulos embutidos. Código do nó: ====');
  return `${partes.join('\n')}\n`;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const uuid = (s) => { const h = crypto.createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function gerar(def, ids) {
  const nomes = new Set(def.nodes.map((n) => n.name));
  if (nomes.size !== def.nodes.length) throw new Error(`${def.name}: nomes de nós repetidos`);
  // posição: em cadeia, pela ordem de definição
  const nodes = def.nodes.map((n, i) => {
    const { libs, ...resto } = n;
    const node = { ...resto, id: uuid(`${def.id}:${n.name}`), position: [(i % 6) * 240, Math.floor(i / 6) * 220] };
    if (n.type === 'n8n-nodes-base.code') {
      node.parameters = { ...n.parameters, jsCode: prelude(libs || []) + n.parameters.jsCode };
      // Pega erro de sintaxe já no build (o n8n só acusaria ao executar o nó).
      try { new AsyncFunction(node.parameters.jsCode); } catch (e) { throw new Error(`${def.name} / ${n.name}: ${e.message}`); }
    }
    return node;
  });
  const connections = {};
  for (const [de, para, saida = 0] of def.connections) {
    if (!nomes.has(de) || !nomes.has(para)) throw new Error(`${def.name}: conexão inválida ${de} -> ${para}`);
    connections[de] = connections[de] || { main: [] };
    while (connections[de].main.length <= saida) connections[de].main.push([]);
    connections[de].main[saida].push({ node: para, type: 'main', index: 0 });
  }
  const settings = { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' };
  if (!def.semErrorWorkflow) settings.errorWorkflow = ids.erros;
  return { id: def.id, name: def.name, active: false, nodes, connections, settings, pinData: {}, meta: { templateCredsSetupCompleted: true } };
}

function construir() {
  const { workflows, ID } = require('../n8n/workflows-src/definicoes');
  return workflows.map((w) => ({
    arquivo: `${w.name.split(' ')[0].toLowerCase()}_${w.name.split(' ').slice(1).join('_').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]/g, '')}.json`,
    json: `${JSON.stringify(gerar(w, ID), null, 2)}\n`,
  }));
}

if (require.main === module) {
  const arquivos = construir();
  if (process.argv.includes('--checar')) {
    const velhos = arquivos.filter((a) => !fs.existsSync(path.join(SAIDA, a.arquivo)) || fs.readFileSync(path.join(SAIDA, a.arquivo), 'utf8') !== a.json);
    if (velhos.length) { console.error(`Desatualizados (rode npm run build): ${velhos.map((a) => a.arquivo).join(', ')}`); process.exit(1); }
    console.log('Workflows gerados estão em dia.');
  } else {
    fs.mkdirSync(SAIDA, { recursive: true });
    for (const antigo of fs.readdirSync(SAIDA).filter((f) => f.endsWith('.json'))) fs.unlinkSync(path.join(SAIDA, antigo));
    for (const a of arquivos) { fs.writeFileSync(path.join(SAIDA, a.arquivo), a.json); console.log(`n8n/workflows/${a.arquivo}`); }
  }
}

module.exports = { construir, prelude, dependencias };
