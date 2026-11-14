'use strict';
/**
 * Definição dos workflows do n8n (Fase 2), em código.
 *
 * Os workflows são só o "casco" de E/S (webhook, Postgres, Telegram, e-mail, Drive, Sheets).
 * Toda regra de negócio vive em lib/*.js e sql/*.sql; os nós Code apenas chamam essas funções.
 * `npm run build` gera n8n/workflows/*.json embutindo em cada nó Code os módulos de lib/ que ele usa
 * (declarados em `libs`). NÃO edite os JSON gerados nem o código dentro do n8n: edite aqui e gere de novo.
 *
 * Dentro de um nó Code, os módulos ficam disponíveis via __req('./nome').
 */

const CRED_PG = { postgres: { id: 'therion-postgres', name: 'Therion Postgres' } };
const CRED_SMTP = { smtp: { id: 'therion-smtp', name: 'Therion SMTP' } };
const CRED_DRIVE = { googleApi: { id: 'therion-google', name: 'Therion Google (service account)' } };
const CRED_SHEETS = { googleApi: { id: 'therion-google', name: 'Therion Google (service account)' } };

const ID = {
  entradaTelegram: 'therion-wf-01a',
  identificacao: 'therion-wf-02',
  roteador: 'therion-wf-03',
  motor: 'therion-wf-04',
  envio: 'therion-wf-05',
  drive: 'therion-wf-06',
  syncMembros: 'therion-wf-09',
  erros: 'therion-wf-99',
};

// ------------------------------------------------------------------------- construtores de nós

const code = (name, libs, js, extra = {}) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, libs, parameters: { jsCode: js.trim(), ...(extra.porItem ? { mode: 'runOnceForEachItem' } : {}) }, ...(extra.node || {}) });

/** Chama uma função SQL jsonb->jsonb. `argExpr` é uma expressão JS (sem {{ }}) que produz o objeto de entrada. */
const sql = (name, fn, argExpr, extra = {}) => ({
  name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, credentials: CRED_PG,
  parameters: { operation: 'executeQuery', query: `SELECT ${fn}($1::jsonb) AS r`, options: { queryReplacement: `={{ [JSON.stringify(${argExpr})] }}` } },
  ...extra,
});

const gatilhoSub = (name = 'Início') => ({ name, type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, parameters: { inputSource: 'passthrough' } });

const chamar = (name, workflowId, extra = {}) => ({
  name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2,
  parameters: {
    source: 'database', workflowId: { __rl: true, mode: 'id', value: workflowId },
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    mode: 'once', options: { waitForSubWorkflow: true },
  },
  ...extra,
});

const seVerdadeiro = (name, expr) => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2.2,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: `cond-${name}`, leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    looseTypeValidation: true, options: {},
  },
});

/** Chamada à Bot API do Telegram. Nunca lança por resposta 4xx: o corpo ({ok:false,...}) segue adiante. */
const telegramHttp = (name, metodoExpr, corpoExpr, extra = {}) => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  parameters: {
    method: 'POST',
    url: `={{ ($env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\\/+$/, '') }}/bot{{ $env.TELEGRAM_BOT_TOKEN }}/{{ ${metodoExpr} }}`,
    sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${corpoExpr}) }}`,
    options: { response: { response: { neverError: true } }, timeout: 20000 },
  },
  ...extra,
});

// ---------------------------------------------------------------------------------- WF-01a
const wf01a = {
  id: ID.entradaTelegram, name: 'WF-01a Entrada Telegram', active: true,
  nodes: [
    {
      name: 'Webhook Telegram', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: 'therion-telegram',
      // Responde 200 na hora (o Telegram reenvia se demorar); o processamento segue em segundo plano.
      parameters: { httpMethod: 'POST', path: 'telegram', responseMode: 'onReceived', options: {} },
    },
    code('Normalizar', ['config', 'normalizadores', 'seguranca'], `
