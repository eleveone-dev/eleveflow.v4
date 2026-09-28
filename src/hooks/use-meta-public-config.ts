import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** Só identificadores públicos. Segredos nunca trafegam por este caminho. */
export interface PublicMetaConfig {
  appId: string | null;
  configId: string | null;
  graphApiVersion: string;
  enabled: boolean;
}

/**
 * Lê a configuração do Embedded Signup do backend em tempo de execução. Não usa
 * `VITE_*` de propósito: valor baked no build exigiria redeploy da Vercel a cada
 * troca de App ID ou Configuration ID.
 */
export function usePublicMetaConfig() {
  return useQuery<PublicMetaConfig>({
    queryKey: ["meta-public-config"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("meta-whatsapp-admin", {
        body: { action: "public-config" },
      });
      if (error) throw new Error(error.message);
      if (data?.success === false) throw new Error(data.error ?? "Falha ao ler a configuração");
      return data.config as PublicMetaConfig;
    },
    staleTime: 60_000,
    retry: false,
  });
}
