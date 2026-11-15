#!/usr/bin/env node
'use strict';
/**
 * Implanta credenciais e workflows no n8n do docker compose e publica na ordem correta.
 *
 *   node --env-file=.env scripts/implantar_n8n.js            credenciais + workflows
 *   node --env-file=.env scripts/implantar_n8n.js --so-workflows
 *
 * Por que importar as credenciais por aqui: os workflows referenciam credenciais por ID fixo
 * (therion-postgres, therion-smtp, therion-google). Criadas à mão na interface, teriam outro ID e
 * a publicação falharia. O JSON das credenciais é enviado por stdin e apagado do container em seguida.
 *
 * Ordem de publicação: o n8n 2.x só publica um workflow se os sub-workflows que ele chama já
 * estiverem publicados.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const { construir } = require('./build_workflows');
const path = require('path');

// WF-09 vem antes do WF-03, que o chama no /sync.
const ORDEM = ['therion-wf-99', 'therion-wf-05', 'therion-wf-06', 'therion-wf-04', 'therion-wf-02', 'therion-wf-09', 'therion-wf-03', 'therion-wf-01a'];
const env = process.env;

function n8n(args, entrada) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'n8n', ...args], { input: entrada, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function credenciais() {
  const lista = [{
    id: 'therion-postgres', name: 'Therion Postgres', type: 'postgres',
    data: { host: 'postgres', port: 5432, database: env.POSTGRES_DB || 'ej_fluxo', user: env.POSTGRES_USER || 'ej', password: env.POSTGRES_PASSWORD || '', ssl: 'disable' },
  }, {
    id: 'therion-smtp', name: 'Therion SMTP', type: 'smtp',
    data: { host: env.SMTP_HOST || 'localhost', port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true', user: env.SMTP_USER || '', password: env.SMTP_PASSWORD || '' },
  }];
  const sa = env.GOOGLE_SA_JSON_PATH;
  if (sa && fs.existsSync(sa)) {
    const j = JSON.parse(fs.readFileSync(sa, 'utf8'));
    // httpNode/scopes: permite o nó HTTP do WF-09 usar esta credencial só com leitura de planilhas (e Drive, se ligado).
    const escopos = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
    if (env.FEATURE_DRIVE !== 'false') escopos.push('https://www.googleapis.com/auth/drive');
    lista.push({ id: 'therion-google', name: 'Therion Google (service account)', type: 'googleApi',
      data: { email: j.client_email, privateKey: j.private_key, httpNode: true, scopes: escopos.join(' ') } });
  } else {
    // Sem service account (modo local, FEATURE_DRIVE=false): credencial de mentira só para os
    // workflows publicarem; os nós do Google nunca são executados com o Drive desligado.
    console.warn(`AVISO: ${sa || 'GOOGLE_SA_JSON_PATH'} não encontrado — usando credencial Google fictícia (Drive/Sheets ficam inoperantes).`);
    lista.push({ id: 'therion-google', name: 'Therion Google (service account)', type: 'googleApi',
      data: { email: 'nao-configurado@local.iam.gserviceaccount.com', privateKey: '-----BEGIN PRIVATE KEY-----\nNAO_CONFIGURADO\n-----END PRIVATE KEY-----\n' } });
  }
  return lista;
}

(async () => {
  const soWorkflows = process.argv.includes('--so-workflows');
  // 1. JSON dos workflows em dia com lib/
  const saida = path.join(__dirname, '..', 'n8n', 'workflows');
  fs.mkdirSync(saida, { recursive: true });
  for (const a of construir()) fs.writeFileSync(path.join(saida, a.arquivo), a.json);
  console.log('Workflows gerados.');

  if (!soWorkflows) {
    n8n(['sh', '-c', 'umask 077 && cat > /tmp/therion_creds.json'], JSON.stringify(credenciais()));
    try { console.log(n8n(['n8n', 'import:credentials', '--input=/tmp/therion_creds.json']).trim().split('\n').pop()); }
    finally { n8n(['rm', '-f', '/tmp/therion_creds.json']); }
  }
  console.log(n8n(['n8n', 'import:workflow', '--separate', '--input=/workflows']).trim().split('\n').pop());

  let falhas = 0;
  // WF-09 é sempre publicado (o WF-03 o chama no /sync). Sem SHEETS_MEMBROS_ID, o cron não faz nada.
  const ordem = ORDEM;
  if (!env.SHEETS_MEMBROS_ID) console.log('SHEETS_MEMBROS_ID vazio: o sync de membros fica inativo até a planilha ser configurada.');
  for (const id of ordem) {
    try { n8n(['n8n', 'publish:workflow', `--id=${id}`]); console.log(`publicado: ${id}`); } catch (e) {
      falhas += 1;
      const msg = `${e.stdout || ''}${e.stderr || ''}`.split('\n').filter((l) => /Cannot publish|failed|Error/i.test(l)).join(' ') || e.message;
      console.error(`NÃO publicado: ${id} — ${msg}`);
    }
  }
  if (falhas) process.exit(1);
  console.log('Pronto. O n8n em execução aplica a publicação em instantes.');
})().catch((e) => { console.error(e.stderr || e.message); process.exit(1); });