// Autenticidade: o Telegram envia o segredo combinado no setWebhook. Sem segredo configurado, nada passa.
const segredo = $env.TELEGRAM_WEBHOOK_SECRET;
const entrada = $input.first().json;
const recebido = (entrada.headers || {})['x-telegram-bot-api-secret-token'];
if (!__req('./seguranca').compararSegredo(recebido, segredo)) return [];
const cfg = __req('./config').lerConfig($env);
if (!cfg.canais.telegram) return [];
const cmd = __req('./normalizadores').normalizarTelegram(entrada.body);
return cmd ? [{ json: cmd }] : [];   // updates ignorados (grupos, edições, bots) param aqui
`),
    chamar('Roteador (WF-03)', ID.roteador, { onError: 'continueErrorOutput' }),
    code('Avisar erro', [], `
// O roteador falhou: avisa quem mandou a mensagem e o grupo de administradores (sem dados pessoais).
const cmd = $('Normalizar').first().json;
const erro = $input.first().json.error;
const detalhe = String((erro && (erro.message || erro.description)) || erro || 'erro desconhecido').slice(0, 300);
const mensagens = [{ canal: 'telegram', destino: cmd.chat_id, resposta_direta: true,
  texto: 'Ocorreu um erro interno e a equipe técnica foi avisada. Tente de novo em alguns minutos. (ref: ' + $execution.id + ')' }];
if ($env.TELEGRAM_CHAT_ADMINS) {
  mensagens.push({ canal: 'telegram', destino: String($env.TELEGRAM_CHAT_ADMINS), resposta_direta: true,
    texto: '🚨 Falha no roteador (execução ' + $execution.id + ')\\n' + detalhe });
}
return [{ json: { mensagens, callback: cmd.callback } }];
`),
    chamar('Enviar aviso (WF-05)', ID.envio),
  ],
  connections: [
    ['Webhook Telegram', 'Normalizar'],
    ['Normalizar', 'Roteador (WF-03)'],
    ['Roteador (WF-03)', 'Avisar erro', 1],
    ['Avisar erro', 'Enviar aviso (WF-05)'],
  ],
};

// ----------------------------------------------------------------------------------- WF-02
// Identificação (§17 WF-02): recebe o Comando Normalizado e devolve { r: { membro, sessao,
// ja_processada, rate_ok } } numa única consulta (ctx_entrada). Quem decide o que fazer com um
// remetente não identificado (permitir só /vincular e /codigo) é lib/app.js#preparar.
const wf02 = {
  id: ID.identificacao, name: 'WF-02 Identificação', active: true,
  nodes: [
    gatilhoSub(),
    sql('Identificar', 'ctx_entrada',
      `{ canal: $json.canal, id_externo: $json.id_externo_remetente, idempotency_key: $json.idempotency_key, rate_limit: Number($env.RATE_LIMIT_POR_MIN || 20) }`),
  ],
  connections: [['Início', 'Identificar']],
};

// ----------------------------------------------------------------------------------- WF-03
const wf03 = {
  id: ID.roteador, name: 'WF-03 Roteador de Comandos', active: true,
  nodes: [
    gatilhoSub(),   // entrada: Comando Normalizado (de qualquer canal)
    chamar('Contexto', ID.identificacao),   // WF-02: membro, sessão aberta, idempotência e rate limit
    code('Preparar', ['app'], `
const cmd = $('Início').first().json;
const ctx = $input.first().json.r;
return [{ json: __req('./app').preparar(cmd, ctx) }];
`),
    sql('Dados', 'carregar_dados', `{ membro_id: $json.membro_id, projeto_codigo: $json.projeto_codigo }`),
    code('Processar', ['app', 'config'], `
const pre = $('Preparar').first().json;
const dados = $input.first().json.r;
const cfg = __req('./config').lerConfig($env);
const saida = __req('./app').processar(pre, dados, cfg);
if (saida.silencioso) return [];   // update reentregue pelo Telegram: já foi processado, nada a fazer
return [{ json: { saida, temOperacao: !!saida.operacao } }];
`),
    seVerdadeiro('Tem operação?', '$json.temOperacao'),
    code('Pedido ao motor', [], `
