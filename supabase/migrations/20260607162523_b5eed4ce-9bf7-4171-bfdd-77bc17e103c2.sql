ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;

-- Create extraction_history table if it doesn't exist (requested in security checks)
CREATE TABLE IF NOT EXISTS public.extraction_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  query TEXT NOT NULL,
  location TEXT,
  results_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

GRANT ALL ON public.extraction_history TO authenticated;
ALTER TABLE public.extraction_history ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'extraction_history' AND policyname = 'extraction_history_own'
  ) THEN
    CREATE POLICY "extraction_history_own" ON public.extraction_history FOR ALL USING (user_id = auth.uid());
  END IF;
END $$;
