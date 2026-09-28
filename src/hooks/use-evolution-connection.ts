import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { EvolutionState } from "@/lib/evolution-connection-view";

export interface ConnectResult {
  connected: boolean;
  qrcode: string | null;
  created: boolean;
  webhook: { ok: boolean; shape?: string; reason?: string };
  instance: string;
}

/** Toda gestão de instância passa pelo `whatsapp-proxy`. O nome da instância
 *  NÃO vai no corpo: quem decide é o servidor, a partir do `auth.uid()`. */
async function callProxy<T>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("whatsapp-proxy", {
    body: { action, ...extra },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.message ?? "Erro na Evolution");
  return data as T;
}

export type WhatsappProvider = "meta_cloud" | "evolution";

async function conexaoDoUsuario(colunas: string) {
  const { data: user } = await supabase.auth.getUser();
  const tenantId = user.user?.id;
  if (!tenantId) return null;

  const { data, error } = await supabase
    .from("whatsapp_connections")
    .select(colunas)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  // Erro de leitura não pode virar "nada configurado": foi assim que a tela
  // passou a afirmar ausência de conexão onde havia uma.
  if (error) throw new Error(error.message);
  return data as Record<string, unknown> | null;
}

/** Qual provedor esta conta usa. Sem linha gravada a resposta é `null`, e a
 *  tela entra pelo caminho da Evolution — o ativo. O caminho Meta continua
 *  alcançável para quem tem linha `meta_cloud`. */
export function useWhatsappProvider() {
  return useQuery<WhatsappProvider | null>({
    queryKey: ["whatsapp-provider"],
    queryFn: async () => {
      const row = await conexaoDoUsuario("provider");
      const provider = row?.provider;
      return provider === "evolution" || provider === "meta_cloud" ? provider : null;
    },
    staleTime: 30_000,
  });
}

/**
 * Estado da conexão Evolution: o que o servidor da Evolution responde agora,
 * somado ao que o nosso banco registrou. Prova de tráfego não entra aqui —
 * varrer `messages` para dizer "envio testado" é o erro que
 * `connection-proof.ts` documenta e proíbe.
 */
export function useEvolutionConnection({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<EvolutionState>({
    enabled,
    queryKey: ["evolution-connection"],
    queryFn: async () => {
      const checkedAt = new Date().toISOString();
      const row = await conexaoDoUsuario("provider, instance_name, webhook_subscribed_at");

      let exists = false;
      let connected = false;
      let providerState: string | null = null;
      let error: { message: string } | null = null;
      let instance = (row?.instance_name as string | null) ?? null;

      try {
        const status = await callProxy<{
          exists: boolean;
          connected: boolean;
          state: string | null;
          instance: string;
        }>("status");
        exists = status.exists;
        connected = status.connected;
        providerState = status.state;
        instance = status.instance ?? instance;
      } catch (e) {
        error = { message: e instanceof Error ? e.message : String(e) };
      }

      return {
        configured: row?.provider === "evolution",
        instance,
        exists,
        connected,
        providerState,
        webhookAt: (row?.webhook_subscribed_at as string | null) ?? null,
        checkedAt,
        error,
      };
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useEvolutionConnect() {
  const queryClient = useQueryClient();
  return useMutation<ConnectResult, Error, void>({
    mutationFn: () => callProxy<ConnectResult>("connect"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["evolution-connection"] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-provider"] });
    },
  });
}

export function useEvolutionDisconnect() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationFn: () => callProxy("disconnect"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["evolution-connection"] });
    },
  });
}