return [{ json: { operacao: $('Processar').first().json.saida.operacao } }];
`),
    chamar('Motor (WF-04)', ID.motor),
    code('Concluir', ['app', 'config'], `
const pre = $('Preparar').first().json;
const saida = $('Processar').first().json.saida;
const resultado = $('Motor (WF-04)').isExecuted ? $('Motor (WF-04)').first().json.resultado : null;
const app = __req('./app');
const cfg = __req('./config').lerConfig($env);
const final = app.concluir(pre, saida, resultado, cfg);
return [{ json: {
  finalizar: {
    canal: pre.cmd.canal, id_externo: pre.cmd.id_externo_remetente, idempotency_key: pre.cmd.idempotency_key,
    resposta: final.resposta || {}, sessao: final.sessao, sessao_ttl_min: cfg.sessaoTtlMin,
  },
  mensagens: app.mensagensDeSaida(pre, final),
  callback: pre.cmd.callback,
  efeitos: final.efeitos,
} }];
`),
    sql('Finalizar', 'finalizar_requisicao', `$json.finalizar`),
    code('Mensagens', [], `
const c = $('Concluir').first().json;
return [{ json: { mensagens: c.mensagens, callback: c.callback } }];
`),
    chamar('Enviar (WF-05)', ID.envio),
    code('Efeitos do Drive', [], `
// Efeitos pós-gravação. Na Fase 2 só existe "criar_pasta_drive"; os demais (IA, envio ao cliente)
// são de fases futuras e ficam apenas registrados na execução.
// TODO(ENVIO_AUTOMATICO_CLIENTE): despachar aqui o efeito "enviar_documento_cliente" para o WF-13.
const efeitos = $('Concluir').first().json.efeitos || [];
return efeitos.filter((e) => e.tipo === 'criar_pasta_drive').map((e) => ({ json: { op: 'criar_pasta_projeto', ...e } }));
`),
    chamar('Drive (WF-06)', ID.drive, { onError: 'continueErrorOutput' }),
    code('Avisar falha do Drive', [], `
// O projeto JÁ foi criado; só a pasta falhou. Avisa o autor e os administradores.
const cmd = $('Preparar').first().json.cmd;
const ef = $('Efeitos do Drive').first().json;
const mensagens = [{ canal: cmd.canal, destino: cmd.chat_id, resposta_direta: true,
  texto: '⚠️ O projeto ' + ef.codigo + ' foi criado, mas não consegui criar a pasta no Drive. Um administrador foi avisado.' }];
if ($env.TELEGRAM_CHAT_ADMINS) {
  mensagens.push({ canal: 'telegram', destino: String($env.TELEGRAM_CHAT_ADMINS), resposta_direta: true,
    texto: '🚨 Falha ao criar a pasta do projeto ' + ef.codigo + ' no Drive (execução ' + $execution.id + ').' });
}
return [{ json: { mensagens, callback: null } }];
`),
    chamar('Enviar aviso (WF-05)', ID.envio),
  ],
  connections: [
    ['Início', 'Contexto'], ['Contexto', 'Preparar'], ['Preparar', 'Dados'], ['Dados', 'Processar'],
    ['Processar', 'Tem operação?'],
    ['Tem operação?', 'Pedido ao motor', 0], ['Pedido ao motor', 'Motor (WF-04)'], ['Motor (WF-04)', 'Concluir'],
    ['Tem operação?', 'Concluir', 1],
    ['Concluir', 'Finalizar'], ['Finalizar', 'Mensagens'], ['Mensagens', 'Enviar (WF-05)'],
    // Em paralelo ao envio: se não houvesse mensagens, o WF-05 não devolveria itens e a cadeia pararia.
    ['Mensagens', 'Efeitos do Drive'], ['Efeitos do Drive', 'Drive (WF-06)'],
    ['Drive (WF-06)', 'Avisar falha do Drive', 1], ['Avisar falha do Drive', 'Enviar aviso (WF-05)'],
  ],
};

// ----------------------------------------------------------------------------------- WF-04
const wf04 = {
  id: ID.motor, name: 'WF-04 Motor de Fluxo', active: true,
  nodes: [
    gatilhoSub(),   // entrada: { operacao: { fn, payload, uploads? } }
    code('Arquivos a subir', ['config'], `
