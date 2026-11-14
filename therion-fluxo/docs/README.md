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
