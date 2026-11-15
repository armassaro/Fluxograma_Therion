'use strict';
/**
 * Converte variáveis de ambiente (strings) num objeto de configuração tipado.
 * Todo workflow/roteiro chama lerConfig() no início; nenhuma outra parte lê `env` direto.
 */

function bool(v, padrao) {
  if (v === undefined || v === null || v === '') return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function int(v, padrao) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : padrao;
}
function lista(v, padrao) {
  if (v === undefined || v === null || String(v).trim() === '') return padrao;
  return String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {Record<string,string|undefined>} env  ex.: process.env ou $env do n8n
 */
function lerConfig(env = {}) {
  return {
    tz: env.TZ || 'America/Sao_Paulo',
    canais: {
      telegram: bool(env.CANAL_TELEGRAM_ATIVO, true),
      whatsapp: bool(env.CANAL_WHATSAPP_ATIVO, false),   // Fase 5
      email: bool(env.CANAL_EMAIL_ATIVO, false),         // entrada por e-mail: Fase 3
      forms: bool(env.CANAL_FORMS_ATIVO, false),         // Fase 3
    },
    notificacoes: {
      telegram: bool(env.NOTIFICACAO_TELEGRAM_ATIVA, true),
      whatsapp: bool(env.NOTIFICACAO_WHATSAPP_ATIVA, false),
      email: bool(env.NOTIFICACAO_EMAIL_ATIVA, true),
    },
    features: {
      rodizio: bool(env.FEATURE_RODIZIO, true),
      reversao: bool(env.FEATURE_REVERSAO, true),
      drive: bool(env.FEATURE_DRIVE, true),
      fluxograma: bool(env.FEATURE_FLUXOGRAMA, true),       // imagem do fluxo em /projeto e /fluxograma
      iaDocumentos: bool(env.FEATURE_IA_DOCUMENTOS, false), // Fase 4
      // TODO(ENVIO_AUTOMATICO_CLIENTE): quando implementado, o efeito `enviar_documento_cliente` usa esta flag.
      envioAutomaticoCliente: bool(env.ENVIO_AUTOMATICO_CLIENTE, false),
    },
    sla: {
      lembreteIntervaloHoras: int(env.LEMBRETE_INTERVALO_HORAS, 24),
      escalonarAposLembretes: int(env.ESCALONAR_APOS_LEMBRETES, 2),
      diasAutoAbandono: int(env.DIAS_AUTO_ABANDONO, 30),
      horarioInicio: env.HORARIO_NOTIFICACAO_INICIO || '08:00',
      horarioFim: env.HORARIO_NOTIFICACAO_FIM || '21:00',
      notificarFimDeSemana: bool(env.NOTIFICAR_FIM_DE_SEMANA, false),
      tz: env.TZ || 'America/Sao_Paulo',
    },
    exigirResponsavelAtribuido: bool(env.EXIGIR_RESPONSAVEL_ATRIBUIDO, false),
    sync: {
      cron: env.SYNC_MEMBROS_CRON || '*/15 * * * *',
      planilhaId: env.SHEETS_MEMBROS_ID || '',
      aba: env.SHEETS_MEMBROS_ABA || '',          // vazio = ano atual
      maxDesativacoes: int(env.SYNC_MAX_DESATIVACOES, 5),
      maxDesativacoesPct: int(env.SYNC_MAX_DESATIVACOES_PCT, 20),
      mapaDiretorias: env.SYNC_MAPA_DIRETORIAS || '',
    },
    fluxoMostrarRevertidas: bool(env.FLUXO_MOSTRAR_REVERTIDAS, true),
    krokiUrl: (env.KROKI_URL || 'http://kroki:8000').replace(/\/+$/, ''),
    janelaReversaoHoras: int(env.JANELA_REVERSAO_HORAS, 48),
    sessaoTtlMin: int(env.SESSAO_TTL_MIN, 30),
    rateLimitPorMin: int(env.RATE_LIMIT_POR_MIN, 20),
    arquivoTamanhoMaxMb: int(env.ARQUIVO_TAMANHO_MAX_MB, 20),
    arquivoExtensoes: lista(env.ARQUIVO_EXTENSOES_PERMITIDAS,
      ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'xlsx', 'zip', 'stl', '3mf', 'step']),
    driveRaizId: env.DRIVE_RAIZ_ID || '',
    emailRemetente: env.EMAIL_REMETENTE || 'Therion Bot <fluxo@example.com>',
    telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
  };
}

module.exports = { lerConfig };
