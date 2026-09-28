import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const useLogs = (filters: { event?: string; search?: string }) => {
  return useQuery({
    queryKey: ["logs", filters],
    queryFn: async () => {
      let query = supabase
        .from("logs")
        .select(
          `
          *,
          leads(name),
          flows(name),
          flow_blocks(type)
        `,
        )
        .order("created_at", { ascending: false });

      if (filters.event && filters.event !== "all") {
        query = query.eq("event", filters.event);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });
};
