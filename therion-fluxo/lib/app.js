'use strict';
/**
 * Aplicação — roteador de comandos e diálogos (§11, §17 WF-03/WF-04). Tudo puro.
 *
 * O "casco" (n8n ou scripts/pipeline.js) só faz E/S, sempre nesta ordem:
 *
 *   cmd      = normalizar*(payload do canal)
 *   ctx      = SQL ctx_entrada(...)
 *   pre      = preparar(cmd, ctx)                      -> diz qual projeto carregar
 *   dados    = SQL carregar_dados(...)
 *   saida    = processar(pre, dados, cfg)              -> resposta OU operação a gravar
 *   res      = SQL executar_operacao(saida.operacao)   (só se houver operação)
 *   final    = concluir(pre, saida, res, cfg)          -> resposta + notificações + efeitos
 *   SQL finalizar_requisicao(...) e envio das mensagens
 *
 * Sessão de diálogo (tabela sessoes_chat):
 *   { fluxo:'novo'|'acao', projeto_codigo, tipo_acao, campos:{}, arquivos:[], pulados:[],
 *     direto:boolean, aguardando:'campo:<nome>'|'confirmacao' }
 */
const { parseComando } = require('./comandos');
const { definicaoAcao } = require('./templates');
const { planejarAcao, acoesPermitidas, candidatosMembro } = require('./motor');
const { converterValor, validarArquivo, ehPular } = require('./validacao');
const { ehSuper } = require('./autorizacao');
const { montarNotificacoes } = require('./notificacoes');
const { normalizar, nomeDiretoria, fmtMoeda } = require('./texto');
const M = require('./mensagens');
const { pedidoImagem } = require('./fluxograma');
const { resp } = M;

const CANAIS_PREFERIDOS = ['telegram', 'email'];
const BOTAO_CANCELAR = { rotulo: '✖️ Cancelar', dados: 'cancelar' };

// ------------------------------------------------------------------------------- entrada

/** Converte clique de botão ou texto em {comando, args, comBarra, texto}. */
function interpretarEntrada(cmd) {
  const cb = cmd.callback && cmd.callback.dados;
  if (cb) {
    const base = { comBarra: true, texto: '', args: { campos: {}, resto: '' } };
    if (cb === 'ok') return { ...base, comando: 'confirmar' };
    if (cb === 'cancelar') return { ...base, comando: 'cancelar' };
    if (cb === 'pular') return { ...base, comando: null, texto: 'pular' };
    if (cb === 'digitar') return { ...base, comando: null, digitar: true };
    if (cb.startsWith('sug:')) return { ...base, comando: null, sugestao: Number(cb.slice(4)) };
    if (cb.startsWith('val:')) return { ...base, comando: null, texto: cb.slice(4) };
    const [k, a, b] = cb.split(':');
    if (k === 'proj') return { ...base, comando: 'projeto', args: { ...base.args, projeto_codigo: a } };
    if (k === 'flux') return { ...base, comando: 'fluxograma', args: { ...base.args, projeto_codigo: a } };
    if (k === 'hist') return { ...base, comando: 'historico', args: { ...base.args, projeto_codigo: a } };
    if (k === 'acao') return { ...base, comando: 'acao', args: { ...base.args, projeto_codigo: a, tipo_acao: b } };
    if (k === 'sync') return { ...base, comando: 'sync', args: { ...base.args, resto: a } };
    if (k === 'cmd') return { ...base, comando: a };
    return { ...base, comando: null };
  }
  return parseComando(cmd.texto || '');
}

/**
 * Passo 1: interpreta a entrada e diz o que carregar do banco.
 * @param {object} cmd  Comando Normalizado
 * @param {object} ctx  retorno de ctx_entrada
 */
function preparar(cmd, ctx) {
  const sessao = ctx.sessao || null;
  let entrada = interpretarEntrada(cmd);
  // Durante um diálogo, só "/comando" (ou botão) interrompe; texto solto é resposta à pergunta.
  // Sem isso, uma descrição começando com "Projeto ..." seria lida como o comando /projeto.
  if (sessao && entrada.comando && !entrada.comBarra) {
    const aguardaCampo = String(sessao.aguardando || '').startsWith('campo:');
    const cancelou = normalizar(cmd.texto) === 'cancelar';
    if (aguardaCampo && !cancelou) {
      entrada = { comando: null, comBarra: false, texto: cmd.texto, args: { campos: {}, resto: cmd.texto } };
    }
  }
  const continuaSessao = sessao && (entrada.comando === null || entrada.comando === 'confirmar');
  return {
    cmd, ctx, entrada,
    membro_id: ctx.membro ? ctx.membro.id : null,
    projeto_codigo: entrada.args.projeto_codigo || (continuaSessao ? sessao.projeto_codigo : null) || null,
  };
}

// ------------------------------------------------------------------------------- diálogo

