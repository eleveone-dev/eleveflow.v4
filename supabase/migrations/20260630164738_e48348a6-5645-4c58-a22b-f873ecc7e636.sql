
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS about text,
  ADD COLUMN IF NOT EXISTS top_reviews jsonb,
  ADD COLUMN IF NOT EXISTS all_photos jsonb,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS professional_photo_url text,
  ADD COLUMN IF NOT EXISTS structure_photo_url text,
  ADD COLUMN IF NOT EXISTS facade_photo_url text,
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz;
