# Runbook — implantação e operação

## Requisitos
VPS com Docker + Compose, Tailscale (acesso ao editor do n8n), Cloudflare Tunnel (expõe só
`/webhook/*`), service account Google com acesso ao Shared Drive e à planilha de membros, bot
criado no @BotFather, SMTP. O `docker compose up -d` também sobe o `kroki` (renderizador local do
fluxograma, sem porta exposta).

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

No Google: compartilhe a pasta `DRIVE_RAIZ_ID` (Shared Drive) com o e-mail da service account.
A planilha de membros tem configuração própria: veja **Planilha de membros** abaixo.

## Atualizar código
```bash
git pull && npm ci && npm test
node --env-file=.env scripts/migrar.js               # idempotente
node --env-file=.env scripts/carregar_fluxos.js      # só se fluxos mudaram
node --env-file=.env scripts/implantar_n8n.js --so-workflows
node --env-file=.env scripts/setup_telegram.js       # só se a lista de comandos do bot mudou
```
No modo local (banco no Docker, scripts rodando no host), o `.env` aponta `POSTGRES_HOST=postgres`,
que só existe dentro da rede do Compose. Para migrar a partir do host use
`POSTGRES_HOST=localhost node --env-file=.env scripts/migrar.js`.

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
| `/sync`: "Não consegui ler a planilha" | aba do ano não existe / planilha não compartilhada com a service account / chave inválida | conferir aba, compartilhamento (Leitor) e `GOOGLE_SA_JSON_PATH` |
| `/sync`: "Sync bloqueado" | trava de desativação em massa | conferir a planilha; se correto, `/sync forcar` |
| Arquivos não vão ao Drive | credencial Google / pasta não compartilhada | rever service account; WF-06 |
| Workflow não publica | sub-workflow não publicado | rodar `implantar_n8n.js` (publica na ordem) |
| `module 'crypto' is disallowed` | falta `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | ver docker-compose.yml |

## Planilha de membros (sync seguro)

A planilha **continua privada**: nada é publicado na internet. O n8n faz chamadas de saída à API do
Google com uma service account que só tem **leitura** da planilha.

**Formato.** Aba com o nome do **ano atual** (ex.: `2026`; `SHEETS_MEMBROS_ABA` força outra), colunas:
`Nome | E-mail UTFPR | E-mail Therion | CPF | RG | Telefone | Endereço | Data de nascimento | R.A. |
Data de entrada | Data de saída | Tempo de permanência | Cargo | Diretoria`.
O WF-09 lê **só** A–C, F, K e M–N (`values:batchGet`). CPF, RG, endereço, nascimento e R.A. nunca
saem do Google nem aparecem nas execuções do n8n.

**Regras.** E-mail do membro = E-mail Therion (ou UTFPR se vazio). "Egresso" no cargo ou data de saída
passada ⇒ inativo. Cargo com "Diretor(a)" ou "Presidente" (inclui vice) ⇒ admin. Diretoria é lida
com tolerância (ex.: "Diretoria de Projetos" ⇒ projetos); nomes diferentes vão em
`SYNC_MAPA_DIRETORIAS`. Disponibilidade (`/ausente`) e canal (`/canal`) continuam sendo do app.

**Proteções.** Linha com erro não desativa a pessoa; desativar mais de `SYNC_MAX_DESATIVACOES` (5)
ou `SYNC_MAX_DESATIVACOES_PCT` (20%) dos ativos é bloqueado sem gravar nada (libera com
`/sync forcar`); egressos que nunca usaram o sistema não são criados; os admins são avisados de todo
sync aplicado (incluindo quem ganhou/perdeu admin).

**Configuração (uma vez).**
1. Google Cloud: crie um projeto só para isso, habilite a **Google Sheets API** (e a Drive API se usar
   o Drive) e crie uma service account **sem papéis** no projeto. Gere uma chave JSON.
2. Salve a chave em `segredos/google_sa.json` (`chmod 600`; a pasta está no `.gitignore`) e aponte
   `GOOGLE_SA_JSON_PATH` para ela.
3. Na planilha: Compartilhar → adicione o e-mail da service account (`...@...iam.gserviceaccount.com`)
   como **Leitor**. Mantenha o acesso geral como **Restrito**. Proteja as colunas **Cargo** e
   **Diretoria** (Dados → Proteger páginas e intervalos) para só a Presidência editar, porque elas
   definem quem é admin.
4. Antes do 1º sync, confira que as contas já usadas no bot têm, no banco, o mesmo e-mail da coluna
   E-mail Therion (o sync casa por e-mail; quem não estiver na planilha é desativado).
5. `.env`: `SHEETS_MEMBROS_ID=<id da URL>`; rode `node --env-file=.env scripts/implantar_n8n.js`
   (com credenciais, sem `--so-workflows`).
6. No Telegram, como admin: `/sync` mostra a **prévia** (nada é gravado) → **Aplicar**. Depois disso
   o cron (`SYNC_MEMBROS_CRON`, padrão a cada 15 min) mantém tudo em dia.

**Rotação da chave:** gere uma nova chave na service account, troque o arquivo, rode
`implantar_n8n.js` e apague a chave antiga no Google Cloud.

## Rotação anual da gestão
Crie a aba do novo ano na planilha (o sync passa a ler a aba do ano corrente automaticamente) e marque
quem saiu como "Egresso" ou com data de saída. Rode `/sync` para ver a prévia; se muita gente sair de
uma vez, a trava pede `/sync forcar`. Transfira a posse do Shared Drive e troque senhas/tokens do `.env`.

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