// Arquivos recebidos pelo Telegram precisam ir para o Drive ANTES da gravação (a ação guarda o id do Drive).
// Se o upload falhar, o workflow para aqui e a ação NÃO é registrada.
const operacao = $input.first().json.operacao;
const cfg = __req('./config').lerConfig($env);
const arquivos = (operacao.payload && operacao.payload.arquivos) || [];
const pendentes = arquivos.filter((a) => a.origem === 'telegram' && !a.drive_file_id);
return [{ json: { operacao, precisaUpload: cfg.features.drive && pendentes.length > 0,
  pedido: { op: 'subir_arquivos', arquivos, uploads: operacao.uploads || {} } } }];
`),
    seVerdadeiro('Precisa de upload?', '$json.precisaUpload'),
    code('Pedido ao Drive', [], `return [{ json: $input.first().json.pedido }];`),
    chamar('Drive (WF-06)', ID.drive),
    code('Operação final', [], `
const { operacao } = $('Arquivos a subir').first().json;
const payload = { ...operacao.payload };
if ($('Drive (WF-06)').isExecuted) payload.arquivos = $('Drive (WF-06)').first().json.arquivos;
return [{ json: { chamada: { fn: operacao.fn, payload } } }];
`),
    // Gravação atômica: uma única chamada SQL (ver sql/registrar_acao.sql).
    sql('Gravar', 'executar_operacao', `$json.chamada`),
    code('Resultado', [], `return [{ json: { resultado: $input.first().json.r } }];`),
  ],
  connections: [
    ['Início', 'Arquivos a subir'], ['Arquivos a subir', 'Precisa de upload?'],
    ['Precisa de upload?', 'Pedido ao Drive', 0], ['Pedido ao Drive', 'Drive (WF-06)'], ['Drive (WF-06)', 'Operação final'],
    ['Precisa de upload?', 'Operação final', 1],
    ['Operação final', 'Gravar'], ['Gravar', 'Resultado'],
  ],
};

// ----------------------------------------------------------------------------------- WF-05
const wf05 = {
  id: ID.envio, name: 'WF-05 Notificações e Respostas', active: true,
  nodes: [
    gatilhoSub(),   // entrada: { mensagens: [{canal, destino, texto, botoes?, assunto?, membro_id?}], callback? }
    code('Montar envios', ['render', 'config'], `
const { mensagens, callback } = $input.first().json;
const cfg = __req('./config').lerConfig($env);
const envios = __req('./render').montarEnvios(mensagens || [], callback || null)
  // respeita as chaves gerais de notificação; respostas diretas no Telegram e e-mails essenciais
  // (código de vínculo) sempre saem
  .filter((e) => (e.canal === 'email' ? cfg.notificacoes.email || e.essencial : true));
return envios.map((e) => ({ json: e }));
`),
    seVerdadeiro('É Telegram?', "$json.canal === 'telegram'"),
    telegramHttp('Telegram', '$json.telegram.metodo', '$json.telegram.corpo', { onError: 'continueRegularOutput' }),
    {
      name: 'E-mail', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, credentials: CRED_SMTP, onError: 'continueRegularOutput',
      parameters: {
        fromEmail: "={{ $env.EMAIL_REMETENTE || 'Therion Bot <fluxo@example.com>' }}",
        toEmail: '={{ $json.email.para }}', subject: '={{ $json.email.assunto }}',
        emailFormat: 'text', text: '={{ $json.email.texto }}', options: { appendAttribution: false },
      },
    },
    code('Resultado Telegram', [], `
