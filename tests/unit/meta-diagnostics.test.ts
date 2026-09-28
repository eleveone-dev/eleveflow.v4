import { describe, it, expect, vi } from "vitest";
import {
  debugToken,
  listPhoneNumbers,
  getPhoneNumber,
  getWabaDetails,
  listSubscribedApps,
  verifyConnection,
} from "../../supabase/functions/_shared/whatsapp/meta-diagnostics";

const base = { graphApiVersion: "v25.0", accessToken: "EAAJB-token" };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("debugToken", () => {
  it("chama /debug_token com o token inspecionado e devolve validade e escopos", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          app_id: "APP1",
          is_valid: true,
          expires_at: 1790000000,
          scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
          granular_scopes: [
            { scope: "whatsapp_business_management", target_ids: ["WABA1", "WABA2"] },
          ],
        },
      }),
    );

    const result = await debugToken({ ...base, fetchFn: fetchFn as any });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/debug_token?input_token=EAAJB-token");
    expect(init.headers.Authorization).toBe("Bearer EAAJB-token");
    expect(result).toMatchObject({
      valid: true,
      appId: "APP1",
      expiresAt: "2026-09-21T14:13:20.000Z",
      wabaIds: ["WABA1", "WABA2"],
    });
  });

  it("token inválido devolve valid=false sem lançar e sem vazar o token", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" } },
          401,
        ),
      );
    const result = await debugToken({ ...base, fetchFn: fetchFn as any });
    expect(result.valid).toBe(false);
    expect(result.error).toEqual({ code: "190", message: "Invalid OAuth access token" });
    expect(JSON.stringify(result)).not.toContain("EAAJB-token");
  });

  it("is_valid false no corpo também é inválido", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { is_valid: false } }));
    expect((await debugToken({ ...base, fetchFn: fetchFn as any })).valid).toBe(false);
  });

  it("token permanente sem expires_at não vira data inválida", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { is_valid: true, expires_at: 0 } }));
    const result = await debugToken({ ...base, fetchFn: fetchFn as any });
    expect(result.valid).toBe(true);
    expect(result.expiresAt).toBeNull();
  });

  it("ignora granular_scopes de outro escopo", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          is_valid: true,
          granular_scopes: [
            { scope: "pages_show_list", target_ids: ["PAGE1"] },
            { scope: "whatsapp_business_management", target_ids: ["WABA1"] },
          ],
        },
      }),
    );
    expect((await debugToken({ ...base, fetchFn: fetchFn as any })).wabaIds).toEqual(["WABA1"]);
  });
});

describe("listPhoneNumbers", () => {
  it("lista os números da WABA com os campos da Meta", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            verified_name: "Eleve One",
            display_phone_number: "+55 11 99999-0000",
            id: "1064",
            quality_rating: "GREEN",
          },
        ],
      }),
    );

    const numbers = await listPhoneNumbers({ ...base, wabaId: "WABA1", fetchFn: fetchFn as any });

    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/WABA1/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type",
    );
    expect(numbers).toEqual([
      {
        phoneNumberId: "1064",
        displayPhoneNumber: "+55 11 99999-0000",
        verifiedName: "Eleve One",
        qualityRating: "GREEN",
      },
    ]);
  });

  it("mapeia is_on_biz_app e platform_type quando a Graph os devolve", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            verified_name: "Eleve One",
            display_phone_number: "+55 11 99999-0000",
            id: "1064",
            quality_rating: "GREEN",
            is_on_biz_app: true,
            platform_type: "CLOUD_API",
          },
        ],
      }),
    );

    const numbers = await listPhoneNumbers({ ...base, wabaId: "WABA1", fetchFn: fetchFn as any });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(numbers[0]).toMatchObject({ isOnBizApp: true, platformType: "CLOUD_API" });
  });

  it("cai para os campos básicos quando a Graph rejeita is_on_biz_app/platform_type", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Unknown fields: is_on_biz_app", code: 100 } }, 400),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              verified_name: "Eleve One",
              display_phone_number: "+55 11 99999-0000",
              id: "1064",
              quality_rating: "GREEN",
            },
          ],
        }),
      );

    const numbers = await listPhoneNumbers({ ...base, wabaId: "WABA1", fetchFn: fetchFn as any });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toBe("https://graph.facebook.com/v25.0/WABA1/phone_numbers");
    expect(numbers[0].isOnBizApp).toBeUndefined();
  });

  it("WABA inacessível lança com a mensagem da Meta", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Unsupported get request", code: 100 } }, 400),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Unsupported get request", code: 100 } }, 400),
      );
    await expect(
      listPhoneNumbers({ ...base, wabaId: "WABA1", fetchFn: fetchFn as any }),
    ).rejects.toThrow("Unsupported get request");
  });
});

describe("getPhoneNumber", () => {
  it("pede os campos explicitamente e normaliza a resposta", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "1064",
        display_phone_number: "+55 11 99999-0000",
        verified_name: "Eleve One",
        quality_rating: "GREEN",
        code_verification_status: "VERIFIED",
      }),
    );

    const number = await getPhoneNumber({
      ...base,
      phoneNumberId: "1064",
      fetchFn: fetchFn as any,
    });

    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/1064?fields=display_phone_number,verified_name,quality_rating,code_verification_status",
    );
    expect(number).toEqual({
      phoneNumberId: "1064",
      displayPhoneNumber: "+55 11 99999-0000",
      verifiedName: "Eleve One",
      qualityRating: "GREEN",
      codeVerificationStatus: "VERIFIED",
    });
  });

  it("número inexistente lança", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "Unknown path components", code: 2500 } }, 400),
      );
    await expect(
      getPhoneNumber({ ...base, phoneNumberId: "nao-existe", fetchFn: fetchFn as any }),
    ).rejects.toThrow("Unknown path components");
  });
});

