-- Leitura da API do Eleve Office (parte B). Uma funcao por recurso; toda consulta
-- filtra pela conta p_user_id, que a Edge Function tira do token. So o
-- service_role executa: sem o REVOKE, o default privileges do schema public daria
-- EXECUTE a anon e authenticated, e um usuario logado leria outra conta.
--
-- Listas devolvem ate p_limite + 1 itens: o excedente diz a Edge Function que ha
-- mais pagina. Listagem e feed deixam de fora os ultimos 5 s: transacao que comecou
-- antes e terminou depois nao escapa do cursor de quem ja passou por aquele instante.

CREATE OR REPLACE FUNCTION public.office_leads(
  p_user_id uuid,
  p_lead_id uuid,
  p_cursor_ts timestamptz,
  p_cursor_id uuid,
  p_limite integer,
  p_atualizado_desde timestamptz,
  p_criado_de timestamptz,
  p_criado_ate timestamptz,
  p_etapa_id uuid,
  p_situacao text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH base AS (
  SELECT l.id, l.name, l.company, l.source, l.created_at, l.updated_at,
         s.id AS etapa_id, btrim(s.name) AS etapa_nome, s.funnel_key,
         CASE s.funnel_key WHEN 'won' THEN 'ganha' WHEN 'lost' THEN 'perdida'
                           ELSE 'em_andamento' END AS situacao
    FROM public.leads l
    LEFT JOIN public.pipeline_stages s ON s.id = l.stage_id AND s.user_id = p_user_id
   WHERE l.user_id = p_user_id
     AND l.is_test IS NOT TRUE
     AND ((p_lead_id IS NOT NULL AND l.id = p_lead_id)
          OR (p_lead_id IS NULL AND l.updated_at <= now() - interval '5 seconds'))
     AND (p_atualizado_desde IS NULL OR l.updated_at >= p_atualizado_desde)
     AND (p_criado_de IS NULL OR l.created_at >= p_criado_de)
     AND (p_criado_ate IS NULL OR l.created_at <= p_criado_ate)
     AND (p_etapa_id IS NULL OR l.stage_id = p_etapa_id)
     AND (p_cursor_ts IS NULL OR (l.updated_at, l.id) > (p_cursor_ts, p_cursor_id))
),
pagina AS (
  SELECT * FROM base
   WHERE p_situacao IS NULL OR situacao = p_situacao
   ORDER BY updated_at, id
   LIMIT p_limite + 1
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'lead_id', p.id,
  'nome', p.name,
  'empresa', p.company,
  'origem', p.source,
  'responsavel', NULL,
  'etapa', CASE WHEN p.etapa_id IS NULL THEN NULL
                ELSE jsonb_build_object('id', p.etapa_id, 'nome', p.etapa_nome, 'tipo', p.funnel_key) END,
  'situacao', p.situacao,
  -- So mudanca registrada fecha: lead importado ja fechado fica sem data.
  'fechado_em', CASE WHEN p.situacao = 'em_andamento' THEN NULL ELSE (
      SELECT max(e.occurred_at) FROM public.lead_stage_events e
       WHERE e.user_id = p_user_id AND e.lead_id = p.id
         AND e.event_type = 'stage_changed' AND e.to_stage_id = p.etapa_id) END,
  'motivo_perda', CASE WHEN p.situacao = 'perdida' THEN p.etapa_nome END,
  'criado_em', p.created_at,
  'atualizado_em', p.updated_at
) ORDER BY p.updated_at, p.id), '[]'::jsonb)
FROM pagina p;
$$;

CREATE OR REPLACE FUNCTION public.office_mensagens(
  p_user_id uuid,
  p_lead_id uuid,
  p_feed boolean,
  p_cursor_ts timestamptz,
  p_cursor_id uuid,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH base AS (
  SELECT m.id, m.lead_id, m.created_at, m.inserted_at, m.direction, m.origin, m.flow_id,
         m.content, m.media_type, m.status, b.type AS tipo_bloco,
         CASE WHEN p_feed THEN m.inserted_at ELSE m.created_at END AS chave
    FROM public.messages m
    JOIN public.leads l ON l.id = m.lead_id AND l.user_id = p_user_id AND l.is_test IS NOT TRUE
    LEFT JOIN public.flow_blocks b ON b.id = m.block_id
   WHERE m.user_id = p_user_id
     AND (p_lead_id IS NULL OR m.lead_id = p_lead_id)
     AND (NOT p_feed OR m.inserted_at <= now() - interval '5 seconds')
),
pagina AS (
  SELECT * FROM base
   WHERE p_cursor_ts IS NULL OR (chave, id) > (p_cursor_ts, p_cursor_id)
   ORDER BY chave, id
   LIMIT p_limite + 1
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'mensagem_id', p.id,
  'lead_id', p.lead_id,
  'conversa_id', p.lead_id,
  'enviada_em', p.created_at,
  'gravada_em', p.inserted_at,
  'direcao', CASE WHEN p.direction = 'inbound' THEN 'recebida' ELSE 'enviada' END,
  'origem', CASE
      WHEN p.direction = 'inbound' THEN 'lead'
      WHEN p.origin = 'business_app' THEN 'humano_aparelho'
      WHEN p.origin = 'ia' OR p.tipo_bloco = 'ai_agent' THEN 'ia'
      WHEN p.flow_id IS NULL THEN 'humano_crm'
      ELSE 'automacao' END,
  'atendente_id', NULL,
  'tipo', CASE p.media_type
      WHEN 'audio' THEN 'audio' WHEN 'image' THEN 'imagem' WHEN 'video' THEN 'video'
      WHEN 'document' THEN 'documento' WHEN 'sticker' THEN 'figurinha'
      WHEN 'location' THEN 'localizacao' WHEN 'contact' THEN 'contato'
      WHEN 'other' THEN 'outro' ELSE 'texto' END,
  'texto', p.content,
  'tem_texto', btrim(p.content) <> '',
  'transcricao', NULL,
  'status', CASE p.status
      WHEN 'received' THEN 'recebida' WHEN 'pending' THEN 'pendente'
      WHEN 'sent' THEN 'enviada' WHEN 'delivered' THEN 'enviada' WHEN 'read' THEN 'enviada'
      WHEN 'failed' THEN 'falhou' END
) ORDER BY p.chave, p.id), '[]'::jsonb)
FROM pagina p;
$$;