const envio = $('Montar envios').item.json;
const r = $json || {};
const ok = r.ok === true;
return { json: { registrar: !!envio.registrar, membro_id: envio.membro_id, canal: 'telegram',
  payload: envio.telegram, ok, erro: ok ? null : String(r.description || (r.error && (r.error.message || r.error)) || 'falha no envio') } };
`, { porItem: true }),
    code('Resultado E-mail', [], `
const envio = $('Montar envios').item.json;
const r = $json || {};
const ok = !r.error;
return { json: { registrar: !!envio.registrar, membro_id: envio.membro_id, canal: 'email',
  payload: { para: envio.email.para, assunto: envio.email.assunto, texto: envio.email.texto },
  ok, erro: ok ? null : String((r.error && (r.error.message || r.error)) || 'falha no envio') } };
`, { porItem: true }),
    sql('Registrar envio', 'registrar_envio', `$json`),
  ],
  connections: [
    ['Início', 'Montar envios'], ['Montar envios', 'É Telegram?'],
    ['É Telegram?', 'Telegram', 0], ['É Telegram?', 'E-mail', 1],
    ['Telegram', 'Resultado Telegram'], ['E-mail', 'Resultado E-mail'],
    ['Resultado Telegram', 'Registrar envio'], ['Resultado E-mail', 'Registrar envio'],
  ],
};

// ----------------------------------------------------------------------------------- WF-06
const pastaDrive = (name, nomeExpr, paiExpr) => ({
  name, type: 'n8n-nodes-base.googleDrive', typeVersion: 3, credentials: CRED_DRIVE,
  parameters: {
    authentication: 'serviceAccount', resource: 'folder', operation: 'create', name: `={{ ${nomeExpr} }}`,
    driveId: { __rl: true, mode: 'list', value: 'My Drive' },
    folderId: { __rl: true, mode: 'id', value: `={{ ${paiExpr} }}` },
    options: {},
  },
});

const wf06 = {
  id: ID.drive, name: 'WF-06 Drive', active: true,
  nodes: [
    gatilhoSub(),   // entrada: { op: 'criar_pasta_projeto', projeto_id, codigo, nome, subpastas[] } | { op: 'subir_arquivos', arquivos[], uploads{pasta_id, prefixo} }
    seVerdadeiro('Criar pasta?', "$json.op === 'criar_pasta_projeto'"),

    // --- criar_pasta_projeto: <DRIVE_RAIZ_ID>/<codigo> - <nome>/<subpastas do template>
    pastaDrive('Pasta do projeto', "$json.codigo + ' - ' + $json.nome", '$env.DRIVE_RAIZ_ID'),
    code('Subpastas', [], `
const pedido = $('Início').first().json;
const raiz = $input.first().json;
return (pedido.subpastas || []).slice().sort().map((nome) => ({ json: { nome, pai: raiz.id } }));
`),
    pastaDrive('Criar subpasta', '$json.nome', '$json.pai'),
    code('Pastas criadas', [], `
const pedido = $('Início').first().json;
const raiz = $('Pasta do projeto').first().json;
const nomes = $('Subpastas').all().map((i) => i.json.nome);
const pastas = {};
$input.all().forEach((item, i) => { pastas[item.json.name || nomes[i]] = item.json.id; });
return [{ json: { projeto_id: pedido.projeto_id, drive_pasta_id: raiz.id,
  link: 'https://drive.google.com/drive/folders/' + raiz.id, pastas } }];
`),
    sql('Gravar pastas', 'definir_pastas_projeto', `$json`),

    // --- subir_arquivos: Telegram -> Drive
    code('Arquivos do Telegram', [], `
