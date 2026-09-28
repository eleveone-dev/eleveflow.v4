CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE public.flow_executions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',
    current_block_id UUID REFERENCES public.flow_blocks(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.flow_executions TO authenticated;
GRANT ALL ON public.flow_executions TO service_role;

ALTER TABLE public.flow_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own flow executions" ON public.flow_executions
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_flow_executions_updated_at BEFORE UPDATE ON public.flow_executions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();