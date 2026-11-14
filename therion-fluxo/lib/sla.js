'use strict';
/**
 * SLA (§8.6): prazo de etapa descontando pausas, etapas vencidas e janela de notificação.
 * Funções puras; datas como ISO ou Date. O horário local é calculado no fuso `tz`.
 */
const H = 3600 * 1000;
const ms = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/**
 * @param {string|Date} entrada  data de entrada na etapa
 * @param {number|null} slaHoras
 * @param {{inicio:string, fim?:string|null}[]} pausas  pausa sem fim = ainda pausado (prazo indefinido)
 * @returns {string|null} ISO do prazo
 */
function calcularPrazo(entrada, slaHoras, pausas = []) {
  if (slaHoras == null || !(Number(slaHoras) > 0)) return null;
  const t0 = ms(entrada);
  let pausado = 0;
  for (const p of pausas || []) {
    if (!p || !p.inicio) continue;
    if (!p.fim) return null;
    const ini = Math.max(ms(p.inicio), t0);
    const fim = ms(p.fim);
    if (fim > ini) pausado += fim - ini;
  }
  return new Date(t0 + Number(slaHoras) * H + pausado).toISOString();
}

/**
 * @param {{prazo_sla, status_projeto?, data_saida?, ultimo_lembrete?, lembretes?}[]} etapas
 * @param {{lembreteIntervaloHoras?:number, escalonarAposLembretes?:number}} cfg
 * @returns etapas vencidas que devem receber lembrete agora, com `escalonar` marcado.
 */
function etapasVencidas(etapas, agora = new Date(), cfg = {}) {
  const t = ms(agora);
  const intervalo = (cfg.lembreteIntervaloHoras ?? 24) * H;
  const escalonar = cfg.escalonarAposLembretes ?? 2;
  return (etapas || [])
    .filter((e) => e.prazo_sla && !e.data_saida && (e.status_projeto ?? 'ativo') === 'ativo' && ms(e.prazo_sla) < t)
    .filter((e) => !e.ultimo_lembrete || t - ms(e.ultimo_lembrete) >= intervalo)
    .map((e) => ({ ...e, atraso_horas: Math.floor((t - ms(e.prazo_sla)) / H), escalonar: (e.lembretes || 0) >= escalonar }));
}

function partesLocais(data, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms(data))).map((x) => [x.type, x.value]));
  return { dia: p.weekday, minutos: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

const hhmm = (s, padrao) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || padrao)); return Number(m[1]) * 60 + Number(m[2]); };

/** Está dentro da janela em que notificações não urgentes podem ser enviadas? */
function dentroHorario(data = new Date(), cfg = {}) {
  const { dia, minutos } = partesLocais(data, cfg.tz || 'America/Sao_Paulo');
  if (!cfg.notificarFimDeSemana && (dia === 'Sat' || dia === 'Sun')) return false;
  return minutos >= hhmm(cfg.horarioInicio, '08:00') && minutos < hhmm(cfg.horarioFim, '21:00');
}

module.exports = { calcularPrazo, etapasVencidas, dentroHorario };
