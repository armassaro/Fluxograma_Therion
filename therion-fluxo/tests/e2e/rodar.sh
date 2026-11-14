#!/usr/bin/env bash
# Teste ponta a ponta dos workflows num n8n de verdade, com Telegram e SMTP falsos.
# Sobe tudo em containers descartáveis, roda tests/e2e/e2e.js e limpa no final.
# Requisitos: docker e node. Uso: bash tests/e2e/rodar.sh
# Não cobre Google Drive nem Google Sheets (precisam de credenciais reais).
set -euo pipefail
cd "$(dirname "$0")/../.."

IMG_N8N="${IMG_N8N:-n8nio/n8n:2.47.7}"
PG=therion-e2e-pg; N8=therion-e2e-n8n; VOL=therion-e2e
TMP="$(mktemp -d)"; MOCK_PID=""

limpar() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  docker rm -f "$N8" "$PG" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap limpar EXIT
limpar; TMP="$(mktemp -d)"

echo "== Postgres"
docker run -d --name "$PG" -e POSTGRES_PASSWORD=teste -e POSTGRES_USER=ej -e POSTGRES_DB=e2e -p 127.0.0.1:55439:5432 postgres:16-alpine >/dev/null
export DATABASE_URL=postgres://ej:teste@127.0.0.1:55439/e2e
for _ in $(seq 1 30); do node scripts/migrar.js >/dev/null 2>&1 && break; sleep 1; done
node scripts/migrar.js && node scripts/carregar_fluxos.js

echo "== Workflows"
node scripts/build_workflows.js >/dev/null
cat > "$TMP/creds.json" <<'JSON'
[
 {"id":"therion-postgres","name":"Therion Postgres","type":"postgres","data":{"host":"127.0.0.1","port":55439,"database":"e2e","user":"ej","password":"teste","ssl":"disable"}},
 {"id":"therion-smtp","name":"Therion SMTP","type":"smtp","data":{"host":"127.0.0.1","port":18025,"secure":false,"disableStartTls":true,"user":"","password":""}},
 {"id":"therion-google","name":"Therion Google (service account)","type":"googleApi","data":{"email":"falso@falso.iam.gserviceaccount.com","privateKey":"-----BEGIN PRIVATE KEY-----\nFALSA\n-----END PRIVATE KEY-----\n"}}
]
JSON
chmod -R a+rX "$TMP"
docker volume create "$VOL" >/dev/null
n8n() { docker run --rm --network host --security-opt label=disable -v "$VOL":/home/node/.n8n -v "$PWD/n8n/workflows":/wf:ro -v "$TMP":/cred:ro -e N8N_ENCRYPTION_KEY=e2e-chave "$IMG_N8N" "$@" 2>&1 | grep -v 'license SDK' || true; }
n8n import:credentials --input=/cred/creds.json | tail -1
n8n import:workflow --separate --input=/wf | tail -1
# WF-09 (agendado, lê o Google Sheets) fica de fora: com credencial falsa só geraria erros.
for id in therion-wf-99 therion-wf-05 therion-wf-06 therion-wf-04 therion-wf-02 therion-wf-03 therion-wf-01a; do n8n publish:workflow --id="$id" | grep -E 'Publishing|Cannot' ; done

echo "== Serviços falsos + n8n"
node tests/e2e/mock_servicos.js > "$TMP/mock.log" 2>&1 & MOCK_PID=$!
docker run -d --name "$N8" --network host --security-opt label=disable -v "$VOL":/home/node/.n8n \
  -e N8N_ENCRYPTION_KEY=e2e-chave -e N8N_PORT=5678 -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false -e NODE_FUNCTION_ALLOW_BUILTIN=crypto -e N8N_DIAGNOSTICS_ENABLED=false \
  -e N8N_PERSONALIZATION_ENABLED=false -e GENERIC_TIMEZONE=America/Sao_Paulo -e TZ=America/Sao_Paulo \
  -e TELEGRAM_API_BASE=http://127.0.0.1:18081 -e TELEGRAM_BOT_TOKEN=TOKENFALSO -e TELEGRAM_WEBHOOK_SECRET=segredo-e2e \
  -e TELEGRAM_CHAT_ADMINS=777000 -e FEATURE_DRIVE=false -e RATE_LIMIT_POR_MIN=1000 -e "EMAIL_REMETENTE=Therion Bot <fluxo@ej.test>" \
  "$IMG_N8N" >/dev/null

echo "== Cenários"
node tests/e2e/e2e.js
