import { describe, it, expect } from "vitest";
import {
  readPublicMetaConfig,
  validateEmbeddedSignupInput,
  saveEmbeddedSignupConfig,
} from "../../supabase/functions/_shared/whatsapp/embedded-signup-config";
import { createFakeClient } from "./helpers/fake-supabase";

const settings = (rows: Record<string, string>) => ({
  global_settings: Object.entries(rows).map(([key, value]) => ({ key, value })),
});

describe("readPublicMetaConfig — configuração completa", () => {
  it("devolve os quatro campos públicos", async () => {
    const client = createFakeClient(
      settings({
        meta_app_id: "1742922410057266",
        meta_embedded_signup_config_id: "1234567890123456",
        meta_graph_api_version: "v25.0",
        meta_embedded_signup_enabled: "true",
      }),
    ) as any;

    expect(await readPublicMetaConfig(client)).toEqual({
      appId: "1742922410057266",
      configId: "1234567890123456",
      graphApiVersion: "v25.0",
      enabled: true,
    });
  });
});

describe("readPublicMetaConfig — configuração ausente", () => {
  it("sem nenhuma chave devolve nulos e enabled falso", async () => {
    const client = createFakeClient(settings({})) as any;
    expect(await readPublicMetaConfig(client)).toEqual({
      appId: null,
      configId: null,
      graphApiVersion: "v25.0",
      enabled: false,
    });
  });

  it("versão da Graph API cai no padrão quando ausente", async () => {
    const client = createFakeClient(settings({ meta_app_id: "1742922410057266" })) as any;
    expect((await readPublicMetaConfig(client)).graphApiVersion).toBe("v25.0");
  });
});

describe("readPublicMetaConfig — Embedded Signup desabilitado", () => {
  it("enabled falso mesmo com app id e config id presentes", async () => {
    const client = createFakeClient(
      settings({
        meta_app_id: "1742922410057266",
        meta_embedded_signup_config_id: "1234567890123456",
        meta_embedded_signup_enabled: "false",
      }),
    ) as any;
    const config = await readPublicMetaConfig(client);
    expect(config.enabled).toBe(false);
    expect(config.appId).toBe("1742922410057266");
  });

  it("habilitado no banco mas sem config id não pode reportar enabled", async () => {
    const client = createFakeClient(
      settings({ meta_app_id: "1742922410057266", meta_embedded_signup_enabled: "true" }),
    ) as any;
    // Um enabled=true sem os ids faria o frontend tentar abrir o SDK sem
    // parâmetros e falhar de forma opaca.
    expect((await readPublicMetaConfig(client)).enabled).toBe(false);
  });
});

describe("readPublicMetaConfig — nenhum segredo na resposta", () => {
  it("ignora chaves sensíveis mesmo que existam em global_settings", async () => {
    const client = createFakeClient(
      settings({
        meta_app_id: "1742922410057266",
        meta_embedded_signup_config_id: "1234567890123456",
        meta_embedded_signup_enabled: "true",
        meta_webhook_verify_token: "TOKEN-DE-VERIFICACAO-NAO-PODE-VAZAR",
        meta_app_secret_encrypted: "v1:SEGREDO.CIFRADO",
        edge_functions_internal_secret: "SEGREDO-INTERNO",
      }),
    ) as any;

    const config = await readPublicMetaConfig(client);
    const serialized = JSON.stringify(config);

    expect(Object.keys(config).sort()).toEqual(["appId", "configId", "enabled", "graphApiVersion"]);
    expect(serialized).not.toContain("TOKEN-DE-VERIFICACAO-NAO-PODE-VAZAR");
    expect(serialized).not.toContain("SEGREDO");
  });
});

describe("validateEmbeddedSignupInput", () => {
  it("aceita ids numéricos plausíveis", () => {
    expect(
      validateEmbeddedSignupInput({
        appId: "1742922410057266",
        configId: "1234567890123456",
        enabled: true,
      }),
    ).toEqual({ ok: true });
  });

  it.each(["abc", "17429-22410", "17429 22410", "174292241005726x"])(
    "rejeita app id não numérico: %s",
    (appId) => {
      const result = validateEmbeddedSignupInput({
        appId,
        configId: "1234567890123456",
        enabled: false,
      });
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain("App ID");
    },
  );

  it("rejeita app id curto demais para ser real", () => {
    const result = validateEmbeddedSignupInput({ appId: "123", configId: "", enabled: false });
    expect(result.ok).toBe(false);
  });

  it.each(["abc", "12-34", "x1234567890123"])("rejeita config id inválido: %s", (configId) => {
    const result = validateEmbeddedSignupInput({
      appId: "1742922410057266",
      configId,
      enabled: false,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("Configuration ID");
  });

  it("aceita campos vazios quando o Embedded Signup fica desabilitado", () => {
    expect(validateEmbeddedSignupInput({ appId: "", configId: "", enabled: false })).toEqual({
      ok: true,
    });
  });

  it("não deixa habilitar sem App ID", () => {
    const result = validateEmbeddedSignupInput({
      appId: "",
      configId: "1234567890123456",
      enabled: true,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("App ID");
  });

  it("não deixa habilitar sem Configuration ID", () => {
    const result = validateEmbeddedSignupInput({
      appId: "1742922410057266",
      configId: "",
      enabled: true,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("Configuration ID");
  });
});

describe("saveEmbeddedSignupConfig", () => {
  it("grava as três chaves em global_settings", async () => {
    const db = settings({});
    const client = createFakeClient(db) as any;

    await saveEmbeddedSignupConfig(client, {
      appId: "1742922410057266",
      configId: "1234567890123456",
      enabled: true,
    });

    const gravado = Object.fromEntries(db.global_settings.map((r: any) => [r.key, r.value]));
    expect(gravado).toMatchObject({
      meta_app_id: "1742922410057266",
      meta_embedded_signup_config_id: "1234567890123456",
      meta_embedded_signup_enabled: "true",
    });
  });

  it("atualiza chave já existente em vez de duplicar", async () => {
    const db = settings({ meta_app_id: "111111111111111" });
    const client = createFakeClient(db) as any;

    await saveEmbeddedSignupConfig(client, {
      appId: "1742922410057266",
      configId: "1234567890123456",
      enabled: false,
    });

    const linhas = db.global_settings.filter((r: any) => r.key === "meta_app_id");
    expect(linhas).toHaveLength(1);
    expect(linhas[0].value).toBe("1742922410057266");
  });

  it("recusa entrada inválida antes de gravar", async () => {
    const db = settings({});
    const client = createFakeClient(db) as any;

    await expect(
      saveEmbeddedSignupConfig(client, { appId: "nao-numerico", configId: "", enabled: false }),
    ).rejects.toThrow("App ID");
    expect(db.global_settings).toHaveLength(0);
  });
});