CREATE OR REPLACE FUNCTION public.office_eventos(
  p_user_id uuid,
  p_lead_id uuid,
  p_feed boolean,
  p_cursor_ts timestamptz,
  p_cursor_id uuid,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH base AS (
  SELECT e.id, e.lead_id, e.event_type, e.from_stage_id, e.to_stage_id, e.changed_by,
         e.occurred_at, e.created_at,
         e.metadata ? 'para_nome' AS da_epoca,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'de_nome' ELSE btrim(sf.name) END AS de_nome,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'de_tipo' ELSE sf.funnel_key END AS de_tipo,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'para_nome' ELSE btrim(st.name) END AS para_nome,
         CASE WHEN e.metadata ? 'para_nome' THEN e.metadata->>'para_tipo' ELSE st.funnel_key END AS para_tipo,
         CASE WHEN p_feed THEN e.created_at ELSE e.occurred_at END AS chave
    FROM public.lead_stage_events e
    JOIN public.leads l ON l.id = e.lead_id AND l.user_id = p_user_id AND l.is_test IS NOT TRUE
    LEFT JOIN public.pipeline_stages sf ON sf.id = e.from_stage_id AND sf.user_id = p_user_id
    LEFT JOIN public.pipeline_stages st ON st.id = e.to_stage_id AND st.user_id = p_user_id
   WHERE e.user_id = p_user_id
     AND (p_lead_id IS NULL OR e.lead_id = p_lead_id)
     AND (NOT p_feed OR e.created_at <= now() - interval '5 seconds')
),
pagina AS (
  SELECT * FROM base
   WHERE p_cursor_ts IS NULL OR (chave, id) > (p_cursor_ts, p_cursor_id)
   ORDER BY chave, id
   LIMIT p_limite + 1
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'evento_id', p.id,
  'lead_id', p.lead_id,
  'tipo', CASE p.event_type WHEN 'lead_created' THEN 'criacao' ELSE 'mudanca' END,
  'de', CASE WHEN p.from_stage_id IS NULL THEN NULL
             ELSE jsonb_build_object('id', p.from_stage_id, 'nome', p.de_nome, 'tipo', p.de_tipo) END,
  'para', CASE WHEN p.to_stage_id IS NULL THEN NULL
               ELSE jsonb_build_object('id', p.to_stage_id, 'nome', p.para_nome, 'tipo', p.para_tipo) END,
  'nome_da_epoca', p.da_epoca,
  'ocorreu_em', p.occurred_at,
  'gravado_em', p.created_at,
  'autor', jsonb_build_object(
      'tipo', CASE WHEN p.changed_by IS NULL THEN 'automacao_ou_importacao' ELSE 'usuario' END,
      'id', p.changed_by),
  'resultado', CASE
      WHEN p.event_type <> 'stage_changed' THEN NULL
      WHEN p.para_tipo = 'won' THEN 'ganho'
      WHEN p.para_tipo = 'lost' THEN 'perda'
      WHEN p.de_tipo IN ('won', 'lost') THEN 'reabertura' END,
  'motivo_perda', CASE WHEN p.event_type = 'stage_changed' AND p.para_tipo = 'lost'
                       THEN p.para_nome END
) ORDER BY p.chave, p.id), '[]'::jsonb)
FROM pagina p;
$$;

CREATE OR REPLACE FUNCTION public.office_exclusoes(
  p_user_id uuid,
  p_cursor_ts timestamptz,
  p_cursor_id bigint,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'entidade', CASE d.entity WHEN 'lead' THEN 'lead' ELSE 'mensagem' END,
  'id', d.entity_id,
  'excluido_em', d.deleted_at,
  'sequencia', d.id
) ORDER BY d.deleted_at, d.id), '[]'::jsonb)
FROM (
  SELECT r.id, r.entity, r.entity_id, r.deleted_at
    FROM public.api_deleted_records r
   WHERE r.user_id = p_user_id
     AND r.deleted_at <= now() - interval '5 seconds'
     AND (p_cursor_ts IS NULL OR (r.deleted_at, r.id) > (p_cursor_ts, p_cursor_id))
   ORDER BY r.deleted_at, r.id
   LIMIT p_limite + 1
) d;
$$;

REVOKE ALL ON FUNCTION public.office_leads(uuid, uuid, timestamptz, uuid, integer, timestamptz, timestamptz, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_leads(uuid, uuid, timestamptz, uuid, integer, timestamptz, timestamptz, timestamptz, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.office_mensagens(uuid, uuid, boolean, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_mensagens(uuid, uuid, boolean, timestamptz, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.office_eventos(uuid, uuid, boolean, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_eventos(uuid, uuid, boolean, timestamptz, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.office_exclusoes(uuid, timestamptz, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_exclusoes(uuid, timestamptz, bigint, integer) TO service_role;
