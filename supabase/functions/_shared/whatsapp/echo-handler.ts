// Eco do aparelho: o dono respondeu fora do CRM — pelo WhatsApp Business App na
// Meta, pelo celular ou WhatsApp Web na Evolution.
//
// Faz três coisas e nada mais: registra a mensagem na conversa, marca que ela
// veio do aparelho e cala IA e fluxos daquele lead por um prazo. Não classifica
// etapa, não chama IA, não dispara fluxo — o dono já está falando.

import { getGlobalSetting } from "../ai.ts";
import { safeLog } from "./inbound-orchestrator.ts";
import { isAlreadyRegistered } from "./message-dedupe.ts";
import { resolveLead } from "./lead-resolver.ts";
import { DEFAULT_TAKEOVER_HOURS, startHumanTakeover } from "./human-takeover.ts";

export interface EchoDeps {
  client: { from: (table: string) => any };
  onStep?: (step: string) => void;
}

export interface EchoInput {
  tenantId: string;
  providerMessageId: string | null;
  toPhone: string;
  text: string;
  timestamp: string;
  /** Valor de messages.media_type; null ou ausente = texto. */
  mediaType?: string | null;
}

export interface EchoResult {
  status: number;
  body: Record<string, unknown>;
}

// O process-queue marca o item como `sending` antes de chamar o provedor, e o eco
// do envio pode chegar antes de a entrega gravar a mensagem. Gravar esse eco como
// humano pausaria a IA sem motivo e derrubaria a entrega no indice unico de
// whatsapp_id.
export const OWN_SEND_WINDOW_MS = 2 * 60 * 1000;

async function hasOwnSendInFlight(
  client: EchoDeps["client"],
  tenantId: string,
  leadId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("send_queue")
    .select("id, sending_at")
    .eq("user_id", tenantId)
    .eq("lead_id", leadId)
    .eq("status", "sending");
  if (error) throw error;

  const limite = Date.now() - OWN_SEND_WINDOW_MS;
  return (data ?? []).some(
    (item: { sending_at: string | null }) =>
      item.sending_at !== null && new Date(item.sending_at).getTime() >= limite,
  );
}

async function takeoverHours(client: EchoDeps["client"]): Promise<number> {
  const raw = await getGlobalSetting(client as any, "human_takeover_hours");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TAKEOVER_HOURS;
}

export async function handleEcho(deps: EchoDeps, input: EchoInput): Promise<EchoResult> {
  const setStep = (step: string) => deps.onStep?.(step);

  setStep("echo_dedupe");
  if (await isAlreadyRegistered(deps.client, input.tenantId, input.providerMessageId, "outbound")) {
    return {
      status: 200,
      body: {
        success: true,
        ignored: true,
        reason: "duplicate",
        whatsapp_id: input.providerMessageId,
      },
    };
  }

  setStep("echo_find_lead");
  const resolution = await resolveLead(deps.client, input.tenantId, input.toPhone);

  if (resolution.kind === "none") {
    // Mesma regra do inbound: o dono também fala com contato pessoal e
    // entregador. Criar lead aqui poluiria a base, e o telefone dessa gente não
    // tem por que ficar no log.
    await safeLog(deps.client, {
      user_id: input.tenantId,
      event: "echo_lead_not_found",
      details: {},
    });
    return { status: 200, body: { success: true, ignored: true, reason: "lead_not_found" } };
  }

  if (resolution.kind === "ambiguous") {
    await safeLog(deps.client, {
      user_id: input.tenantId,
      event: "echo_ambiguous_lead_phone",
      details: { phone: resolution.normalized, matching_leads: resolution.leads.length },
    });
    return {
      status: 200,
      body: { success: true, ignored: true, reason: "ambiguous_lead_phone" },
    };
  }

  const lead = resolution.lead;

  setStep("echo_own_send_check");
  if (await hasOwnSendInFlight(deps.client, input.tenantId, lead.id)) {
    return { status: 200, body: { success: true, ignored: true, reason: "own_send_in_flight" } };
  }

  setStep("echo_save_message");
  const { error: insertError } = await deps.client.from("messages").insert({
    user_id: input.tenantId,
    lead_id: lead.id,
    content: input.text ?? "",
    direction: "outbound",
    origin: "business_app",
    media_type: input.mediaType ?? null,
    whatsapp_id: input.providerMessageId,
    status: null,
  });
  if (insertError) throw insertError;

  setStep("echo_start_takeover");
  const hours = await takeoverHours(deps.client);
  const until = await startHumanTakeover(deps.client, input.tenantId, lead.id, hours);

  await safeLog(deps.client, {
    user_id: input.tenantId,
    lead_id: lead.id,
    event: "human_takeover_started",
    details: { until, hours, whatsapp_id: input.providerMessageId },
  });

  return {
    status: 200,
    body: { success: true, lead_id: lead.id, human_takeover_until: until },
  };
}
