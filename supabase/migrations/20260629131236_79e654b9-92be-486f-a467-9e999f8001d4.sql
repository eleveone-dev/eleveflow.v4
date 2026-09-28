ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS place_id text,
  ADD COLUMN IF NOT EXISTS maps_url text,
  ADD COLUMN IF NOT EXISTS instagram_url text;

CREATE INDEX IF NOT EXISTS leads_place_id_idx ON public.leads(place_id);