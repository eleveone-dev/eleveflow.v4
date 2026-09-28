// Trava dura de marketing, compartilhada por webhooks, fila e execução de
// fluxo. Deno-free de propósito: precisa rodar em Deno (edge) e Node/Vitest.

import { HttpError } from "./http-error.ts";

/**
 * A hard marketing stop. Consent may be made stricter by product policy later,
 * but an explicit opt-out or suppression must never be enqueued or sent.
 */
export function assertLeadCanReceiveMarketing(lead: any): void {
  const consentStatus = lead?.marketing_consent_status ?? "unknown";
  if (lead?.is_suppressed === true || lead?.marketing_opted_out_at) {
    throw new HttpError(409, "Lead is suppressed or opted out of marketing messages");
  }
  if (consentStatus !== "granted" && consentStatus !== "not_required") {
    throw new HttpError(409, "Lead does not have an approved marketing consent status");
  }
}
