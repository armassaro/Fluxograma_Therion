# Arquitetura

```
Telegram ──webhook──▶ WF-01a Entrada ──▶ WF-03 Roteador ──▶ WF-02 Identificação (ctx_entrada)
                                            │                     membro, sessão, idempotência, rate limit
                                            ├─▶ lib/app.js#preparar / processar  (decide o que fazer)
                                            ├─▶ WF-04 Motor ──▶ WF-06 Drive (upload antes de gravar)
                                            │                └─▶ SQL executar_operacao → registrar_acao / criar_projeto
                                            ├─▶ finalizar_requisicao (resposta + sessão + idempotência)
                                            ├─▶ WF-05 Envio (Telegram / e-mail, outbox em `notificacoes`)
                                            └─▶ WF-06 Drive (efeitos pós-commit: pasta do projeto)
Cron ─▶ WF-09 Sync de membros (Google Sheets → sync_membros → reatribuições)
Qualquer erro ─▶ WF-99 (alerta sem dados pessoais no grupo de admins)
```

## Princípios

- **n8n é só E/S.** Regras ficam em `lib/*.js` (puras, testadas) e em funções PL/pgSQL. O build
  (`scripts/build_workflows.js`) embute os módulos de `lib/` nos nós Code; dentro do nó use
  `__req('./modulo')`. Built-ins do Node (só `crypto`) passam pelo `require` do n8n
  (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`).
- **Uma transação por ação.** `registrar_acao(jsonb)` trava o projeto (`FOR UPDATE`), confere
  `versao` (concorrência otimista), revalida transição/permissão, grava `acoes` (append-only, trigger
  impede UPDATE/DELETE exceto `revertida_por_id`), troca de etapa, rodízio e projeção.
- **Event sourcing leve.** `acoes` é a fonte da verdade; `projetos` é projeção.
  `lib/projecao.js#projetarEstado` refaz o estado a partir das ações não revertidas e os testes
  comparam com a tabela.
- **Idempotência.** `idempotency_key` derivada do id nativo do provedor
  (`telegram:update:<update_id>`), checada em `requisicoes_processadas` e garantida por
  `acoes.idempotency_key UNIQUE`.
- **Efeitos depois do commit.** Falha no Drive/notificação não desfaz a ação; é alertada no WF-99.

## Workflows (fases 1–2)

| ID | Nome | Papel |
|---|---|---|
| therion-wf-01a | Entrada Telegram | webhook, segredo (tempo constante, `lib/seguranca.js`), normalização |
| therion-wf-02 | Identificação | `ctx_entrada`: membro pelo canal, sessão aberta, já processada?, rate limit |
| therion-wf-03 | Roteador | parse, consultas, diálogo de campos, chama motor/envio/drive |
| therion-wf-04 | Motor | upload de arquivos → `executar_operacao` |
| therion-wf-05 | Notificações | render por canal, envio, registro em `notificacoes` |
| therion-wf-06 | Drive | pasta do projeto + subpastas, upload de arquivos do Telegram |
| therion-wf-09 | Sync de membros | planilha → `sync_membros` → relatório e reatribuições |
| therion-wf-99 | Erros | alerta para `TELEGRAM_CHAT_ADMINS` |

## Módulos de `lib/`

| Módulo | Responsabilidade |
|---|---|
| config | `$env` → objeto tipado (flags, regras, SLA) |
| normalizadores | payload do canal → Comando Normalizado |
| seguranca | `compararSegredo`, `verificarHmac`, `verificarMeta`, `rateLimit` |
| comandos | parser tolerante (com/sem barra, acentos, aspas, código no meio) |
| templates / jsonschema | consulta e validação de fluxos (grafo + `fluxos/schema.json`) |
| autorizacao | §8.1 — `podeExecutar` com "quem pode" na recusa; o responsável designado da etapa (mesmo de outra diretoria, quando um admin o designou via `reatribuir`) pode executar as transições dela |
| validacao | tipos de campo, dinheiro/datas pt-BR, arquivos |
| guardas | mini-DSL sem `eval` (`soma(...) >= projeto.valor_contratado`) |
| motor | plano da ação enviado ao SQL |
| projecao | replay de eventos |
| rodizio | round robin alfabético pulando indisponíveis |
| sla | prazo com pausas, etapas vencidas, janela de notificação (usado pelo WF-10 na fase 3) |
| codigo_projeto | `P-AAAA-NNNN` |
| app | orquestra o roteador (diálogo, sessões, respostas) |
| render / notificacoes / mensagens / texto / membros | saída por canal e textos pt-BR |

## SQL

- `schema.sql` — DDL (§5). `registrar_acao.sql` — funções transacionais usadas pelos workflows.
- `consultas.sql` — `meus_pendentes`, `listar_projetos`, `detalhes_projeto`, `historico`,
  `etapas_vencidas` (relatórios, psql, WF-10).
- `views.sql` — `vw_pipeline`, `vw_tempo_medio_etapa`, `vw_conversao` (dashboard).
- `seed.sql` — só dev/homologação.
