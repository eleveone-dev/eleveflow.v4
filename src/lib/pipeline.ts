import { supabase } from "@/integrations/supabase/client";

export const initializeDefaultStages = async (userId: string) => {
  const defaultStages = [
    { name: "Prospecção", color: "#3b82f6", position: 0, user_id: userId },
    { name: "Respondeu", color: "#a855f7", position: 1, user_id: userId },
    { name: "Interessado", color: "#22c55e", position: 2, user_id: userId },
    { name: "Fechado", color: "#ef4444", position: 3, user_id: userId },
  ];

  const { data, error } = await supabase.from("pipeline_stages").insert(defaultStages);
  return { data, error };
};
