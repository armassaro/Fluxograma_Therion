'use strict';
/**
 * Testes de integração: pipeline completo (lib/app.js + funções PL/pgSQL) contra um Postgres real,
 * com as mensagens entrando no formato do webhook do Telegram.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { criarBanco, semear, criarBot, update, projeto } = require('./_banco');
const { divergencias } = require('../../lib/projecao');
const { escolherResponsavel } = require('../../lib/rodizio');
const { chamar } = require('../../scripts/db');

let banco, db, bot, ultimaCriacao;
const CARLA = 101, CAIO = 102, BRUNO = 201, ERICA = 202, PAULO = 203, FABIO = 301, HELENA = 302,
  ALICE = 401, DIEGO = 402, PIETRA = 501, ADA = 601;

test.before(async () => {
  banco = await criarBanco(); db = banco.db;
  await semear(db);
  bot = criarBot(db);
});
test.after(async () => { await banco.fechar(); });

/** Garante que a tabela `projetos` bate com o replay dos eventos. */
async function consistente(codigo) {
  const d = await projeto(db, codigo);
  assert.deepEqual(divergencias(d.projeto, d.acoes), [], `projeção divergente em ${codigo}`);
  return d;
}

/** Cria um projeto website pelo diálogo completo e devolve o código. */
async function criarProjeto(nome = 'Site Padaria Sol', tipo = 'website') {
  let r = await bot.diz(CARLA, '/novo');
  assert.equal(r.final.resposta.codigo, 'CAMPOS_FALTANTES');
  await bot.clica(CARLA, `val:${tipo}`);
  await bot.diz(CARLA, nome);
  await bot.diz(CARLA, 'Padaria Sol');
  await bot.diz(CARLA, 'contato@padariasol.test');
  await bot.clica(CARLA, 'pular');                       // nome do lead
  r = await bot.diz(CARLA, 'Projeto de site institucional'); // descrição da demanda; começa com "Projeto": não pode virar /projeto
  while (r.final.resposta.codigo === 'CAMPOS_FALTANTES') r = await bot.clica(CARLA, 'pular');  // prazo, arquivo do cliente
  assert.equal(r.final.resposta.codigo, 'CONFIRMACAO_PENDENTE', r.final.resposta.mensagem);
  r = await bot.clica(CARLA, 'ok');
  assert.equal(r.final.resposta.codigo, 'PROJETO_CRIADO', r.final.resposta.mensagem);
  // acao_na_criacao: o projeto já nasce encaminhado para Projetos.
  assert.equal(r.resultado.projeto.etapa.chave, 'definicao_escopo');
  ultimaCriacao = r;
  return r.resultado.projeto.codigo;
}

/** Leva um projeto website recém-criado até `ate` (chave de etapa). */
async function avancarAte(cod, ate) {
  const passos = [
    ['definicao_escopo', CARLA, `/acao ${cod} enviar_para_escopo descricao_demanda="Site com 5 páginas"`],
    ['elaboracao_orcamento', null, `/acao ${cod} enviar_escopo escopo="5 páginas + blog" estimativa_horas=40`],
    ['validacao_orcamento', null, `/acao ${cod} orcamento_rascunho_pronto obs="planilha anexa"`],
    ['aguardando_cliente_orcamento', null, `/acao ${cod} aprovar_orcamento_interno valor_orcado=3.200,00`],
    ['elaboracao_contrato', CARLA, `/acao ${cod} cliente_aprovou obs="aprovado por e-mail"`],
    ['validacao_contrato', null, `/acao ${cod} contrato_rascunho_pronto obs=ok`],
    ['aguardando_assinatura', null, `/acao ${cod} aprovar_contrato_interno obs=ok`],
    ['execucao', null, `/acao ${cod} contrato_assinado valor_contratado=3200`, 'contrato.pdf'],
    ['entrega', null, `/acao ${cod} concluir_execucao link_entrega=https://padariasol.test`],
    ['pagamento', null, `/acao ${cod} cliente_aceitou_entrega obs=ok`],
  ];
  let origem = 'registro_lead';
  for (const [destino, quem, texto, arquivo] of passos) {
    const d = await projeto(db, cod);
    const partida = origem; origem = destino;
    if (d.projeto.etapa.chave !== partida) continue;      // projeto já passou deste passo
    // quem age: o responsável atribuído ou alguém da diretoria da etapa
    let tg = quem;
    if (!tg) {
      const e = d.projeto.etapa;
      const r = await db.query(
        'SELECT telegram_user_id FROM membros WHERE (id = $1 OR ($1 IS NULL AND diretoria = $2)) AND NOT is_admin ORDER BY nome LIMIT 1',
        [e.responsavel_atribuido_id, e.diretoria_responsavel]);
      tg = Number(r.rows[0].telegram_user_id);
    }
    const r = await bot.faz(tg, texto, arquivo ? { arquivo } : undefined);
    assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA', `${texto} -> ${r.final.resposta.mensagem}`);
    assert.equal(r.resultado.projeto.etapa.chave, destino);
    if (destino === ate) return r;
  }
  return null;
}

