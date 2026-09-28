import { describe, it, expect } from "vitest";
import {
  buildLoginParams,
  isTrustedMetaOrigin,
  parseSignupEvent,
} from "../../src/lib/meta-embedded-signup";

const config = {
  appId: "1742922410057266",
  configId: "2302998863777075",
  graphApiVersion: "v25.0",
  enabled: true,
};

describe("buildLoginParams", () => {
  it("monta os parâmetros de coexistência exigidos pela doc oficial", () => {
    expect(buildLoginParams(config)).toEqual({
      config_id: "2302998863777075",
      response_type: "code",
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: "whatsapp_business_app_onboarding",
        sessionInfoVersion: "3",
      },
    });
  });

  // `setup: {}` está em todos os exemplos oficiais (Implementation e Onboard
  // WhatsApp Business app users). Omiti-lo foi tentativa de imitar o link do
  // Hosted ES, que é outro produto e tem outros parâmetros.
  it("envia setup vazio como a doc oficial", () => {
    expect(buildLoginParams(config).extras.setup).toEqual({});
  });

  it("featureType de coexistência é obrigatório: sem ele a Meta abriria o fluxo de número novo", () => {
    expect(buildLoginParams(config).extras.featureType).toBe("whatsapp_business_app_onboarding");
  });

  // A versão do fluxo vem da configuração do Facebook Login for Business
  // ("Selecting the products will automatically set you to v4"), não de extras.
  // `version` não existe como parâmetro do FB.login em nenhuma doc.
  it("não envia version: quem define a geração do fluxo é a configuração", () => {
    expect(buildLoginParams(config).extras).not.toHaveProperty("version");
  });

  it("response_type é code e o padrão é sobrescrito", () => {
    const params = buildLoginParams(config);
    expect(params.response_type).toBe("code");
    expect(params.override_default_response_type).toBe(true);
  });

  it("sem configId não monta parâmetros", () => {
    expect(() => buildLoginParams({ ...config, configId: null })).toThrow(
      "Configuration ID não configurado",
    );
  });
});

describe("isTrustedMetaOrigin", () => {
  it.each([
    "https://www.facebook.com",
    "https://web.facebook.com",
    "https://business.facebook.com",
  ])("aceita origem da Meta: %s", (origin) => {
    expect(isTrustedMetaOrigin(origin)).toBe(true);
  });

  it.each([
    "https://facebook.com.attacker.test",
    "https://notfacebook.com",
    "https://evil.test",
    "http://localhost:3000",
    "",
    "null",
  ])("rejeita origem não confiável: %s", (origin) => {
    expect(isTrustedMetaOrigin(origin)).toBe(false);
  });

  it("não aceita sufixo forjado que apenas termina com facebook.com", () => {
    // endsWith("facebook.com") sozinho aceitaria isto; a checagem precisa ser
    // por host completo.
    expect(isTrustedMetaOrigin("https://malicious-facebook.com")).toBe(false);
  });
});

describe("parseSignupEvent", () => {
  it("reconhece conclusão do onboarding de coexistência", () => {
    const result = parseSignupEvent({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      version: 3,
      data: { waba_id: "1570798631374583" },
    });
    expect(result).toEqual({
      kind: "finish",
      coexistence: true,
      wabaId: "1570798631374583",
      phoneNumberId: null,
    });
  });

  it("reconhece conclusão do onboarding comum", () => {
    const result = parseSignupEvent({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { waba_id: "WABA1", phone_number_id: "PNID1" },
    });
    expect(result).toEqual({
      kind: "finish",
      coexistence: false,
      wabaId: "WABA1",
      phoneNumberId: "PNID1",
    });
  });

  it("reconhece cancelamento com o passo em que parou", () => {
    expect(
      parseSignupEvent({
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        data: { current_step: "PHONE_NUMBER_SELECTION" },
      }),
    ).toEqual({ kind: "cancel", step: "PHONE_NUMBER_SELECTION" });
  });

  it("reconhece erro reportado pelo fluxo", () => {
    expect(
      parseSignupEvent({
        type: "WA_EMBEDDED_SIGNUP",
        event: "ERROR",
        data: { error_message: "algo falhou" },
      }),
    ).toEqual({ kind: "error", message: "algo falhou" });
  });

  it("ignora mensagem que não é do Embedded Signup", () => {
    expect(parseSignupEvent({ type: "OUTRA_COISA", event: "FINISH" })).toBeNull();
    expect(parseSignupEvent(null)).toBeNull();
    expect(parseSignupEvent("texto solto")).toBeNull();
  });

  it("aceita payload que chega como string JSON", () => {
    const result = parseSignupEvent(
      JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
        data: { waba_id: "WABA9" },
      }),
    );
    expect(result).toMatchObject({ kind: "finish", coexistence: true, wabaId: "WABA9" });
  });

  it("string que não é JSON não derruba o listener", () => {
    expect(parseSignupEvent("{{{nao e json")).toBeNull();
  });
});
