#!/usr/bin/env bash
# Liga o bot do Telegram no próprio computador: Postgres + n8n + túnel temporário do Cloudflare.
# Uso: bash scripts/ligar_local.sh        (desligar: bash scripts/desligar_local.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Falta o .env (copie de .env.example)."; exit 1; }
command -v docker >/dev/null || { echo "Docker não encontrado."; exit 1; }
[ -d node_modules ] || npm ci

# Os scripts Node rodam no host: o Postgres do compose está em localhost:5432.
HOST_ENV=(env POSTGRES_HOST=localhost POSTGRES_PORT="${POSTGRES_PORTA_HOST:-5432}")

echo "== Postgres"
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -q -U "$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2)"; do sleep 1; done

echo "== Banco e fluxos"
"${HOST_ENV[@]}" node --env-file=.env scripts/migrar.js
"${HOST_ENV[@]}" node --env-file=.env scripts/carregar_fluxos.js

echo "== Túnel"
# A URL do trycloudflare muda a cada início do túnel; o n8n precisa dela (WEBHOOK_URL), por isso
# o túnel sobe antes e o n8n é (re)criado depois de gravar a URL no .env.
docker compose --profile local up -d --force-recreate --no-deps tunel_local
URL=""
for _ in $(seq 1 60); do
  URL=$(docker compose --profile local logs tunel_local 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$URL" ] && break; sleep 2
done
[ -n "$URL" ] || { echo "Não consegui obter a URL do túnel. Veja: docker compose --profile local logs tunel_local"; exit 1; }
sed -i "s|^BASE_URL_PUBLICA=.*|BASE_URL_PUBLICA=$URL|" .env
echo "URL pública: $URL"

echo "== n8n e workflows"
docker compose up -d --force-recreate n8n
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:5678/healthz >/dev/null && break; sleep 2; done
node --env-file=.env scripts/implantar_n8n.js
docker compose restart n8n >/dev/null   # garante que os webhooks recém-publicados estejam ativos
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:5678/healthz >/dev/null && break; sleep 2; done

echo "== Telegram"
for _ in $(seq 1 60); do   # o DNS do trycloudflare leva alguns segundos para propagar
  node --env-file=.env scripts/setup_telegram.js && break; sleep 5
done
node --env-file=.env scripts/setup_telegram.js --info | grep -q "url: 'https" \
  || { echo "ERRO: webhook não registrado (DNS do túnel). Rode de novo: node --env-file=.env scripts/setup_telegram.js"; exit 1; }
node --env-file=.env scripts/setup_telegram.js --info | grep -E "url|pending|last_error" || true
cat <<MSG

Bot ligado. Editor do n8n: http://127.0.0.1:5678
Primeiro uso: mande /start ao bot, depois rode
  node --env-file=.env scripts/vincular_local.js --listar
  node --env-file=.env scripts/vincular_local.js --telegram <id> --nome "Seu Nome" --email voce@ej.com --diretoria comercial --admin
MSG