const { arquivos, uploads } = $input.first().json;
return (arquivos || []).map((a, indice) => ({ json: { ...a, indice, pasta_id: uploads.pasta_id || $env.DRIVE_RAIZ_ID, nome_final: (uploads.prefixo || '') + a.nome } }))
  .filter((i) => i.json.origem === 'telegram' && !i.json.drive_file_id);
`),
    telegramHttp('getFile', "'getFile'", '{ file_id: $json.file_id }'),
    {
      name: 'Baixar', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      parameters: {
        method: 'GET',
        url: "={{ ($env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\\/+$/, '') }}/file/bot{{ $env.TELEGRAM_BOT_TOKEN }}/{{ $json.result.file_path }}",
        options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } }, timeout: 60000 },
      },
    },
    {
      name: 'Enviar ao Drive', type: 'n8n-nodes-base.googleDrive', typeVersion: 3, credentials: CRED_DRIVE,
      parameters: {
        authentication: 'serviceAccount', resource: 'file', operation: 'upload', inputDataFieldName: 'data',
        name: "={{ $('Arquivos do Telegram').item.json.nome_final }}",
        driveId: { __rl: true, mode: 'list', value: 'My Drive' },
        folderId: { __rl: true, mode: 'id', value: "={{ $('Arquivos do Telegram').item.json.pasta_id }}" },
        options: {},
      },
    },
    code('Arquivos no Drive', [], `
// Devolve a lista COMPLETA de arquivos da ação, agora com a referência do Drive.
const original = $('Início').first().json.arquivos || [];
const enviados = $('Arquivos do Telegram').all().map((i) => i.json);
const noDrive = $input.all().map((i) => i.json);
const arquivos = original.map((a) => ({ ...a }));
enviados.forEach((e, k) => {
  const d = noDrive[k] || {};
  if (!d.id) throw new Error('Upload ao Drive não retornou id para ' + e.nome);
  arquivos[e.indice] = { campo: e.campo, nome: e.nome_final, mime: e.mime, tamanho: e.tamanho,
    drive_file_id: d.id, url: d.webViewLink || ('https://drive.google.com/file/d/' + d.id + '/view') };
});
return [{ json: { arquivos } }];
`),
  ],
  connections: [
    ['Início', 'Criar pasta?'],
    ['Criar pasta?', 'Pasta do projeto', 0], ['Pasta do projeto', 'Subpastas'], ['Subpastas', 'Criar subpasta'],
    ['Criar subpasta', 'Pastas criadas'], ['Pastas criadas', 'Gravar pastas'],
    ['Criar pasta?', 'Arquivos do Telegram', 1], ['Arquivos do Telegram', 'getFile'], ['getFile', 'Baixar'],
    ['Baixar', 'Enviar ao Drive'], ['Enviar ao Drive', 'Arquivos no Drive'],
  ],
};

// ----------------------------------------------------------------------------------- WF-09
const wf09 = {
  id: ID.syncMembros, name: 'WF-09 Sync de Membros', active: true,
  nodes: [
    { name: 'A cada 15 minutos', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
    {
      name: 'Ler planilha', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, credentials: CRED_SHEETS, alwaysOutputData: true,
      parameters: {
        authentication: 'serviceAccount', resource: 'sheet', operation: 'read',
        documentId: { __rl: true, mode: 'id', value: '={{ $env.SHEETS_MEMBROS_ID }}' },
        sheetName: { __rl: true, mode: 'name', value: "={{ $env.SHEETS_MEMBROS_ABA || 'Membros' }}" },
        options: {},
      },
    },
    code('Validar linhas', ['membros'], `
const linhas = $input.all().map((i) => i.json);
const { validas, erros } = __req('./membros').validarLinhas(linhas);
return [{ json: { linhas: validas, erros } }];
`),
    // Planilha vazia/ilegível => sync_membros devolve PLANILHA_VAZIA e não desativa ninguém.
    sql('Aplicar sync', 'sync_membros', `{ linhas: $json.linhas }`),
    code('Relatório', ['notificacoes', 'config', 'mensagens'], `
