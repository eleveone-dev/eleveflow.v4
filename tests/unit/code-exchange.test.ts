import { describe, it, expect, vi } from "vitest";
import { exchangeSignupCode } from "../../supabase/functions/_shared/whatsapp/code-exchange";

const base = {
  graphApiVersion: "v25.0",
  appId: "1742922410057266",
  appSecret: "APP-SECRET-NAO-PODE-VAZAR",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Troca bem-sucedida seguida de debug_token válido. */
const happyFetch = () =>
  vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ access_token: "EAAJB-token-do-cliente" }))
    .mockResolvedValueOnce(
      jsonResponse({
        data: {
          is_valid: true,
          app_id: "1742922410057266",
          expires_at: 0,
          scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
          granular_scopes: [
            { scope: "whatsapp_business_management", target_ids: ["WABA-DO-CLIENTE"] },
          ],
        },
      }),
    );

describe("exchangeSignupCode — troca bem-sucedida", () => {
  it("chama /oauth/access_token com client_id, client_secret e code", async () => {
    const fetchFn = happyFetch();
    await exchangeSignupCode({ ...base, code: "CODE-123", fetchFn: fetchFn as any });

    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(url.pathname).toBe("/v25.0/oauth/access_token");
    expect(url.searchParams.get("client_id")).toBe("1742922410057266");
    expect(url.searchParams.get("client_secret")).toBe("APP-SECRET-NAO-PODE-VAZAR");
    expect(url.searchParams.get("code")).toBe("CODE-123");
  });

  it("devolve os ativos autorizados sem devolver o token", async () => {
    const result = await exchangeSignupCode({
      ...base,
      code: "CODE-123",
      fetchFn: happyFetch() as any,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wabaIds).toEqual(["WABA-DO-CLIENTE"]);
    expect(result.scopes).toContain("whatsapp_business_management");
    expect(result.appId).toBe("1742922410057266");
    expect(result.tokenExpiresAt).toBeNull();
    // O token do cliente fica no servidor; quem chama recebe só o resumo.
    expect(Object.keys(result)).not.toContain("accessToken");
    expect(JSON.stringify(result)).not.toContain("EAAJB-token-do-cliente");
  });

  it("entrega o token por callback, nunca no retorno", async () => {
    const recebido: string[] = [];
    await exchangeSignupCode({
      ...base,
      code: "CODE-123",
      fetchFn: happyFetch() as any,
      onToken: async (token) => {
        recebido.push(token);
      },
    });
    expect(recebido).toEqual(["EAAJB-token-do-cliente"]);
  });
});

describe("exchangeSignupCode — falhas", () => {
  it("code expirado devolve erro legível sem vazar o app secret", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "This authorization code has expired.",
            code: 100,
            type: "OAuthException",
          },
        },
        400,
      ),
    );

    const result = await exchangeSignupCode({ ...base, code: "VELHO", fetchFn: fetchFn as any });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("expired");
    expect(result.error.code).toBe("100");
    expect(JSON.stringify(result)).not.toContain("APP-SECRET-NAO-PODE-VAZAR");
  });

  it("resposta sem access_token não é tratada como sucesso", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ token_type: "bearer" }));
    const result = await exchangeSignupCode({ ...base, code: "X", fetchFn: fetchFn as any });
    expect(result.ok).toBe(false);
  });

  it("token trocado mas inválido no debug_token é recusado", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "EAAJB-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: { is_valid: false } }));

    const result = await exchangeSignupCode({ ...base, code: "X", fetchFn: fetchFn as any });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("inválido");
  });

  it("token sem acesso a nenhuma WABA é recusado", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "EAAJB-token" }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { is_valid: true, app_id: "1742922410057266", granular_scopes: [] } }),
      );

    const result = await exchangeSignupCode({ ...base, code: "X", fetchFn: fetchFn as any });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("WABA");
  });

  it("code vazio nem chega a chamar a rede", async () => {
    const fetchFn = vi.fn();
    const result = await exchangeSignupCode({ ...base, code: "  ", fetchFn: fetchFn as any });
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sem app secret configurado falha antes da rede", async () => {
    const fetchFn = vi.fn();
    const result = await exchangeSignupCode({
      ...base,
      appSecret: "",
      code: "X",
      fetchFn: fetchFn as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("App Secret");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("token emitido por outro app é recusado", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "EAAJB-token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            is_valid: true,
            app_id: "OUTRO-APP",
            granular_scopes: [
              { scope: "whatsapp_business_management", target_ids: ["WABA-DO-CLIENTE"] },
            ],
          },
        }),
      );

    const result = await exchangeSignupCode({ ...base, code: "X", fetchFn: fetchFn as any });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("outro app");
  });
});
