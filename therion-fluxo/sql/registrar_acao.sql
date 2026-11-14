-- =====================================================================================
-- Therion Fluxo — funções de gravação e leitura (PL/pgSQL)
--
-- Cada função é chamada como UM statement (`SELECT fn($1::jsonb)`), portanto é atômica.
-- A validação "rica" (campos, guardas, mensagens) é feita antes em JavaScript (lib/motor.js);
-- aqui ficam a gravação atômica, o controle de concorrência e uma revalidação mínima
-- (membro ativo, transição existe, diretoria confere) como defesa em profundidade.
--
-- Erros de negócio NÃO lançam exceção: retornam {"ok": false, "codigo": "..."}.
-- Idempotente: pode ser reaplicado (CREATE OR REPLACE).
-- =====================================================================================

-- ------------------------------------------------------------------------------- utilitários
CREATE OR REPLACE FUNCTION _erro(p_codigo text, p_extra jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('ok', false, 'codigo', p_codigo) || coalesce(p_extra, '{}'::jsonb);
$$;

-- Projeto + cliente + etapa atual (com nome do responsável) num único JSON.
CREATE OR REPLACE FUNCTION _projeto_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(p)
      || jsonb_build_object(
           'cliente', to_jsonb(c),
           'membro_original_nome', mo.nome,
           'etapa', CASE WHEN e.id IS NULL THEN NULL
                         ELSE to_jsonb(e) || jsonb_build_object('responsavel_nome', r.nome) END)
  FROM projetos p
  JOIN clientes c ON c.id = p.cliente_id
  JOIN membros mo ON mo.id = p.membro_original_id
  LEFT JOIN etapas e ON e.id = p.etapa_atual_id
  LEFT JOIN membros r ON r.id = e.responsavel_atribuido_id
  WHERE p.id = p_id;
$$;

-- Último valor numérico (de ações não revertidas) de uma chave de `dados`.
CREATE OR REPLACE FUNCTION _ultimo_dado(p_projeto uuid, p_chave text) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT (dados->>p_chave)::numeric
  FROM acoes
  WHERE projeto_id = p_projeto AND revertida_por_id IS NULL AND tipo_acao <> 'reverter'
    AND jsonb_typeof(dados->p_chave) = 'number'
  ORDER BY seq DESC LIMIT 1;
$$;

-- Recalcula os campos projetados do projeto a partir dos eventos não revertidos
-- (equivalente SQL de lib/projecao.js#projetarEstado para os campos numéricos).
CREATE OR REPLACE FUNCTION _reprojetar(p_projeto uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE projetos SET
    estimativa_horas       = _ultimo_dado(p_projeto, 'estimativa_horas'),
    estimativa_filamento_g = _ultimo_dado(p_projeto, 'estimativa_filamento_g'),
    valor_orcado           = _ultimo_dado(p_projeto, 'valor_orcado'),
    valor_contratado       = _ultimo_dado(p_projeto, 'valor_contratado')
  WHERE id = p_projeto;
$$;

-- ---------------------------------------------------------------------------------- rodízio
-- Round robin alfabético (§8.5): próximo membro ativo+disponível da diretoria cujo
-- (nome_ordenacao, id) é maior que o do último atribuído; se não houver, volta ao início.
-- Mesmo algoritmo de lib/rodizio.js#escolherResponsavel.
CREATE OR REPLACE FUNCTION _proximo_rodizio(p_chave text, p_diretoria diretoria_t) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_ultimo uuid; v_ord text; v_id uuid;
BEGIN
  INSERT INTO rodizio (chave_etapa, diretoria) VALUES (p_chave, p_diretoria) ON CONFLICT DO NOTHING;
  SELECT ultimo_membro_id INTO v_ultimo FROM rodizio
   WHERE chave_etapa = p_chave AND diretoria = p_diretoria FOR UPDATE;
  SELECT nome_ordenacao INTO v_ord FROM membros WHERE id = v_ultimo;

  IF v_ord IS NOT NULL THEN
    SELECT id INTO v_id FROM membros
     WHERE diretoria = p_diretoria AND ativo AND disponivel AND NOT is_sistema
       AND (nome_ordenacao COLLATE "C", id) > (v_ord COLLATE "C", v_ultimo)
     ORDER BY nome_ordenacao COLLATE "C", id LIMIT 1;
  END IF;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM membros
     WHERE diretoria = p_diretoria AND ativo AND disponivel AND NOT is_sistema
     ORDER BY nome_ordenacao COLLATE "C", id LIMIT 1;
  END IF;
  IF v_id IS NOT NULL THEN
    UPDATE rodizio SET ultimo_membro_id = v_id WHERE chave_etapa = p_chave AND diretoria = p_diretoria;
  END IF;
  RETURN v_id;
END $$;

-- Fecha a etapa aberta do projeto e abre uma nova (definida no template).
-- p_resp_preferido: reaproveitado se ainda ativo+disponível (usado na reversão).
CREATE OR REPLACE FUNCTION _entrar_etapa(p_projeto uuid, p_tpl jsonb, p_chave text,
                                         p_resp_preferido uuid, p_rodizio boolean) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_def jsonb := p_tpl->'etapas'->p_chave;
  v_dir diretoria_t; v_resp uuid; v_prazo timestamptz; v_id uuid;
BEGIN
  IF v_def IS NULL THEN RAISE EXCEPTION 'etapa % não existe no template', p_chave; END IF;
  v_dir := (v_def->>'diretoria')::diretoria_t;

  IF p_resp_preferido IS NOT NULL THEN
    SELECT id INTO v_resp FROM membros WHERE id = p_resp_preferido AND ativo AND disponivel;
  END IF;
  IF v_resp IS NULL AND p_rodizio AND coalesce((v_def->>'rodizio')::boolean, false) THEN
    v_resp := _proximo_rodizio(p_chave, v_dir);
  END IF;
  IF v_def->>'sla_horas' IS NOT NULL THEN
    v_prazo := now() + ((v_def->>'sla_horas')::numeric * interval '1 hour');
  END IF;

  UPDATE etapas SET data_saida = now() WHERE projeto_id = p_projeto AND data_saida IS NULL;
  INSERT INTO etapas (projeto_id, chave, nome, diretoria_responsavel, responsavel_atribuido_id, prazo_sla)
  VALUES (p_projeto, p_chave, v_def->>'nome', v_dir, v_resp, v_prazo)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Quem deve ser notificado sobre a etapa: responsável atribuído (ou a diretoria inteira se
-- não houver), opcionalmente o membro que trouxe o projeto e um membro extra (ex.: quem estava
-- na etapa desfeita por uma reversão). Nunca inclui o autor da ação nem o usuário-sistema.
CREATE OR REPLACE FUNCTION _destinatarios(p_etapa_id uuid, p_ator uuid, p_incluir_etapa boolean,
                                          p_incluir_origem boolean, p_extra uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(s.d), '[]'::jsonb) FROM (
    SELECT DISTINCT ON (m.id) jsonb_build_object(
             'membro_id', m.id, 'nome', m.nome, 'email', m.email,
             'telegram_user_id', m.telegram_user_id, 'canal_preferido', m.canal_preferido,
             'canais_habilitados', m.canais_habilitados, 'motivo', x.motivo) AS d
    FROM (
      SELECT p_extra AS id, 'reversao' AS motivo, 0 AS ord WHERE p_extra IS NOT NULL
      UNION ALL
      SELECT e.responsavel_atribuido_id, 'responsavel', 1 FROM etapas e
       WHERE e.id = p_etapa_id AND p_incluir_etapa AND e.responsavel_atribuido_id IS NOT NULL
      UNION ALL
      SELECT m2.id, 'diretoria', 2 FROM etapas e
        JOIN membros m2 ON m2.diretoria = e.diretoria_responsavel
       WHERE e.id = p_etapa_id AND p_incluir_etapa AND e.responsavel_atribuido_id IS NULL
      UNION ALL
      SELECT p.membro_original_id, 'origem', 3 FROM etapas e
        JOIN projetos p ON p.id = e.projeto_id
       WHERE e.id = p_etapa_id AND p_incluir_origem
    ) x
    JOIN membros m ON m.id = x.id
    WHERE m.ativo AND NOT m.is_sistema AND m.id IS DISTINCT FROM p_ator
    ORDER BY m.id, x.ord
  ) s;
$$;

-- ---------------------------------------------------------------------------- criar_projeto
-- Entrada: { membro_id, canal, idempotency_key, nome, tipo, nome_lead, descricao,
--            cliente: {nome, email, telefone, documento}, rodizio_ativo }
CREATE OR REPLACE FUNCTION criar_projeto(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_m membros; v_tpl templates_fluxo; v_cliente uuid; v_ano int; v_n int; v_codigo text;
  v_proj uuid; v_etapa uuid; v_acao uuid := gen_random_uuid(); v_enc jsonb;
  v_email text := nullif(lower(trim(p->'cliente'->>'email')), '');
  v_def jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM acoes WHERE idempotency_key = p->>'idempotency_key') THEN
    RETURN _erro('DUPLICADA');
  END IF;
  SELECT * INTO v_m FROM membros WHERE id = (p->>'membro_id')::uuid;
  IF NOT FOUND OR NOT v_m.ativo THEN RETURN _erro('NAO_AUTORIZADO'); END IF;
  IF NOT (v_m.is_admin OR v_m.diretoria IN ('presidencia', 'comercial')) THEN
    RETURN _erro('NAO_AUTORIZADO');
  END IF;
  IF coalesce(trim(p->>'nome'), '') = '' OR coalesce(trim(p->'cliente'->>'nome'), '') = '' THEN
    RETURN _erro('CAMPOS_FALTANTES');
  END IF;

  SELECT * INTO v_tpl FROM templates_fluxo
   WHERE tipo_servico = p->>'tipo' AND ativo ORDER BY versao DESC LIMIT 1;
  IF NOT FOUND THEN RETURN _erro('TIPO_INVALIDO'); END IF;
  v_def := v_tpl.definicao;

  IF v_email IS NOT NULL THEN
    SELECT id INTO v_cliente FROM clientes WHERE lower(email) = v_email ORDER BY criado_em LIMIT 1;
  END IF;
  IF v_cliente IS NULL THEN
    INSERT INTO clientes (nome, email, telefone, documento)
    VALUES (trim(p->'cliente'->>'nome'), v_email, nullif(trim(p->'cliente'->>'telefone'), ''),
            nullif(trim(p->'cliente'->>'documento'), ''))
    RETURNING id INTO v_cliente;
  END IF;

  v_ano := extract(year FROM now() AT TIME ZONE 'America/Sao_Paulo')::int;
  INSERT INTO sequencias_codigo (ano, ultimo) VALUES (v_ano, 1)
  ON CONFLICT (ano) DO UPDATE SET ultimo = sequencias_codigo.ultimo + 1
  RETURNING ultimo INTO v_n;
  v_codigo := 'P-' || v_ano || '-' || lpad(v_n::text, 4, '0');

  INSERT INTO projetos (codigo, nome, cliente_id, nome_lead, descricao, tipo, template_versao, membro_original_id)
  VALUES (v_codigo, trim(p->>'nome'), v_cliente, coalesce(nullif(trim(p->>'nome_lead'), ''), trim(p->'cliente'->>'nome')),
          nullif(trim(p->>'descricao'), ''), v_tpl.tipo_servico, v_tpl.versao, v_m.id)
  RETURNING id INTO v_proj;

  v_etapa := _entrar_etapa(v_proj, v_def, v_def->>'etapa_inicial', NULL,
                           coalesce((p->>'rodizio_ativo')::boolean, true));
  UPDATE projetos SET etapa_atual_id = v_etapa WHERE id = v_proj;

  INSERT INTO acoes (id, projeto_id, seq, tipo_acao, etapa_origem_id, etapa_destino_id, status_anterior,
                     status_novo, membro_id, nome_responsavel, canal_origem, dados, idempotency_key)
  VALUES (v_acao, v_proj, 1, 'criar_projeto', NULL, v_etapa, 'ativo', 'ativo', v_m.id, v_m.nome,
          (p->>'canal')::canal_t,
          jsonb_strip_nulls(jsonb_build_object('descricao', nullif(trim(p->>'descricao'), ''))),
          p->>'idempotency_key');

  -- Ação de criação (template.acao_na_criacao): executada na MESMA transação, como uma ação comum
  -- (seq 2, reversível). Se falhar, a criação inteira é desfeita.
  IF v_def->>'acao_na_criacao' IS NOT NULL AND p ? 'encaminhar' THEN
    v_enc := registrar_acao(jsonb_build_object(
      'projeto_id', v_proj, 'tipo_acao', v_def->>'acao_na_criacao', 'membro_id', v_m.id,
      'canal', p->>'canal', 'dados', coalesce(p->'encaminhar'->'dados', '{}'::jsonb),
      'observacoes', p->'encaminhar'->>'observacoes', 'arquivos', coalesce(p->'arquivos', '[]'::jsonb),
      'idempotency_key', (p->>'idempotency_key') || ':criacao',
      'rodizio_ativo', coalesce((p->>'rodizio_ativo')::boolean, true)));
    IF NOT (v_enc->>'ok')::boolean THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'encaminhar:' || coalesce(v_enc->>'codigo', 'ERRO_INTERNO');
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'codigo', 'PROJETO_CRIADO', 'encaminhado', true,
      'acao', v_enc->'acao',
      'projeto', v_enc->'projeto',
      'mudou_etapa', true,
      'efeitos', '["criar_pasta_drive"]'::jsonb || coalesce(v_enc->'efeitos', '[]'::jsonb),
      'subpastas', (SELECT coalesce(jsonb_agg(DISTINCT e.value->>'pasta'), '[]'::jsonb)
                      FROM jsonb_each(v_def->'etapas') e WHERE e.value->>'pasta' IS NOT NULL),
      'destinatarios', v_enc->'destinatarios');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'codigo', 'PROJETO_CRIADO',
    'acao', (SELECT to_jsonb(a) FROM acoes a WHERE a.id = v_acao),
    'projeto', _projeto_json(v_proj),
    'mudou_etapa', true,
    'efeitos', '["criar_pasta_drive"]'::jsonb,
    'subpastas', (SELECT coalesce(jsonb_agg(DISTINCT e.value->>'pasta'), '[]'::jsonb)
                    FROM jsonb_each(v_def->'etapas') e WHERE e.value->>'pasta' IS NOT NULL),
    'destinatarios', _destinatarios(v_etapa, v_m.id, true, false, NULL));
EXCEPTION
  WHEN unique_violation THEN RETURN _erro('CONFLITO');
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'encaminhar:%' THEN RETURN _erro(substr(SQLERRM, 12)); END IF;
    RAISE;
END $$;

-- --------------------------------------------------------------------------- registrar_acao
-- Entrada (o "plano" produzido por lib/motor.js#planejarAcao):
--   { projeto_id, versao_esperada, tipo_acao, membro_id, canal, dados, observacoes, arquivos,
--     idempotency_key, reverte_acao_id?, janela_reversao_horas?, rodizio_ativo? }
-- Saída: { ok, codigo, acao, projeto, etapa_anterior, mudou_etapa, efeitos[], destinatarios[],
--          acao_revertida? }
CREATE OR REPLACE FUNCTION registrar_acao(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_proj projetos; v_m membros; v_tpl jsonb; v_etapa etapas; v_alvo acoes; v_origem etapas;
  v_tipo text := p->>'tipo_acao';
  v_dados jsonb := coalesce(p->'dados', '{}'::jsonb);
  v_rodizio boolean := coalesce((p->>'rodizio_ativo')::boolean, true);
  v_janela numeric := coalesce((p->>'janela_reversao_horas')::numeric, 48);
  v_super boolean; v_terminal boolean; v_mudou boolean := false;
  v_trans jsonb; v_para text; v_dest_def jsonb; v_efeitos jsonb := '[]'::jsonb;
  v_status_novo status_projeto_t; v_final timestamptz;
  v_nova_etapa uuid; v_acao uuid := gen_random_uuid(); v_seq int;
  v_resp uuid; v_extra uuid; v_pausa timestamptz; v_etapa_final uuid; v_final_terminal boolean;
BEGIN
  SELECT * INTO v_proj FROM projetos WHERE id = (p->>'projeto_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN _erro('PROJETO_NAO_ENCONTRADO'); END IF;
  -- Checado depois do lock: uma reentrega concorrente espera aqui e então cai neste teste.
  IF EXISTS (SELECT 1 FROM acoes WHERE idempotency_key = p->>'idempotency_key') THEN
    RETURN _erro('DUPLICADA');
  END IF;
  IF p->>'versao_esperada' IS NOT NULL AND v_proj.versao <> (p->>'versao_esperada')::int THEN
    RETURN _erro('CONFLITO');
  END IF;

  SELECT * INTO v_m FROM membros WHERE id = (p->>'membro_id')::uuid;
  IF NOT FOUND OR NOT v_m.ativo THEN RETURN _erro('NAO_AUTORIZADO'); END IF;
  v_super := v_m.is_admin OR v_m.diretoria = 'presidencia';

  SELECT definicao INTO v_tpl FROM templates_fluxo
   WHERE tipo_servico = v_proj.tipo AND versao = v_proj.template_versao;
  SELECT * INTO v_etapa FROM etapas WHERE id = v_proj.etapa_atual_id;
  v_terminal := coalesce((v_tpl->'etapas'->v_etapa.chave->>'terminal')::boolean, false);
  v_status_novo := v_proj.status;
  v_final := v_proj.data_final;

  CASE v_tipo
  WHEN 'pausar' THEN
    IF v_proj.status <> 'ativo' OR v_terminal THEN RETURN _erro('TRANSICAO_INVALIDA'); END IF;
    v_status_novo := 'pausado';

  WHEN 'retomar' THEN
    IF v_proj.status <> 'pausado' THEN RETURN _erro('TRANSICAO_INVALIDA'); END IF;
    v_status_novo := 'ativo';
    -- O prazo da etapa é empurrado pelo tempo que o projeto ficou pausado (§8.4).
    SELECT criado_em INTO v_pausa FROM acoes
     WHERE projeto_id = v_proj.id AND tipo_acao = 'pausar' AND revertida_por_id IS NULL
     ORDER BY seq DESC LIMIT 1;
    IF v_pausa IS NOT NULL THEN
      UPDATE etapas SET prazo_sla = prazo_sla + (now() - v_pausa)
       WHERE id = v_etapa.id AND prazo_sla IS NOT NULL;
    END IF;

  WHEN 'abandonar' THEN
    IF v_proj.status NOT IN ('ativo', 'pausado') OR v_terminal OR v_tpl->'etapas'->'abandonado' IS NULL THEN
      RETURN _erro('TRANSICAO_INVALIDA');
    END IF;
    v_nova_etapa := _entrar_etapa(v_proj.id, v_tpl, 'abandonado', NULL, false);
    v_mudou := true;
    v_status_novo := 'abandonado';
    v_final := now();

  WHEN 'comentar' THEN
    IF v_proj.status NOT IN ('ativo', 'pausado') THEN RETURN _erro('TRANSICAO_INVALIDA'); END IF;

  WHEN 'reatribuir' THEN
    IF v_proj.status NOT IN ('ativo', 'pausado') OR v_terminal THEN RETURN _erro('TRANSICAO_INVALIDA'); END IF;
    IF NOT (v_super OR v_m.diretoria = v_etapa.diretoria_responsavel) THEN RETURN _erro('NAO_AUTORIZADO'); END IF;
    v_resp := nullif(v_dados->>'novo_responsavel_id', '')::uuid;
    IF v_resp IS NULL THEN
      v_resp := _proximo_rodizio(v_etapa.chave, v_etapa.diretoria_responsavel);  -- pode ser NULL: ninguém disponível
    -- Admin/Presidência podem designar qualquer membro ativo; a diretoria, só alguém dela.
    ELSIF NOT EXISTS (SELECT 1 FROM membros WHERE id = v_resp AND ativo AND NOT is_sistema
                         AND (v_super OR diretoria = v_etapa.diretoria_responsavel)) THEN
      RETURN _erro('RESPONSAVEL_INVALIDO');
    END IF;
    UPDATE etapas SET responsavel_atribuido_id = v_resp WHERE id = v_etapa.id;
    v_dados := v_dados || jsonb_build_object(
      'novo_responsavel_id', v_resp, 'responsavel_anterior_id', v_etapa.responsavel_atribuido_id);

  WHEN 'reverter' THEN
    -- Alvo: sempre a última ação efetiva ainda não revertida (§8.3). Nada é apagado.
    SELECT * INTO v_alvo FROM acoes
     WHERE projeto_id = v_proj.id AND revertida_por_id IS NULL
       AND tipo_acao NOT IN ('reverter', 'criar_projeto', 'comentar', 'reatribuir')
     ORDER BY seq DESC LIMIT 1;
    IF NOT FOUND THEN RETURN _erro('NADA_A_REVERTER'); END IF;
    IF p->>'reverte_acao_id' IS NOT NULL AND v_alvo.id <> (p->>'reverte_acao_id')::uuid THEN
      RETURN _erro('CONFLITO');
    END IF;
    IF NOT v_super AND (v_terminal OR v_alvo.membro_id <> v_m.id
                        OR v_alvo.criado_em < now() - (v_janela * interval '1 hour')) THEN
      RETURN _erro('NAO_AUTORIZADO');
    END IF;
    v_status_novo := v_alvo.status_anterior;
    IF v_alvo.etapa_destino_id IS NOT NULL AND v_alvo.etapa_origem_id IS NOT NULL
       AND v_alvo.etapa_destino_id <> v_alvo.etapa_origem_id THEN
      SELECT * INTO v_origem FROM etapas WHERE id = v_alvo.etapa_origem_id;
      v_extra := v_etapa.responsavel_atribuido_id;     -- quem estava na etapa desfeita
      v_nova_etapa := _entrar_etapa(v_proj.id, v_tpl, v_origem.chave, v_origem.responsavel_atribuido_id, v_rodizio);
      v_mudou := true;
    END IF;
    IF v_status_novo IN ('ativo', 'pausado') THEN v_final := NULL; END IF;

  ELSE
    -- Transição definida no template do projeto.
    SELECT t INTO v_trans FROM jsonb_array_elements(v_tpl->'transicoes') t
     WHERE t->>'acao' = v_tipo AND t->'de' ? v_etapa.chave LIMIT 1;
    IF v_trans IS NULL OR v_proj.status <> 'ativo' THEN RETURN _erro('TRANSICAO_INVALIDA'); END IF;
    IF NOT (v_super OR v_m.diretoria = v_etapa.diretoria_responsavel
            OR v_m.id = v_etapa.responsavel_atribuido_id) THEN RETURN _erro('NAO_AUTORIZADO'); END IF;
    v_para := v_trans->>'para';
    v_efeitos := coalesce(v_trans->'efeitos', '[]'::jsonb);
    IF v_para <> v_etapa.chave THEN            -- self-loop (ex.: registrar_parcela) não troca de etapa
      v_dest_def := v_tpl->'etapas'->v_para;
      v_nova_etapa := _entrar_etapa(v_proj.id, v_tpl, v_para, NULL, v_rodizio);
      v_mudou := true;
      IF coalesce((v_dest_def->>'terminal')::boolean, false) THEN
        v_status_novo := coalesce(v_dest_def->>'status_projeto', 'concluido')::status_projeto_t;
        v_final := now();
      END IF;
    END IF;
  END CASE;

  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM acoes WHERE projeto_id = v_proj.id;
  INSERT INTO acoes (id, projeto_id, seq, tipo_acao, etapa_origem_id, etapa_destino_id, status_anterior,
                     status_novo, membro_id, nome_responsavel, canal_origem, dados, observacoes, arquivos,
                     reverte_acao_id, idempotency_key)
  VALUES (v_acao, v_proj.id, v_seq, v_tipo, v_etapa.id, v_nova_etapa, v_proj.status, v_status_novo,
          v_m.id, v_m.nome, (p->>'canal')::canal_t, v_dados, nullif(trim(p->>'observacoes'), ''),
          coalesce(p->'arquivos', '[]'::jsonb),
          CASE WHEN v_tipo = 'reverter' THEN v_alvo.id END, p->>'idempotency_key');

  IF v_tipo = 'reverter' THEN
    UPDATE acoes SET revertida_por_id = v_acao WHERE id = v_alvo.id;
  END IF;

  v_etapa_final := coalesce(v_nova_etapa, v_etapa.id);
  UPDATE projetos SET etapa_atual_id = v_etapa_final, status = v_status_novo, data_final = v_final,
                      versao = versao + 1
   WHERE id = v_proj.id;
  PERFORM _reprojetar(v_proj.id);

  SELECT coalesce((v_tpl->'etapas'->e.chave->>'terminal')::boolean, false) INTO v_final_terminal
    FROM etapas e WHERE e.id = v_etapa_final;

  RETURN jsonb_build_object(
    'ok', true, 'codigo', 'ACAO_REGISTRADA',
    'acao', (SELECT to_jsonb(a) FROM acoes a WHERE a.id = v_acao),
    'projeto', _projeto_json(v_proj.id),
    'etapa_anterior', to_jsonb(v_etapa),
    'mudou_etapa', v_mudou,
    'efeitos', v_efeitos,
    'acao_revertida', CASE WHEN v_tipo = 'reverter' THEN to_jsonb(v_alvo) END,
    'destinatarios', _destinatarios(
        v_etapa_final, v_m.id,
        NOT v_final_terminal,
        v_mudou OR v_status_novo <> v_proj.status,
        v_extra));
EXCEPTION WHEN unique_violation THEN
  RETURN _erro('CONFLITO');
END $$;

-- ------------------------------------------------------------------------------ ctx_entrada
-- Primeiro passo de toda requisição: idempotência, rate limit, identificação e sessão.
-- Entrada: { canal, id_externo, idempotency_key, rate_limit }
CREATE OR REPLACE FUNCTION ctx_entrada(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_canal canal_t := (p->>'canal')::canal_t;
  v_id text := p->>'id_externo';
  v_m membros; v_sessao jsonb; v_n int;
BEGIN
  IF v_canal = 'telegram' AND v_id ~ '^[0-9]{1,18}$' THEN
    SELECT * INTO v_m FROM membros WHERE telegram_user_id = v_id::bigint AND ativo;
  ELSIF v_canal IN ('email', 'forms') THEN
    SELECT * INTO v_m FROM membros WHERE email = lower(v_id) AND ativo AND NOT is_sistema;
  ELSIF v_canal = 'whatsapp' THEN
    SELECT * INTO v_m FROM membros WHERE telefone_e164 = v_id AND ativo;
  END IF;

  SELECT estado INTO v_sessao FROM sessoes_chat
   WHERE canal = v_canal AND id_externo = v_id AND expira_em > now();
  SELECT count(*) INTO v_n FROM requisicoes_processadas
   WHERE canal = v_canal AND id_externo = v_id AND criado_em > now() - interval '1 minute';

  RETURN jsonb_build_object(
    'ja_processada', EXISTS (SELECT 1 FROM requisicoes_processadas WHERE idempotency_key = p->>'idempotency_key'),
    'rate_ok', v_n < coalesce((p->>'rate_limit')::int, 20),
    'membro', CASE WHEN v_m.id IS NULL THEN NULL ELSE to_jsonb(v_m) END,
    'sessao', v_sessao);
END $$;

-- --------------------------------------------------------------------------- carregar_dados
-- Tudo que lib/app.js precisa para responder a um comando, numa única ida ao banco.
CREATE OR REPLACE FUNCTION carregar_dados(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_membro uuid := nullif(p->>'membro_id', '')::uuid;
  v_codigo text := upper(nullif(trim(p->>'projeto_codigo'), ''));
  v_m membros; v_proj projetos; v_etapa etapas; v_out jsonb;
BEGIN
  IF v_membro IS NULL THEN RETURN '{}'::jsonb; END IF;
  SELECT * INTO v_m FROM membros WHERE id = v_membro;

  v_out := jsonb_build_object(
    'tipos_servico', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('tipo_servico', t.tipo_servico,
                 'nome_exibicao', coalesce(t.definicao->>'nome_exibicao', t.tipo_servico),
                 'acao_na_criacao', t.definicao->>'acao_na_criacao',
                 'campos_criacao', (SELECT tr->'campos' FROM jsonb_array_elements(t.definicao->'transicoes') tr
                                     WHERE tr->>'acao' = t.definicao->>'acao_na_criacao' LIMIT 1))
                 ORDER BY t.tipo_servico), '[]'::jsonb)
      FROM (SELECT DISTINCT ON (tipo_servico) * FROM templates_fluxo WHERE ativo
            ORDER BY tipo_servico, versao DESC) t),
    'projetos', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'codigo', pr.codigo, 'nome', pr.nome, 'tipo', pr.tipo, 'status', pr.status,
                 'etapa_chave', e.chave, 'etapa_nome', e.nome, 'diretoria', e.diretoria_responsavel,
                 'responsavel_id', e.responsavel_atribuido_id, 'responsavel_nome', r.nome,
                 'prazo_sla', e.prazo_sla) ORDER BY pr.codigo), '[]'::jsonb)
      FROM projetos pr
      JOIN etapas e ON e.id = pr.etapa_atual_id
      LEFT JOIN membros r ON r.id = e.responsavel_atribuido_id
      WHERE pr.status IN ('ativo', 'pausado')));

  IF v_codigo IS NOT NULL THEN
    SELECT * INTO v_proj FROM projetos WHERE codigo = v_codigo;
    IF FOUND THEN
      SELECT * INTO v_etapa FROM etapas WHERE id = v_proj.etapa_atual_id;
      v_out := v_out || jsonb_build_object(
        'projeto', _projeto_json(v_proj.id),
        'template', (SELECT definicao FROM templates_fluxo
                      WHERE tipo_servico = v_proj.tipo AND versao = v_proj.template_versao),
        'acoes', (
          SELECT coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object(
                     'etapa_origem_chave', eo.chave, 'etapa_destino_chave', ed.chave,
                     'etapa_destino_nome', ed.nome) ORDER BY a.seq), '[]'::jsonb)
          FROM acoes a
          LEFT JOIN etapas eo ON eo.id = a.etapa_origem_id
          LEFT JOIN etapas ed ON ed.id = a.etapa_destino_id
          WHERE a.projeto_id = v_proj.id),
        'membros_diretoria', (
          SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nome', m.nome, 'email', m.email,
                     'disponivel', m.disponivel) ORDER BY m.nome_ordenacao COLLATE "C"), '[]'::jsonb)
          FROM membros m
          WHERE m.diretoria = v_etapa.diretoria_responsavel AND m.ativo AND NOT m.is_sistema),
        -- Candidatos quando um admin/Presidência designa responsável fora da diretoria.
        'membros_ativos', (
          SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nome', m.nome, 'email', m.email,
                     'diretoria', m.diretoria, 'disponivel', m.disponivel)
                     ORDER BY m.nome_ordenacao COLLATE "C"), '[]'::jsonb)
          FROM membros m
          WHERE m.ativo AND NOT m.is_sistema));
    END IF;
  END IF;
  RETURN v_out;