const r = $input.first().json.r;
const errosPlanilha = $('Validar linhas').first().json.erros || [];
const cfg = __req('./config').lerConfig($env);
const { resolverCanal, montarNotificacoes } = __req('./notificacoes');
const mensagens = [];
if (r.ok) {
  for (const n of r.novos || []) {
    mensagens.push({ canal: 'email', destino: n.email, assunto: 'Bem-vindo(a) ao Therion Fluxo',
      texto: 'Olá, ' + n.nome + '!\\n\\nVocê foi cadastrado(a) no sistema de fluxo de projetos da EJ.\\n'
        + 'Para usar pelo Telegram, abra o bot e envie:  /vincular ' + n.email + '\\n' });
  }
  // quem recebeu etapas por reatribuição automática
  for (const x of r.reatribuicoes || []) if (x.ok) mensagens.push(...montarNotificacoes(x, { rotulo: 'Trocar responsável' }, cfg));
}
const linhas = [];
if (!r.ok) linhas.push('Sync NÃO aplicado: ' + r.codigo + ' (a planilha está vazia ou ilegível?)');
for (const e of errosPlanilha) linhas.push('Linha ' + e.linha + ' (' + (e.email || 'sem e-mail') + '): ' + e.erro);
for (const e of (r.erros || [])) linhas.push((e.email || '?') + ': ' + e.erro);
for (const d of (r.desativados || [])) linhas.push('Desativado: ' + d.nome);
if (linhas.length) {
  const texto = '👥 Sync de membros\\n' + linhas.join('\\n');
  for (const a of (r.admins || [])) {
    const canal = resolverCanal(a, cfg);
    if (canal) mensagens.push({ membro_id: a.membro_id, canal, destino: canal === 'telegram' ? String(a.telegram_user_id) : a.email, assunto: 'Sync de membros', texto });
  }
  if (!r.ok && $env.TELEGRAM_CHAT_ADMINS) mensagens.push({ canal: 'telegram', destino: String($env.TELEGRAM_CHAT_ADMINS), resposta_direta: true, texto });
}
return mensagens.length ? [{ json: { mensagens, callback: null } }] : [];
`),
    chamar('Enviar (WF-05)', ID.envio),
  ],
  connections: [
    ['A cada 15 minutos', 'Ler planilha'], ['Ler planilha', 'Validar linhas'], ['Validar linhas', 'Aplicar sync'],
    ['Aplicar sync', 'Relatório'], ['Relatório', 'Enviar (WF-05)'],
  ],
};

// ----------------------------------------------------------------------------------- WF-99
const wf99 = {
  id: ID.erros, name: 'WF-99 Tratamento de Erros', active: true, semErrorWorkflow: true,
  nodes: [
    { name: 'Erro em workflow', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {} },
    code('Formatar alerta', [], `
// Sem dados pessoais: só workflow, nó, mensagem e id da execução.
if (!$env.TELEGRAM_CHAT_ADMINS) return [];
const e = $input.first().json;
const ex = e.execution || {};
const texto = '🚨 Erro no n8n\\nWorkflow: ' + ((e.workflow && e.workflow.name) || '?')
  + '\\nNó: ' + (ex.lastNodeExecuted || '?')
  + '\\nErro: ' + String((ex.error && ex.error.message) || (e.trigger && e.trigger.error && e.trigger.error.message) || '?').slice(0, 500)
  + '\\nExecução: ' + (ex.id || '?');
return [{ json: { corpo: { chat_id: String($env.TELEGRAM_CHAT_ADMINS), text: texto } } }];
`),
    telegramHttp('Avisar administradores', "'sendMessage'", '$json.corpo'),
  ],
  connections: [['Erro em workflow', 'Formatar alerta'], ['Formatar alerta', 'Avisar administradores']],
};

module.exports = { workflows: [wf01a, wf02, wf03, wf04, wf05, wf06, wf09, wf99], ID };
