import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { previaMensagem } from "@/lib/midia-mensagem";

export interface ConversationSummary {
  leadId: string;
  name: string;
  phone: string | null;
  lastMessageAt: string;
  lastContent: string;
  lastDirection: "inbound" | "outbound";
  /** Última mensagem recebida. Define a janela de 24h do WhatsApp. */
  lastInboundAt: string | null;
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  status: string | null;
  origin: string | null;
  /** Tipo da mídia; null é texto. */
  mediaType: string | null;
  whatsappId: string | null;
  createdAt: string;
}

/**
 * A janela de atendimento do WhatsApp: 24h a partir da última mensagem do
 * cliente. Fora dela, só template é aceito pela Meta — por isso a interface
 * precisa mostrar o prazo, e não deixar o operador descobrir pelo erro.
 */
export function serviceWindow(lastInboundAt: string | null): {
  open: boolean;
  expiresAt: Date | null;
  hoursLeft: number | null;
} {
  if (!lastInboundAt) return { open: false, expiresAt: null, hoursLeft: null };

  const expiresAt = new Date(new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000);
  const msLeft = expiresAt.getTime() - Date.now();
  return {
    open: msLeft > 0,
    expiresAt,
    hoursLeft: msLeft > 0 ? Math.floor(msLeft / (60 * 60 * 1000)) : 0,
  };
}

export function useConversations() {
  return useQuery<ConversationSummary[]>({
    queryKey: ["conversations"],
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return [];

      const { data, error } = await supabase
        .from("messages")
        .select("id, lead_id, direction, content, media_type, created_at, leads(name, phone)")
        .eq("user_id", auth.user.id)
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) throw new Error(error.message);

      const porLead = new Map<string, ConversationSummary>();
      for (const row of (data ?? []) as any[]) {
        if (!row.lead_id) continue;
        const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads;
        const atual = porLead.get(row.lead_id);

        if (!atual) {
          porLead.set(row.lead_id, {
            leadId: row.lead_id,
            name: lead?.name ?? "Sem nome",
            phone: lead?.phone ?? null,
            lastMessageAt: row.created_at,
            lastContent: previaMensagem(row.content ?? "", row.media_type),
            lastDirection: row.direction,
            lastInboundAt: row.direction === "inbound" ? row.created_at : null,
          });
        } else if (row.direction === "inbound" && !atual.lastInboundAt) {
          atual.lastInboundAt = row.created_at;
        }
      }

      return [...porLead.values()];
    },
    refetchInterval: 15_000,
  });
}

export function useConversationMessages(leadId: string | null) {
  return useQuery<ConversationMessage[]>({
    queryKey: ["conversation-messages", leadId],
    enabled: !!leadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, direction, content, status, whatsapp_id, origin, media_type, created_at")
        .eq("lead_id", leadId!)
        .order("created_at", { ascending: true })
        .limit(200);

      if (error) throw new Error(error.message);
      return (data ?? []).map((row: any) => ({
        id: row.id,
        direction: row.direction,
        content: row.content ?? "",
        status: row.status,
        origin: row.origin ?? null,
        mediaType: row.media_type ?? null,
        whatsappId: row.whatsapp_id,
        createdAt: row.created_at,
      }));
    },
    // A resposta do cliente chega pelo webhook, sem avisar o navegador.
    refetchInterval: 5_000,
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { leadId: string; content: string }>({
    mutationFn: async ({ leadId, content }) => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Sessão expirada");

      // Passa pela fila, e não direto pela Graph API: é a fila que aplica
      // consentimento, limite diário, intervalo e idempotência.
      const { data: item, error: queueError } = await supabase
        .from("send_queue")
        .insert({
          user_id: auth.user.id,
          lead_id: leadId,
          content,
          status: "pending",
          scheduled_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (queueError) throw new Error(queueError.message);

      const { data, error } = await supabase.functions.invoke("process-queue", {
        body: { queueItemId: item.id },
      });
      if (error) throw new Error(error.message);
      if (data?.success === false) {
        throw new Error(data.error ?? data.reason ?? "Falha ao enviar");
      }
    },
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["conversation-messages", variables.leadId] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/**
 * Pausa das automações depois que o dono do negócio responde pelo próprio
 * celular. `human_takeover_until` já vem carimbado pelo back-end; aqui só se
 * lê (ignorando prazo vencido) e se oferece a devolução manual para a IA.
 */
export function useHumanTakeover(leadId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["human-takeover", leadId],
    enabled: !!leadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("human_takeover_until")
        .eq("id", leadId!)
        .maybeSingle();
      if (error) throw new Error(error.message);

      const until = data?.human_takeover_until ?? null;
      if (!until) return null;
      return new Date(until).getTime() > Date.now() ? until : null;
    },
    // A pausa vale por tempo determinado: sem repoll, a faixa continuaria
    // exibida depois de já ter vencido.
    refetchInterval: 30_000,
  });

  const release = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("leads")
        .update({ human_takeover_until: null })
        .eq("id", leadId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["human-takeover", leadId] });
    },
  });

  return { until: query.data ?? null, isLoading: query.isLoading, release };
}
