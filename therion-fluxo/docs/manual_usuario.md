# Manual do usuário — bot Therion

Converse com o bot **em conversa privada** no Telegram (em grupos ele não responde).

## 1. Vincular sua conta (uma vez)

1. Seu e-mail precisa estar na planilha de membros (fale com a diretoria).
2. Envie `/vincular seu.email@dominio`.
3. Chega um código de 6 dígitos no e-mail. Envie `/codigo 123456`.

## 2. Comandos

| Comando | O que faz |
|---|---|
| `/me` (ou `/perfil`) | mostra seus dados cadastrados: nome completo, diretoria, cargo, se é admin, e-mail, telefone, canal de notificação e se está no rodízio |
| `/meus` | projetos esperando você ou sua diretoria |
| `/projetos [filtro]` | todos os projetos em andamento |
| `/projeto P-2026-0042` | envia a **imagem do fluxograma** do projeto e, em seguida, os detalhes com os botões das ações que você pode fazer |
| `/fluxograma P-2026-0042` | só a imagem do fluxograma: etapas já percorridas (verde), etapa atual (amarelo, com responsável e prazo), etapas futuras (cinza), responsável e datas de cada etapa, caminho percorrido com autor e data, ações revertidas (vermelho) e tabela das últimas ações |
| `/novo` | registra um projeto novo (Comercial) — o bot pergunta campo a campo e o projeto **já segue para a diretoria de Projetos** (com responsável pelo rodízio) |
| `/acao P-2026-0042 <ação> campo=valor ...` | executa uma ação direto |
| `/historico P-2026-0042` | linha do tempo |
| `/comentar P-2026-0042 texto` | registra um comentário (pode anexar arquivo) |
| `/pausar`, `/retomar`, `/abandonar` `P-...` | pausa/retoma/abandona (pausar e abandonar pedem motivo) |
| `/reverter P-...` | desfaz a última ação (até 48 h; só quem fez, o diretor ou admin) |
| `/reatribuir P-...` | troca o responsável da etapa (diretoria responsável ou admin). A lista de opções mostra apenas os membros ativos da diretoria responsável pela etapa atual do projeto (vale também para admin); o designado é notificado |
| `/canal telegram` ou `/canal email` | onde receber notificações |
| `/ausente` / `/disponivel` | sai/volta do rodízio de responsáveis |
| `/sync` (admin) | lê a planilha de membros e mostra uma **prévia** (novos, desativados, mudanças de admin, linhas com problema); nada muda até tocar em **Aplicar**. `/sync forcar` libera a trava quando muitos membros seriam desativados |
| `/cancelar` | cancela o diálogo em andamento |

Não precisa da barra nem de acento: `projeto p-2026-0042` funciona.

## 3. Dicas

- Valores: `3.200,00` ou `3200`. Datas: `dd/mm/aaaa`.
- Para anexar arquivo, envie o documento quando o bot pedir (máx. 20 MB). Ele vai para a pasta
  certa do projeto no Drive.
- Campo opcional? Responda `pular`.
- Se aparecer "você não tem permissão", a mensagem diz **quem pode** agir naquela etapa.
- "O projeto foi alterado por outra pessoa": alguém agiu ao mesmo tempo; confira com `/projeto`.
