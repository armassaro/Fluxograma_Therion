# Credenciais do n8n

Os workflows referenciam credenciais por **ID fixo**. `scripts/implantar_n8n.js` as cria a partir
do `.env` — não crie à mão pela interface (o ID seria outro e a publicação falharia).
Nenhum segredo fica nos JSON exportados em `n8n/workflows/`.

| ID | Tipo n8n | Origem no `.env` | Usada por |
|---|---|---|---|
| `therion-postgres` | postgres | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (host `postgres`) | WF-02, 03, 04, 05, 06, 09 |
| `therion-smtp` | smtp | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | WF-05 |
| `therion-google` | googleApi (service account) | arquivo `GOOGLE_SA_JSON_PATH` (`client_email`, `private_key`) | WF-06, WF-09 |

Tokens lidos via `$env` (não são credenciais do n8n): `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`. Por isso o editor do n8n deve ficar acessível só a admins (Tailscale).
