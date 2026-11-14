#!/usr/bin/env node
'use strict';
/**
 * Simulador de linha de comando: conversa com o sistema SEM Telegram/n8n, usando o mesmo
 * pipeline (lib/app.js + funções SQL). Nada é enviado: as mensagens são impressas.
 *
 *   node scripts/simular.js demo                 roda um projeto website do lead à conclusão
 *   node scripts/simular.js chat --como EMAIL    conversa interativa como um membro
 *                                                (digite o número de um botão para clicá-lo)
 *   --semear   cria membros de demonstração (e-mails *@demo.local) se ainda não existirem
 *
 * Conexão: POSTGRES_* ou DATABASE_URL. Antes: `npm run migrar && npm run fluxos`.
 */
const readline = require('readline');
const { criarCliente } = require('./db');
const { executar } = require('./pipeline');
const { lerConfig } = require('../lib/config');
const { normalizarTelegram } = require('../lib/normalizadores');
const { chaveOrdenacao } = require('../lib/texto');
const { divergencias } = require('../lib/projecao');

const DEMO = [
  ['Carla Souza', 'carla@demo.local', 'comercial', 900101],
  ['Bruno Lima', 'bruno@demo.local', 'projetos', 900201],
  ['Fábio Nunes', 'fabio@demo.local', 'financeiro', 900301],
  ['Alice Prado', 'alice@demo.local', 'administrativo', 900401],
  ['Pietra Rocha', 'pietra@demo.local', 'presidencia', 900501],
];

async function semear(db) {
  for (const [nome, email, diretoria, tg] of DEMO) {
    await db.query(
      `INSERT INTO membros (nome, nome_ordenacao, email, diretoria, telegram_user_id, canal_preferido)
       VALUES ($1,$2,$3,$4,$5,'telegram') ON CONFLICT (email) DO NOTHING`,
      [nome, chaveOrdenacao(nome), email, diretoria, tg]);
  }
}

let seq = Date.now();
function update(tg, texto, callback, arquivo) {
  const id = ++seq, de = { id: tg, is_bot: false, first_name: 'sim' }, chat = { id: tg, type: 'private' };
  if (callback) return { update_id: id, callback_query: { id: `cb${id}`, from: de, data: callback, message: { message_id: 1, chat } } };
  const message = { message_id: id, from: de, chat, date: Math.floor(Date.now() / 1000) };
  if (arquivo) { message.document = { file_id: `sim-${id}`, file_name: arquivo, file_size: 1000 }; message.caption = texto; } else message.text = texto;
  return { update_id: id, message };
}

function imprimir(r, nomes) {
  for (const m of r.mensagens) {
    const quem = m.resposta_direta ? 'BOT' : `NOTIFICAÇÃO → ${nomes.get(m.destino) || m.destino} (${m.canal})`;
    console.log(`\n  ┌─ ${quem}`);
    for (const l of m.texto.split('\n')) console.log(`  │ ${l}`);
    (m.botoes || []).forEach((b, i) => console.log(`  │ [${i + 1}] ${b.rotulo}`));
    console.log('  └─');
  }
  for (const e of (r.final && r.final.efeitos) || []) console.log(`  (efeito pós-gravação: ${e.tipo}${e.pendente_de_fase_futura ? ' — fase futura' : ''})`);
}

async function mapaNomes(db) {
  const r = await db.query('SELECT nome, email, telegram_user_id FROM membros');
  const m = new Map();
  for (const x of r.rows) { m.set(x.email, x.nome); if (x.telegram_user_id) m.set(String(x.telegram_user_id), x.nome); }
  return m;
}

