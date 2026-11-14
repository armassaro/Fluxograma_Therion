-- Consultas nomeadas (§18): usadas por relatórios, pelo WF-10 (Fase 3) e por administradores via psql.
-- O bot (WF-03) usa carregar_dados() de registrar_acao.sql, que agrega o mesmo conteúdo numa ida só.
-- Idempotente: CREATE OR REPLACE.

-- Etapas abertas em que o membro é o responsável atribuído, ou da diretoria dele sem responsável.
CREATE OR REPLACE FUNCTION meus_pendentes(p_membro uuid)
RETURNS TABLE (codigo text, nome text, status status_projeto_t, etapa_chave text, etapa_nome text,
               responsavel_atribuido_id uuid, prazo_sla timestamptz, vencida boolean)
LANGUAGE sql STABLE AS $$
  SELECT pr.codigo, pr.nome, pr.status, e.chave, e.nome, e.responsavel_atribuido_id, e.prazo_sla,
         coalesce(e.prazo_sla < now(), false)
    FROM projetos pr
    JOIN etapas e ON e.id = pr.etapa_atual_id
    JOIN membros m ON m.id = p_membro
   WHERE pr.status IN ('ativo', 'pausado')
     AND (e.responsavel_atribuido_id = m.id
          OR (e.responsavel_atribuido_id IS NULL AND e.diretoria_responsavel = m.diretoria))
   ORDER BY e.prazo_sla NULLS LAST, pr.codigo;
$$;

-- Projetos em andamento, opcionalmente filtrados por diretoria da etapa atual e/ou status.
CREATE OR REPLACE FUNCTION listar_projetos(p_diretoria diretoria_t DEFAULT NULL, p_status status_projeto_t DEFAULT NULL)
RETURNS TABLE (codigo text, nome text, tipo text, status status_projeto_t, etapa_nome text,
               diretoria diretoria_t, responsavel text, prazo_sla timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT pr.codigo, pr.nome, pr.tipo, pr.status, e.nome, e.diretoria_responsavel, r.nome, e.prazo_sla
    FROM projetos pr
    JOIN etapas e ON e.id = pr.etapa_atual_id
    LEFT JOIN membros r ON r.id = e.responsavel_atribuido_id
   WHERE (p_status IS NULL AND pr.status IN ('ativo', 'pausado') OR pr.status = p_status)
     AND (p_diretoria IS NULL OR e.diretoria_responsavel = p_diretoria)
   ORDER BY pr.codigo;
$$;

-- Detalhes completos (mesmo JSON que o bot usa em /projeto).
CREATE OR REPLACE FUNCTION detalhes_projeto(p_codigo text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT _projeto_json(id) FROM projetos WHERE codigo = upper(trim(p_codigo));
$$;

-- Linha do tempo de ações (inclui revertidas, marcadas).
CREATE OR REPLACE FUNCTION historico(p_codigo text)
RETURNS TABLE (seq int, criado_em timestamptz, tipo_acao text, membro text, canal canal_t,
               etapa_origem text, etapa_destino text, status_novo status_projeto_t,
               revertida boolean, observacoes text)
LANGUAGE sql STABLE AS $$
  SELECT a.seq, a.criado_em, a.tipo_acao, a.nome_responsavel, a.canal_origem,
         eo.chave, ed.chave, a.status_novo, a.revertida_por_id IS NOT NULL, a.observacoes
    FROM acoes a
    JOIN projetos pr ON pr.id = a.projeto_id
    LEFT JOIN etapas eo ON eo.id = a.etapa_origem_id
    LEFT JOIN etapas ed ON ed.id = a.etapa_destino_id
   WHERE pr.codigo = upper(trim(p_codigo))
   ORDER BY a.seq;
$$;

-- Etapas abertas de projetos ativos com SLA estourado (entrada do WF-10 / lib/sla.js#etapasVencidas).
CREATE OR REPLACE FUNCTION etapas_vencidas(p_agora timestamptz DEFAULT now())
RETURNS TABLE (etapa_id uuid, projeto_codigo text, projeto_nome text, etapa_nome text,
               diretoria diretoria_t, responsavel_atribuido_id uuid, prazo_sla timestamptz,
               status_projeto status_projeto_t, atraso interval)
LANGUAGE sql STABLE AS $$
  SELECT e.id, pr.codigo, pr.nome, e.nome, e.diretoria_responsavel, e.responsavel_atribuido_id,
         e.prazo_sla, pr.status, p_agora - e.prazo_sla
    FROM projetos pr
    JOIN etapas e ON e.id = pr.etapa_atual_id
   WHERE pr.status = 'ativo' AND e.data_saida IS NULL AND e.prazo_sla < p_agora
   ORDER BY e.prazo_sla;
$$;
