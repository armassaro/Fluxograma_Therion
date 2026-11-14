#!/usr/bin/env node
'use strict';
/**
 * Registra o webhook do bot no Telegram (com o segredo) e a lista de comandos do menu.
 * Uso: node --env-file=.env scripts/setup_telegram.js [--info | --remover]
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const publica = (process.env.BASE_URL_PUBLICA || '').replace(/\/+$/, '');

async function api(metodo, corpo) {
  const r = await fetch(`${base}/bot${token}/${metodo}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${metodo}: ${j.description}`);
  return j.result;
}

(async () => {
  if (!token) throw new Error('Defina TELEGRAM_BOT_TOKEN.');
  if (process.argv.includes('--info')) { console.log(await api('getWebhookInfo')); return; }
  if (process.argv.includes('--remover')) { await api('deleteWebhook'); console.log('Webhook removido.'); return; }
  if (!/^https:\/\//.test(publica)) throw new Error('BASE_URL_PUBLICA precisa ser uma URL https (o Telegram só entrega em HTTPS).');
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) throw new Error('Defina TELEGRAM_WEBHOOK_SECRET (o workflow recusa tudo sem ele).');
  await api('setWebhook', {
    url: `${publica}/webhook/telegram`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await api('setMyCommands', { commands: [
    { command: 'meus', description: 'Projetos aguardando a minha diretoria' },
    { command: 'projetos', description: 'Todos os projetos em andamento' },
    { command: 'projeto', description: 'Detalhes e ações de um projeto' },
    { command: 'novo', description: 'Registrar novo projeto (Comercial)' },
    { command: 'historico', description: 'Histórico de um projeto' },
    { command: 'cancelar', description: 'Cancelar a operação em andamento' },
    { command: 'ajuda', description: 'Lista de comandos' },
  ] });
  console.log(`Webhook registrado em ${publica}/webhook/telegram e comandos atualizados.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
