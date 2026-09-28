-- PENDENTE ANTES DE APLICAR EM PRODUCAO (Task 16): conferir inventario
-- `SELECT jobid, jobname, schedule, command, active FROM cron.job;` no projeto
-- de producao e adicionar cron.unschedule(<nome antigo>) para jobs equivalentes
-- com outros nomes. Staging nao tem jobs legados (projeto novo) — aplicar direto.

-- Versiona o agendamento de process-flows e process-queue (antes só existia
-- ad hoc no projeto de produção, irreproduzível a partir do repositório).
-- URL e chave vêm de global_settings (mesma parametrização do trigger de estágio).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-flows-cron') THEN
    PERFORM cron.unschedule('process-flows-cron');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-queue-cron') THEN
    PERFORM cron.unschedule('process-queue-cron');
  END IF;
END $$;

SELECT cron.schedule('process-flows-cron', '* * * * *', $$
  SELECT net.http_post(
    url := (SELECT value FROM public.global_settings WHERE key = 'edge_functions_base_url') || '/functions/v1/process-flows',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.global_settings WHERE key = 'edge_functions_anon_key')
    ),
    body := '{}'::jsonb
  )
$$);

SELECT cron.schedule('process-queue-cron', '* * * * *', $$
  SELECT net.http_post(
    url := (SELECT value FROM public.global_settings WHERE key = 'edge_functions_base_url') || '/functions/v1/process-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM public.global_settings WHERE key = 'edge_functions_anon_key')
    ),
    body := '{}'::jsonb
  )
$$);