/**
 * Campos do /novo. Depois que o tipo é escolhido, se o template tem `acao_na_criacao`, os campos
 * dessa ação (ex.: descrição da demanda, prazo, arquivo do cliente) são perguntados também e a
 * "descrição inicial" genérica deixa de ser perguntada (a da ação a substitui).
 */
function camposNovo(tipos, tipoEscolhido) {
  const rotulos = Object.fromEntries((tipos || []).map((t) => [t.tipo_servico, t.nome_exibicao]));
  const tipo = (tipos || []).find((t) => t.tipo_servico === tipoEscolhido);
  const extras = tipo && tipo.acao_na_criacao ? (tipo.campos_criacao || []).filter((c) => !c.sistema) : null;
  const base = [
    { nome: 'tipo', rotulo: 'Tipo de serviço', tipo: 'enum', obrigatorio: true, opcoes: Object.keys(rotulos), rotulos },
    { nome: 'nome_projeto', rotulo: 'Nome do projeto', tipo: 'text', obrigatorio: true },
    { nome: 'cliente_nome', rotulo: 'Nome do cliente', tipo: 'text', obrigatorio: true },
    { nome: 'cliente_contato', rotulo: 'Contato do cliente (e-mail ou telefone)', tipo: 'text', obrigatorio: true },
    { nome: 'nome_lead', rotulo: 'Nome do lead (quem fez o contato)', tipo: 'text', obrigatorio: false },
  ];
  if (!extras) return [...base, { nome: 'descricao', rotulo: 'Descrição inicial da demanda', tipo: 'text', obrigatorio: false }];
  return [...base, ...extras.map((c) => ({ ...c, _criacao: true }))];
}

/** Campos perguntados no diálogo (os do template + "observacoes"); null se a ação não existe mais. */
function camposDialogo(sessao, dados, membro) {
  if (sessao.fluxo === 'novo') return camposNovo(dados.tipos_servico, sessao.campos.tipo);
  if (!dados.projeto) return null;
  const def = definicaoAcao(dados.template, dados.projeto.etapa.chave, sessao.tipo_acao);
  if (!def) return null;
  const campos = def.campos.filter((c) => !c.sistema).map((c) => (c.tipo === 'membro'
    ? { ...c, tipo: 'enum',
      opcoes: candidatosMembro(dados.membros_diretoria).map((m) => m.nome) }
    : c));
  if (!['comentar', 'reverter', 'retomar'].includes(sessao.tipo_acao)) {
    campos.push({ nome: 'observacoes', rotulo: 'Observações', tipo: 'text', obrigatorio: false });
  }
  return campos;
}

function preenchido(sessao, def) {
  if (def.tipo === 'arquivo') return sessao.arquivos.some((a) => a.campo === def.nome);
  return sessao.campos[def.nome] !== undefined;
}

function tituloDialogo(sessao, dados) {
  if (sessao.fluxo === 'novo') return 'Novo projeto';
  const def = definicaoAcao(dados.template, dados.projeto.etapa.chave, sessao.tipo_acao);
  return `${def ? def.rotulo : sessao.tipo_acao} — ${dados.projeto.codigo}`;
}

function perguntar(sessao, def, dados, avisos) {
  const linhas = [...avisos];
  linhas.push(`${tituloDialogo(sessao, dados)}`);
  const botoes = [];
  if (def.tipo === 'arquivo') {
    linhas.push(`📎 ${def.rotulo || def.nome}: envie o arquivo.`);
  } else if (def.tipo === 'enum') {
    linhas.push(`${def.rotulo || def.nome}: escolha uma opção.`);
    for (const o of def.opcoes) botoes.push({ rotulo: (def.rotulos && def.rotulos[o]) || o, dados: `val:${o}` });
  } else if (Array.isArray(def.sugestoes) && def.sugestoes.length) {
    linhas.push(`${def.rotulo || def.nome}: escolha um motivo ou toque em "Outro motivo" para escrever o seu.`);
    // Índice no callback: o texto completo poderia passar dos 64 bytes do callback_data do Telegram.
    def.sugestoes.forEach((s, i) => botoes.push({ rotulo: s, dados: `sug:${i}` }));
    botoes.push({ rotulo: '✏️ Outro motivo', dados: 'digitar' });
  } else {
    linhas.push(`${def.rotulo || def.nome}:`);
  }
  if (!def.obrigatorio) {
    linhas.push('(opcional — envie "pular" para deixar em branco)');
    botoes.push({ rotulo: '⏭ Pular', dados: 'pular' });
  }
  botoes.push(BOTAO_CANCELAR);
  return resp(true, 'CAMPOS_FALTANTES', linhas.join('\n'), botoes);
}

function fmtValor(def, v) {
  if (def.tipo === 'money') return fmtMoeda(v);
  if (def.tipo === 'date') return String(v).split('-').reverse().join('/');
  if (def.rotulos && def.rotulos[v]) return def.rotulos[v];
  return String(v);
}

