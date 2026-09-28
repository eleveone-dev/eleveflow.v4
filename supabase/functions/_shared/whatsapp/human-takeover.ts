// Pausa por atendimento humano. Quando o dono responde pelo WhatsApp Business
// App do celular, IA e fluxos daquele lead ficam calados por um prazo — senão o
// cliente recebe duas respostas para a mesma pergunta.
//
// O núcleo é puro de propósito: os gates de envio precisam decidir sem tocar o
// banco, e a decisão precisa de teste sem client.

export const DEFAULT_TAKEOVER_HOURS = 24;

interface LeadLike {
  human_takeover_until?: string | null;
}

export function humanTakeoverUntil(
  lead: LeadLike | null | undefined,
  now = new Date(),
): string | null {
  const raw = lead?.human_takeover_until;
  if (!raw) return null;

  const until = new Date(raw);
  if (Number.isNaN(until.getTime())) return null;

  return until.getTime() > now.getTime() ? until.toISOString() : null;
}

export function isUnderHumanTakeover(lead: LeadLike | null | undefined, now = new Date()): boolean {
  return humanTakeoverUntil(lead, now) !== null;
}

/** Decisão única usada pelos dois gates de envio. `isTest` fura a pausa: teste
 *  do editor é o dono clicando de propósito, não pode ser calado pela pausa que
 *  ele mesmo criou. */
export function shouldSkipAutomation(
  lead: LeadLike | null | undefined,
  options: { isTest?: boolean; now?: Date } = {},
): boolean {
  if (options.isTest) return false;
  return isUnderHumanTakeover(lead, options.now ?? new Date());
}

/** Até quando um item da fila espera por causa da pausa, ou null. Só automação
 *  espera: item sem `flow_id` é o próprio vendedor escrevendo pela tela de
 *  Conversas, e a pausa existe para calar a automação, não ele. */
export function queueDeferralUntil(
  item: { flow_id?: string | null },
  lead: (LeadLike & { is_test?: boolean | null }) | null | undefined,
  now = new Date(),
): string | null {
  if (!item.flow_id || lead?.is_test === true) return null;
  return humanTakeoverUntil(lead, now);
}

export async function startHumanTakeover(
  client: { from: (table: string) => any },
  tenantId: string,
  leadId: string,
  hours: number,
  now = new Date(),
): Promise<string> {
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

  const { error } = await client
    .from("leads")
    .update({ human_takeover_until: until })
    .eq("id", leadId)
    .eq("user_id", tenantId);

  if (error) throw error;
  return until;
}

/** Adia a execução para quando a pausa vencer. `process-flows` recolhe depois e
 *  o fluxo continua de onde parou, em vez de morrer. */
export async function rescheduleForTakeover(
  client: { from: (table: string) => any },
  executionId: string,
  until: string,
): Promise<void> {
  const { error } = await client
    .from("flow_executions")
    .update({ scheduled_at: until, status: "running" })
    .eq("id", executionId);

  if (error) throw error;
}

export async function endHumanTakeover(
  client: { from: (table: string) => any },
  tenantId: string,
  leadId: string,
): Promise<void> {
  const { error } = await client
    .from("leads")
    .update({ human_takeover_until: null })
    .eq("id", leadId)
    .eq("user_id", tenantId);

  if (error) throw error;
}