describe("getWabaDetails", () => {
  it("devolve id, nome e status de revisão", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "WABA1",
        name: "Eleve One WABA",
        account_review_status: "APPROVED",
        timezone_id: "12",
      }),
    );
    const waba = await getWabaDetails({ ...base, wabaId: "WABA1", fetchFn: fetchFn as any });
    expect(waba).toEqual({
      wabaId: "WABA1",
      name: "Eleve One WABA",
      accountReviewStatus: "APPROVED",
    });
  });
});

describe("listSubscribedApps", () => {
  it("devolve os apps inscritos no webhook da WABA", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ whatsapp_business_api_data: { id: "APP1", name: "EleveFlow" } }],
      }),
    );
    const apps = await listSubscribedApps({ ...base, wabaId: "WABA1", fetchFn: fetchFn as any });
    expect(fetchFn.mock.calls[0][0]).toBe("https://graph.facebook.com/v25.0/WABA1/subscribed_apps");
    expect(apps).toEqual([{ appId: "APP1", name: "EleveFlow" }]);
  });

  it("sem permissão devolve lista vazia em vez de derrubar o diagnóstico", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Permissions error", code: 200 } }, 403));
    expect(await listSubscribedApps({ ...base, wabaId: "W", fetchFn: fetchFn as any })).toEqual([]);
  });
});

describe("verifyConnection", () => {
  const okFetch = () =>
    vi
      .fn()
      // debug_token
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            app_id: "APP1",
            is_valid: true,
            expires_at: 0,
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA1"] }],
          },
        }),
      )
      // waba
      .mockResolvedValueOnce(
        jsonResponse({ id: "WABA1", name: "Eleve One WABA", account_review_status: "APPROVED" }),
      )
      // phone number
      .mockResolvedValueOnce(
        jsonResponse({
          id: "1064",
          display_phone_number: "+55 11 99999-0000",
          verified_name: "Eleve One",
          quality_rating: "GREEN",
          code_verification_status: "VERIFIED",
        }),
      )
      // subscribed apps
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ whatsapp_business_api_data: { id: "APP1", name: "EleveFlow" } }] }),
      );

  it("confirma cada elo com dado vindo da Meta", async () => {
    const fetchFn = okFetch();
    const result = await verifyConnection({
      ...base,
      wabaId: "WABA1",
      phoneNumberId: "1064",
      appId: "APP1",
      fetchFn: fetchFn as any,
    });

    expect(result.tokenValid).toBe(true);
    expect(result.wabaAccessible).toBe(true);
    expect(result.phoneNumberFound).toBe(true);
    expect(result.webhookSubscribed).toBe(true);
    expect(result.phoneNumber).toMatchObject({
      phoneNumberId: "1064",
      displayPhoneNumber: "+55 11 99999-0000",
      verifiedName: "Eleve One",
      qualityRating: "GREEN",
    });
    expect(result.waba).toMatchObject({ wabaId: "WABA1", name: "Eleve One WABA" });
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("token inválido interrompe: nada depois dele é dado como verdadeiro", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401),
      );

    const result = await verifyConnection({
      ...base,
      wabaId: "WABA1",
      phoneNumberId: "1064",
      fetchFn: fetchFn as any,
    });

    expect(result.tokenValid).toBe(false);
    expect(result.wabaAccessible).toBe(false);
    expect(result.phoneNumberFound).toBe(false);
    expect(result.webhookSubscribed).toBe(false);
    expect(result.phoneNumber).toBeNull();
    expect(result.error).toMatchObject({ code: "190" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("número que não existe na WABA não é dado como encontrado", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            is_valid: true,
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA1"] }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "WABA1", name: "W" }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Unknown path components", code: 2500 } }, 400),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await verifyConnection({
      ...base,
      wabaId: "WABA1",
      phoneNumberId: "fantasma",
      fetchFn: fetchFn as any,
    });

    expect(result.tokenValid).toBe(true);
    expect(result.wabaAccessible).toBe(true);
    expect(result.phoneNumberFound).toBe(false);
    expect(result.phoneNumber).toBeNull();
  });

  it("app não inscrito na WABA deixa webhookSubscribed falso", async () => {
    const fetchFn = okFetch();
    fetchFn.mockReset();
    fetchFn
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            is_valid: true,
            app_id: "APP1",
            granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["WABA1"] }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "WABA1", name: "W" }))
      .mockResolvedValueOnce(jsonResponse({ id: "1064", display_phone_number: "+55" }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ whatsapp_business_api_data: { id: "OUTRO-APP", name: "X" } }] }),
      );

    const result = await verifyConnection({
      ...base,
      wabaId: "WABA1",
      phoneNumberId: "1064",
      appId: "APP1",
      fetchFn: fetchFn as any,
    });
    expect(result.phoneNumberFound).toBe(true);
    expect(result.webhookSubscribed).toBe(false);
  });

  it("sem wabaId usa o descoberto pelo debug_token", async () => {
    const fetchFn = okFetch();
    const result = await verifyConnection({
      ...base,
      phoneNumberId: "1064",
      fetchFn: fetchFn as any,
    });
    expect(result.waba?.wabaId).toBe("WABA1");
    expect(fetchFn.mock.calls[1][0]).toContain("/WABA1");
  });

  it("nenhum resultado contém o access token", async () => {
    const fetchFn = okFetch();
    const result = await verifyConnection({
      ...base,
      wabaId: "WABA1",
      phoneNumberId: "1064",
      fetchFn: fetchFn as any,
    });
    expect(JSON.stringify(result)).not.toContain("EAAJB-token");
  });
});
