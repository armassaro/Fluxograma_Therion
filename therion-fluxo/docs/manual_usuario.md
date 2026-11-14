# Manual do usuário — bot Therion

Converse com o bot **em conversa privada** no Telegram (em grupos ele não responde).

## 1. Vincular sua conta (uma vez)

1. Seu e-mail precisa estar na planilha de membros (fale com a diretoria).
2. Envie `/vincular seu.email@dominio`.
3. Chega um código de 6 dígitos no e-mail. Envie `/codigo 123456`.

## 2. Comandos

| Comando | O que faz |
|---|---|
| `/meus` | projetos esperando você ou sua diretoria |
| `/projetos [filtro]` | todos os projetos em andamento |
| `/projeto P-2026-0042` | detalhes e botões com as ações que você pode fazer |
| `/novo` | registra um projeto novo (Comercial) — o bot pergunta campo a campo e o projeto **já segue para a diretoria de Projetos** (com responsável pelo rodízio) |
| `/acao P-2026-0042 <ação> campo=valor ...` | executa uma ação direto |
| `/historico P-2026-0042` | linha do tempo |
| `/comentar P-2026-0042 texto` | registra um comentário (pode anexar arquivo) |
| `/pausar`, `/retomar`, `/abandonar` `P-...` | pausa/retoma/abandona (pausar e abandonar pedem motivo) |
| `/reverter P-...` | desfaz a última ação (até 48 h; só quem fez, o diretor ou admin) |
| `/reatribuir P-...` | troca o responsável da etapa (diretoria responsável ou admin). A diretoria só escolhe entre os próprios membros; **admin/Presidência podem designar qualquer membro ativo**, inclusive de outra diretoria — o designado é notificado e passa a poder executar as ações daquela etapa |
| `/canal telegram` ou `/canal email` | onde receber notificações |
| `/ausente` / `/disponivel` | sai/volta do rodízio de responsáveis |
| `/cancelar` | cancela o diálogo em andamento |

Não precisa da barra nem de acento: `projeto p-2026-0042` funciona.

## 3. Dicas

- Valores: `3.200,00` ou `3200`. Datas: `dd/mm/aaaa`.
- Para anexar arquivo, envie o documento quando o bot pedir (máx. 20 MB). Ele vai para a pasta
  certa do projeto no Drive.
- Campo opcional? Responda `pular`.
- Se aparecer "você não tem permissão", a mensagem diz **quem pode** agir naquela etapa.
- "O projeto foi alterado por outra pessoa": alguém agiu ao mesmo tempo; confira com `/projeto`.
