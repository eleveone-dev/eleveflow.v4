// Helper compartilhado para "Testar fluxo". Espelha o handleTestFlow do FlowEditor visual,
// reusado pelo Modo Simples sem alterar comportamento do motor.

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { handleError } from "@/utils/error-handler";

export async function runFlowTest(flowId: string, onNavigateSettings?: () => void) {
  const loadingToast = toast.loading("Iniciando teste real...");
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Não autenticado");

    const { data: account } = await supabase
      .from("accounts")
      .select("*")
      .eq("user_id", user.id)
      .single();
    if (!account) throw new Error("Conta não encontrada");

    const settings = account.settings as any;
    const testPhone = settings?.test_phone;
    if (!testPhone) {
      toast.dismiss(loadingToast);
      toast.error("Configure o telefone de teste nas configurações.");
      onNavigateSettings?.();
      return;
    }
    if (account.whatsapp_status !== "connected") {
      toast.dismiss(loadingToast);
      toast.error("WhatsApp desconectado. Conecte antes de testar.");
      return;
    }

    const { normalizeBrazilPhone } = await import("@/lib/phone");
    const normalized = normalizeBrazilPhone(testPhone);

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .insert({
        user_id: user.id,
        name: "Teste EleveFlow",
        phone: normalized,
        company: "Ambiente de Teste",
        tags: ["teste-editor"],
        marketing_consent_status: "not_required",
      })
      .select()
      .single();
    if (leadError) throw new Error(`Falha ao criar lead: ${leadError.message}`);

    const { data: executionResult, error: invokeError } = await supabase.functions.invoke(
      "execute-flow",
      { body: { lead_id: lead.id, flow_id: flowId, user_id: user.id, trigger_type: "manual" } },
    );
    if (invokeError) throw new Error(invokeError.message);
    if (executionResult?.error) throw new Error(executionResult.error);

    toast.loading("Fluxo acionado. Gerando mensagem...", { id: loadingToast });

    const { processQueueBatch } = await import("@/services/queueService");
    await new Promise((r) => setTimeout(r, 3500));
    await processQueueBatch(5);

    let attempts = 0;
    let finalStatus = "pending";
    toast.loading("Aguardando confirmação de envio real...", { id: loadingToast });
    while (attempts < 8 && finalStatus !== "sent" && finalStatus !== "failed") {
      attempts++;
      await new Promise((r) => setTimeout(r, 2500));
      const { data: queueItem } = await supabase
        .from("send_queue")
        .select("status")
        .eq("lead_id", lead.id)
        .eq("flow_id", flowId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (queueItem?.status) finalStatus = queueItem.status;
    }

    toast.dismiss(loadingToast);
    if (finalStatus === "sent") toast.success("Mensagem enviada com sucesso!");
    else if (finalStatus === "failed") toast.error("Falha no envio pelo WhatsApp.");
    else toast.warning("Fluxo iniciado, mas mensagem ainda na fila.");

    setTimeout(() => supabase.from("leads").delete().eq("id", lead.id), 30000);
  } catch (err: any) {
    toast.dismiss(loadingToast);
    handleError(err, "flow-test:runFlowTest");
  }
}
