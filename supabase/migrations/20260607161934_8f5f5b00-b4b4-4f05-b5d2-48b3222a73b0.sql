ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{
  "delay_min": 3,
  "delay_max": 8,
  "start_hour": "08:00",
  "end_hour": "20:00",
  "days": [1, 2, 3, 4, 5],
  "respect_business_hours": true,
  "notifications": {
    "whatsapp_disconnected": true,
    "queue_stuck": true,
    "lead_reply": true,
    "send_errors": true
  }
}'::jsonb;

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS integrations JSONB DEFAULT '{
  "serpapi": { "key": "" },
  "evolution": { "url": "", "key": "" },
  "openrouter": { "key": "", "model": "gpt-4o-mini", "use_ia": false }
}'::jsonb;
