import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { handleError } from "@/utils/error-handler";

type Lead = Database["public"]["Tables"]["leads"]["Row"];
type Stage = Database["public"]["Tables"]["pipeline_stages"]["Row"];

export const useLeads = (stageId?: string) => {
  return useQuery({
    queryKey: ["leads", stageId],
    queryFn: async () => {
      try {
        let query = supabase
          .from("leads")
          .select("*, flow_executions(status)")
          .order("created_at", { ascending: false });
        if (stageId) {
          query = query.eq("stage_id", stageId);
        }
        const { data, error } = await query;
        if (error) {
          handleError(error, "useLeads");
          return [];
        }
        return (data || []) as Lead[];
      } catch (err) {
        handleError(err, "useLeads:catch");
        return [];
      }
    },
  });
};

export const useStages = () => {
  return useQuery({
    queryKey: ["stages"],
    queryFn: async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return [];

        const { data, error } = await supabase
          .from("pipeline_stages")
          .select("*")
          .eq("user_id", user.id)
          .order("position", { ascending: true });
        if (error) {
          handleError(error, "useStages");
          return [];
        }
        return (data || []) as Stage[];
      } catch (err) {
        handleError(err, "useStages:catch");
        return [];
      }
    },
  });
};

export const useUpdateLeadStage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, stageId }: { leadId: string; stageId: string }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { data, error } = await supabase
        .from("leads")
        .update({ stage_id: stageId })
        .eq("id", leadId)
        .select();
      if (error) throw error;

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Lead movido. As automações aplicáveis serão verificadas.");
    },
    onError: (error) => {
      handleError(error, "useUpdateLeadStage");
    },
  });
};

export const useCreateLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (lead: Database["public"]["Tables"]["leads"]["Insert"]) => {
      const { data, error } = await supabase.from("leads").insert(lead).select();
      if (error) {
        if ((error as any).code === "23505") {
          throw new Error("Já existe um lead com este telefone.");
        }
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Lead criado com sucesso!");
    },
    onError: (error: any) => {
      toast.error(error?.message || "Erro ao criar lead");
      handleError(error, "useCreateLead");
    },
  });
};

export const useUpdateLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Database["public"]["Tables"]["leads"]["Update"] & { id: string }) => {
      const { data, error } = await supabase.from("leads").update(updates).eq("id", id).select();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-data"] });
      toast.success("Lead atualizado!");
    },
    onError: (error) => {
      handleError(error, "useUpdateLead");
    },
  });
};

export const useResetExecutions = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { error } = await supabase
        .from("flow_executions")
        .update({ status: "paused" })
        .eq("user_id", user.id)
        .eq("status", "running");

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flow_executions"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-data"] });
      toast.success("Todas as execuções foram pausadas.");
    },
    onError: (error) => {
      handleError(error, "useResetExecutions");
    },
  });
};

export const useClearQueue = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { error } = await supabase
        .from("send_queue")
        .delete()
        .eq("user_id", user.id)
        .eq("status", "pending");

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["send_queue"] });
      queryClient.invalidateQueries({ queryKey: ["pending-queue-count"] });
      toast.success("Fila de envio limpa!");
    },
    onError: (error) => {
      handleError(error, "useClearQueue");
    },
  });
};

export const useDeleteLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("leads").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Lead excluído!");
    },
    onError: (error) => {
      handleError(error, "useDeleteLead");
    },
  });
};

export const useCreateStage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (stage: Database["public"]["Tables"]["pipeline_stages"]["Insert"]) => {
      const { data, error } = await supabase.from("pipeline_stages").insert(stage).select();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stages"] });
      toast.success("Estágio criado!");
    },
    onError: (error) => {
      handleError(error, "useCreateStage");
    },
  });
};

export const useUpdateStage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Database["public"]["Tables"]["pipeline_stages"]["Update"] & { id: string }) => {
      const { data, error } = await supabase
        .from("pipeline_stages")
        .update(updates)
        .eq("id", id)
        .select();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stages"] });
      toast.success("Estágio atualizado!");
    },
    onError: (error) => {
      handleError(error, "useUpdateStage");
    },
  });
};

export const useExecuteFlow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      leadId,
      flowId,
      triggerType = "manual",
    }: {
      leadId: string;
      flowId: string;
      triggerType?: string;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { data, error } = await supabase.functions.invoke("execute-flow", {
        body: {
          lead_id: leadId,
          flow_id: flowId,
          user_id: user.id,
          trigger_type: triggerType,
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flow_executions"] });
      toast.success("Fluxo iniciado com sucesso!");
    },
    onError: (error) => {
      handleError(error, "useExecuteFlow");
    },
  });
};

export const useFlowExecutions = (leadId?: string) => {
  return useQuery({
    queryKey: ["flow_executions", leadId],
    queryFn: async () => {
      let query = supabase
        .from("flow_executions")
        .select("*, flows(name)")
        .order("created_at", { ascending: false });

      if (leadId) {
        query = query.eq("lead_id", leadId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
};

export const useDeleteStage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("pipeline_stages").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stages"] });
      toast.success("Estágio excluído!");
    },
    onError: (error) => {
      handleError(error, "useDeleteStage");
    },
  });
};

export const useAccount = () => {
  return useQuery({
    queryKey: ["account"],
    queryFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", user.id)
        .single();

      if (error && error.code !== "PGRST116") throw error;
      return data;
    },
  });
};

export const useUpdateAccount = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Database["public"]["Tables"]["accounts"]["Update"]) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { data, error } = await supabase
        .from("accounts")
        .update(updates)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["account"] });
      toast.success("Configurações salvas!");
    },
    onError: (error) => {
      toast.error(`Erro ao salvar: ${error.message}`);
    },
  });
};
