-- =====================================================================================
-- Therion Fluxo — esquema do banco (PostgreSQL 13+)
-- Hierarquia lógica: Projeto(Etapa(Ação())).
-- `acoes` é append-only (event sourcing leve); `projetos` é a projeção do estado atual.
-- Idempotente: pode ser reaplicado (CREATE ... IF NOT EXISTS).
-- =====================================================================================

DO $$ BEGIN
  CREATE TYPE diretoria_t AS ENUM ('comercial','projetos','financeiro','administrativo','presidencia');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE canal_t AS ENUM ('telegram','whatsapp','email','forms','sistema');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE status_projeto_t AS ENUM ('ativo','pausado','concluido','abandonado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------------- membros
-- Projeção da planilha "Membros EJ". telegram_user_id e canal_preferido são mantidos pelo
-- sistema (vínculo de conta e comando /canal), não pela planilha.
CREATE TABLE IF NOT EXISTS membros (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               text NOT NULL,
  nome_ordenacao     text NOT NULL,            -- nome sem acento/caixa (lib/texto.js#chaveOrdenacao); usado no rodízio
  email              text UNIQUE NOT NULL,     -- sempre minúsculo
  telefone_e164      text UNIQUE,
  telegram_user_id   bigint UNIQUE,
  diretoria          diretoria_t NOT NULL,
  cargo              text NOT NULL DEFAULT 'membro' CHECK (cargo IN ('membro','diretor')),
  is_admin           boolean NOT NULL DEFAULT false,
  is_sistema         boolean NOT NULL DEFAULT false,  -- usuário interno "Therion Bot"
  ativo              boolean NOT NULL DEFAULT true,
  disponivel         boolean NOT NULL DEFAULT true,   -- false = ausente (fora do rodízio)
  canal_preferido    canal_t NOT NULL DEFAULT 'email',
  canais_habilitados canal_t[] NOT NULL DEFAULT '{email,telegram}',
  sincronizado_em    timestamptz
);

-- --------------------------------------------------------------------------------- clientes
CREATE TABLE IF NOT EXISTS clientes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL,
  documento  text,
  email      text,
  telefone   text,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------- templates_fluxo
CREATE TABLE IF NOT EXISTS templates_fluxo (
  tipo_servico text NOT NULL,
  versao       int  NOT NULL,
  definicao    jsonb NOT NULL,
  ativo        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tipo_servico, versao)
);

-- --------------------------------------------------------------------------------- projetos
CREATE TABLE IF NOT EXISTS projetos (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo                 text UNIQUE NOT NULL,       -- P-2026-0042
  nome                   text NOT NULL,
  cliente_id             uuid NOT NULL REFERENCES clientes(id),
  nome_lead              text NOT NULL,
  descricao              text,
  tipo                   text NOT NULL,
  template_versao        int  NOT NULL,
  membro_original_id     uuid NOT NULL REFERENCES membros(id),
  etapa_atual_id         uuid,
  status                 status_projeto_t NOT NULL DEFAULT 'ativo',
  estimativa_horas       numeric,
  estimativa_filamento_g numeric,
  valor_orcado           numeric(12,2),
  valor_contratado       numeric(12,2),
  link_pasta_drive       text,
  drive_pasta_id         text,
  drive_pastas           jsonb NOT NULL DEFAULT '{}',  -- {"03_orcamento": "<id da subpasta>"}
  data_inicio            timestamptz NOT NULL DEFAULT now(),
  data_final             timestamptz,
  versao                 int NOT NULL DEFAULT 0,       -- concorrência otimista
  FOREIGN KEY (tipo, template_versao) REFERENCES templates_fluxo(tipo_servico, versao)
);

-- ----------------------------------------------------------------------------------- etapas
-- Uma linha por ENTRADA do projeto numa etapa (voltar a uma etapa cria nova linha).
CREATE TABLE IF NOT EXISTS etapas (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projeto_id               uuid NOT NULL REFERENCES projetos(id),
  chave                    text NOT NULL,
  nome                     text NOT NULL,
  diretoria_responsavel    diretoria_t NOT NULL,
  responsavel_atribuido_id uuid REFERENCES membros(id),
  data_entrada             timestamptz NOT NULL DEFAULT now(),
  data_saida               timestamptz,
  prazo_sla                timestamptz
);
DO $$ BEGIN
  ALTER TABLE projetos ADD CONSTRAINT fk_etapa_atual FOREIGN KEY (etapa_atual_id) REFERENCES etapas(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------------------------ acoes
CREATE TABLE IF NOT EXISTS acoes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projeto_id       uuid NOT NULL REFERENCES projetos(id),
  seq              int  NOT NULL,
  tipo_acao        text NOT NULL,
  etapa_origem_id  uuid REFERENCES etapas(id),
  etapa_destino_id uuid REFERENCES etapas(id),   -- null se a ação não muda de etapa
  status_anterior  status_projeto_t NOT NULL,
  status_novo      status_projeto_t NOT NULL,
  membro_id        uuid NOT NULL REFERENCES membros(id),
  nome_responsavel text NOT NULL,
  canal_origem     canal_t NOT NULL,
  dados            jsonb NOT NULL DEFAULT '{}',
  observacoes      text,
  arquivos         jsonb NOT NULL DEFAULT '[]',
  revertida_por_id uuid REFERENCES acoes(id),
  reverte_acao_id  uuid REFERENCES acoes(id),
  idempotency_key  text UNIQUE NOT NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (projeto_id, seq)
);

CREATE OR REPLACE FUNCTION bloquear_alteracao_acoes() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'acoes é append-only'; END IF;
  -- UPDATE: só permite preencher revertida_por_id, uma única vez.
  IF OLD.revertida_por_id IS NOT NULL
     OR (to_jsonb(NEW) - 'revertida_por_id') IS DISTINCT FROM (to_jsonb(OLD) - 'revertida_por_id') THEN
    RAISE EXCEPTION 'apenas revertida_por_id pode ser preenchido, uma única vez';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acoes_append_only ON acoes;
CREATE TRIGGER trg_acoes_append_only BEFORE UPDATE OR DELETE ON acoes
  FOR EACH ROW EXECUTE FUNCTION bloquear_alteracao_acoes();

-- ------------------------------------------------------------------------------- documentos
-- Usada a partir da Fase 4 (IA); criada já para estabilizar o esquema.
CREATE TABLE IF NOT EXISTS documentos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projeto_id        uuid NOT NULL REFERENCES projetos(id),
  tipo              text NOT NULL CHECK (tipo IN ('orcamento','contrato')),
  versao            int  NOT NULL,
  status            text NOT NULL CHECK (status IN ('rascunho','aprovado','reprovado','enviado_cliente')),
  drive_doc_id      text NOT NULL,
  gerado_por        text NOT NULL,
  validado_por_id   uuid REFERENCES membros(id),
  motivo_reprovacao text,
  precos_snapshot   jsonb,
  criado_em         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------- rodizio
CREATE TABLE IF NOT EXISTS rodizio (
  chave_etapa      text NOT NULL,
  diretoria        diretoria_t NOT NULL,
  ultimo_membro_id uuid REFERENCES membros(id),
  PRIMARY KEY (chave_etapa, diretoria)
);

-- ----------------------------------------------------------------------- vinculos_pendentes
CREATE TABLE IF NOT EXISTS vinculos_pendentes (
  canal      canal_t NOT NULL,
  id_externo text NOT NULL,          -- quem pediu o vínculo (ex.: id do usuário no Telegram)
  membro_id  uuid NOT NULL REFERENCES membros(id),
  codigo     text NOT NULL,          -- 6 dígitos
  tentativas int  NOT NULL DEFAULT 0,
  expira_em  timestamptz NOT NULL,
  PRIMARY KEY (canal, id_externo)
);

-- ----------------------------------------------------------------------------- sessoes_chat
CREATE TABLE IF NOT EXISTS sessoes_chat (
  canal      canal_t NOT NULL,
  id_externo text NOT NULL,
  estado     jsonb NOT NULL,
  expira_em  timestamptz NOT NULL,
  PRIMARY KEY (canal, id_externo)
);

-- ----------------------------------------------------------------------------- notificacoes
CREATE TABLE IF NOT EXISTS notificacoes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membro_id  uuid REFERENCES membros(id),
  canal      canal_t NOT NULL,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','falhou')),
  tentativas int NOT NULL DEFAULT 0,
  erro       text,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  enviada_em timestamptz
);

