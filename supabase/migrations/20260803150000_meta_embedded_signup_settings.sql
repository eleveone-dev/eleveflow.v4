-- Configuração pública do Embedded Signup (Bloco B, Fase 4 — etapa 4A).
--
-- App ID e Configuration ID não são segredos: o SDK da Meta os expõe no cliente
-- quando o fluxo é iniciado. Ficam aqui, e não em VITE_*, para poderem ser
-- trocados sem rebuild da Vercel — mesmo padrão de `meta_graph_api_version`.
--
-- App Secret, access token e verify token continuam fora desta tabela pública:
-- vivem nos secrets do Supabase ou cifrados.
--
-- As linhas nascem vazias e desabilitadas; quem preenche é o superadmin pela
-- tela Configurações › Integrações › Meta.

INSERT INTO public.global_settings (key, value)
VALUES
  ('meta_app_id', ''),
  ('meta_embedded_signup_config_id', ''),
  ('meta_embedded_signup_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
