import { describe, it, expect } from "vitest";
import {
  marcarUso,
  resolveApiToken,
  tokenDoHeader,
} from "../../supabase/functions/_shared/api-token";
import { sha256Hex } from "../../supabase/functions/_shared/hmac";
import { createFakeClient } from "./helpers/fake-supabase";

const TOKEN = "efsc_token-de-teste";

async function banco(over: Record<string, unknown> = {}) {
  return {
    api_tokens: [
      {
        id: "tok-1",
        user_id: "conta-1",
        label: "Eleve Office",
        token_hash: await sha256Hex(TOKEN),
        scopes: ["comercial:leitura"],
        rate_limit_per_minute: 120,
        revoked_at: null,
        last_used_at: null,
        ...over,
      },
    ],
  };
}

describe("tokenDoHeader", () => {
  it("le o Bearer em qualquer caixa e recusa o resto", () => {
    expect(tokenDoHeader(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(tokenDoHeader(`bearer ${TOKEN}`)).toBe(TOKEN);
    for (const header of [null, "", "Bearer", "Bearer ", `Basic ${TOKEN}`, TOKEN]) {
      expect(tokenDoHeader(header)).toBeNull();
    }
  });
});

describe("resolveApiToken", () => {
  it("token conhecido devolve conta, escopos e limite", async () => {
    const client = createFakeClient(await banco());
    expect(await resolveApiToken(client as any, `Bearer ${TOKEN}`)).toEqual({
      tokenId: "tok-1",
      userId: "conta-1",
      label: "Eleve Office",
      scopes: ["comercial:leitura"],
      rateLimitPerMinute: 120,
    });
  });

  it("token errado, ausente ou revogado devolve nulo", async () => {
    const client = createFakeClient(await banco());
    expect(await resolveApiToken(client as any, "Bearer efsc_outro")).toBeNull();
    expect(await resolveApiToken(client as any, null)).toBeNull();
    const revogado = createFakeClient(await banco({ revoked_at: "2026-09-25T00:00:00Z" }));
    expect(await resolveApiToken(revogado as any, `Bearer ${TOKEN}`)).toBeNull();
  });
});

describe("marcarUso", () => {
  it("atualiza last_used_at do token", async () => {
    const db = await banco();
    const client = createFakeClient(db);
    await marcarUso(client as any, "tok-1", new Date("2026-09-25T12:00:00.000Z"));
    expect(db.api_tokens[0].last_used_at).toBe("2026-09-25T12:00:00.000Z");
  });
});