function resumo(sessao, defs, dados, extra) {
  const linhas = [`Confirme: ${tituloDialogo(sessao, dados)}`];
  if (extra) linhas.push(extra);
  for (const d of defs) {
    if (d.tipo === 'arquivo') {
      const a = sessao.arquivos.find((x) => x.campo === d.nome);
      if (a) linhas.push(`• ${d.rotulo || d.nome}: 📎 ${a.nome}`);
    } else if (sessao.campos[d.nome] !== undefined) {
      linhas.push(`• ${d.rotulo || d.nome}: ${fmtValor(d, sessao.campos[d.nome])}`);
    }
  }
  return resp(true, 'CONFIRMACAO_PENDENTE', linhas.join('\n'),
    [{ rotulo: '✅ Confirmar', dados: 'ok' }, BOTAO_CANCELAR]);
}

function argsPlano(sessao, pre, dados, cfg) {
  const { observacoes, ...campos } = sessao.campos;
  return {
    membro: pre.ctx.membro, projeto: dados.projeto, template: dados.template, acoes: dados.acoes,
    membrosDiretoria: dados.membros_diretoria, tipoAcao: sessao.tipo_acao, campos,
    arquivos: sessao.arquivos, observacoes, canal: pre.cmd.canal,
    idempotencyKey: pre.cmd.idempotency_key, cfg,
  };
}

/** Pergunta o próximo campo ou, se não falta nada, mostra o resumo para confirmação. */
function avancar(sessao, pre, dados, cfg, avisos = []) {
  const defs = camposDialogo(sessao, dados, pre.ctx.membro);
  const proximo = defs.find((d) => !preenchido(sessao, d) && !sessao.pulados.includes(d.nome)
    && (d.obrigatorio || !sessao.direto));
  if (proximo) {
    sessao.aguardando = `campo:${proximo.nome}`;
    return { resposta: perguntar(sessao, proximo, dados, avisos), sessao, operacao: null };
  }
  let extra = null;
  if (sessao.fluxo === 'acao') {
    const plano = planejarAcao(argsPlano(sessao, pre, dados, cfg));
    if (!plano.ok) return { resposta: resp(false, plano.codigo, plano.mensagem), sessao: null, operacao: null };
    if (plano.alvo) {
      extra = `Será desfeita a ação #${plano.alvo.seq} "${M.rotuloAcao(plano.alvo.tipo_acao, dados.template)}" `
        + `de ${plano.alvo.nome_responsavel}. Nada é apagado: a reversão fica registrada no histórico.`;
    }
  }
  sessao.aguardando = 'confirmacao';
  const r = resumo(sessao, defs, dados, extra);
  if (avisos.length) r.mensagem = `${avisos.join('\n')}\n${r.mensagem}`;
  return { resposta: r, sessao, operacao: null };
}

/** Associa arquivos recebidos aos campos de arquivo ainda vazios (primeiro o campo aguardado). */
function anexarArquivos(sessao, defs, arquivos, cfg, avisos) {
  for (const arq of arquivos || []) {
    const aguardado = String(sessao.aguardando || '').replace(/^campo:/, '');
    const def = defs.find((d) => d.tipo === 'arquivo' && d.nome === aguardado && !preenchido(sessao, d))
      || defs.find((d) => d.tipo === 'arquivo' && !preenchido(sessao, d));
    if (!def) { avisos.push(`(O arquivo "${arq.nome}" foi ignorado: esta ação não espera mais arquivos.)`); continue; }
    const erro = validarArquivo(def, arq, cfg);
    if (erro) { avisos.push(`⚠️ ${erro}`); continue; }
    sessao.arquivos.push({ ...arq, campo: def.nome });
    sessao.pulados = sessao.pulados.filter((n) => n !== def.nome);
  }
}

/** Trata uma resposta (texto/arquivo) dada durante um diálogo. */
function responderDialogo(sessao, pre, dados, cfg) {
  const { cmd, entrada } = pre;
  const defs = camposDialogo(sessao, dados, pre.ctx.membro);
  if (!defs) {
    return { resposta: resp(false, 'TRANSICAO_INVALIDA', 'O projeto mudou de etapa; a operação em andamento foi cancelada.'), sessao: null, operacao: null };
  }
  if (sessao.aguardando === 'confirmacao') {
    return { resposta: resp(true, 'CONFIRMACAO_PENDENTE', 'Responda "confirmar" ou "cancelar".',
      [{ rotulo: '✅ Confirmar', dados: 'ok' }, BOTAO_CANCELAR]), sessao, operacao: null };
  }
  const avisos = [];
  const def = defs.find((d) => `campo:${d.nome}` === sessao.aguardando);
  let texto = String(entrada.texto || '').trim();
  if (def && entrada.digitar) {
    return { resposta: resp(true, 'CAMPOS_FALTANTES',
      `${tituloDialogo(sessao, dados)}\n✏️ Digite o ${String(def.rotulo || def.nome).toLowerCase()}:`, [BOTAO_CANCELAR]),
    sessao, operacao: null };
  }
  if (def && Number.isInteger(entrada.sugestao) && Array.isArray(def.sugestoes) && def.sugestoes[entrada.sugestao]) {
    texto = def.sugestoes[entrada.sugestao];
  }
  if (def) {
    if (def.tipo === 'arquivo') {
      if (cmd.arquivos && cmd.arquivos.length) anexarArquivos(sessao, defs, cmd.arquivos, cfg, avisos);
      else if (!def.obrigatorio && ehPular(texto)) sessao.pulados.push(def.nome);
      else avisos.push('⚠️ Envie o arquivo como anexo (documento ou foto).');
    } else if (!def.obrigatorio && ehPular(texto)) {
      sessao.pulados.push(def.nome);
    } else {
      // Aceita também o rótulo exibido no botão (ex.: "Websites" -> "website").
      const porRotulo = def.rotulos && Object.keys(def.rotulos).find((k) => normalizar(def.rotulos[k]) === normalizar(texto));
      const r = converterValor(def, porRotulo || texto);
      if (r.ok) sessao.campos[def.nome] = r.valor; else avisos.push(`⚠️ ${r.erro}`);
      if (cmd.arquivos && cmd.arquivos.length) anexarArquivos(sessao, defs, cmd.arquivos, cfg, avisos);
    }
  }
  return avancar(sessao, pre, dados, cfg, avisos);
}

