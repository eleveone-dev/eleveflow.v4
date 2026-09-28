import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

type SendQueue = Database["public"]["Tables"]["send_queue"]["Row"];

export const useQueue = (status?: string) => {
  return useQuery({
    queryKey: ["send-queue", status],
    queryFn: async () => {
      let query = supabase
        .from("send_queue")
        .select(
          `
          *,
          leads(name, phone)
        `,
        )
        .order("scheduled_at", { ascending: true });

      if (status && status !== "all") {
        query = query.eq("status", status);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });
};

export const useQueueStats = () => {
  return useQuery({
    queryKey: ["queue-stats"],
    queryFn: async () => {
      const { data, error } = await supabase.from("send_queue").select("status");

      if (error) throw error;

      const stats = {
        pending: 0,
        sent: 0,
        failed: 0,
        sending: 0,
      };

      data.forEach((item) => {
        if (item.status === "pending") stats.pending++;
        if (item.status === "sent") stats.sent++;
        if (item.status === "failed") stats.failed++;
        if (item.status === "sending") stats.sending++;
      });

      return stats;
    },
    refetchInterval: 30000,
  });
};

export const useReprocessFailed = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Unauthorized");

      const { error } = await supabase
        .from("send_queue")
        .update({ status: "pending", attempts: 0 })
        .eq("status", "failed")
        .eq("user_id", user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["send-queue"] });
      toast.success("Mensagens falhas colocadas na fila novamente.");
    },
    onError: (error: any) => {
      toast.error(`Erro ao reprocessar: ${error.message}`);
    },
  });
};