END $$;

-- ----------------------------------------------------------------------- vínculo de contas
CREATE OR REPLACE FUNCTION iniciar_vinculo(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_m membros; v_codigo text;
BEGIN
  SELECT * INTO v_m FROM membros
   WHERE email = lower(trim(p->>'email')) AND ativo AND NOT is_sistema;
  IF NOT FOUND THEN
    -- Não revela se o e-mail existe: quem chama responde a mesma mensagem nos dois casos.
    RETURN jsonb_build_object('ok', true, 'codigo', 'VINCULO_INICIADO', 'encontrado', false);
  END IF;
  -- gen_random_uuid() usa gerador criptográfico; random() não serviria para um código de acesso.
  v_codigo := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  INSERT INTO vinculos_pendentes (canal, id_externo, membro_id, codigo, expira_em)
  VALUES ((p->>'canal')::canal_t, p->>'id_externo', v_m.id, v_codigo, now() + interval '10 minutes')
  ON CONFLICT (canal, id_externo) DO UPDATE
    SET membro_id = EXCLUDED.membro_id, codigo = EXCLUDED.codigo, tentativas = 0, expira_em = EXCLUDED.expira_em;
  RETURN jsonb_build_object('ok', true, 'codigo', 'VINCULO_INICIADO', 'encontrado', true,
                            'membro_id', v_m.id, 'nome', v_m.nome, 'email', v_m.email, 'codigo_vinculo', v_codigo);
END $$;

CREATE OR REPLACE FUNCTION confirmar_vinculo(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_v vinculos_pendentes; v_canal canal_t := (p->>'canal')::canal_t; v_id text := p->>'id_externo';
  v_m membros;
BEGIN
  SELECT * INTO v_v FROM vinculos_pendentes
   WHERE canal = v_canal AND id_externo = v_id AND expira_em > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN _erro('VINCULO_INEXISTENTE'); END IF;
  IF v_v.codigo <> trim(p->>'codigo_vinculo') THEN
    IF v_v.tentativas + 1 >= 5 THEN
      DELETE FROM vinculos_pendentes WHERE canal = v_canal AND id_externo = v_id;
    ELSE
      UPDATE vinculos_pendentes SET tentativas = tentativas + 1 WHERE canal = v_canal AND id_externo = v_id;
    END IF;
    RETURN _erro('CODIGO_INVALIDO');
  END IF;
  IF v_canal <> 'telegram' OR v_id !~ '^[0-9]{1,18}$' THEN RETURN _erro('CANAL_NAO_SUPORTADO'); END IF;

  UPDATE membros SET telegram_user_id = NULL WHERE telegram_user_id = v_id::bigint AND id <> v_v.membro_id;
  UPDATE membros SET telegram_user_id = v_id::bigint, canal_preferido = 'telegram',
         canais_habilitados = (SELECT array_agg(DISTINCT c) FROM unnest(canais_habilitados || 'telegram'::canal_t) c)
   WHERE id = v_v.membro_id RETURNING * INTO v_m;
  DELETE FROM vinculos_pendentes WHERE canal = v_canal AND id_externo = v_id;
  RETURN jsonb_build_object('ok', true, 'codigo', 'VINCULO_CONFIRMADO', 'nome', v_m.nome, 'membro_id', v_m.id);
END $$;

-- ------------------------------------------------------------------------ executar_operacao
-- Despachante único usado pelo WF-04: { fn, payload }.
CREATE OR REPLACE FUNCTION executar_operacao(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_fn text := p->>'fn'; v_p jsonb := coalesce(p->'payload', '{}'::jsonb);
BEGIN
  CASE v_fn
  WHEN 'criar_projeto'     THEN RETURN criar_projeto(v_p);
  WHEN 'registrar_acao'    THEN RETURN registrar_acao(v_p);
  WHEN 'iniciar_vinculo'   THEN RETURN iniciar_vinculo(v_p);
  WHEN 'confirmar_vinculo' THEN RETURN confirmar_vinculo(v_p);
  WHEN 'definir_canal' THEN
    UPDATE membros SET canal_preferido = (v_p->>'canal_preferido')::canal_t WHERE id = (v_p->>'membro_id')::uuid;
    RETURN jsonb_build_object('ok', true, 'codigo', 'CANAL_DEFINIDO');
  WHEN 'definir_disponivel' THEN
    UPDATE membros SET disponivel = (v_p->>'disponivel')::boolean WHERE id = (v_p->>'membro_id')::uuid;
    RETURN jsonb_build_object('ok', true, 'codigo', 'DISPONIBILIDADE_DEFINIDA');
  ELSE
    RETURN _erro('OPERACAO_DESCONHECIDA');
  END CASE;
END $$;

-- --------------------------------------------------------------------- finalizar_requisicao
-- Último passo: marca a requisição como processada e grava/apaga a sessão de diálogo.
-- Entrada: { canal, id_externo, idempotency_key, resposta, sessao (objeto ou null), sessao_ttl_min }
CREATE OR REPLACE FUNCTION finalizar_requisicao(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_canal canal_t := (p->>'canal')::canal_t; v_id text := p->>'id_externo';
BEGIN
  INSERT INTO requisicoes_processadas (idempotency_key, canal, id_externo, resposta)
  VALUES (p->>'idempotency_key', v_canal, v_id, coalesce(p->'resposta', '{}'::jsonb))
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF p->'sessao' IS NULL OR jsonb_typeof(p->'sessao') <> 'object' THEN
    DELETE FROM sessoes_chat WHERE canal = v_canal AND id_externo = v_id;
  ELSE
    INSERT INTO sessoes_chat (canal, id_externo, estado, expira_em)
    VALUES (v_canal, v_id, p->'sessao', now() + (coalesce((p->>'sessao_ttl_min')::int, 30) * interval '1 minute'))
    ON CONFLICT (canal, id_externo) DO UPDATE SET estado = EXCLUDED.estado, expira_em = EXCLUDED.expira_em;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ----------------------------------------------------------------------------- sync_membros
-- Aplica as linhas já validadas da planilha (lib/membros.js#validarLinhas).
-- Entrada: { linhas: [{nome, nome_ordenacao, email, telefone_e164, diretoria, cargo, is_admin,
--            ativo, disponivel, canal_preferido, canais_habilitados[]}] }
-- telegram_user_id nunca é tocado; canal_preferido só é definido na criação do membro.
CREATE OR REPLACE FUNCTION sync_membros(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_l jsonb; v_m membros; v_bot uuid; v_e record; v_r jsonb;
  v_novos jsonb := '[]'; v_desativados jsonb := '[]'; v_erros jsonb := '[]'; v_reatr jsonb := '[]';
  v_emails text[];
BEGIN
  IF jsonb_typeof(p->'linhas') <> 'array' OR jsonb_array_length(p->'linhas') = 0 THEN
    RETURN _erro('PLANILHA_VAZIA');   -- proteção: planilha vazia/ilegível não desativa ninguém
  END IF;
  SELECT array_agg(lower(l->>'email')) INTO v_emails FROM jsonb_array_elements(p->'linhas') l;

  FOR v_l IN SELECT * FROM jsonb_array_elements(p->'linhas') LOOP
    BEGIN
      SELECT * INTO v_m FROM membros WHERE email = lower(v_l->>'email');
      IF NOT FOUND THEN
        INSERT INTO membros (nome, nome_ordenacao, email, telefone_e164, diretoria, cargo, is_admin, ativo,
                             disponivel, canal_preferido, canais_habilitados, sincronizado_em)
        VALUES (v_l->>'nome', v_l->>'nome_ordenacao', lower(v_l->>'email'), nullif(v_l->>'telefone_e164', ''),
                (v_l->>'diretoria')::diretoria_t, v_l->>'cargo', (v_l->>'is_admin')::boolean,
                (v_l->>'ativo')::boolean, (v_l->>'disponivel')::boolean,
                (v_l->>'canal_preferido')::canal_t,
                ARRAY(SELECT jsonb_array_elements_text(v_l->'canais_habilitados'))::canal_t[], now());
        IF (v_l->>'ativo')::boolean THEN
          v_novos := v_novos || jsonb_build_object('nome', v_l->>'nome', 'email', lower(v_l->>'email'));
        END IF;
      ELSIF NOT v_m.is_sistema THEN
        UPDATE membros SET
          nome = v_l->>'nome', nome_ordenacao = v_l->>'nome_ordenacao',
          telefone_e164 = nullif(v_l->>'telefone_e164', ''),
          diretoria = (v_l->>'diretoria')::diretoria_t, cargo = v_l->>'cargo',
          is_admin = (v_l->>'is_admin')::boolean, ativo = (v_l->>'ativo')::boolean,
          disponivel = (v_l->>'disponivel')::boolean, sincronizado_em = now()
        WHERE id = v_m.id;
        IF v_m.ativo AND NOT (v_l->>'ativo')::boolean THEN
          v_desativados := v_desativados || jsonb_build_object('nome', v_m.nome, 'email', v_m.email);
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_erros := v_erros || jsonb_build_object('email', v_l->>'email', 'erro', SQLERRM);
    END;
  END LOOP;

  -- Quem saiu da planilha é desativado (offboarding).
  FOR v_m IN UPDATE membros SET ativo = false, sincronizado_em = now()
              WHERE ativo AND NOT is_sistema AND NOT (email = ANY (v_emails)) RETURNING * LOOP
    v_desativados := v_desativados || jsonb_build_object('nome', v_m.nome, 'email', v_m.email);
  END LOOP;

  -- Etapas abertas cujo responsável ficou inativo/indisponível voltam para o rodízio.
  SELECT id INTO v_bot FROM membros WHERE is_sistema ORDER BY email LIMIT 1;
  FOR v_e IN
    SELECT e.id AS etapa_id, e.projeto_id, pr.versao
    FROM etapas e
    JOIN projetos pr ON pr.etapa_atual_id = e.id AND pr.status IN ('ativo', 'pausado')
    JOIN membros m ON m.id = e.responsavel_atribuido_id
    WHERE NOT (m.ativo AND m.disponivel)
  LOOP
    v_r := registrar_acao(jsonb_build_object(
      'projeto_id', v_e.projeto_id, 'tipo_acao', 'reatribuir', 'membro_id', v_bot, 'canal', 'sistema',
      'observacoes', 'Reatribuição automática: responsável anterior indisponível.',
      'idempotency_key', 'sync:reatribuir:' || v_e.etapa_id || ':' || v_e.versao));
    v_reatr := v_reatr || v_r;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'codigo', 'SYNC_CONCLUIDO', 'novos', v_novos, 'desativados', v_desativados,
    'erros', v_erros, 'reatribuicoes', v_reatr,
    'admins', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'membro_id', id, 'nome', nome, 'email', email, 'telegram_user_id', telegram_user_id,
                   'canal_preferido', canal_preferido, 'canais_habilitados', canais_habilitados)), '[]'::jsonb)
                 FROM membros WHERE ativo AND NOT is_sistema AND (is_admin OR diretoria = 'presidencia')));
END $$;

-- --------------------------------------------------------------------------- registrar_envio
-- Chamado pelo WF-05 depois de cada tentativa de envio. Só notificações são gravadas
-- (registrar=true); respostas diretas e mensagens sigilosas não ficam no banco.
-- Entrada: { registrar, membro_id, canal, payload, ok, erro }
CREATE OR REPLACE FUNCTION registrar_envio(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := coalesce((p->>'ok')::boolean, false);
BEGIN
  IF coalesce((p->>'registrar')::boolean, false) THEN
    INSERT INTO notificacoes (membro_id, canal, payload, status, tentativas, erro, enviada_em)
    VALUES (nullif(p->>'membro_id', '')::uuid, (p->>'canal')::canal_t, coalesce(p->'payload', '{}'::jsonb),
            CASE WHEN v_ok THEN 'enviada' ELSE 'falhou' END, 1,
            CASE WHEN v_ok THEN NULL ELSE left(p->>'erro', 500) END, CASE WHEN v_ok THEN now() END);
  END IF;
  RETURN jsonb_build_object('ok', v_ok);
END $$;

-- -------------------------------------------------------------------- definir_pastas_projeto
-- Chamado pelo WF-06 depois de criar as pastas no Drive.
-- Entrada: { projeto_id, drive_pasta_id, link, pastas: {"01_comercial": "<id>", ...} }
CREATE OR REPLACE FUNCTION definir_pastas_projeto(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projetos SET drive_pasta_id = p->>'drive_pasta_id', link_pasta_drive = p->>'link',
                      drive_pastas = coalesce(p->'pastas', '{}'::jsonb)
   WHERE id = (p->>'projeto_id')::uuid;
  RETURN jsonb_build_object('ok', FOUND);
END $$;