test('fluxo completo de um projeto website, do lead à conclusão', async () => {
  const cod = await criarProjeto();
  assert.match(cod, /^P-\d{4}-0001$/);
  let d = await consistente(cod);
  assert.equal(d.projeto.etapa.chave, 'definicao_escopo');
  assert.deepEqual(d.acoes.map((a) => a.tipo_acao), ['criar_projeto', 'enviar_para_escopo']);
  assert.equal(d.acoes[1].dados.descricao_demanda, 'Projeto de site institucional');
  assert.match(ultimaCriacao.final.resposta.mensagem, /criado e enviado para Projetos/);
  assert.equal(d.projeto.cliente.email, 'contato@padariasol.test');
  assert.equal(d.projeto.nome_lead, 'Padaria Sol');

  const r = await avancarAte(cod, 'pagamento');
  assert.equal(r.resultado.projeto.status, 'ativo');
  d = await consistente(cod);
  assert.equal(Number(d.projeto.estimativa_horas), 40);
  assert.equal(Number(d.projeto.valor_orcado), 3200);
  assert.equal(Number(d.projeto.valor_contratado), 3200);
  const assinatura = d.acoes.find((a) => a.tipo_acao === 'contrato_assinado');
  assert.equal(assinatura.arquivos[0].campo, 'contrato_assinado');
  assert.equal(assinatura.arquivos[0].nome, 'contrato.pdf');

  // Guarda: não quita antes de receber o valor contratado.
  let q = await bot.diz(FABIO, `/acao ${cod} quitar`);
  assert.equal(q.final.resposta.codigo, 'GUARDA_NAO_ATENDIDA');
  q = await bot.faz(FABIO, `/acao ${cod} registrar_parcela valor_pago=1.200,00`, { arquivo: 'pix1.pdf' });
  assert.equal(q.final.resposta.codigo, 'ACAO_REGISTRADA', q.final.resposta.mensagem);
  assert.equal(q.resultado.mudou_etapa, false);
  q = await bot.diz(FABIO, `/acao ${cod} quitar`);
  assert.equal(q.final.resposta.codigo, 'GUARDA_NAO_ATENDIDA');
  await bot.faz(FABIO, `/acao ${cod} registrar_parcela valor_pago=2000`, { arquivo: 'pix2.pdf' });
  q = await bot.faz(FABIO, `/acao ${cod} quitar`);
  assert.equal(q.final.resposta.codigo, 'ACAO_REGISTRADA', q.final.resposta.mensagem);
  assert.equal(q.resultado.projeto.status, 'concluido');
  assert.ok(q.resultado.projeto.data_final);

  d = await consistente(cod);
  // Uma etapa aberta por vez; todas as anteriores fechadas.
  const abertas = await db.query('SELECT count(*)::int n FROM etapas WHERE projeto_id = $1 AND data_saida IS NULL', [d.projeto.id]);
  assert.equal(abertas.rows[0].n, 1);
  // Projeto encerrado não aceita mais ações.
  const fora = await bot.diz(FABIO, `/acao ${cod} registrar_parcela valor_pago=1`);
  assert.equal(fora.final.resposta.codigo, 'TRANSICAO_INVALIDA');
});

test('autorização: outra diretoria é barrada e a resposta diz quem pode agir', async () => {
  const cod = await criarProjeto('Site Autorização');
  let r = await bot.diz(CARLA, `/acao ${cod} enviar_escopo escopo=y estimativa_horas=10`);
  assert.equal(r.final.resposta.codigo, 'NAO_AUTORIZADO');
  assert.match(r.final.resposta.mensagem, /Projetos/);
  assert.equal(r.saida.operacao, null);
  // Presidência e admin agem em qualquer etapa.
  r = await bot.faz(PIETRA, `/acao ${cod} enviar_escopo escopo=y estimativa_horas=10`);
  assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA');
  r = await bot.faz(ADA, `/acao ${cod} orcamento_rascunho_pronto`);
  assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA');
  // Defesa em profundidade: chamar o SQL direto com membro de outra diretoria também falha.
  const d = await projeto(db, cod);
  const carla = (await db.query("SELECT id FROM membros WHERE email = 'carla@ej.test'")).rows[0].id;
  const direto = await chamar(db, 'registrar_acao', {
    projeto_id: d.projeto.id, tipo_acao: 'aprovar_orcamento_interno', membro_id: carla, canal: 'telegram', idempotency_key: 'direto-1',
  });
  assert.deepEqual(direto, { ok: false, codigo: 'NAO_AUTORIZADO' });
  // /novo é só do Comercial (ou admin).
  r = await bot.diz(FABIO, '/novo');
  assert.equal(r.final.resposta.codigo, 'NAO_AUTORIZADO');
});

