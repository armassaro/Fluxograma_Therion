'use strict';
/**
 * Normalizadores: convertem o payload nativo de cada canal no "Comando Normalizado" (§12),
 * único formato que o restante do sistema conhece. Nenhuma regra de negócio aqui.
 *
 * Comando Normalizado:
 *   { idempotency_key, canal, id_externo_remetente, chat_id, nome_remetente, recebido_em,
 *     texto, arquivos: [{origem, file_id, nome, mime, tamanho}], callback: {id, dados}|null }
 *
 * Fases seguintes acrescentam normalizarEmail / normalizarForms / normalizarWhatsapp neste arquivo.
 */

/**
 * @param {object} update  Update da Bot API do Telegram
 * @returns {object|null}  null = update que o sistema ignora
 */
function normalizarTelegram(update) {
  if (!update || typeof update !== 'object' || update.update_id === undefined) return null;
  const cq = update.callback_query;
  const msg = update.message || (cq && cq.message);
  const de = cq ? cq.from : update.message && update.message.from;
  if (!msg || !de || de.is_bot) return null;
  // Só conversas privadas: evita expor dados de projetos em grupos onde o bot foi adicionado.
  if (!msg.chat || msg.chat.type !== 'private') return null;

  const arquivos = [];
  if (!cq) {
    const m = update.message;
    if (m.document) {
      arquivos.push({
        origem: 'telegram', file_id: m.document.file_id, nome: m.document.file_name || 'arquivo',
        mime: m.document.mime_type || 'application/octet-stream', tamanho: m.document.file_size || 0,
      });
    } else if (Array.isArray(m.photo) && m.photo.length) {
      const maior = m.photo[m.photo.length - 1];      // o Telegram manda vários tamanhos; o último é o maior
      arquivos.push({
        origem: 'telegram', file_id: maior.file_id, nome: `foto_${m.message_id}.jpg`,
        mime: 'image/jpeg', tamanho: maior.file_size || 0,
      });
    }
  }

  return {
    idempotency_key: `telegram:update:${update.update_id}`,
    canal: 'telegram',
    id_externo_remetente: String(de.id),
    chat_id: String(msg.chat.id),
    nome_remetente: [de.first_name, de.last_name].filter(Boolean).join(' ') || de.username || '',
    recebido_em: new Date(((update.message && update.message.date) || Date.now() / 1000) * 1000).toISOString(),
    texto: cq ? '' : String(update.message.text || update.message.caption || '').trim(),
    arquivos,
    callback: cq ? { id: String(cq.id), dados: String(cq.data || '') } : null,
  };
}

module.exports = { normalizarTelegram };
