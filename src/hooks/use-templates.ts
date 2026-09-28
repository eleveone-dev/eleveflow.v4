import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type TemplateCategory = "AUTHENTICATION" | "MARKETING" | "UTILITY";

export interface Template {
  id: string;
  name: string;
  language: string;
  category: string;
  /** Status atribuído pela Meta: APPROVED, PENDING, REJECTED, PAUSED… */
  status: string;
  components?: unknown[];
}

async function callAdmin<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("meta-whatsapp-admin", { body });
  if (error) throw new Error(error.message);
  if (data?.success === false) throw new Error(data.error ?? "Falha ao falar com a Meta");
  return data as T;
}

export function useTemplates() {
  return useQuery<Template[]>({
    queryKey: ["whatsapp-templates"],
    queryFn: async () => {
      const result = await callAdmin<{ templates: Template[] }>({ action: "list-templates" });
      return result.templates;
    },
    retry: false,
  });
}

export interface NewTemplate {
  name: string;
  category: TemplateCategory;
  language: string;
  body: string;
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();

  return useMutation<Template, Error, NewTemplate>({
    mutationFn: async (input) => {
      const result = await callAdmin<{ template: Template }>({
        action: "create-template",
        ...input,
      });
      return result.template;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-templates"] });
    },
  });
}
