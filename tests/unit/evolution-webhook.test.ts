import { describe, it, expect } from "vitest";
import {
  verifyEvolutionWebhook,
  evolutionWebhookHeaders,
} from "../../supabase/functions/_shared/whatsapp/evolution-webhook";
import { isInboundMessageEvent } from "../../supabase/functions/_shared/whatsapp/evolution-parse";
import { hmacSha256Hex } from "../../supabase/functions/_shared/hmac";

const SECRET = "a".repeat(32);
const CORPO = JSON.stringify({ event: "messages.upsert" });

function requisicao(headers: Record<string, string>): Request {
  return new Request("https://exemplo.test/webhook", { method: "POST", headers });
}

describe("verifyEvolutionWebhook", () => {
  it("header compartilhado correto passa", async () => {
    const r = await verifyEvolutionWebhook(
      requisicao({ "x-eleveflow-webhook-secret": SECRET }),
      CORPO,
      SECRET,
    );
    expect(r).toEqual({ verified: true });
  });

  it("header compartilhado errado recusa com 401", async () => {
    await expect(
      verifyEvolutionWebhook(
        requisicao({ "x-eleveflow-webhook-secret": "b".repeat(32) }),
        CORPO,
        SECRET,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("assinatura HMAC valida do corpo cru passa", async () => {
    const assinatura = await hmacSha256Hex(SECRET, CORPO);
    const r = await verifyEvolutionWebhook(
      requisicao({ "x-evolution-signature": `sha256=${assinatura}` }),
      CORPO,
      SECRET,
    );
    expect(r).toEqual({ verified: true });
  });

  it("assinatura HMAC de outro corpo recusa com 401", async () => {
    const assinatura = await hmacSha256Hex(SECRET, "outro corpo");
    await expect(
      verifyEvolutionWebhook(requisicao({ "x-evolution-signature": assinatura }), CORPO, SECRET),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("sem header e sem assinatura recusa com 401", async () => {
    await expect(verifyEvolutionWebhook(requisicao({}), CORPO, SECRET)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("guarda de implantacao: sem secret no ambiente passa e sinaliza", async () => {
    const r = await verifyEvolutionWebhook(requisicao({}), CORPO, null);
    expect(r).toEqual({ verified: false, reason: "no_secret_configured" });
  });

  it("secret curto demais e recusado na origem", async () => {
    await expect(
      verifyEvolutionWebhook(
        requisicao({ "x-eleveflow-webhook-secret": "curto" }),
        CORPO,
        "curto",
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("evolutionWebhookHeaders", () => {
  it("monta o header privado", () => {
    expect(evolutionWebhookHeaders(SECRET)).toEqual({ "x-eleveflow-webhook-secret": SECRET });
  });
});

describe("isInboundMessageEvent", () => {
  it("reconhece messages.upsert em qualquer grafia", () => {
    expect(isInboundMessageEvent("messages.upsert")).toBe(true);
    expect(isInboundMessageEvent("MESSAGES_UPSERT")).toBe(true);
    expect(isInboundMessageEvent("messages-upsert")).toBe(true);
  });

  it("recusa outros eventos", () => {
    expect(isInboundMessageEvent("connection.update")).toBe(false);
    expect(isInboundMessageEvent(undefined)).toBe(false);
  });
});
