# Runbook — implantação e operação

## Requisitos
VPS com Docker + Compose, Tailscale (acesso ao editor do n8n), Cloudflare Tunnel (expõe só
`/webhook/*`), service account Google com acesso ao Shared Drive e à planilha de membros, bot
criado no @BotFather, SMTP.

## Primeira implantação

```bash
cp .env.example .env            # preencha (N8N_ENCRYPTION_KEY e segredos: openssl rand -hex 32)
mkdir -p segredos && cp ~/google_sa.json segredos/   # GOOGLE_SA_JSON_PATH
docker compose up -d
npm ci
node --env-file=.env scripts/migrar.js
node --env-file=.env scripts/carregar_fluxos.js
node --env-file=.env scripts/implantar_n8n.js        # credenciais + workflows + publicação em ordem
docker compose --profile tunel up -d
node --env-file=.env scripts/setup_telegram.js        # webhook com secret_token + menu de comandos
```

No Google: compartilhe a pasta `DRIVE_RAIZ_ID` (Shared Drive) e a planilha `SHEETS_MEMBROS_ID` com o
e-mail da service account. A planilha precisa das colunas: `nome, email, diretoria, cargo, telefone,
is_admin, ativo, disponivel, canal_preferido, canais_habilitados`.

## Atualizar código
```bash
git pull && npm ci && npm test
node --env-file=.env scripts/migrar.js               # idempotente
node --env-file=.env scripts/carregar_fluxos.js      # só se fluxos mudaram
node --env-file=.env scripts/implantar_n8n.js --so-workflows
```

## Verificações
- `node --env-file=.env scripts/setup_telegram.js --info` — webhook e último erro do Telegram.
- Execuções no editor do n8n (via Tailscale). Alertas chegam em `TELEGRAM_CHAT_ADMINS`.
- Notificações com falha: `SELECT * FROM notificacoes WHERE status='falhou' ORDER BY criado_em DESC;`
- Pipeline: `SELECT * FROM vw_pipeline;` · Atrasos: `SELECT * FROM etapas_vencidas();`
- Consistência: `npm run simular` num banco de homologação.

## Incidentes comuns
| Sintoma | Causa provável | Ação |
|---|---|---|
| Bot não responde | webhook caiu / túnel parado | `setup_telegram.js --info`; `docker compose ps` |
| "Não reconheci você" | membro sem vínculo ou inativo na planilha | conferir planilha; `/vincular` |
| Arquivos não vão ao Drive | credencial Google / pasta não compartilhada | rever service account; WF-06 |
| Workflow não publica | sub-workflow não publicado | rodar `implantar_n8n.js` (publica na ordem) |
| `module 'crypto' is disallowed` | falta `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | ver docker-compose.yml |

## Rotação anual da gestão
Atualize a planilha (novos membros, `ativo=false` para quem saiu). O WF-09 desativa e reatribui as
etapas abertas automaticamente. Transfira a posse do Shared Drive e troque senhas/tokens do `.env`.

## Modo local (só Telegram, sem Google/SMTP)

```bash
bash scripts/ligar_local.sh       # Postgres + n8n + túnel trycloudflare + webhook do Telegram
bash scripts/desligar_local.sh    # remove o webhook e para tudo (dados preservados; --apagar-dados apaga)
```
- `.env` com `FEATURE_DRIVE=false`, `NOTIFICACAO_EMAIL_ATIVA=false`, `SHEETS_MEMBROS_ID` vazio
  (WF-09 não é publicado; credencial Google fictícia).
- A URL do túnel muda a cada `ligar_local.sh`; o script atualiza `BASE_URL_PUBLICA` e o webhook.
- Sem SMTP, `/vincular` não entrega o código. Vincule pelo terminal:
  `node --env-file=.env scripts/vincular_local.js --listar` e
  `node --env-file=.env scripts/vincular_local.js --telegram <id> --nome "..." --email ... --diretoria comercial [--diretor] [--admin]`.
- No `.env`, não ponha comentário na mesma linha de uma variável vazia: o Compose lê o comentário como valor.
