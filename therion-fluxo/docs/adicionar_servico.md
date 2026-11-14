# Como adicionar um novo tipo de serviço

1. Copie `fluxos/website.yaml` para `fluxos/<tipo_servico>.yaml` (o nome do arquivo deve ser igual a
   `tipo_servico`, em `snake_case`).
2. Edite `etapas` e `transicoes`. Formato (validado por `fluxos/schema.json` + regras de grafo):

```yaml
tipo_servico: video_institucional
nome_exibicao: "Vídeo institucional"
versao: 1
etapa_inicial: registro_lead
etapas:
  registro_lead: { nome: "Registro do lead", diretoria: comercial, sla_horas: 24, pasta: 01_comercial }
  roteiro:       { nome: "Roteiro", diretoria: projetos, sla_horas: 72, pasta: 02_escopo, rodizio: true }
  concluido:     { nome: "Concluído",  diretoria: administrativo, terminal: true, status_projeto: concluido }
  abandonado:    { nome: "Abandonado", diretoria: comercial, terminal: true, status_projeto: abandonado }
transicoes:
  - acao: enviar_roteiro
    de: registro_lead            # ou lista: [a, b]
    para: roteiro
    rotulo: "Enviar para Projetos"
    campos:
      - { nome: briefing, rotulo: "Briefing", tipo: text, obrigatorio: true }
      - { nome: duracao_min, tipo: number, obrigatorio: false, min: 1 }
      - { nome: referencia, tipo: arquivo, obrigatorio: false }
    efeitos: []
  - acao: concluir
    de: roteiro
    para: concluido
    rotulo: "Concluir"
```

Regras:
- `diretoria`: comercial | projetos | financeiro | administrativo.
- Tipos de campo: `text`, `number`, `money`, `date`, `enum` (com `opcoes`), `arquivo`, `membro`.
- Precisa existir a etapa terminal `abandonado` (usada pela ação global `abandonar`).
- Toda etapa deve ser alcançável a partir da inicial; terminais não têm saída.
- `guarda` opcional: `soma(<acao>.<campo>) >= projeto.<campo>` (sem código arbitrário).
- `acao_na_criacao` opcional (ex.: `enviar_para_escopo`): transição a partir da etapa inicial que é
  executada junto com o `/novo`, na mesma transação. Os campos dela são perguntados no `/novo` e o
  projeto já nasce na etapa seguinte. Sem guarda e sem campos `membro`. É reversível como qualquer ação.
- Ações globais (`pausar`, `retomar`, `abandonar`, `reverter`, `comentar`, `reatribuir`) não vão no YAML.

3. Valide e carregue:

```bash
npm run fluxos -- --validar      # só valida
npm test                         # os testes carregam todos os YAML
node --env-file=.env scripts/carregar_fluxos.js
```

**Alterou um fluxo existente?** Aumente `versao`. Projetos já criados continuam na versão antiga;
os novos usam a nova.