test('diálogo: pede campos faltantes um a um, valida e aceita arquivo', async () => {
  const cod = await criarProjeto('Site Diálogo');
  const d0 = await projeto(db, cod);
  const resp0 = Number((await db.query('SELECT telegram_user_id t FROM membros WHERE id = $1', [d0.projeto.etapa.responsavel_atribuido_id])).rows[0].t);

  let r = await bot.clica(resp0, `acao:${cod}:enviar_escopo`);           // botão, sem campos
  assert.equal(r.final.resposta.codigo, 'CAMPOS_FALTANTES');
  assert.match(r.final.resposta.mensagem, /Escopo do projeto/);
  r = await bot.diz(resp0, 'Site institucional com blog');
  assert.match(r.final.resposta.mensagem, /Estimativa de horas/);
  r = await bot.diz(resp0, 'quarenta');                                  // inválido: pergunta de novo
  assert.match(r.final.resposta.mensagem, /informe um número/);
  r = await bot.diz(resp0, '0');                                         // abaixo do mínimo
  assert.match(r.final.resposta.mensagem, /mínimo é 1/);
  r = await bot.diz(resp0, '40');
  assert.match(r.final.resposta.mensagem, /Arquivo do escopo/);
  r = await bot.diz(resp0, '', { arquivo: 'virus.exe' });                // extensão proibida
  assert.match(r.final.resposta.mensagem, /não permitido/);
  r = await bot.diz(resp0, '', { arquivo: 'escopo.pdf' });
  assert.match(r.final.resposta.mensagem, /Observações/);
  r = await bot.clica(resp0, 'pular');
  assert.equal(r.final.resposta.codigo, 'CONFIRMACAO_PENDENTE');
  assert.match(r.final.resposta.mensagem, /escopo\.pdf/);
  r = await bot.diz(resp0, 'sim');
  assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA', r.final.resposta.mensagem);

  // /cancelar apaga o diálogo
  const d1 = await projeto(db, cod);
  const fin = Number((await db.query('SELECT telegram_user_id t FROM membros WHERE id = $1', [d1.projeto.etapa.responsavel_atribuido_id])).rows[0].t);
  await bot.diz(fin, `/acao ${cod} orcamento_rascunho_pronto`);
  r = await bot.diz(fin, '/cancelar');
  assert.equal(r.final.resposta.codigo, 'CANCELADO');
  assert.equal((await db.query('SELECT count(*)::int n FROM sessoes_chat')).rows[0].n, 0);
  r = await bot.diz(fin, 'confirmar');
  assert.equal(r.final.resposta.codigo, 'NADA_A_CONFIRMAR');
});

