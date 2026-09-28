-- Cidade e estado vinham do projeto legado e a migracao dos tenants (F3) nao
-- pode perde-los: sao a base da prospeccao por regiao. Na conta Eleve One, 564
-- dos 937 leads tem cidade e 801 tem estado.
--
-- Aditivo. O grant de tabela de `authenticated` em leads ja cobre colunas novas,
-- e a RLS existente continua valendo sem mudanca.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text;