-- ------------------------------------------------------------------ requisicoes_processadas
-- Idempotência de entrada (webhooks são reentregues) e base do rate limit.
CREATE TABLE IF NOT EXISTS requisicoes_processadas (
  idempotency_key text PRIMARY KEY,
  canal           canal_t,
  id_externo      text,
  resposta        jsonb NOT NULL DEFAULT '{}',
  criado_em       timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------- sequencia codigo
CREATE TABLE IF NOT EXISTS sequencias_codigo (
  ano    int PRIMARY KEY,
  ultimo int NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acoes_projeto_seq ON acoes (projeto_id, seq);
CREATE INDEX IF NOT EXISTS idx_projetos_status ON projetos (status, etapa_atual_id);
CREATE INDEX IF NOT EXISTS idx_etapas_projeto ON etapas (projeto_id, data_saida);
CREATE INDEX IF NOT EXISTS idx_req_rate ON requisicoes_processadas (canal, id_externo, criado_em);

-- Usuário interno para ações do sistema (reatribuições automáticas, futuras ações de IA).
INSERT INTO membros (nome, nome_ordenacao, email, diretoria, is_admin, is_sistema, disponivel, canais_habilitados)
VALUES ('Therion Bot', 'therion bot', 'bot@sistema.local', 'presidencia', true, true, false, '{}')
ON CONFLICT (email) DO NOTHING;
