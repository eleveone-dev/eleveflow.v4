-- Leitura do comercial de uma conta para o Eleve Sales Coach, servida pela Edge
-- Function sales-coach. Spec: docs/specs/2026-09-23-sales-coach-api-design.md.
--
-- Isolamento: toda CTE filtra user_id = p_user_id, e so o service_role executa.
-- O p_user_id sai do token resolvido na Edge Function, nunca da requisicao. Sem o
-- REVOKE, o default privileges do schema public daria EXECUTE a anon e
-- authenticated, e qualquer usuario logado leria outra conta pelo PostgREST.

CREATE OR REPLACE FUNCTION public.sales_coach_snapshot(
  p_user_id uuid,
  p_periodo_dias integer,
  p_parado_dias integer,
  p_followup_horas integer,
  p_limite integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
WITH janela AS (
  SELECT now() - make_interval(days => p_periodo_dias) AS de, now() AS ate
),
etapas AS (
  SELECT s.id, btrim(s.name) AS nome, s.funnel_key, s.position, s.created_at
    FROM public.pipeline_stages s
   WHERE s.user_id = p_user_id
),
leads_conta AS (
  SELECT l.id, l.name, l.company, l.city, l.stage_id, l.created_at, l.is_suppressed
    FROM public.leads l
   WHERE l.user_id = p_user_id
     AND l.is_test IS NOT TRUE
),
-- Envio que falhou nao e contato.
ultima_msg AS (
  SELECT DISTINCT ON (m.lead_id) m.lead_id, m.direction, m.content, m.created_at
    FROM public.messages m
   WHERE m.user_id = p_user_id
     AND (m.direction <> 'outbound' OR m.status IS DISTINCT FROM 'failed')
   ORDER BY m.lead_id, m.created_at DESC NULLS LAST, m.id DESC
),
eventos AS (
  SELECT ev.lead_id, ev.to_stage_id
    FROM public.lead_stage_events ev
    JOIN leads_conta l ON l.id = ev.lead_id
    CROSS JOIN janela j
   WHERE ev.user_id = p_user_id
     AND ev.occurred_at BETWEEN j.de AND j.ate
),
-- Mesma regra do Dashboard (calculateResponseRate): respondeu na janela quem
-- recebeu envio na janela.
contatados AS (
  SELECT DISTINCT m.lead_id
    FROM public.messages m
    JOIN leads_conta l ON l.id = m.lead_id
    CROSS JOIN janela j
   WHERE m.user_id = p_user_id
     AND m.direction = 'outbound'
     AND m.status = 'sent'
     AND m.created_at BETWEEN j.de AND j.ate
),
responderam AS (
  SELECT DISTINCT m.lead_id
    FROM public.messages m
    JOIN contatados c ON c.lead_id = m.lead_id
    CROSS JOIN janela j
   WHERE m.user_id = p_user_id
     AND m.direction = 'inbound'
     AND m.created_at BETWEEN j.de AND j.ate
),
-- As tres listas ficam sem corte aqui: "totais" conta tudo, e so a lista
-- devolvida para em p_limite.
follow_ups AS (
  SELECT l.id, l.name, l.company, l.city, e.nome AS etapa, u.created_at AS msg_em, u.content
    FROM leads_conta l
    JOIN ultima_msg u ON u.lead_id = l.id
    LEFT JOIN etapas e ON e.id = l.stage_id
   WHERE NOT l.is_suppressed
     AND COALESCE(e.funnel_key, '') NOT IN ('won', 'lost')
     AND u.direction = 'inbound'
     AND u.created_at < now() - make_interval(hours => p_followup_horas)
),
-- Prospeccao fica de fora: centenas de leads frios esperando o primeiro contato
-- enterrariam a lista.
parados AS (
  SELECT l.id, l.name, l.company, e.nome AS etapa,
         COALESCE(u.created_at, l.created_at) AS ultimo_contato
    FROM leads_conta l
    LEFT JOIN ultima_msg u ON u.lead_id = l.id
    LEFT JOIN etapas e ON e.id = l.stage_id
   WHERE NOT l.is_suppressed
     AND COALESCE(e.funnel_key, '') NOT IN ('won', 'lost', 'prospecting')
     AND COALESCE(u.created_at, l.created_at) < now() - make_interval(days => p_parado_dias)
),
tarefas AS (
  SELECT t.title, t.due_date, t.priority
    FROM public.personal_tasks t
   WHERE t.user_id = p_user_id
     AND t.completed_at IS NULL
     AND t.due_date < now()
)
SELECT jsonb_build_object(
  'gerado_em', now(),
  'conta', (SELECT a.name FROM public.accounts a
             WHERE a.user_id = p_user_id ORDER BY a.created_at LIMIT 1),
  'periodo', (SELECT jsonb_build_object('dias', p_periodo_dias, 'de', j.de, 'ate', j.ate)
                FROM janela j),
  'etapas_sem_classificacao', COALESCE(
    (SELECT jsonb_agg(e.nome ORDER BY e.position NULLS LAST, e.created_at)
       FROM etapas e WHERE e.funnel_key IS NULL), '[]'::jsonb),
  'funil', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'etapa', e.nome,
              'tipo', e.funnel_key,
              'leads_agora', (SELECT count(*) FROM leads_conta l WHERE l.stage_id = e.id),
              'entradas_no_periodo', (SELECT count(DISTINCT ev.lead_id)
                                        FROM eventos ev WHERE ev.to_stage_id = e.id)
            ) ORDER BY e.position NULLS LAST, e.created_at)
       FROM etapas e), '[]'::jsonb),
  'resultado_periodo', jsonb_build_object(
    'leads_novos', (SELECT count(*) FROM leads_conta l CROSS JOIN janela j
                     WHERE l.created_at BETWEEN j.de AND j.ate),
    'ganhos', (SELECT count(DISTINCT ev.lead_id) FROM eventos ev
                 JOIN etapas e ON e.id = ev.to_stage_id WHERE e.funnel_key = 'won'),
    'perdas', (SELECT count(DISTINCT ev.lead_id) FROM eventos ev
                 JOIN etapas e ON e.id = ev.to_stage_id WHERE e.funnel_key = 'lost'),
    'taxa_resposta', (SELECT CASE WHEN c.n = 0 THEN 0 ELSE round(r.n::numeric / c.n, 2) END
                        FROM (SELECT count(*) AS n FROM contatados) c,
                             (SELECT count(*) AS n FROM responderam) r)
  ),
  'perdas_por_motivo', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('motivo', p.nome, 'leads', p.leads)
                      ORDER BY p.leads DESC, p.nome)
       FROM (SELECT e.nome, count(DISTINCT ev.lead_id) AS leads
               FROM eventos ev JOIN etapas e ON e.id = ev.to_stage_id
              WHERE e.funnel_key = 'lost'
              GROUP BY e.id, e.nome) p), '[]'::jsonb),
  'totais', jsonb_build_object(
    'follow_ups_atrasados', (SELECT count(*) FROM follow_ups),
    'leads_parados', (SELECT count(*) FROM parados),
    'tarefas_atrasadas', (SELECT count(*) FROM tarefas)
  ),
  -- Listas do atraso mais recente para o mais antigo: o historico migrado tem
  -- centenas de conversas de meses atras, e na ordem inversa elas escondiam as
  -- da semana. Decisao do dono em 2026-09-24.
  'follow_ups_atrasados', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'lead_id', f.id,
              'nome', f.name,
              'empresa', f.company,
              'cidade', f.city,
              'etapa', f.etapa,
              'ultima_msg_do_lead_em', f.msg_em,
              'horas_sem_resposta', floor(extract(epoch FROM now() - f.msg_em) / 3600)::int,
              'ultima_msg_do_lead', left(f.content, 200)
            ) ORDER BY f.msg_em DESC)
       FROM (SELECT * FROM follow_ups ORDER BY msg_em DESC LIMIT p_limite) f), '[]'::jsonb),
  'leads_parados', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'lead_id', p.id,
              'nome', p.name,
              'empresa', p.company,
              'etapa', p.etapa,
              'ultimo_contato_em', p.ultimo_contato,
              'dias_parado', floor(extract(epoch FROM now() - p.ultimo_contato) / 86400)::int
            ) ORDER BY p.ultimo_contato DESC)
       FROM (SELECT * FROM parados ORDER BY ultimo_contato DESC LIMIT p_limite) p), '[]'::jsonb),
  'tarefas_atrasadas', COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
              'titulo', t.title,
              'vencimento', t.due_date,
              'prioridade', t.priority
            ) ORDER BY t.due_date DESC)
       FROM (SELECT * FROM tarefas ORDER BY due_date DESC LIMIT p_limite) t), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public.sales_coach_snapshot(uuid, integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_coach_snapshot(uuid, integer, integer, integer, integer)
  TO service_role;