test('reversão: nada é apagado, o estado volta e a projeção continua consistente', async () => {
  const cod = await criarProjeto('Site Reversão');
  await avancarAte(cod, 'validacao_orcamento');           // 3 avanços
  let d = await consistente(cod);
  const respEscopo = (await db.query(
    "SELECT responsavel_atribuido_id r FROM etapas WHERE projeto_id = $1 AND chave = 'definicao_escopo'", [d.projeto.id])).rows[0].r;
  const autor3 = Number((await db.query('SELECT telegram_user_id t FROM membros WHERE id = $1', [d.acoes[3].membro_id])).rows[0].t);

  // Quem não é o autor não reverte.
  let r = await bot.diz(CARLA, `/reverter ${cod}`);
  assert.equal(r.final.resposta.codigo, 'NAO_AUTORIZADO');
  // O autor reverte (com confirmação mostrando o que será desfeito).
  r = await bot.diz(autor3, `/reverter ${cod}`);
  assert.equal(r.final.resposta.codigo, 'CONFIRMACAO_PENDENTE');
  assert.match(r.final.resposta.mensagem, /#4/);
  r = await bot.clica(autor3, 'ok');
  assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA', r.final.resposta.mensagem);
  assert.equal(r.resultado.projeto.etapa.chave, 'elaboracao_orcamento');
  // Admin reverte a ação de outra pessoa.
  r = await bot.faz(ADA, `/reverter ${cod}`);
  assert.equal(r.resultado.projeto.etapa.chave, 'definicao_escopo');
  // Continuidade: a etapa volta para a MESMA pessoa que a tinha antes.
  assert.equal(r.resultado.projeto.etapa.responsavel_atribuido_id, respEscopo);

  d = await consistente(cod);
  assert.equal(d.projeto.estimativa_horas, null, 'estimativa veio de uma ação revertida');
  assert.equal(d.acoes.length, 6);                         // criar + 3 avanços + 2 reversões
  assert.equal(d.acoes.filter((a) => a.revertida_por_id).length, 2);
  assert.equal(d.acoes.filter((a) => a.tipo_acao === 'reverter').length, 2);

  // acoes é append-only no banco.
  await assert.rejects(db.query('DELETE FROM acoes WHERE projeto_id = $1', [d.projeto.id]), /append-only/);
  await assert.rejects(db.query("UPDATE acoes SET tipo_acao = 'x' WHERE projeto_id = $1", [d.projeto.id]), /revertida_por_id/);

  // Depois de reverter, o fluxo segue normalmente.
  await avancarAte(cod, 'elaboracao_orcamento');
  await consistente(cod);
});

test('reversão a partir de etapa terminal: só admin reabre', async () => {
  const cod = await criarProjeto('Site Terminal');
  let r = await bot.faz(CARLA, `/abandonar ${cod} cliente sumiu`);
  assert.equal(r.resultado.projeto.status, 'abandonado');
  assert.ok(r.resultado.projeto.data_final);
  r = await bot.diz(CARLA, `/reverter ${cod}`);
  assert.equal(r.final.resposta.codigo, 'NAO_AUTORIZADO');
  r = await bot.faz(ADA, `/reverter ${cod}`);
  assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA', r.final.resposta.mensagem);
  assert.equal(r.resultado.projeto.status, 'ativo');
  assert.equal(r.resultado.projeto.data_final, null);
  assert.equal(r.resultado.projeto.etapa.chave, 'definicao_escopo');
  await consistente(cod);
  // O encaminhamento automático é uma ação comum: pode ser revertido (volta ao Comercial).
  r = await bot.faz(ADA, `/reverter ${cod}`);
  assert.equal(r.resultado.projeto.etapa.chave, 'registro_lead');
  await consistente(cod);
  // Só resta a criação: nada mais a reverter.
  r = await bot.diz(ADA, `/reverter ${cod}`);
  assert.equal(r.final.resposta.codigo, 'NADA_A_REVERTER');
});

test('abandonar pelo botão: motivos padrão em botões e motivo personalizado', async () => {
  const cod = await criarProjeto('Site Abandono Botões');
  let r = await bot.clica(CARLA, `acao:${cod}:abandonar`);
  assert.equal(r.final.resposta.codigo, 'CAMPOS_FALTANTES');
  const rotulos = r.final.resposta.botoes.map((b) => b.rotulo);
  for (const m of ['Cliente cancelou o projeto', 'Orçamento muito alto para o cliente', 'Tempo estimado em escopo muito alto', '✏️ Outro motivo']) {
    assert.ok(rotulos.includes(m), `falta o botão "${m}"`);
  }
  // Motivo personalizado: "Outro motivo" pede o texto e não grava nada ainda.
  r = await bot.clica(CARLA, 'digitar');
  assert.equal(r.final.resposta.codigo, 'CAMPOS_FALTANTES');
  assert.match(r.final.resposta.mensagem, /Digite o motivo/);
  await bot.diz(CARLA, 'Cliente fechou com concorrente');
  await bot.clica(CARLA, 'pular');                       // observações
  r = await bot.clica(CARLA, 'ok');
  assert.equal(r.resultado.projeto.status, 'abandonado');

  // Motivo padrão escolhido pelo botão.
  const cod2 = await criarProjeto('Site Abandono Padrão');
  await bot.clica(CARLA, `acao:${cod2}:abandonar`);
  r = await bot.clica(CARLA, 'sug:1');
  assert.equal(r.final.resposta.codigo, 'CAMPOS_FALTANTES');   // pergunta observações
  r = await bot.clica(CARLA, 'pular');
  assert.match(r.final.resposta.mensagem, /Motivo do abandono: Orçamento muito alto para o cliente/);
  r = await bot.clica(CARLA, 'ok');
  assert.equal(r.resultado.projeto.status, 'abandonado');
});

test('rodízio alfabético: alterna, pula indisponíveis e bate com a implementação de referência', async () => {
  const projetosDir = (await db.query("SELECT * FROM membros WHERE diretoria = 'projetos'")).rows;
  let ultimo = (await db.query("SELECT ultimo_membro_id u FROM rodizio WHERE chave_etapa = 'definicao_escopo'")).rows[0]?.u || null;
  const vistos = [];
  for (let i = 0; i < 4; i++) {
    await criarProjeto(`Site Rodízio ${i}`);
    const r = ultimaCriacao;
    const esperado = escolherResponsavel(projetosDir, ultimo);
    assert.equal(r.resultado.projeto.etapa.responsavel_atribuido_id, esperado.id, 'SQL e lib/rodizio.js divergem');
    ultimo = esperado.id;
    vistos.push(esperado.nome);
    // O responsável é notificado; quem agiu não recebe notificação de si mesmo.
    const dest = r.final.notificacoes.map((n) => n.destino);
    assert.ok(dest.includes(String(projetosDir.find((m) => m.id === esperado.id).telegram_user_id)));
    assert.ok(!dest.includes(String(CARLA)));
  }
  // Ada (admin) está indisponível: nunca entra. Ordem alfabética sem acento: Bruno, Érica, Paulo.
  assert.ok(!vistos.includes('Ada Admin'));
  const i0 = ['Bruno Lima', 'Érica Alves', 'Paulo Reis'].indexOf(vistos[0]);
  assert.deepEqual(vistos, [0, 1, 2, 3].map((k) => ['Bruno Lima', 'Érica Alves', 'Paulo Reis'][(i0 + k) % 3]));

  // /ausente tira do rodízio; ninguém disponível => sem responsável e a diretoria inteira é avisada.
  for (const tg of [BRUNO, ERICA, PAULO]) await bot.diz(tg, '/ausente');
  const cod = await criarProjeto('Site Sem Responsável');
  const r = ultimaCriacao;
  assert.equal(r.resultado.projeto.etapa.responsavel_atribuido_id, null);
  const motivos = r.final.notificacoes.map((n) => n.destino).sort();
  assert.deepEqual(motivos, [String(BRUNO), String(ERICA), String(PAULO), String(ADA)].sort());
  for (const tg of [BRUNO, ERICA, PAULO]) await bot.diz(tg, '/disponivel');
  // /reatribuir sem nome usa o rodízio; com nome, escolhe a pessoa.
  let t = await bot.diz(PAULO, `/reatribuir ${cod}`);
  assert.match(t.final.resposta.mensagem, /Novo responsável/);
  t = await bot.clica(PAULO, 'val:Érica Alves');
  t = await bot.clica(PAULO, 'pular');
  t = await bot.clica(PAULO, 'ok');
  assert.equal(t.final.resposta.codigo, 'ACAO_REGISTRADA', t.final.resposta.mensagem);
  assert.equal(t.resultado.projeto.etapa.responsavel_nome, 'Érica Alves');
});

test('idempotência: o mesmo update entregue duas vezes gera uma ação só', async () => {
  const cod = await criarProjeto('Site Idempotência');
  await bot.diz(CARLA, `/acao ${cod} pausar motivo=x`);
  const u = update(CARLA, 'confirmar');
  const r1 = await bot.enviar(u);
  assert.equal(r1.final.resposta.codigo, 'ACAO_REGISTRADA');
  const r2 = await bot.enviar(u);                         // reentrega do webhook
  assert.equal(r2.saida.silencioso, true);
  assert.equal(r2.mensagens.length, 0);
  const d = await projeto(db, cod);
  assert.equal(d.acoes.length, 3);   // criar + encaminhar + pausar
  // Última barreira: a mesma idempotency_key direto no SQL.
  const rep = await chamar(db, 'registrar_acao', { ...r1.saida.operacao.payload, versao_esperada: null });
  assert.deepEqual(rep, { ok: false, codigo: 'DUPLICADA' });
});

test('concorrência: duas ações simultâneas no mesmo projeto, só uma entra', async () => {
  const cod = await criarProjeto('Site Concorrência');
  const d = await projeto(db, cod);
  const ids = (await db.query("SELECT id FROM membros WHERE diretoria = 'projetos' AND NOT is_admin ORDER BY nome LIMIT 2")).rows;
  const outro = new Client({ connectionString: banco.url });
  await outro.connect();
  try {
    const plano = (m, k) => ({
      projeto_id: d.projeto.id, versao_esperada: d.projeto.versao, tipo_acao: 'enviar_escopo',
      membro_id: m, canal: 'telegram', dados: { escopo: k, estimativa_horas: 1 }, idempotency_key: `conc-${k}`,
    });
    const [a, b] = await Promise.all([
      chamar(db, 'registrar_acao', plano(ids[0].id, 'a')),
      chamar(outro, 'registrar_acao', plano(ids[1].id, 'b')),
    ]);
    assert.deepEqual([a.codigo, b.codigo].sort(), ['ACAO_REGISTRADA', 'CONFLITO']);
  } finally { await outro.end(); }
  const depois = await consistente(cod);
  assert.equal(depois.acoes.length, 3);
});

test('pausar congela o fluxo; retomar empurra o prazo da etapa', async () => {
  const cod = await criarProjeto('Site Pausa');
  let r = await bot.diz(CARLA, `/pausar ${cod}`);
  assert.match(r.final.resposta.mensagem, /Motivo da pausa/);
  await bot.diz(CARLA, 'cliente viajou');
  await bot.clica(CARLA, 'pular');
  r = await bot.clica(CARLA, 'ok');
  assert.equal(r.resultado.projeto.status, 'pausado');
  const prazo0 = new Date(r.resultado.projeto.etapa.prazo_sla);
  // Pausado: não avança, mas aceita comentário.
  r = await bot.diz(ADA, `/acao ${cod} enviar_escopo escopo=x estimativa_horas=1`);
  assert.equal(r.final.resposta.codigo, 'NAO_AUTORIZADO');
  assert.match(r.final.resposta.mensagem, /pausado/);
  r = await bot.faz(BRUNO, `/comentar ${cod} liguei e ninguém atendeu`);
  assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA', r.final.resposta.mensagem);
  assert.equal(r.resultado.acao.observacoes, 'liguei e ninguém atendeu');
  // Simula 2 dias de pausa.
  await db.query('ALTER TABLE acoes DISABLE TRIGGER trg_acoes_append_only');
  await db.query("UPDATE acoes SET criado_em = criado_em - interval '2 days' WHERE tipo_acao = 'pausar' AND projeto_id = $1", [r.resultado.projeto.id]);
  await db.query('ALTER TABLE acoes ENABLE TRIGGER trg_acoes_append_only');
  r = await bot.faz(CARLA, `/retomar ${cod}`);
  assert.equal(r.resultado.projeto.status, 'ativo');
  const ganho = (new Date(r.resultado.projeto.etapa.prazo_sla) - prazo0) / 3600000;
  assert.ok(ganho > 47.9 && ganho < 48.1, `prazo deveria andar ~48h, andou ${ganho}h`);
  await consistente(cod);
});

test('vínculo de conta: código por e-mail, tentativas erradas e sucesso', async () => {
  const NOVO = 9001;
  await db.query(`INSERT INTO membros (nome, nome_ordenacao, email, diretoria) VALUES ('Nina Novata', 'nina novata', 'nina@ej.test', 'comercial')`);
  let r = await bot.diz(NOVO, '/meus');
  assert.equal(r.final.resposta.codigo, 'NAO_IDENTIFICADO');
  // E-mail desconhecido: mesma resposta, nenhum e-mail enviado.
  r = await bot.diz(NOVO, '/vincular ninguem@ej.test');
  assert.equal(r.final.resposta.codigo, 'VINCULO_INICIADO');
  assert.equal(r.final.notificacoes.length, 0);
  r = await bot.diz(NOVO, '/vincular Nina@EJ.test');
  assert.equal(r.final.resposta.codigo, 'VINCULO_INICIADO');
  assert.equal(r.final.notificacoes.length, 1);
  const email = r.final.notificacoes[0];
  assert.equal(email.canal, 'email');
  assert.equal(email.destino, 'nina@ej.test');
  const codigo = /é: (\d{6})/.exec(email.texto)[1];
  assert.ok(!r.final.resposta.mensagem.includes(codigo), 'o código não pode ir pelo próprio chat');
  const errado = codigo === '000000' ? '111111' : '000000';
  r = await bot.diz(NOVO, `/codigo ${errado}`);
  assert.equal(r.final.resposta.codigo, 'CODIGO_INVALIDO');
  r = await bot.diz(NOVO, `/codigo ${codigo}`);
  assert.equal(r.final.resposta.codigo, 'VINCULO_CONFIRMADO', r.final.resposta.mensagem);
  r = await bot.diz(NOVO, '/meus');
  assert.equal(r.final.resposta.ok, true);
  // 5 erros invalidam o pedido.
  const OUTRO = 9002;
  await db.query(`INSERT INTO membros (nome, nome_ordenacao, email, diretoria) VALUES ('Otto Outro', 'otto outro', 'otto@ej.test', 'comercial')`);
  await bot.diz(OUTRO, '/vincular otto@ej.test');
  const real = (await db.query("SELECT codigo FROM vinculos_pendentes WHERE id_externo = '9002'")).rows[0].codigo;
  const ruim = real === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await bot.diz(OUTRO, `/codigo ${ruim}`);
  r = await bot.diz(OUTRO, `/codigo ${real}`);
  assert.equal(r.final.resposta.codigo, 'VINCULO_INEXISTENTE');
});

test('fluxo de impressão 3D: campos próprios (material, filamento) e contraproposta', async () => {
  const cod = await criarProjeto('Suporte de celular', 'impressao_modelagem_3d');
  const d = await projeto(db, cod);
  const tg = Number((await db.query('SELECT telegram_user_id t FROM membros WHERE id = $1', [d.projeto.etapa.responsavel_atribuido_id])).rows[0].t);
  let r = await bot.diz(tg, `/acao ${cod} enviar_escopo escopo="100 un" estimativa_filamento_g=1.500 material=madeira`);
  assert.match(r.final.resposta.mensagem, /escolha uma das opções/);
  r = await bot.clica(tg, 'val:PETG');
  assert.equal(r.final.resposta.codigo, 'CONFIRMACAO_PENDENTE', r.final.resposta.mensagem);
  r = await bot.clica(tg, 'ok');
  assert.equal(r.final.resposta.codigo, 'ACAO_REGISTRADA', r.final.resposta.mensagem);
  assert.equal(Number(r.resultado.projeto.estimativa_filamento_g), 1500);
  assert.equal(r.resultado.acao.dados.material, 'PETG');
  await consistente(cod);
});

test('consultas: /meus, /projetos, /projeto e /historico', async () => {
  const cod = await criarProjeto('Site Consultas');
  let r = await bot.diz(BRUNO, '/meus');                     // já está com Projetos
  assert.match(r.final.resposta.mensagem, new RegExp(cod));
  r = await bot.diz(CARLA, '/meus');
  assert.doesNotMatch(r.final.resposta.mensagem, new RegExp(cod));
  r = await bot.diz(FABIO, 'projetos consultas');           // sem barra, com filtro
  assert.match(r.final.resposta.mensagem, /Site Consultas/);
  r = await bot.diz(BRUNO, `/projeto ${cod.toLowerCase()}`);
  assert.match(r.final.resposta.mensagem, /Definição de escopo/);
  const dados = r.final.resposta.botoes.map((b) => b.dados);
  assert.ok(dados.includes(`acao:${cod}:enviar_escopo`));
  assert.ok(dados.every((x) => Buffer.byteLength(x) <= 64));
  r = await bot.diz(CARLA, `/projeto ${cod}`);              // outra diretoria: vê, mas sem botão de avançar
  assert.ok(!r.final.resposta.botoes.some((b) => b.dados.endsWith(':enviar_escopo')));
  r = await bot.clica(CARLA, `hist:${cod}`);
  assert.match(r.final.resposta.mensagem, /#1 .*Projeto criado \(Carla Souza\)/);
  r = await bot.diz(CARLA, '/projeto P-1999-0001');
  assert.equal(r.final.resposta.codigo, 'PROJETO_NAO_ENCONTRADO');
});

test('sync de membros: cria, atualiza, desativa quem saiu e reatribui etapas órfãs', async () => {
  const { validarLinhas } = require('../../lib/membros');
  const cod = await criarProjeto('Site Sync');
  const r0 = ultimaCriacao;
  const responsavel = r0.resultado.projeto.etapa.responsavel_nome;
  const atuais = (await db.query('SELECT * FROM membros WHERE NOT is_sistema AND ativo')).rows;
  const nomeDir = { comercial: 'Comercial', projetos: 'Projetos', financeiro: 'Financeiro', administrativo: 'Administrativo', presidencia: 'Presidência' };

  // Planilha vazia (erro de leitura) não desativa ninguém.
  assert.deepEqual(await chamar(db, 'sync_membros', { linhas: [] }), { ok: false, codigo: 'PLANILHA_VAZIA' });

  // Linhas no formato de lib/membros.js#montarLinhas (aba do ano).
  const linha = (m, k) => ({ linha: k + 2, nome: m.nome, email_utfpr: '', email_therion: m.email, telefone: '', data_saida: '',
    cargo: m.is_admin ? 'Diretor' : 'Assessor', diretoria: nomeDir[m.diretoria] });
  const ficam = atuais.filter((m) => m.nome !== responsavel);
  const planilha = ficam.map(linha);
  planilha.push({ linha: 90, nome: 'Zeca Novo', email_therion: 'zeca@ej.test', telefone: '(11) 98888-7777', cargo: 'Assessor', diretoria: 'Financeiro' });
  planilha.push({ linha: 91, nome: 'Velho Egresso', email_therion: 'velho@ej.test', cargo: 'Egresso', diretoria: 'Projetos' });
  // Linha com diretoria errada de alguém que já existe: NÃO pode desativá-lo.
  const protegido = ficam[0];
  planilha[0] = { ...planilha[0], diretoria: 'Diretoria Inexistente' };
  const { validas, erros, preservar } = validarLinhas(planilha);
  assert.equal(erros.length, 1);
  assert.deepEqual(preservar, [protegido.email]);

  // Disponibilidade e canal são do app: o sync não mexe.
  await db.query("UPDATE membros SET disponivel = false, canal_preferido = 'telegram' WHERE email = $1", [ficam[1].email]);

  // Simulação não altera nada.
  const antes = (await db.query('SELECT count(*)::int n FROM membros WHERE ativo')).rows[0].n;
  const sim = await chamar(db, 'sync_membros', { linhas: validas, preservar, simular: true });
  assert.equal(sim.ok, true); assert.equal(sim.simulado, true);
  assert.deepEqual(sim.novos.map((n) => n.email), ['zeca@ej.test']);
  assert.equal((await db.query('SELECT count(*)::int n FROM membros WHERE ativo')).rows[0].n, antes);
  assert.equal((await db.query("SELECT count(*)::int n FROM membros WHERE email = 'zeca@ej.test'")).rows[0].n, 0);

  // Trava de massa: tirar todo mundo da planilha é bloqueado (sem gravar nada).
  const massa = await chamar(db, 'sync_membros', { linhas: validas.slice(-2), max_desativacoes: 2 });
  assert.equal(massa.codigo, 'DESATIVACAO_EM_MASSA');
  assert.equal((await db.query('SELECT count(*)::int n FROM membros WHERE ativo')).rows[0].n, antes);

  const r = await chamar(db, 'sync_membros', { linhas: validas, preservar });
  assert.equal(r.ok, true); assert.equal(r.simulado, false);
  assert.deepEqual(r.novos.map((n) => n.email), ['zeca@ej.test']);
  assert.deepEqual(r.desativados.map((n) => n.nome), [responsavel]);
  assert.deepEqual(r.ignorados.map((n) => n.email), ['velho@ej.test'], 'egresso novo não é criado');
  assert.equal(r.reatribuicoes.length >= 1, true);
  assert.ok(r.reatribuicoes.every((x) => x.ok), JSON.stringify(r.reatribuicoes));
  assert.equal((await db.query('SELECT ativo FROM membros WHERE email = $1', [protegido.email])).rows[0].ativo, true);
  const pref = (await db.query('SELECT disponivel, canal_preferido FROM membros WHERE email = $1', [ficam[1].email])).rows[0];
  assert.deepEqual(pref, { disponivel: false, canal_preferido: 'telegram' });

  const d = await consistente(cod);
  assert.notEqual(d.projeto.etapa.responsavel_nome, responsavel);
  assert.ok(d.projeto.etapa.responsavel_nome);
  const zeca = (await db.query("SELECT * FROM membros WHERE email = 'zeca@ej.test'")).rows[0];
  assert.equal(zeca.telefone_e164, '+5511988887777');
  assert.equal(zeca.is_admin, false);
  // O sync não apaga vínculos do Telegram.
  const carla = (await db.query("SELECT telegram_user_id t FROM membros WHERE email = 'carla@ej.test'")).rows[0];
  assert.equal(Number(carla.t), CARLA);
  // Membro desativado não é mais reconhecido.
  const tgSaiu = Number(atuais.find((m) => m.nome === responsavel).telegram_user_id);
  const fora = await bot.diz(tgSaiu, '/meus');
  assert.equal(fora.final.resposta.codigo, 'NAO_IDENTIFICADO');

  // Promoção a admin pela planilha aparece no relatório.
  const promovido = linha({ ...zeca, is_admin: true }, 0);
  const r2 = await chamar(db, 'sync_membros', { linhas: [...validas.filter((v) => v.email !== 'zeca@ej.test'), ...validarLinhas([promovido]).validas], preservar });
  assert.deepEqual(r2.admins_alterados.map((x) => [x.email, x.admin]), [['zeca@ej.test', true]]);

  // /sync: só admin; gera o efeito para o WF-09.
  const naoAdmin = await bot.diz(CARLA, '/sync');
  assert.equal(naoAdmin.final.resposta.codigo, 'NAO_AUTORIZADO');
  const admin = await bot.diz(ADA, '/sync');
  assert.equal(admin.final.resposta.codigo, 'SYNC_INICIADO');
  assert.deepEqual(admin.final.efeitos.map((e) => [e.tipo, e.simular, e.forcar]), [['sync_membros', true, false]]);
  const aplicar = await bot.clica(ADA, 'sync:aplicar');
  assert.deepEqual(aplicar.final.efeitos.map((e) => [e.simular, e.forcar]), [[false, false]]);
});

test('consultas nomeadas (sql/consultas.sql) e views (sql/views.sql)', async () => {
  const cod = await criarProjeto('Site Relatórios');
  await avancarAte(cod, 'elaboracao_orcamento');
  const carla = (await db.query("SELECT id FROM membros WHERE telegram_user_id = $1", [CARLA])).rows[0].id;
  const pend = (await db.query('SELECT * FROM listar_projetos()')).rows;
  assert.ok(pend.some((p) => p.codigo === cod && p.diretoria === 'financeiro'));
  assert.ok((await db.query("SELECT * FROM listar_projetos('financeiro')")).rows.some((p) => p.codigo === cod));
  assert.ok(!(await db.query("SELECT * FROM listar_projetos('comercial')")).rows.some((p) => p.codigo === cod));
  assert.ok(!(await db.query('SELECT * FROM meus_pendentes($1)', [carla])).rows.some((p) => p.codigo === cod));
  const hist = (await db.query('SELECT * FROM historico($1)', [cod.toLowerCase()])).rows;
  assert.deepEqual(hist.map((h) => h.seq), [1, 2, 3]);
  assert.equal((await db.query('SELECT detalhes_projeto($1) AS d', [cod])).rows[0].d.codigo, cod);
  // força vencimento e confere etapas_vencidas
  await db.query("UPDATE etapas SET prazo_sla = now() - interval '2 hours' WHERE id = (SELECT etapa_atual_id FROM projetos WHERE codigo = $1)", [cod]);
  assert.ok((await db.query('SELECT * FROM etapas_vencidas()')).rows.some((e) => e.projeto_codigo === cod));
  const pipe = (await db.query("SELECT * FROM vw_pipeline WHERE etapa_chave = 'elaboracao_orcamento'")).rows;
  assert.ok(pipe.reduce((s, l) => s + Number(l.vencidos), 0) >= 1);
  const tempo = (await db.query("SELECT * FROM vw_tempo_medio_etapa WHERE etapa_chave = 'registro_lead'")).rows;
  assert.ok(Number(tempo[0].passagens) >= 1);
  await db.query('SELECT * FROM vw_conversao');
});

test('criação já encaminha: arquivo do cliente vai na ação de encaminhamento (3D)', async () => {
  let r = await bot.diz(CARLA, '/novo');
  await bot.clica(CARLA, 'val:impressao_modelagem_3d');
  await bot.diz(CARLA, 'Engrenagens');
  await bot.diz(CARLA, 'Oficina X');
  await bot.diz(CARLA, '(43) 99999-0000');
  r = await bot.clica(CARLA, 'pular');                         // lead
  assert.match(r.final.resposta.mensagem, /Descrição da demanda/);
  assert.doesNotMatch(r.final.resposta.mensagem, /Descrição inicial/);
  await bot.diz(CARLA, '20 engrenagens em PETG');
  r = await bot.diz(CARLA, '31/12/2030');                      // prazo
  assert.match(r.final.resposta.mensagem, /Arquivo\/referência do cliente/);
  r = await bot.diz(CARLA, '', { arquivo: 'engrenagem.stl' });
  assert.equal(r.final.resposta.codigo, 'CONFIRMACAO_PENDENTE', r.final.resposta.mensagem);
  assert.match(r.final.resposta.mensagem, /engrenagem\.stl/);
  r = await bot.clica(CARLA, 'ok');
  assert.equal(r.final.resposta.codigo, 'PROJETO_CRIADO', r.final.resposta.mensagem);
  const d = await consistente(r.resultado.projeto.codigo);
  assert.equal(d.projeto.etapa.chave, 'definicao_escopo');
  assert.ok(d.projeto.etapa.responsavel_atribuido_id, 'rodízio atribuiu alguém de Projetos');
  assert.equal(d.projeto.descricao, '20 engrenagens em PETG');
  const enc = d.acoes.find((a) => a.tipo_acao === 'enviar_para_escopo');
  assert.equal(enc.seq, 2);
  assert.equal(enc.dados.prazo_desejado, '2030-12-31');
  assert.equal(enc.arquivos[0].campo, 'arquivo_cliente');
  assert.equal(enc.arquivos[0].nome, 'engrenagem.stl');
  // Quem recebe a notificação é Projetos, não quem criou.
  const dest = r.final.notificacoes.map((n) => n.destino);
  assert.ok(!dest.includes(String(CARLA)));
  assert.ok(dest.length >= 1);
});