async function demo(db, cfg) {
  await semear(db);
  const nomes = await mapaNomes(db);
  const [C, P, F, A] = [900101, 900201, 900301, 900401];
  let cod = 'P-?';
  const passos = [
    [C, '/novo'], [C, null, 'val:website'], [C, 'Site Padaria Sol'], [C, 'Padaria Sol'], [C, 'contato@padariasol.example'],
    [C, 'pular'], [C, 'Site institucional com cardápio'], [C, 'pular'], [C, 'pular'], [C, 'confirmar'],  // já vai para Projetos
    [P, () => `/acao ${cod} enviar_escopo escopo="5 páginas, cardápio, formulário" estimativa_horas=40`], [P, 'confirmar'],
    [F, () => `/acao ${cod} orcamento_rascunho_pronto obs="planilha na pasta"`], [F, 'confirmar'],
    [F, () => `/acao ${cod} aprovar_orcamento_interno valor_orcado=3.200,00`], [F, 'confirmar'],
    [C, () => `/acao ${cod} cliente_aprovou obs="aprovado por e-mail"`], [C, 'confirmar'],
    [A, () => `/acao ${cod} contrato_rascunho_pronto obs=ok`], [A, 'confirmar'],
    [A, () => `/acao ${cod} aprovar_contrato_interno obs=ok`], [A, 'confirmar'],
    [A, () => `/acao ${cod} contrato_assinado valor_contratado=3200`, null, 'contrato_assinado.pdf'], [A, 'confirmar'],
    [P, () => `/acao ${cod} concluir_execucao link_entrega=https://padariasol.example`], [P, 'confirmar'],
    [P, () => `/acao ${cod} cliente_aceitou_entrega obs="aceite por e-mail"`], [P, 'confirmar'],
    [F, () => `/acao ${cod} registrar_parcela valor_pago=3200`, null, 'comprovante_pix.pdf'], [F, 'confirmar'],
    [F, () => `/acao ${cod} quitar obs="pago à vista"`], [F, 'confirmar'],
    [C, () => `/historico ${cod}`],
  ];
  for (const [tg, texto, callback, arquivo] of passos) {
    const t = typeof texto === 'function' ? texto() : texto;
    console.log(`\n${nomes.get(String(tg))}> ${callback ? `[botão ${callback}]` : t}${arquivo ? `  📎 ${arquivo}` : ''}`);
    const r = await executar(db, normalizarTelegram(update(tg, t || '', callback, arquivo)), cfg);
    imprimir(r, nomes);
    if (r.resultado && r.resultado.projeto) cod = r.resultado.projeto.codigo;
  }
  const d = (await db.query('SELECT carregar_dados($1::jsonb) r', [JSON.stringify({ membro_id: (await db.query('SELECT id FROM membros WHERE is_sistema')).rows[0].id, projeto_codigo: cod })])).rows[0].r;
  const dif = divergencias(d.projeto, d.acoes);
  console.log(`\nEstado final de ${cod}: ${d.projeto.status}, etapa "${d.projeto.etapa.nome}", ${d.acoes.length} ações.`);
  console.log(dif.length ? `INCONSISTÊNCIA: ${dif.join('; ')}` : 'Projeção consistente com o histórico de eventos.');
  if (dif.length || d.projeto.status !== 'concluido') process.exitCode = 1;
}

async function chat(db, cfg, email) {
  const m = (await db.query('SELECT nome, telegram_user_id t FROM membros WHERE email = lower($1) AND ativo', [email || ''])).rows[0];
  if (!m) throw new Error(`Membro ativo não encontrado: ${email}. Use --semear para criar membros de demonstração (ex.: carla@demo.local).`);
  if (!m.t) throw new Error(`${m.nome} ainda não tem Telegram vinculado; o simulador identifica pelo id do Telegram.`);
  const nomes = await mapaNomes(db);
  console.log(`Conversando como ${m.nome}. Comece com /ajuda. Ctrl+D para sair. "anexar nome.pdf [legenda]" simula um arquivo.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${m.nome}> ` });
  let botoes = [];
  rl.prompt();
  for await (const linha of rl) {
    const t = linha.trim();
    if (t) {
      const n = /^\d+$/.test(t) ? botoes[Number(t) - 1] : null;
      const anexo = /^anexar\s+(\S+)\s*(.*)$/i.exec(t);
      const u = n ? update(Number(m.t), '', n.dados) : anexo ? update(Number(m.t), anexo[2], null, anexo[1]) : update(Number(m.t), t);
      const r = await executar(db, normalizarTelegram(u), cfg);
      imprimir(r, nomes);
      botoes = (r.mensagens.find((x) => x.resposta_direta) || {}).botoes || [];
    }
    rl.prompt();
  }
}

(async () => {
  const args = process.argv.slice(2);
  const modo = args[0];
  if (!['demo', 'chat'].includes(modo)) { console.log('Uso: node scripts/simular.js demo | chat --como EMAIL [--semear]'); process.exit(2); }
  // No simulador não há Drive nem limite de mensagens.
  const cfg = lerConfig({ ...process.env, FEATURE_DRIVE: 'false', RATE_LIMIT_POR_MIN: '100000' });
  const db = criarCliente();
  await db.connect();
  try {
    if (args.includes('--semear')) await semear(db);
    if (modo === 'demo') await demo(db, cfg);
    else await chat(db, cfg, args[args.indexOf('--como') + 1]);
  } finally { await db.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
