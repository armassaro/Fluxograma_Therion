'use strict';
/**
 * Segurança das entradas (§18, §20): segredos, assinaturas HMAC e rate limit.
 * Comparações sempre em tempo constante. `crypto` é built-in do Node; no n8n é preciso
 * NODE_FUNCTION_ALLOW_BUILTIN=crypto (já definido no docker-compose.yml).
 */
const crypto = require('crypto');

/** Compara dois segredos em tempo constante. Vazio/ausente nunca confere. */
function compararSegredo(recebido, esperado) {
  if (typeof recebido !== 'string' || typeof esperado !== 'string' || !recebido || !esperado) return false;
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

function hmacHex(raw, secret) {
  return crypto.createHmac('sha256', secret).update(typeof raw === 'string' ? raw : Buffer.from(raw)).digest('hex');
}

/** Assinatura "sha256=<hex>" (Forms/API interna). */
function verificarHmac(raw, assinatura, secret) {
  if (!secret || raw == null || typeof assinatura !== 'string') return false;
  const hex = assinatura.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), Buffer.from(hmacHex(raw, secret), 'hex'));
}

/** Header X-Hub-Signature-256 da Meta (WhatsApp Cloud API) — mesmo formato "sha256=<hex>". */
function verificarMeta(raw, assinatura, appSecret) {
  return verificarHmac(raw, assinatura, appSecret);
}

/**
 * Janela deslizante: `historico` = datas (ISO/ms) das requisições anteriores do remetente.
 * @returns {{ok:boolean, restantes:number, tentarEmS:number}}
 */
function rateLimit(historico, limite, agora = Date.now(), janelaMs = 60000) {
  const t0 = agora - janelaMs;
  const recentes = (historico || []).map((d) => new Date(d).getTime()).filter((t) => t > t0 && t <= agora).sort((x, y) => x - y);
  const ok = recentes.length < limite;
  return {
    ok,
    restantes: Math.max(0, limite - recentes.length - (ok ? 1 : 0)),
    tentarEmS: ok ? 0 : Math.ceil((recentes[recentes.length - limite] + janelaMs - agora) / 1000),
  };
}

module.exports = { compararSegredo, verificarHmac, verificarMeta, rateLimit, hmacHex };
