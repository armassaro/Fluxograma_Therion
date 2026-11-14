-- Dados de DESENVOLVIMENTO/HOMOLOGAÇÃO (nunca aplicar em produção: membros reais vêm da planilha, WF-09).
-- Uso: psql ... -f sql/seed.sql   (ou node scripts/migrar.js --seed)
INSERT INTO membros (nome, nome_ordenacao, email, diretoria, cargo, is_admin, canal_preferido) VALUES
  ('Ana Comercial',     'ana comercial',     'ana@ej.test',     'comercial',      'diretor', false, 'telegram'),
  ('Bruno Comercial',   'bruno comercial',   'bruno@ej.test',   'comercial',      'membro',  false, 'telegram'),
  ('Carla Projetos',    'carla projetos',    'carla@ej.test',   'projetos',       'diretor', false, 'telegram'),
  ('Diego Projetos',    'diego projetos',    'diego@ej.test',   'projetos',       'membro',  false, 'telegram'),
  ('Eva Financeiro',    'eva financeiro',    'eva@ej.test',     'financeiro',     'diretor', false, 'email'),
  ('Fábio Adm',         'fabio adm',         'fabio@ej.test',   'administrativo', 'diretor', false, 'email'),
  ('Gabi Presidência',  'gabi presidencia',  'gabi@ej.test',    'presidencia',    'diretor', true,  'telegram')
ON CONFLICT (email) DO NOTHING;
