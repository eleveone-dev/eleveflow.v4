
CREATE TABLE public.personal_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
  due_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.personal_tasks TO authenticated;
GRANT ALL ON public.personal_tasks TO service_role;

ALTER TABLE public.personal_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own personal tasks"
  ON public.personal_tasks FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_personal_tasks_updated_at
  BEFORE UPDATE ON public.personal_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_personal_tasks_user_status ON public.personal_tasks(user_id, status);
