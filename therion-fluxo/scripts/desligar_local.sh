#!/usr/bin/env bash
# Desliga o bot local: remove o webhook no Telegram e para túnel, n8n e Postgres (os dados ficam).
# Uso: bash scripts/desligar_local.sh [--apagar-dados]
set -uo pipefail
cd "$(dirname "$0")/.."
node --env-file=.env scripts/setup_telegram.js --remover || true
if [ "${1:-}" = "--apagar-dados" ]; then
  docker compose --profile local down -v
  echo "Containers e volumes (banco e n8n) removidos."
else
  docker compose --profile local stop
  echo "Bot desligado. Dados preservados; ligue de novo com: bash scripts/ligar_local.sh"
fi