function novaSessao(base) {
  return { campos: {}, arquivos: [], pulados: [], direto: false, aguardando: null, ...base };
}

/** Converte valores passados direto no comando (`campo=valor`); inválidos viram aviso e são perguntados. */
function aplicarCamposDiretos(sessao, defs, brutos, avisos) {
  for (const [nome, bruto] of Object.entries(brutos || {})) {
    const def = defs.find((d) => d.nome === nome);
    if (!def) { avisos.push(`(Campo desconhecido ignorado: ${nome})`); continue; }
    if (def.tipo === 'arquivo') continue;
    const r = converterValor(def, bruto);
    if (r.ok) sessao.campos[nome] = r.valor; else avisos.push(`⚠️ ${r.erro}`);
  }
}

// ------------------------------------------------------------------------------ comandos

function semProjeto(membro, dados, entrada, verbo) {
  const meus = (dados.projetos || []).filter((p) => p.diretoria === membro.diretoria || ehSuper(membro)).slice(0, 10);
  const tipo = entrada.args.tipo_acao;
  const botoes = meus.map((p) => ({
    rotulo: `${p.codigo} ${p.nome}`.slice(0, 60),
    dados: tipo ? `acao:${p.codigo}:${tipo}` : `${verbo}:${p.codigo}`,
  }));
  if (!botoes.length) return resp(false, 'PROJETO_NAO_ENCONTRADO', 'Informe o código do projeto (ex.: P-2026-0001). Veja os códigos em /projetos.');
  return resp(true, 'ESCOLHER_PROJETO', 'De qual projeto?', botoes);
}

function cmdMeus(membro, dados) {
  const lista = (dados.projetos || []).filter((p) => p.status === 'ativo' && p.diretoria === membro.diretoria);
  if (!lista.length) return resp(true, 'OK', `Nenhum projeto aguardando a diretoria ${nomeDiretoria(membro.diretoria)} agora. 🎉`);
  const meus = lista.filter((p) => p.responsavel_id === membro.id);
  const linhas = [`Projetos aguardando ${nomeDiretoria(membro.diretoria)} (${lista.length}):`];
  for (const p of lista) linhas.push(`${p.responsavel_id === membro.id ? '👉 ' : ''}${M.linhaProjeto(p)}`);
  if (meus.length) linhas.push('', '👉 = atribuído a você');
  return resp(true, 'OK', linhas.join('\n'),
    lista.slice(0, 10).map((p) => ({ rotulo: `${p.codigo} ${p.nome}`.slice(0, 60), dados: `proj:${p.codigo}` })));
}

function cmdProjetos(dados, filtro) {
  const f = normalizar(filtro);
  const lista = (dados.projetos || []).filter((p) => !f
    || [p.codigo, p.nome, p.tipo, p.etapa_nome, p.etapa_chave, p.diretoria, p.status, p.responsavel_nome]
      .some((x) => normalizar(x).includes(f)));
  if (!lista.length) return resp(true, 'OK', f ? `Nenhum projeto em andamento com "${filtro}".` : 'Nenhum projeto em andamento.');
  return resp(true, 'OK', [`Projetos em andamento (${lista.length}):`, ...lista.map(M.linhaProjeto)].join('\n'),
    lista.slice(0, 10).map((p) => ({ rotulo: `${p.codigo} ${p.nome}`.slice(0, 60), dados: `proj:${p.codigo}` })));
}

