#!/usr/bin/env node
'use strict';
/**
 * Serviços falsos para o teste ponta a ponta dos workflows do n8n (tests/e2e/rodar.sh):
 *  - Bot API do Telegram (HTTP): grava cada chamada; GET /__chamadas devolve e limpa a lista.
 *  - Servidor SMTP mínimo: grava cada e-mail; GET /__emails devolve e limpa a lista.
 * Nada sai para a internet.
 */
const http = require('http');
const net = require('net');

const PORTA_HTTP = Number(process.env.MOCK_HTTP || 18081);
const PORTA_SMTP = Number(process.env.MOCK_SMTP || 18025);
let chamadas = [], emails = [];

http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/__chamadas') { const c = chamadas; chamadas = []; return json(c); }
    if (req.url === '/__emails') { const e = emails; emails = []; return json(e); }
    const m = /^\/bot([^/]+)\/(\w+)/.exec(req.url);
    if (!m) return json({ ok: false, description: 'rota desconhecida' }, 404);
    let dados = {};
    try { dados = JSON.parse(corpo || '{}'); } catch { /* corpo não-JSON */ }
    chamadas.push({ token: m[1], metodo: m[2], corpo: dados });
    // Simula usuário que bloqueou o bot, para testar o registro de falha de entrega.
    if (m[2] === 'sendMessage' && String(dados.chat_id) === '403403') return json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403);
    return json({ ok: true, result: { message_id: chamadas.length } });
  });
}).listen(PORTA_HTTP, '127.0.0.1', () => console.log(`mock Telegram em http://127.0.0.1:${PORTA_HTTP}`));

net.createServer((s) => {
  let buf = '', emData = false, msg = { de: '', para: [], dados: '' };
  s.write('220 mock ESMTP\r\n');
  s.on('data', (d) => {
    buf += d.toString('utf8');
    for (;;) {
      if (emData) {
        const fim = buf.indexOf('\r\n.\r\n');
        if (fim < 0) return;
        msg.dados = buf.slice(0, fim); buf = buf.slice(fim + 5); emData = false;
        emails.push(msg); msg = { de: '', para: [], dados: '' };
        s.write('250 OK\r\n');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const linha = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = linha.toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) s.write('250-mock\r\n250 8BITMIME\r\n');
      else if (cmd.startsWith('MAIL FROM')) { msg.de = linha; s.write('250 OK\r\n'); }
      else if (cmd.startsWith('RCPT TO')) { msg.para.push((/<([^>]+)>/.exec(linha) || [])[1]); s.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { emData = true; s.write('354 fim com <CRLF>.<CRLF>\r\n'); }
      else if (cmd === 'QUIT') { s.write('221 tchau\r\n'); s.end(); }
      else s.write('250 OK\r\n');
    }
  });
  s.on('error', () => {});
}).listen(PORTA_SMTP, '127.0.0.1', () => console.log(`mock SMTP em 127.0.0.1:${PORTA_SMTP}`));
