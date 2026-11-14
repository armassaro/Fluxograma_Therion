-- Views para relatórios/dashboard (§21, WF-12). Idempotente.

-- Pipeline: quantos projetos em cada etapa/status agora.
CREATE OR REPLACE VIEW vw_pipeline AS
SELECT pr.tipo, e.chave AS etapa_chave, e.nome AS etapa_nome, e.diretoria_responsavel AS diretoria,
       pr.status, count(*) AS projetos,
       count(*) FILTER (WHERE e.prazo_sla < now() AND pr.status = 'ativo') AS vencidos
  FROM projetos pr
  JOIN etapas e ON e.id = pr.etapa_atual_id
 GROUP BY pr.tipo, e.chave, e.nome, e.diretoria_responsavel, pr.status;

-- Tempo médio de permanência por etapa (só passagens concluídas).
CREATE OR REPLACE VIEW vw_tempo_medio_etapa AS
SELECT pr.tipo, e.chave AS etapa_chave, e.nome AS etapa_nome, count(*) AS passagens,
       round(avg(extract(epoch FROM e.data_saida - e.data_entrada)) / 3600.0, 1) AS horas_media,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.data_saida - e.data_entrada)) / 3600.0)::numeric, 1) AS horas_mediana
  FROM etapas e
  JOIN projetos pr ON pr.id = e.projeto_id
 WHERE e.data_saida IS NOT NULL
 GROUP BY pr.tipo, e.chave, e.nome;

-- Conversão orçamento → contrato (por ano de início).
CREATE OR REPLACE VIEW vw_conversao AS
SELECT extract(year FROM pr.data_inicio)::int AS ano, pr.tipo,
       count(*) AS projetos,
       count(*) FILTER (WHERE pr.valor_orcado IS NOT NULL) AS orcados,
       count(*) FILTER (WHERE pr.valor_contratado IS NOT NULL) AS contratados,
       round(100.0 * count(*) FILTER (WHERE pr.valor_contratado IS NOT NULL)
             / nullif(count(*) FILTER (WHERE pr.valor_orcado IS NOT NULL), 0), 1) AS taxa_conversao_pct,
       coalesce(sum(pr.valor_contratado), 0) AS receita_contratada
  FROM projetos pr
 GROUP BY 1, 2;
