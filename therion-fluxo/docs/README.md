# Therion Fluxo

Sistema de acompanhamento de projetos entre as diretorias Comercial, Projetos, Financeiro e
Administrativo da EJ. Cada projeto percorre um fluxo de etapas configurado em `fluxos/*.yaml`;
membros agem pelo bot do Telegram e o sistema registra tudo (append-only), atribui responsáveis por
rodízio, guarda arquivos no Google Drive e notifica quem precisa agir.

**Estado:** fases 1 (núcleo) e 2 (Telegram + Drive + sync de membros) implementadas.

| Documento | Para quem |
|---|---|
| [manual_usuario.md](manual_usuario.md) | Membros da EJ: comandos do bot |
| [runbook.md](runbook.md) | Quem implanta e opera o servidor |
| [arquitetura.md](arquitetura.md) | Quem mantém o código |
| [adicionar_servico.md](adicionar_servico.md) | Como criar um fluxo para um novo tipo de serviço |
| [../n8n/credentials.example.md](../n8n/credentials.example.md) | Credenciais do n8n |

## Histórico de mudanças

**2026-11-14**
- **Troca de responsável (`/reatribuir`)**: a diretoria responsável, admins e a Presidência podem
  designar o responsável da etapa. As opções mostradas no Telegram são **somente os membros ativos
  da diretoria responsável pela etapa atual** (vale também para admin), e o SQL recusa qualquer
  outro (`RESPONSAVEL_INVALIDO`).
- **Responsável designado pode agir**: quem está atribuído à etapa pode executar as transições
  dela (`lib/autorizacao.js` e `registrar_acao`, com tratamento de NULL quando a etapa não tem
  responsável).
- **Novo comando `/me`** (aliases `/perfil`, `eu`, `cadastro`): mostra nome completo, diretoria,
  cargo, se é admin, e-mail, telefone, canal de notificação e se está no rodízio. Registrado no
  menu do bot via `scripts/setup_telegram.js`.
- **Fluxograma visual** (`lib/fluxograma.js`): ao abrir um projeto (`/projeto` ou o botão do
  projeto) o bot envia primeiro uma imagem do fluxo e depois o texto com os botões. `/fluxograma P-...`
  envia só a imagem. A imagem é gerada em Graphviz e renderizada pelo container local `kroki`
  (`yuzutech/kroki:0.28.0`); nenhum dado sai da máquina. Flags: `FEATURE_FLUXOGRAMA` (padrão `true`),
  `FLUXO_MOSTRAR_REVERTIDAS`, `KROKI_URL`. O `carregar_dados` agora devolve também `etapas` (passagens
  com responsável).
- **Sync de membros com a planilha real da EJ** (WF-09 + `/sync`): lê a aba do ano atual, só as
  colunas Nome, E-mails, Telefone, Data de saída, Cargo e Diretoria (CPF/RG/endereço nunca são
  lidos), pela API do Google com service account somente-leitura (planilha continua privada).
  Egressos ficam inativos; Diretor(a)/Presidente viram admin. Proteções: prévia antes de aplicar,
  linha com erro não desativa ninguém, trava de desativação em massa, aviso aos admins sobre
  mudanças de admin. Passo a passo em [runbook.md](runbook.md#planilha-de-membros-sync-seguro).
- Repositório remoto: `origin` → https://github.com/armassaro/Fluxograma_Therion.git (branch `main`).

## Início rápido (desenvolvimento)

```bash
npm install
docker run -d --name therion-test-pg -e POSTGRES_PASSWORD=teste -e POSTGRES_USER=ej \
  -e POSTGRES_DB=ej_fluxo -p 127.0.0.1:55432:5432 postgres:16-alpine
# (se o container já existe: docker start therion-test-pg)
npm test                                  # unitários + integração (Postgres acima)
bash tests/e2e/rodar.sh                   # ponta a ponta num n8n real (docker)

export DATABASE_URL=postgres://ej:teste@127.0.0.1:55432/ej_fluxo
npm run migrar -- --seed                  # schema + funções + consultas + views (+ membros fictícios)
npm run fluxos                            # valida e carrega fluxos/*.yaml
npm run simular                           # simula um projeto do início ao fim via CLI
npm run build                             # gera n8n/workflows/*.json a partir de n8n/workflows-src/
```

## Estrutura

```
fluxos/        templates YAML + schema.json
lib/           regras de negócio (JS puro, testado; embutido nos nós Code pelo build)
sql/           schema.sql, registrar_acao.sql (gravação atômica), consultas.sql, views.sql, seed.sql
n8n/           workflows-src/definicoes.js (fonte) → workflows/*.json (gerados, não editar)
scripts/       migrar, carregar_fluxos, build_workflows, implantar_n8n, setup_telegram, simular
tests/         unit/, integracao/ (Postgres real), e2e/ (n8n real), fixtures/
```

Regra de ouro: **não edite workflows na interface do n8n.** Edite `lib/` ou
`n8n/workflows-src/definicoes.js`, rode `npm run build` e reimplante.
