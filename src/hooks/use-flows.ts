import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { handleError } from "@/utils/error-handler";

type Flow = Database["public"]["Tables"]["flows"]["Row"];
type FlowBlock = Database["public"]["Tables"]["flow_blocks"]["Row"];

export const useFlows = () => {
  return useQuery({
    queryKey: ["flows"],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("flows")
          .select(
            `
            *,
            flow_blocks(*)
          `,
          )
          .order("created_at", { ascending: false });
        if (error) {
          handleError(error, "useFlows");
          return [];
        }
        return (data || []) as (Flow & { flow_blocks: FlowBlock[] })[];
      } catch (err) {
        handleError(err, "useFlows:catch");
        return [];
      }
    },
  });
};

export const useFlow = (id: string) => {
  return useQuery({
    queryKey: ["flows", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("flows")
        .select(
          `
          *,
          flow_blocks(*)
        `,
        )
        .eq("id", id)
        .single();
      if (error) {
        handleError(error, `useFlow:${id}`);
        throw error;
      }
      return data as Flow & { flow_blocks: FlowBlock[] };
    },
    enabled: !!id,
    staleTime: 30000, // 30 seconds to avoid aggressive refetching during edits
  });
};

export const useCreateFlow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (flow: Database["public"]["Tables"]["flows"]["Insert"]) => {
      const { data, error } = await supabase.from("flows").insert(flow).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Fluxo criado com sucesso!");
    },
    onError: (error) => {
      handleError(error, "useCreateFlow");
    },
  });
};

export const useUpdateFlow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Database["public"]["Tables"]["flows"]["Update"] & { id: string }) => {
      const { data, error } = await supabase
        .from("flows")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Fluxo atualizado!");
    },
    onError: (error) => {
      handleError(error, "useUpdateFlow");
    },
  });
};

export const useDeleteFlow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("flows").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Fluxo excluído!");
    },
    onError: (error) => {
      handleError(error, "useDeleteFlow");
    },
  });
};

export const useUpdateBlock = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Database["public"]["Tables"]["flow_blocks"]["Update"] & { id: string }) => {
      const { data, error } = await supabase
        .from("flow_blocks")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Bloco atualizado!");
    },
    onError: (error) => {
      handleError(error, "useUpdateBlock");
    },
  });
};

export const useCreateBlock = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (block: Database["public"]["Tables"]["flow_blocks"]["Insert"]) => {
      const { data, error } = await supabase.from("flow_blocks").insert(block).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Bloco adicionado!");
    },
    onError: (error) => {
      handleError(error, "useCreateBlock");
    },
  });
};

export const useDeleteBlock = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("flow_blocks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Bloco removido!");
    },
    onError: (error) => {
      handleError(error, "useDeleteBlock");
    },
  });
};
