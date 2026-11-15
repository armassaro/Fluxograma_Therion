'use strict';
/**
 * Renderização por canal: transforma mensagens neutras em "envios" prontos para o WF-05.
 *   telegram -> { canal:'telegram', membro_id, registrar, telegram: { metodo, corpo } }   (Bot API)
 *   email    -> { canal:'email',    membro_id, registrar, email: { para, assunto, texto } }
 */

const LIMITE_TELEGRAM = 4096;

/** Quebra um texto longo em partes de até `limite`, preferindo quebras de linha. */
function dividirTexto(texto, limite = LIMITE_TELEGRAM) {
  const partes = [];
  let resto = String(texto ?? '');
  while (resto.length > limite) {
    let corte = resto.lastIndexOf('\n', limite);
    if (corte < limite / 2) corte = limite;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte).replace(/^\n/, '');
  }
  if (resto || !partes.length) partes.push(resto);
  return partes;
}

/** Só notificações vão para a tabela `notificacoes`; respostas diretas e mensagens sigilosas (código de vínculo) não. */
function deveRegistrar(msg) { return !msg.resposta_direta && !msg.sigiloso; }

function tecladoTelegram(botoes) {
  if (!botoes || !botoes.length) return undefined;
  return {
    inline_keyboard: botoes.map((b) => [{
      text: String(b.rotulo).slice(0, 60),
      callback_data: String(b.dados).slice(0, 64),   // limite da Bot API
    }]),
  };
}

/**
 * Imagem (fluxograma): o WF-05 renderiza `imagem.fonte` no Kroki e envia com sendPhoto
 * (multipart). Vai ANTES do texto, para os botões ficarem na última mensagem.
 */
function renderImagemTelegram(msg) {
  const im = msg.imagem;
  return {
    canal: 'telegram', membro_id: msg.membro_id || null, registrar: false,
    imagem: { tipo: im.tipo || 'graphviz', fonte: im.fonte, arquivo: im.arquivo || 'fluxograma.png' },
    telegram: { metodo: 'sendPhoto', corpo: { chat_id: msg.destino, caption: String(im.legenda || '').slice(0, 1024) } },
  };
}

function renderTelegram(msg) {
  const partes = dividirTexto(msg.texto || ' ');
  const imagem = msg.imagem && msg.imagem.fonte ? [renderImagemTelegram(msg)] : [];
  return imagem.concat(partes.map((texto, i) => {
    const corpo = { chat_id: msg.destino, text: texto || ' ', disable_web_page_preview: true };
    const teclado = i === partes.length - 1 ? tecladoTelegram(msg.botoes) : undefined;
    if (teclado) corpo.reply_markup = teclado;
    return { canal: 'telegram', membro_id: msg.membro_id || null, registrar: deveRegistrar(msg), telegram: { metodo: 'sendMessage', corpo } };
  }));
}

function renderEmail(msg) {
  let texto = msg.texto || '';
  if (msg.botoes && msg.botoes.length) texto += '\n\nPara agir, use o bot no Telegram.';
  return [{
    canal: 'email', membro_id: msg.membro_id || null, registrar: deveRegistrar(msg),
    // essencial = sai mesmo com NOTIFICACAO_EMAIL_ATIVA=false (ex.: código de vínculo, que só existe por e-mail)
    essencial: !!msg.sigiloso,
    email: { para: msg.destino, assunto: msg.assunto || 'Therion Fluxo', texto },
  }];
}

/**
 * @param {object[]} mensagens  [{canal, destino, texto, botoes?, assunto?, membro_id?}]
 * @param {{id:string}|null} callback  se a entrada foi um clique de botão, responde-o (tira o "carregando")
 */
function montarEnvios(mensagens, callback = null) {
  const envios = [];
  if (callback && callback.id) {
    envios.push({ canal: 'telegram', membro_id: null, registrar: false,
      telegram: { metodo: 'answerCallbackQuery', corpo: { callback_query_id: callback.id } } });
  }
  for (const m of mensagens || []) {
    if (!m || !m.destino) continue;
    if (m.canal === 'telegram') envios.push(...renderTelegram(m));
    else if (m.canal === 'email') envios.push(...renderEmail(m));
  }
  return envios;
}

module.exports = { montarEnvios, renderTelegram, renderImagemTelegram, renderEmail, dividirTexto, tecladoTelegram, LIMITE_TELEGRAM };