function cmdProjeto(membro, dados, cfg) {
  const { projeto, template, acoes } = dados;
  const perm = acoesPermitidas(membro, projeto, template, acoes, cfg);
  const botoes = perm.transicoes.map((t) => ({ rotulo: `▶️ ${t.rotulo}`, dados: `acao:${projeto.codigo}:${t.tipo}` }));
  for (const g of perm.globais) botoes.push({ rotulo: M.rotuloAcao(g, template), dados: `acao:${projeto.codigo}:${g}` });
  botoes.push({ rotulo: '🕓 Histórico', dados: `hist:${projeto.codigo}` });
  let texto = M.formatarProjeto(projeto, template);
  if (!perm.transicoes.length && ['ativo', 'pausado'].includes(projeto.status)) {
    texto += projeto.status === 'pausado'
      ? '\n\nProjeto pausado: retome para poder avançar.'
      : `\n\nAguardando ação da diretoria ${nomeDiretoria(projeto.etapa.diretoria_responsavel)}.`;
  }
  const r = resp(true, 'OK', texto, botoes);
  const imagem = pedidoImagem(dados, cfg);   // fluxograma visual vai junto (antes do texto)
  if (imagem) r.imagem = imagem;
  return r;
}

function iniciarAcao(pre, dados, cfg) {
  const { entrada, cmd } = pre;
  const membro = pre.ctx.membro;
  const fim = (resposta) => ({ resposta, sessao: null, operacao: null });
  if (!entrada.args.projeto_codigo) return fim(semProjeto(membro, dados, entrada, 'proj'));
  if (!dados.projeto) return fim(resp(false, 'PROJETO_NAO_ENCONTRADO', M.mensagemErro('PROJETO_NAO_ENCONTRADO')));
  if (!entrada.args.tipo_acao) return fim(cmdProjeto(membro, dados, cfg));

  const sessao = novaSessao({ fluxo: 'acao', projeto_codigo: dados.projeto.codigo, tipo_acao: entrada.args.tipo_acao });
  // Autorização e existência da ação são checadas ANTES de perguntar qualquer campo.
  const previa = planejarAcao(argsPlano(sessao, pre, dados, cfg));
  if (!previa.ok && !['CAMPOS_FALTANTES', 'CAMPOS_INVALIDOS'].includes(previa.codigo)) {
    return fim(resp(false, previa.codigo, previa.mensagem));
  }

  const defs = camposDialogo(sessao, dados, pre.ctx.membro);
  const avisos = [];
  aplicarCamposDiretos(sessao, defs, entrada.args.campos, avisos);
  sessao.direto = Object.keys(sessao.campos).length > 0;
  anexarArquivos(sessao, defs, cmd.arquivos, cfg, avisos);
  return avancar(sessao, pre, dados, cfg, avisos);
}

function confirmar(sessao, pre, dados, cfg) {
  const membro = pre.ctx.membro;
  if (sessao.fluxo === 'novo') {
    const c = sessao.campos;
    const contato = String(c.cliente_contato || '');
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contato) ? contato : null;
    const defs = camposNovo(dados.tipos_servico, c.tipo);
    const daCriacao = defs.filter((d) => d._criacao);
    const tipoDef = (dados.tipos_servico || []).find((t) => t.tipo_servico === c.tipo) || {};
    const payload = {
      membro_id: membro.id, canal: pre.cmd.canal, idempotency_key: pre.cmd.idempotency_key,
      nome: c.nome_projeto, tipo: c.tipo, nome_lead: c.nome_lead || c.cliente_nome,
      descricao: c.descricao || c.descricao_demanda || null,
      cliente: { nome: c.cliente_nome, email, telefone: email ? null : contato },
      rodizio_ativo: cfg.features.rodizio,
    };
    if (tipoDef.acao_na_criacao) {
      const nomes = daCriacao.filter((d) => d.tipo !== 'arquivo').map((d) => d.nome);
      payload.encaminhar = { dados: Object.fromEntries(nomes.filter((n) => c[n] !== undefined).map((n) => [n, c[n]])) };
      payload.arquivos = sessao.arquivos;   // WF-04 sobe ao Drive antes de gravar (pasta raiz: o projeto ainda não existe)
    }
    return {
      resposta: null, sessao: null, meta: { rotulo: 'Projeto criado' },
      operacao: {
        fn: 'criar_projeto', payload,
        uploads: { pasta_id: cfg.driveRaizId || null, prefixo: '002_criacao_' },
      },
    };
  }
  if (!camposDialogo(sessao, dados, pre.ctx.membro)) {
    return { resposta: resp(false, 'TRANSICAO_INVALIDA', 'O projeto mudou de etapa; a operação em andamento foi cancelada.'), sessao: null, operacao: null };
  }
  const plano = planejarAcao(argsPlano(sessao, pre, dados, cfg));   // revalida: o projeto pode ter mudado
  if (!plano.ok) return { resposta: resp(false, plano.codigo, plano.mensagem), sessao: null, operacao: null };

  const etapaDef = dados.template.etapas[dados.projeto.etapa.chave] || {};
  const pastas = dados.projeto.drive_pastas || {};
  return {
    resposta: null, sessao: null,
    meta: { rotulo: plano.def.rotulo, projeto_codigo: dados.projeto.codigo },
    operacao: {
      ...plano.operacao,
      // Onde o WF-06 deve guardar os arquivos desta ação (subpasta da etapa atual).
      uploads: {
        pasta_id: pastas[etapaDef.pasta] || dados.projeto.drive_pasta_id || cfg.driveRaizId || null,
        prefixo: `${String((dados.acoes || []).length + 1).padStart(3, '0')}_${plano.operacao.payload.tipo_acao}_`,
      },
    },
  };
}

