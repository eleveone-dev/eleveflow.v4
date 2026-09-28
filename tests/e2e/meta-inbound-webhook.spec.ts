import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { adminClient, removeTestConnection, seedTestConnection } from "./helpers/agent-seed";
import { stagingUrl } from "./helpers/supabase-admin";

const SUPABASE_URL = stagingUrl();
const APP_SECRET = process.env.STAGING_META_APP_SECRET?.trim();
const PHONE_NUMBER_ID = process.env.STAGING_META_PHONE_NUMBER_ID?.trim();

if (!APP_SECRET) {
  throw new Error("STAGING_META_APP_SECRET must be configured for E2E tests");
}
if (!PHONE_NUMBER_ID) {
  throw new Error("STAGING_META_PHONE_NUMBER_ID must be configured for E2E tests");
}

/** A Meta assina o corpo cru; assinar o objeto serializado de novo daria outro
 *  hash. Por isso o payload vai como string e é ela que é enviada e assinada. */
function signed(body: string) {
  return `sha256=${createHmac("sha256", APP_SECRET!).update(body).digest("hex")}`;
}

test.beforeAll(async () => {
  const admin = adminClient();
  const { data: users } = await admin.auth.admin.listUsers();
  const e2eUser = users?.users.find((user) => user.email === "e2e@eleveflow.test");
  if (!e2eUser) throw new Error("usuário e2e@eleveflow.test não existe");
  await seedTestConnection(admin, e2eUser.id, PHONE_NUMBER_ID!);
});

test.afterAll(async () => {
  // A conexão fictícia não pode sobreviver ao teste: a aplicação a exibiria
  // como se fosse um número real.
  await removeTestConnection(adminClient(), PHONE_NUMBER_ID!);
});

test("mensagem inbound da Meta é registrada no banco", async ({ request }) => {
  const wamid = `wamid.E2E-${Date.now()}`;
  const admin = adminClient();

  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "E2E-WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5511999990000",
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: "E2E" }, wa_id: "5511999990000" }],
              messages: [
                {
                  from: "5511999990000",
                  id: wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "olá, quero saber mais" },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const res = await request.post(`${SUPABASE_URL}/functions/v1/meta-whatsapp-webhook`, {
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signed(body) },
    data: body,
  });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).success).toBe(true);

  const { data: msg } = await admin
    .from("messages")
    .select("id, direction, content")
    .eq("whatsapp_id", wamid)
    .maybeSingle();

  expect(msg).not.toBeNull();
  expect(msg!.direction).toBe("inbound");
  expect(msg!.content).toBe("olá, quero saber mais");
});

test("assinatura inválida é rejeitada com 401", async ({ request }) => {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  from: "5511999990000",
                  id: `wamid.FORGED-${Date.now()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "forjada" },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const res = await request.post(`${SUPABASE_URL}/functions/v1/meta-whatsapp-webhook`, {
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    data: body,
  });
  expect(res.status()).toBe(401);
});

test("verificação de inscrição devolve o challenge", async ({ request }) => {
  const verifyToken = process.env.STAGING_META_WEBHOOK_VERIFY_TOKEN?.trim();
  test.skip(!verifyToken, "STAGING_META_WEBHOOK_VERIFY_TOKEN não configurado");

  const challenge = String(Date.now());
  const res = await request.get(
    `${SUPABASE_URL}/functions/v1/meta-whatsapp-webhook` +
      `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken!)}` +
      `&hub.challenge=${challenge}`,
  );
  expect(res.status()).toBe(200);
  expect((await res.text()).trim()).toBe(challenge);

  const wrong = await request.get(
    `${SUPABASE_URL}/functions/v1/meta-whatsapp-webhook` +
      `?hub.mode=subscribe&hub.verify_token=token-errado&hub.challenge=${challenge}`,
  );
  expect(wrong.status()).toBe(403);
});