// ----------------------------------------------------------------------------- processar

/**
 * Passo 2: decide a resposta ou a operação a gravar.
 * @returns {{resposta:object|null, sessao:object|null, operacao:object|null, meta?:object, silencioso?:boolean}}
 *          `sessao` é SEMPRE o estado a persistir (null = apagar).
 */
function processar(pre, dados, cfg) {
  const { cmd, ctx, entrada } = pre;
  const membro = ctx.membro;
  const sessao = ctx.sessao ? JSON.parse(JSON.stringify(ctx.sessao)) : null;
  const manter = (resposta) => ({ resposta, sessao, operacao: null });
  const fim = (resposta) => ({ resposta, sessao: null, operacao: null });
  dados = dados || {};

  if (ctx.ja_processada) return { resposta: null, sessao, operacao: null, silencioso: true };
  if (!ctx.rate_ok) return manter(resp(false, 'RATE_LIMIT', 'Muitas mensagens em pouco tempo. Aguarde um minuto e tente de novo.'));
  if (!cfg.canais[cmd.canal]) return manter(resp(false, 'CANAL_DESATIVADO', 'Este canal está desativado no momento.'));

  const c = entrada.comando;

  // --- vínculo de conta (único fluxo permitido a quem ainda não foi identificado)
  if (c === 'vincular') {
    const email = String(entrada.args.resto || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return manter(resp(false, 'CAMPOS_INVALIDOS', 'Envie:  /vincular seu.email@dominio'));
    return { resposta: null, sessao, operacao: { fn: 'iniciar_vinculo', payload: { email, canal: cmd.canal, id_externo: cmd.id_externo_remetente } } };
  }
  if (c === 'codigo') {
    const codigo = String(entrada.args.resto || '').replace(/\D/g, '');
    if (codigo.length !== 6) return manter(resp(false, 'CAMPOS_INVALIDOS', 'Envie:  /codigo 123456  (os 6 dígitos recebidos por e-mail)'));
    return { resposta: null, sessao, operacao: { fn: 'confirmar_vinculo', payload: { codigo_vinculo: codigo, canal: cmd.canal, id_externo: cmd.id_externo_remetente } } };
  }
  if (!membro) return manter(resp(false, 'NAO_IDENTIFICADO', M.NAO_IDENTIFICADO));

  // --- controle de diálogo
  if (c === 'cancelar') return fim(resp(true, 'CANCELADO', sessao ? 'Operação cancelada.' : 'Não há operação em andamento.'));
  if (c === null) {
    if (sessao) return responderDialogo(sessao, pre, dados, cfg);
    return fim(resp(false, 'COMANDO_DESCONHECIDO', 'Não entendi. Envie /ajuda para ver os comandos.',
      [{ rotulo: '📋 Meus pendentes', dados: 'cmd:meus' }]));
  }
  if (c === 'confirmar') {
    if (sessao && sessao.aguardando === 'confirmacao') return confirmar(sessao, pre, dados, cfg);
    if (sessao) return responderDialogo(sessao, pre, dados, cfg);
    return fim(resp(false, 'NADA_A_CONFIRMAR', 'Não há nada aguardando confirmação.'));
  }

  // --- qualquer outro comando começa do zero (descarta diálogo anterior)
  switch (c) {
    case 'ajuda': return fim(resp(true, 'OK', `Olá, ${membro.nome.split(' ')[0]}!\n${M.AJUDA}`
      + (ehSuper(membro) ? `\n\nAdministradores:\n${M.AJUDA_ADMIN}` : '')));
    case 'sync': {
      if (!ehSuper(membro)) return fim(resp(false, 'NAO_AUTORIZADO', 'Só administradores ou a Presidência podem sincronizar os membros.'));
      const modo = normalizar(entrada.args.resto);
      const aplicar = modo === 'aplicar' || modo === 'aplicarforcado';
      const forcar = modo === 'forcar' || modo === 'aplicarforcado';
      return {
        resposta: resp(true, 'SYNC_INICIADO', aplicar
          ? '🔄 Aplicando a planilha de membros... o relatório chega em instantes.'
          : '🔄 Lendo a planilha de membros (prévia: nada é alterado ainda)...'),
        sessao: null, operacao: null,
        efeitos: [{ tipo: 'sync_membros', simular: !aplicar, forcar,
          solicitante: { canal: pre.cmd.canal, destino: String(pre.cmd.chat_id || pre.cmd.id_externo_remetente), membro_id: membro.id } }],
      };
    }
    case 'me': return fim(resp(true, 'OK', M.perfilMembro(membro)));
    case 'meus': return fim(cmdMeus(membro, dados));
    case 'projetos': return fim(cmdProjetos(dados, entrada.args.resto));
    case 'projeto':
      if (!entrada.args.projeto_codigo) return fim(semProjeto(membro, dados, entrada, 'proj'));
      if (!dados.projeto) return fim(resp(false, 'PROJETO_NAO_ENCONTRADO', M.mensagemErro('PROJETO_NAO_ENCONTRADO')));
      return fim(cmdProjeto(membro, dados, cfg));
    case 'historico':
      if (!entrada.args.projeto_codigo) return fim(semProjeto(membro, dados, entrada, 'hist'));
      if (!dados.projeto) return fim(resp(false, 'PROJETO_NAO_ENCONTRADO', M.mensagemErro('PROJETO_NAO_ENCONTRADO')));
      return fim(resp(true, 'OK', M.formatarHistorico(dados.projeto, dados.acoes, dados.template),
        [{ rotulo: '📁 Ver projeto', dados: `proj:${dados.projeto.codigo}` }]));
    case 'fluxograma': {
      if (!entrada.args.projeto_codigo) return fim(semProjeto(membro, dados, entrada, 'flux'));
      if (!dados.projeto) return fim(resp(false, 'PROJETO_NAO_ENCONTRADO', M.mensagemErro('PROJETO_NAO_ENCONTRADO')));
      const imagem = pedidoImagem(dados, cfg);
      if (!imagem) return fim(resp(false, 'FUNCAO_DESATIVADA', 'O fluxograma em imagem está desativado (FEATURE_FLUXOGRAMA). Use /historico.'));
      const r = resp(true, 'OK', `Fluxograma de ${dados.projeto.codigo}.`, [{ rotulo: '📁 Ver projeto', dados: `proj:${dados.projeto.codigo}` }]);
      r.imagem = imagem;
      return fim(r);
    }
    case 'novo': {
      if (!(ehSuper(membro) || membro.diretoria === 'comercial')) {
        return fim(resp(false, 'NAO_AUTORIZADO', 'Só a diretoria Comercial (ou administradores) registra novos projetos.'));
      }
      if (!(dados.tipos_servico || []).length) return fim(resp(false, 'TIPO_INVALIDO', 'Nenhum tipo de serviço cadastrado. Peça a um administrador para carregar os fluxos.'));
      return avancar(novaSessao({ fluxo: 'novo', projeto_codigo: null, tipo_acao: null }), pre, dados, cfg);
    }
    case 'acao': return iniciarAcao(pre, dados, cfg);
    case 'canal': {
      const canal = normalizar(entrada.args.resto);
      if (!CANAIS_PREFERIDOS.includes(canal)) return fim(resp(false, 'CAMPOS_INVALIDOS', 'Envie:  /canal telegram   ou   /canal email'));
      if (canal === 'telegram' && !membro.telegram_user_id) return fim(resp(false, 'CAMPOS_INVALIDOS', 'Vincule sua conta do Telegram primeiro (/vincular).'));
      return { resposta: null, sessao: null, meta: { sucesso: `Pronto: suas notificações irão por ${canal}.` },
        operacao: { fn: 'definir_canal', payload: { membro_id: membro.id, canal_preferido: canal } } };
    }
    case 'ausente': case 'disponivel':
      return { resposta: null, sessao: null,
        meta: { sucesso: c === 'ausente'
          ? 'Você saiu do rodízio. Envie /disponivel quando voltar. (Etapas já atribuídas a você continuam suas; use /reatribuir se precisar.)'
          : 'Você voltou ao rodízio.' },
        operacao: { fn: 'definir_disponivel', payload: { membro_id: membro.id, disponivel: c === 'disponivel' } } };
    default:
      return fim(resp(false, 'COMANDO_DESCONHECIDO', 'Não entendi. Envie /ajuda para ver os comandos.'));
  }
}

// ------------------------------------------------------------------------------ concluir

/**
 * Passo 3: transforma o resultado da gravação em resposta, notificações e efeitos pós-commit.
 * @param {object|null} resultado  retorno de executar_operacao (null se não houve operação)
 * @returns {{resposta:object|null, sessao:object|null, notificacoes:object[], efeitos:object[]}}
 */
function concluir(pre, saida, resultado, cfg) {
  const base = { resposta: saida.resposta, sessao: saida.sessao, notificacoes: [], efeitos: [...(saida.efeitos || [])] };
  if (!saida.operacao) return base;
  const fn = saida.operacao.fn;
  const meta = saida.meta || {};
  const r = resultado || { ok: false, codigo: 'ERRO_INTERNO' };

  if (fn === 'iniciar_vinculo') {
    // Mesma resposta exista ou não o e-mail: não revela quem é membro.
    base.resposta = resp(true, 'VINCULO_INICIADO', 'Se este e-mail estiver cadastrado, você receberá um código em instantes. Depois envie:  /codigo 123456');
    if (r.ok && r.encontrado) {
      base.notificacoes.push({
        membro_id: r.membro_id, canal: 'email', destino: r.email, sigiloso: true,   // não vai para a tabela notificacoes
        assunto: 'Therion Fluxo — código de vínculo',
        texto: `Olá, ${r.nome}!\n\nSeu código para vincular o ${pre.cmd.canal} é: ${r.codigo_vinculo}\n`
          + 'Ele vale por 10 minutos. Se não foi você quem pediu, ignore este e-mail.',
      });
    }
    return base;
  }
  if (fn === 'confirmar_vinculo') {
    base.resposta = r.ok
      ? resp(true, r.codigo, `Conta vinculada. Bem-vindo(a), ${r.nome}! Envie /ajuda para ver os comandos.`,
        [{ rotulo: '📋 Meus pendentes', dados: 'cmd:meus' }])
      : resp(false, r.codigo, M.mensagemErro(r.codigo));
    return base;
  }
  if (fn === 'definir_canal' || fn === 'definir_disponivel') {
    base.resposta = r.ok ? resp(true, r.codigo, meta.sucesso) : resp(false, r.codigo, M.mensagemErro(r.codigo));
    return base;
  }

  // criar_projeto / registrar_acao
  if (!r.ok) {
    base.resposta = resp(r.codigo === 'DUPLICADA', r.codigo, M.mensagemErro(r.codigo, meta.projeto_codigo));
    return base;
  }
  const p = r.projeto, e = p.etapa || {};
  const onde = `${e.nome} (${nomeDiretoria(e.diretoria_responsavel)})` + (e.responsavel_nome ? ` — responsável: ${e.responsavel_nome}` : '');
  let texto;
  if (fn === 'criar_projeto') {
    texto = r.encaminhado
      ? `✅ Projeto ${p.codigo} criado e enviado para ${nomeDiretoria(e.diretoria_responsavel)}: ${p.nome}\nEtapa: ${onde}`
      : `✅ Projeto ${p.codigo} criado: ${p.nome}\nEtapa: ${onde}`;
    if (cfg.features.drive) base.efeitos.push({ tipo: 'criar_pasta_drive', projeto_id: p.id, codigo: p.codigo, nome: p.nome, subpastas: r.subpastas || [] });
  } else {
    const tipo = r.acao.tipo_acao;
    if (tipo === 'pausar') texto = `⏸ Projeto ${p.codigo} pausado. O prazo da etapa fica congelado até /retomar.`;
    else if (tipo === 'retomar') texto = `▶️ Projeto ${p.codigo} retomado. Etapa: ${onde}`;
    else if (tipo === 'comentar') texto = `💬 Comentário registrado em ${p.codigo}.`;
    else if (tipo === 'reatribuir') texto = `👤 ${p.codigo}: responsável agora é ${e.responsavel_nome || 'toda a diretoria (ninguém disponível no rodízio)'}.`;
    else if (tipo === 'reverter') texto = `↩️ Ação #${r.acao_revertida.seq} revertida. ${p.codigo} está em: ${onde}`;
    else if (p.status === 'concluido') texto = `🎉 "${meta.rotulo}" registrado. Projeto ${p.codigo} concluído!`;
    else if (p.status === 'abandonado') texto = `🗄 "${meta.rotulo}" registrado. Projeto ${p.codigo} encerrado como abandonado.`;
    else if (r.mudou_etapa) texto = `✅ "${meta.rotulo}" registrado. ${p.codigo} seguiu para: ${onde}`;
    else texto = `✅ "${meta.rotulo}" registrado em ${p.codigo}.`;
    // Efeitos do template ainda sem implementação (IA: Fase 4; envio ao cliente: futuro) são só listados.
    // TODO(ENVIO_AUTOMATICO_CLIENTE): tratar `enviar_documento_cliente` aqui quando cfg.features.envioAutomaticoCliente.
    for (const ef of r.efeitos || []) base.efeitos.push({ tipo: ef, projeto_id: p.id, codigo: p.codigo, pendente_de_fase_futura: true });
  }
  base.resposta = resp(true, r.codigo, texto, [{ rotulo: '📁 Ver projeto', dados: `proj:${p.codigo}` }]);
  base.resposta.projeto = { codigo: p.codigo, etapa: e.chave, status: p.status };
  base.notificacoes = montarNotificacoes(r, { rotulo: meta.rotulo || r.acao.tipo_acao }, cfg);
  return base;
}

/**
 * Lista final de mensagens a enviar: resposta direta ao remetente + notificações.
 */
function mensagensDeSaida(pre, final) {
  const msgs = [];
  if (final.resposta && final.resposta.mensagem) {
    msgs.push({
      canal: pre.cmd.canal, destino: pre.cmd.chat_id || pre.cmd.id_externo_remetente,
      membro_id: pre.membro_id, texto: final.resposta.mensagem, botoes: final.resposta.botoes || [], resposta_direta: true,
      ...(final.resposta.imagem ? { imagem: final.resposta.imagem } : {}),
    });
  }
  return msgs.concat(final.notificacoes || []);
}

module.exports = { preparar, processar, concluir, mensagensDeSaida, interpretarEntrada };
