# Plano de implementação — Bloco A (Fundação) da migração WhatsApp → Meta Cloud API

> **Para executores agênticos:** SUB-SKILL OBRIGATÓRIA — usar
> `superpowers:subagent-driven-development` (recomendado) ou
> `superpowers:executing-plans` para executar tarefa a tarefa. Os passos usam
> checkbox (`- [ ]`) para rastreio.

**Spec:** `docs/specs/2026-07-24-migracao-whatsapp-meta-cloud-design.md`

**Objetivo:** entregar a fundação verificável sem credenciais Meta — abstração de
provider, criptografia de tokens, tabela `whatsapp_connections`, gate superadmin,
webhook Meta e envio pela abstração — e retirar a Evolution do produto ao final.

> ## Revisão de escopo — 2026-07-25 (decisão do dono)
>
> **A Evolution sai do produto.** A spec original a mantinha como fallback por
> empresa (`docs/specs/2026-07-24-...:18`, `:54`, `:351`); essa decisão foi
> revertida. Não há mais provider duplo, nem rollback para Baileys.
>
> **Ordem de execução:** primeiro o caminho Meta de pé e provado, **depois** a
> remoção. A orquestração do CRM (IA, fluxos, dedupe, opt-out — 1029 linhas)
> mora dentro do `whatsapp-webhook` da Evolution: ela **muda de casa**, não some.
> Apagar antes de mover deixaria o repo vermelho no meio do caminho.
>
> **Consequência aceita:** enquanto as credenciais Meta não chegarem
> (`META_APP_ID`, `META_APP_SECRET`, access token, app aprovado), o produto não
> envia nem recebe WhatsApp. Não existe caminho de contingência depois da Task 16.
>
> **Deltas por tarefa:**
>
> | Task | Mudança |
> |---|---|
> | 1–2 | inalteradas. `hmac.ts` serve o `X-Hub-Signature-256` da Meta. |
> | 3 | `WhatsAppProviderId` = `"meta_cloud"` apenas; `InboundMessage.instance` sai. |
> | 4 | vira `crm-parse.ts`: extrai só `phoneVariants` e `isMarketingOptOutMessage` (regra de negócio neutra). `phoneFromSenderIdentifier` e `extractIncomingMessage` são parse de Baileys — morrem na Task 16. |
> | 5 | **removida** (`EvolutionProvider` não existe mais). |
> | 6–8 | inalteradas (já eram Meta puro). |
> | 9 | migration sem coluna `provider`: a tabela é a conexão Meta do tenant. |
> | 10 | `resolveProvider` sem branch. Sem linha ou `status != 'connected'` → `HttpError(409)` explícito, nunca fallback silencioso. |
> | 11–15 | inalteradas. |
> | **16 (nova)** | **Remoção da Evolution**: edge functions, módulos `_shared`, tela de QR, secrets, testes. |
>
> **Decisão em aberto (trava a Task 16):** a tela `src/pages/Whatsapp.tsx` conecta
> número por QR da Evolution. O substituto oficial (Embedded Signup) é Bloco B,
> Fase 4, travado em credencial. Definir com o dono antes da Task 16: tela mínima
> de conexão Meta no Bloco A (superadmin cola Phone Number ID + token) ou conexão
> só por script até o Bloco B.

**Arquitetura:** todo módulo novo de lógica vive em `supabase/functions/_shared/`
e recebe dependências por parâmetro (client, fetch, env, segredos), porque esses
módulos rodam em Deno (edge) **e** em Node/Vitest. As edge functions ficam como
casca fina: leem `Deno.env`, montam as deps e chamam os módulos compartilhados.
`resolveProvider()` é o único ponto do sistema que escolhe entre Evolution e Meta.

**Stack:** Deno (edge functions), TypeScript, Vitest (unit), Playwright (E2E),
Postgres/Supabase, Web Crypto API.

## Constraints globais

Valem para **todas** as tarefas:

- Módulos em `_shared/` importados por testes **não podem** usar APIs `Deno.*`
  nem `import` por URL. Configuração e segredos entram por parâmetro.
- Imports entre arquivos de edge function usam extensão `.ts`
  (`../_shared/whatsapp/types.ts`). Testes importam sem extensão
  (`../../supabase/functions/_shared/whatsapp/types`), seguindo
  `tests/unit/evolution.test.ts`.
- Dinheiro em centavos (inteiro); custo de API em `cost_usd_micros` (bigint).
- Nenhuma chamada real à Meta neste bloco. Todo teste injeta `fetch`.
- Token de acesso, App Secret e chave de criptografia **nunca** em log, em
  mensagem de erro ou em resposta HTTP.
- Versão da Graph API **nunca** fixa no código: vem de
  `global_settings.meta_graph_api_version` (fallback `META_GRAPH_API_VERSION`).
- Migrations aditivas. Nenhuma alteração destrutiva de schema.
- Conventional Commits, um commit por tarefa, sem menção a ferramenta de IA.
- **Até a Task 15 o comportamento atual da Evolution fica intocado**: qualquer
  diferença observável antes da Task 16 é bug. A remoção é um passo único,
  deliberado e no fim da fila.

## Fatos do código verificados em 2026-07-25 (base do plano)

- `supabase/functions/_shared/evolution.ts` — `sendWhatsAppText({apiUrl, apiKey,
  instance, number, text, mock, timeoutMs, fetchFn})` → `{ok, status, data}`.
- `process-queue/index.ts:341` — `const instanceName = userId;`; envio em
  `:528`; id da mensagem lido de `data.key.id` em `:537`.
- `whatsapp-webhook/index.ts` — 1029 linhas, handler único em `serve()` a partir
  de `:164`. Funções puras nas linhas 25–105; `safeLog` `:107`;
  `recordMarketingOptOut` `:115`; resolução de tenant por instância `:225–250`;
  dedupe `:252–276`; orquestração CRM `:278–1005`.
- `_shared/auth.ts` — tem `HttpError`, `constantTimeEqual` (privado),
  `hmacSha256Hex` (privado), `verifyEvolutionWebhook`; importa `esm.sh` → **não**
  é importável no Vitest.
- `_shared/ai.ts` — `MinimalClient = { from: (table:string)=>any }`,
  `getGlobalSetting(client,key)`, `callLLM`, `makeApiCallRecorder`. Deno-free.
- `messages` — `id, user_id, lead_id, flow_id, block_id, direction, content,
  status default 'pending', whatsapp_id, created_at`. Sem índice em `whatsapp_id`.
- `global_settings` — `key text pk, value text not null`, RLS on, `GRANT SELECT`
  só para `service_role`.
- `public.update_updated_at_column()` existe (migration `20260607130538`).
- `vitest.config.ts` — `include: tests/unit/**/*.test.ts`; coverage `include`
  lista 5 módulos; thresholds 80% em lines/branches/functions/statements.
- Não existem: `_shared/whatsapp/`, `_shared/crypto.ts`, `whatsapp_connections`,
  superadmin, templates, mídia.

## Referência oficial Meta consultada em 2026-07-25 (fonte de verdade do Bloco A)

Copiar destes formatos, não do conhecimento de treino:

- **Enviar:** `POST https://graph.facebook.com/{VERSION}/{PHONE_NUMBER_ID}/messages`,
  headers `Authorization: Bearer <token>` + `Content-Type: application/json`.
  - texto: `{"messaging_product":"whatsapp","recipient_type":"individual","to":"<phone>","type":"text","text":{"body":"<msg>"}}`
  - mídia por id: `{"...","type":"image","image":{"id":"<media_id>"}}`; por link: `{"image":{"link":"https://..."}}`
  - template: `{"...","type":"template","template":{"name":"<name>","language":{"code":"en_US"}}}`
  - resposta ok: `{"messaging_product":"whatsapp","contacts":[{"input":"...","wa_id":"..."}],"messages":[{"id":"wamid...","message_status":"accepted"}]}`
- **Marcar como lida:** mesmo endpoint, corpo
  `{"messaging_product":"whatsapp","status":"read","message_id":"<wamid>"}` →
  `{"success":true}`.
- **Mídia:** `GET /{VERSION}/{MEDIA_ID}?phone_number_id={PHONE_NUMBER_ID}` com Bearer →
  `{"messaging_product","url","mime_type","sha256","file_size","id"}` (url expira em
  5 min); baixar o binário fazendo `GET <url>` **com o mesmo header Bearer**.
  Upload: `POST /{VERSION}/{PHONE_NUMBER_ID}/media` multipart
  (`messaging_product`, `file`, `type`).
- **Templates:** `GET /{VERSION}/{WABA_ID}/message_templates?status=&category=&name=` →
  `{"data":[{"name","components","language","status","category","id"}],"paging":{"cursors":{...}}}`.
  Criar: `POST /{VERSION}/{WABA_ID}/message_templates` com
  `{"name","category","language","components"}` → `{"status":"APPROVED","id":"..."}`.
  `category` ∈ AUTHENTICATION | MARKETING | UTILITY.
- **Webhook GET (verificação):** query `hub.mode` (sempre `subscribe`),
  `hub.challenge`, `hub.verify_token`; responder **exatamente** o `hub.challenge`.
- **Webhook POST (assinatura):** header `X-Hub-Signature-256`, formato
  `sha256=<hex>`, HMAC-SHA256 do **corpo cru** com o **App Secret**.
- **Envelope do webhook:**
  ```json
  {"object":"whatsapp_business_account","entry":[{"id":"<WABA_ID>","changes":[{"value":{
    "messaging_product":"whatsapp",
    "metadata":{"display_phone_number":"15550783881","phone_number_id":"106540352242922"},
    "contacts":[{"profile":{"name":"Sheena Nelson"},"wa_id":"16505551234"}],
    "messages":[{"from":"16505551234","id":"wamid.HBg...","timestamp":"1749416383","type":"text","text":{"body":"Does it come in another color?"}}]
  },"field":"messages"}]}]}
  ```
- **Inbound de imagem:** `messages[0]` =
  `{"from":"...","id":"wamid...","timestamp":"1744344496","type":"image","image":{"caption":"Taj Mahal","mime_type":"image/jpeg","sha256":"...","id":"1003383421387256","url":"https://lookaside..."}}`
- **statuses[]:**
  ```json
  {"id":"<wamid>","status":"<STATUS>","timestamp":"<unix>","recipient_id":"<phone>",
   "conversation":{"id":"...","origin":{"type":"..."}},
   "pricing":{"billable":true,"pricing_model":"...","category":"..."},
   "errors":[{"code":131049,"title":"...","message":"...","error_data":{"details":"..."},"href":"..."}]}
  ```
  Valores: `sent`, `delivered`, `read`, `played`, `failed`.

## Desvios conscientes em relação à spec (aprovar antes de executar)

1. **`encryptSecret`/`decryptSecret` são assíncronos e recebem a chave por
   parâmetro** (`(plaintext, keyBase64) => Promise<string>`), não `(plaintext) => string`.
   Motivo: Web Crypto é assíncrona e o módulo precisa ser Deno-free para rodar no
   Vitest. Quem lê `Deno.env.get("WHATSAPP_TOKEN_ENC_KEY")` é a edge function.
2. **Status `played` existe** na Cloud API e não está na união da spec
   (`sent|delivered|read|failed`). `parseWebhook` **descarta** status fora da
   união, com teste. Tratamento de `played` fica para o Bloco B.
3. **`interactive` não vira texto** no Bloco A: a spec normaliza o tipo, mas a
   forma exata do objeto `interactive` não foi confirmada na doc oficial nesta
   consulta. O parser marca `type:"interactive"` sem `text`. Extrair o título do
   botão/lista fica para a Fase 7 (Bloco B), com a doc na mão.
4. ~~`EvolutionProvider.parseWebhook` existe para a interface e para o teste de
   paridade~~ — **obsoleto** pela revisão de escopo: não há `EvolutionProvider`.
   Os códigos de motivo do 200 atual (`unsupported_event`, `fromMe`,
   `unresolved_lid`, `no_phone`, `empty_or_unsupported_content`,
   `missing_instance`) são específicos do Baileys e saem na Task 16.
5. **`HttpError`, `hmacSha256Hex` e `constantTimeEqual` saem de `auth.ts`** para
   módulos Deno-free (`_shared/http-error.ts`, `_shared/hmac.ts`), reexportados
   por `auth.ts` para não quebrar importadores.
6. **Characterization test é em duas camadas**: unit sobre as funções puras
   extraídas (real, roda antes do move) + E2E `inbound-webhook.spec.ts` verde
   antes e depois da extração do orquestrador. Não existe forma de testar o corpo
   de `serve()` antes de extraí-lo. Com a revisão de escopo, o alvo do unit passa
   a ser `crm-parse.ts` (regra neutra); o E2E da Evolution só cai na Task 16,
   substituído por um E2E equivalente contra o webhook Meta.
7. **O webhook da Meta processa de forma síncrona** antes de responder 200, como
   o webhook da Evolution já faz hoje. A spec fala em "processamento pesado
   assíncrono"; adotar isso agora significaria mudar o modelo do webhook atual e
   quebrar a paridade que o Bloco A precisa provar. Fica para a Fase 7, quando
   houver volume real de mídia.
8. **`WebhookParseResult` ganha `phoneNumberId?: string`** no nível do resultado,
   além do campo por mensagem. Sem isso, um payload que traz **só** `statuses[]`
   não permite resolver o tenant — `StatusUpdate` não carrega o número.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/_shared/http-error.ts` | classe `HttpError` (Deno-free) |
| `supabase/functions/_shared/hmac.ts` | `hmacSha256Hex`, `constantTimeEqual` |
| `supabase/functions/_shared/crypto.ts` | AES-256-GCM `v1:` versionado |
| `supabase/functions/_shared/platform-role.ts` | leitura pura do claim de superadmin |
| `supabase/functions/_shared/whatsapp/types.ts` | interface `WhatsAppProvider` e DTOs |
| `supabase/functions/_shared/whatsapp/crm-parse.ts` | regra de negócio neutra movida do webhook (variantes de telefone, opt-out) |
| `supabase/functions/_shared/whatsapp/meta-provider.ts` | provider Meta Cloud API |
| `supabase/functions/_shared/whatsapp/inbound-orchestrator.ts` | orquestração CRM compartilhada |
| `supabase/functions/_shared/whatsapp/index.ts` | `resolveProvider` |
| `supabase/functions/meta-whatsapp-webhook/index.ts` | webhook Meta (GET verify + POST eventos) |
| `supabase/migrations/20260725120000_whatsapp_connections.sql` | tabela + índices + RLS + settings |
| `scripts/set-superadmin.mjs` | semeia `app_metadata.platform_role` |
| `tests/unit/helpers/fake-supabase.ts` | client fake encadeável para testes |
| `tests/unit/*.test.ts` | um arquivo por módulo novo |

---

## Task 1: Módulos base Deno-free (`http-error.ts`, `hmac.ts`)

**Files:**
- Create: `supabase/functions/_shared/http-error.ts`
- Create: `supabase/functions/_shared/hmac.ts`
- Modify: `supabase/functions/_shared/auth.ts` (linhas 13–21, 101–112, 285–297)
- Test: `tests/unit/hmac.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `class HttpError { status: number; message: string }`;
  `hmacSha256Hex(secret: string, payload: string): Promise<string>`;
  `constantTimeEqual(a: string, b: string): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/hmac.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hmacSha256Hex, constantTimeEqual } from "../../supabase/functions/_shared/hmac";

describe("hmacSha256Hex", () => {
  it("gera o HMAC-SHA256 hex conhecido para 'key'/'The quick brown fox jumps over the lazy dog'", async () => {
    const hex = await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog");
    expect(hex).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("é sensível a mudança de um byte do payload", async () => {
    const a = await hmacSha256Hex("s", "payload");
    const b = await hmacSha256Hex("s", "payloae");
    expect(a).not.toBe(b);
  });
});

describe("constantTimeEqual", () => {
  it("verdadeiro para strings iguais", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("falso para tamanhos diferentes", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("falso para mesmo tamanho e conteúdo diferente", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/hmac.test.ts`
Expected: FAIL — `Failed to resolve import ".../_shared/hmac"`.

- [ ] **Step 3: Implementar**

`supabase/functions/_shared/http-error.ts`:

```ts
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
```

`supabase/functions/_shared/hmac.ts`:

```ts
// HMAC e comparação de tempo constante compartilhados por webhooks.
// Roda em Deno (edge) e Node/Vitest: sem APIs Deno nem import por URL.

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let difference = aBytes.length ^ bBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }

  return difference === 0;
}
```

Em `supabase/functions/_shared/auth.ts`: apagar a declaração de `HttpError`
(linhas 13–21), a de `constantTimeEqual` (101–112) e a de `hmacSha256Hex`
(285–297); no topo do arquivo adicionar

```ts
import { HttpError } from "./http-error.ts";
import { constantTimeEqual, hmacSha256Hex } from "./hmac.ts";

export { HttpError };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/hmac.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Verificar que nada quebrou**

Run: `npm run typecheck` → 0 erros.
Run: `bash scripts/sb-staging.sh functions list` **não** é necessário aqui; em vez
disso `deno check supabase/functions/whatsapp-webhook/index.ts supabase/functions/process-queue/index.ts`
Expected: sem erro (`Check file:///...`).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/http-error.ts supabase/functions/_shared/hmac.ts supabase/functions/_shared/auth.ts tests/unit/hmac.test.ts
git commit -m "refactor(shared): extrai HttpError e HMAC para modulos testaveis"
```

---

## Task 2: Criptografia AES-256-GCM (`_shared/crypto.ts`)

**Files:**
- Create: `supabase/functions/_shared/crypto.ts`
- Test: `tests/unit/crypto.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `encryptSecret(plaintext: string, keyBase64: string): Promise<string>`
  (formato `v1:<base64 iv>.<base64 ct+tag>`);
  `decryptSecret(payload: string, keyBase64: string): Promise<string>`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/crypto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../../supabase/functions/_shared/crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("crypto", () => {
  it("round-trip devolve o texto original", async () => {
    const payload = await encryptSecret("EAAJB-token-secreto", KEY);
    expect(await decryptSecret(payload, KEY)).toBe("EAAJB-token-secreto");
  });

  it("payload é versionado e não contém o plaintext", async () => {
    const payload = await encryptSecret("EAAJB-token-secreto", KEY);
    expect(payload.startsWith("v1:")).toBe(true);
    expect(payload).not.toContain("EAAJB-token-secreto");
  });

  it("duas cifragens do mesmo texto diferem (IV aleatório)", async () => {
    const a = await encryptSecret("mesmo", KEY);
    const b = await encryptSecret("mesmo", KEY);
    expect(a).not.toBe(b);
  });

  it("adulteração do ciphertext é detectada", async () => {
    const payload = await encryptSecret("token", KEY);
    const [head, tail] = payload.split(".");
    const flipped = tail[0] === "A" ? "B" + tail.slice(1) : "A" + tail.slice(1);
    await expect(decryptSecret(`${head}.${flipped}`, KEY)).rejects.toThrow(
      "Encrypted payload failed authentication",
    );
  });

  it("chave errada não decifra", async () => {
    const payload = await encryptSecret("token", KEY);
    await expect(decryptSecret(payload, OTHER_KEY)).rejects.toThrow(
      "Encrypted payload failed authentication",
    );
  });

  it("chave com tamanho inválido falha com erro claro", async () => {
    await expect(encryptSecret("x", btoa("curta"))).rejects.toThrow(
      "WHATSAPP_TOKEN_ENC_KEY must decode to exactly 32 bytes",
    );
  });

  it("chave ausente falha com erro claro", async () => {
    await expect(encryptSecret("x", "")).rejects.toThrow("WHATSAPP_TOKEN_ENC_KEY is required");
  });

  it("versão desconhecida é rejeitada", async () => {
    await expect(decryptSecret("v2:aaa.bbb", KEY)).rejects.toThrow(
      "Unsupported encrypted payload version",
    );
  });

  it("payload malformado é rejeitado", async () => {
    await expect(decryptSecret("v1:semponto", KEY)).rejects.toThrow("Malformed encrypted payload");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/crypto.test.ts`
Expected: FAIL — `Failed to resolve import ".../_shared/crypto"`.

- [ ] **Step 3: Implementar**

`supabase/functions/_shared/crypto.ts`:

```ts
// AES-256-GCM para segredos de integração (tokens Meta, App Secret).
// A chave vem por parâmetro: este módulo roda em Deno (edge) e Node/Vitest,
// então não lê Deno.env nem importa por URL. Nunca logar plaintext nem chave.

const VERSION = "v1";
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const trimmed = String(keyBase64 ?? "").trim();
  if (!trimmed) throw new Error("WHATSAPP_TOKEN_ENC_KEY is required");

  let raw: Uint8Array;
  try {
    raw = fromBase64(trimmed);
  } catch {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY is not valid base64");
  }
  if (raw.length !== 32) {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY must decode to exactly 32 bytes");
  }

  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `${VERSION}:${toBase64(iv)}.${toBase64(ciphertext)}`;
}

export async function decryptSecret(payload: string, keyBase64: string): Promise<string> {
  const raw = String(payload ?? "");
  const separator = raw.indexOf(":");
  if (separator === -1 || raw.slice(0, separator) !== VERSION) {
    throw new Error("Unsupported encrypted payload version");
  }

  const [ivPart, ciphertextPart] = raw.slice(separator + 1).split(".");
  if (!ivPart || !ciphertextPart) throw new Error("Malformed encrypted payload");

  const key = await importKey(keyBase64);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivPart) },
      key,
      fromBase64(ciphertextPart),
    );
  } catch {
    // Erro genérico de propósito: distinguir chave errada de tag inválida
    // vazaria informação sobre o segredo.
    throw new Error("Encrypted payload failed authentication");
  }

  return new TextDecoder().decode(plain);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/crypto.test.ts`
Expected: PASS (9 testes).

- [ ] **Step 5: Adicionar ao coverage e conferir**

Em `vitest.config.ts`, acrescentar à lista `coverage.include`:
`"supabase/functions/_shared/crypto.ts"` e `"supabase/functions/_shared/hmac.ts"`.

Run: `npm run test`
Expected: todos os testes passam e o gate de cobertura (80%) continua verde.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/crypto.ts tests/unit/crypto.test.ts vitest.config.ts
git commit -m "feat(shared): criptografia AES-256-GCM versionada para segredos de integracao"
```

---

## Task 3: Contratos do provider (`whatsapp/types.ts`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp/types.ts`
- Test: `tests/unit/whatsapp-types.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `WhatsAppProviderId`, `SendResult`, `SendTextParams`, `SendMediaParams`,
  `SendTemplateParams`, `MarkAsReadParams`, `CreateTemplateParams`, `InboundMessage`,
  `StatusUpdate`, `WebhookParseResult`, `TemplateSummary`, `DownloadedMedia`,
  `WhatsAppProvider`, `class NotSupportedError`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/whatsapp-types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NotSupportedError } from "../../supabase/functions/_shared/whatsapp/types";

describe("NotSupportedError", () => {
  it("nomeia provider e operação sem vazar detalhes", () => {
    const error = new NotSupportedError("meta_cloud", "sendTemplate");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotSupportedError");
    expect(error.message).toBe("Provider meta_cloud does not support sendTemplate");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/whatsapp-types.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`supabase/functions/_shared/whatsapp/types.ts`:

```ts
// Contrato único de provedor de WhatsApp. Automações, filas, IA e telas falam
// só com esta interface — nunca com Evolution ou Graph API direto.

export type WhatsAppProviderId = "meta_cloud";

export interface SendResult {
  ok: boolean;
  providerMessageId: string | null;
  status: number;
  raw: unknown;
  error?: { code?: string; message: string };
}

export interface SendTextParams {
  to: string;
  text: string;
}

export interface SendMediaParams {
  to: string;
  kind: "image" | "audio" | "video" | "document";
  mediaId?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

export interface SendTemplateParams {
  to: string;
  name: string;
  languageCode: string;
  components?: unknown[];
}

export interface MarkAsReadParams {
  providerMessageId: string;
}

export interface CreateTemplateParams {
  name: string;
  category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
  language: string;
  components: unknown[];
}

export type InboundMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "interactive"
  | "unsupported";

export interface InboundMessage {
  providerMessageId: string;
  fromPhone: string;
  phoneNumberId?: string;
  type: InboundMessageType;
  text?: string;
  media?: { id: string; mimeType?: string; caption?: string; filename?: string };
  timestamp: string;
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface StatusUpdate {
  providerMessageId: string;
  status: DeliveryStatus;
  timestamp: string;
  error?: { code?: string; message: string };
}

export interface WebhookParseResult {
  inbound: InboundMessage[];
  statuses: StatusUpdate[];
  /** Número que recebeu o evento. Único caminho para achar o tenant quando o
   *  payload traz apenas statuses. */
  phoneNumberId?: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components?: unknown[];
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  sendText(params: SendTextParams): Promise<SendResult>;
  sendMedia(params: SendMediaParams): Promise<SendResult>;
  sendTemplate(params: SendTemplateParams): Promise<SendResult>;
  markAsRead(params: MarkAsReadParams): Promise<void>;
  downloadMedia(mediaId: string): Promise<DownloadedMedia>;
  getConnectionStatus(): Promise<{ connected: boolean; details: unknown }>;
  listTemplates(): Promise<TemplateSummary[]>;
  createTemplate(params: CreateTemplateParams): Promise<TemplateSummary>;
  verifyWebhook(req: Request, rawBody: string): Promise<void>;
  parseWebhook(rawBody: string): WebhookParseResult;
}

export class NotSupportedError extends Error {
  constructor(provider: WhatsAppProviderId, operation: string) {
    super(`Provider ${provider} does not support ${operation}`);
    this.name = "NotSupportedError";
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/whatsapp-types.test.ts`
Expected: PASS (1 teste).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp/types.ts tests/unit/whatsapp-types.test.ts
git commit -m "feat(whatsapp): contrato unico de provedor e DTOs normalizados"
```

---

## Task 4: Regra de negócio neutra do webhook (`crm-parse.ts`)

> Revisada em 2026-07-25 pela decisão de remover a Evolution. A versão anterior
> movia as quatro funções puras do webhook, incluindo o parse do shape Baileys.
> `phoneFromSenderIdentifier` e `extractIncomingMessage` leem o envelope da
> Evolution e não sobrevivem à Task 16 — ficam onde estão até lá. Aqui saem só as
> duas que são regra de negócio do CRM e valem para qualquer provedor.

Mover, **sem alterar uma linha de lógica**, `phoneVariants` e
`isMarketingOptOutMessage` do `whatsapp-webhook/index.ts` para um módulo
testável, e fixar o comportamento atual em teste antes de o orquestrador mudar
de casa (Task 12).

**Files:**
- Create: `supabase/functions/_shared/whatsapp/crm-parse.ts`
- Modify: `supabase/functions/whatsapp-webhook/index.ts:35-45,90-105` (apagar as
  duas funções e importar do novo módulo)
- Test: `tests/unit/crm-parse.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `phoneVariants(digits: string): string[]`;
  `isMarketingOptOutMessage(text: string): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/crm-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  phoneVariants,
  isMarketingOptOutMessage,
} from "../../supabase/functions/_shared/whatsapp/crm-parse";

describe("phoneVariants", () => {
  it("13 dígitos com 55 gera variante sem DDI", () => {
    expect(phoneVariants("5511999998888")).toEqual(["5511999998888", "11999998888"]);
  });

  it("12 dígitos com 55 gera variante sem DDI", () => {
    expect(phoneVariants("551199999888")).toEqual(["551199999888", "1199999888"]);
  });

  it("11 dígitos gera variante com 55", () => {
    expect(phoneVariants("11999998888")).toEqual(["11999998888", "5511999998888"]);
  });

  it("10 dígitos gera variante com 55", () => {
    expect(phoneVariants("1199999888")).toEqual(["1199999888", "551199999888"]);
  });

  it("fora das faixas conhecidas devolve só o próprio número", () => {
    expect(phoneVariants("123456789")).toEqual(["123456789"]);
  });

  it("string vazia gera lista vazia", () => {
    expect(phoneVariants("")).toEqual([]);
  });
});

describe("isMarketingOptOutMessage", () => {
  it.each([
    "PARE",
    "parar",
    "stop agora",
    "cancelar",
    "descadastre-me",
    "remova me",
    "não quero receber",
    "nao me mande mais",
  ])("reconhece opt-out em %s", (text) => {
    expect(isMarketingOptOutMessage(text)).toBe(true);
  });

  it.each(["quero comprar", "pode parar de chover?", "ok"])(
    "não confunde %s com opt-out",
    (text) => {
      expect(isMarketingOptOutMessage(text)).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/crm-parse.test.ts`
Expected: FAIL — `Failed to resolve import ".../whatsapp/crm-parse"`.

- [ ] **Step 3: Mover o código (sem alterar lógica)**

Criar `supabase/functions/_shared/whatsapp/crm-parse.ts` com o cabeçalho abaixo
seguido de `phoneVariants` e `isMarketingOptOutMessage` **copiadas verbatim** de
`whatsapp-webhook/index.ts:35-45` e `:90-105`, cada uma prefixada com `export`:

```ts
// Regra de negócio de contato do CRM, independente de provedor: variantes de
// telefone brasileiro (DDI 55) e reconhecimento de opt-out de marketing.
// Movido de whatsapp-webhook para ser compartilhado e testável: roda em Deno
// (edge) e Node/Vitest.
```

Em `whatsapp-webhook/index.ts`: apagar as duas funções e adicionar o import

```ts
import {
  isMarketingOptOutMessage,
  phoneVariants,
} from "../_shared/whatsapp/crm-parse.ts";
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/crm-parse.test.ts`
Expected: PASS.

Run: `npx vitest run`
Expected: nenhuma regressão.

Run: `deno check supabase/functions/whatsapp-webhook/index.ts`
Expected: sem erro.

Se algum caso do teste falhar, o teste está errado — **corrigir o teste para o
comportamento atual**, não o código. Este é um characterization test.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp/crm-parse.ts supabase/functions/whatsapp-webhook/index.ts tests/unit/crm-parse.test.ts
git commit -m "refactor(whatsapp): extrai regra de contato e opt-out com testes de caracterizacao"
```

---

## Task 5: ~~`EvolutionProvider`~~ — REMOVIDA

Cancelada pela revisão de escopo de 2026-07-25: a Evolution sai do produto, então
não há provider para embrulhar nem paridade a provar. O `whatsapp-webhook` e o
`process-queue` continuam chamando a Evolution direto até a Task 16 apagá-la.

---

## Task 6: `MetaProvider` — envio (`sendText`, `sendMedia`, `sendTemplate`, `markAsRead`)

**Files:**
- Create: `supabase/functions/_shared/whatsapp/meta-provider.ts`
- Test: `tests/unit/meta-provider-send.test.ts`

**Interfaces:**
- Consumes: `types.ts` (Task 3).
- Produces: `createMetaProvider(config: MetaProviderConfig): WhatsAppProvider` com
  `MetaProviderConfig = { graphApiVersion: string; phoneNumberId: string; accessToken: string; wabaId?: string; appSecret?: string; baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number }`.
  Nesta tarefa os métodos de webhook/templates/mídia ainda lançam
  `NotSupportedError`; as Tasks 7 e 8 os substituem.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/meta-provider-send.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createMetaProvider } from "../../supabase/functions/_shared/whatsapp/meta-provider";

const config = {
  graphApiVersion: "v25.0",
  phoneNumberId: "106540352242922",
  accessToken: "EAAJB-token",
};

const okResponse = () =>
  new Response(
    JSON.stringify({
      messaging_product: "whatsapp",
      contacts: [{ input: "16505551234", wa_id: "16505551234" }],
      messages: [{ id: "wamid.HBgL", message_status: "accepted" }],
    }),
    { status: 200 },
  );

function callBody(fetchFn: any, index = 0) {
  return JSON.parse(fetchFn.mock.calls[index][1].body);
}

describe("MetaProvider.sendText", () => {
  it("chama /{version}/{phone_number_id}/messages com o corpo da Cloud API", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });

    const result = await provider.sendText({ to: "16505551234", text: "olá" });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/106540352242922/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer EAAJB-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "16505551234",
      type: "text",
      text: { body: "olá" },
    });
    expect(result).toMatchObject({ ok: true, providerMessageId: "wamid.HBgL", status: 200 });
  });

  it("usa a versão configurada, nunca uma fixa", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, graphApiVersion: "v99.9", fetchFn: fetchFn as any });
    await provider.sendText({ to: "1", text: "x" });
    expect(fetchFn.mock.calls[0][0]).toContain("/v99.9/");
  });

  it("erro da Graph API vira SendResult com code e message, sem vazar o token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Unsupported post request", code: 100, type: "GraphMethodException" } }),
        { status: 400 },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const result = await provider.sendText({ to: "1", text: "x" });
    expect(result).toMatchObject({ ok: false, status: 400, providerMessageId: null });
    expect(result.error).toEqual({ code: "100", message: "Unsupported post request" });
    expect(JSON.stringify(result)).not.toContain("EAAJB-token");
  });

  it("resposta não-JSON não quebra o envio", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const result = await provider.sendText({ to: "1", text: "x" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error?.message).toBe("Erro 502 na Graph API");
  });
});

describe("MetaProvider.sendMedia", () => {
  it("mídia por id", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendMedia({ to: "1", kind: "image", mediaId: "media-1", caption: "legenda" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1",
      type: "image",
      image: { id: "media-1", caption: "legenda" },
    });
  });

  it("mídia por link", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendMedia({ to: "1", kind: "video", link: "https://cdn.test/v.mp4" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1",
      type: "video",
      video: { link: "https://cdn.test/v.mp4" },
    });
  });

  it("document aceita filename", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendMedia({ to: "1", kind: "document", mediaId: "d1", filename: "nota.pdf" });
    expect(callBody(fetchFn).document).toEqual({ id: "d1", filename: "nota.pdf" });
  });

  it("sem mediaId e sem link falha antes da rede", async () => {
    const fetchFn = vi.fn();
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(provider.sendMedia({ to: "1", kind: "image" })).rejects.toThrow(
      "sendMedia requires mediaId or link",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("MetaProvider.sendTemplate", () => {
  it("monta template com language.code", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.sendTemplate({ to: "1", name: "boas_vindas", languageCode: "pt_BR" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1",
      type: "template",
      template: { name: "boas_vindas", language: { code: "pt_BR" } },
    });
  });

  it("inclui components quando fornecidos", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const components = [{ type: "body", parameters: [{ type: "text", text: "Lucas" }] }];
    await provider.sendTemplate({ to: "1", name: "t", languageCode: "pt_BR", components });
    expect(callBody(fetchFn).template.components).toEqual(components);
  });
});

describe("MetaProvider.markAsRead", () => {
  it("posta status=read com o wamid", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await provider.markAsRead({ providerMessageId: "wamid.X" });
    expect(callBody(fetchFn)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.X",
    });
  });

  it("falha da API vira erro sem o token na mensagem", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid message id", code: 131009 } }), {
        status: 400,
      }),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(provider.markAsRead({ providerMessageId: "x" })).rejects.toThrow(
      "Invalid message id",
    );
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/meta-provider-send.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`supabase/functions/_shared/whatsapp/meta-provider.ts`:

```ts
// WhatsApp Business Platform Cloud API (Meta). Formatos conferidos na doc
// oficial em 2026-07-25 — ver docs/plans/2026-07-25-migracao-whatsapp-meta-cloud-bloco-a.md.
// A versão da Graph API vem sempre de configuração, nunca fixa aqui.

import {
  NotSupportedError,
  type CreateTemplateParams,
  type DownloadedMedia,
  type MarkAsReadParams,
  type SendMediaParams,
  type SendResult,
  type SendTemplateParams,
  type SendTextParams,
  type TemplateSummary,
  type WebhookParseResult,
  type WhatsAppProvider,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://graph.facebook.com";

export interface MetaProviderConfig {
  graphApiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string;
  appSecret?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface GraphResponse {
  ok: boolean;
  status: number;
  data: Record<string, any>;
}

function graphErrorMessage(data: Record<string, any>, status: number): string {
  const message = data?.error?.message;
  return typeof message === "string" && message ? message : `Erro ${status} na Graph API`;
}

export function createMetaProvider(config: MetaProviderConfig): WhatsAppProvider {
  const fetchFn = config.fetchFn ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 25_000);
  const graphUrl = (path: string) => `${baseUrl}/${config.graphApiVersion}/${path}`;

  const authHeaders = () => ({ Authorization: `Bearer ${config.accessToken}` });

  async function graphRequest(url: string, init: RequestInit): Promise<GraphResponse> {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const raw = await response.text();
    let data: Record<string, any>;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    return { ok: response.ok, status: response.status, data };
  }

  async function postMessages(body: Record<string, unknown>): Promise<GraphResponse> {
    return graphRequest(graphUrl(`${config.phoneNumberId}/messages`), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function toSendResult(response: GraphResponse): SendResult {
    const messageId = response.data?.messages?.[0]?.id;
    if (!response.ok) {
      const code = response.data?.error?.code;
      return {
        ok: false,
        providerMessageId: null,
        status: response.status,
        raw: response.data,
        error: {
          code: code === undefined || code === null ? undefined : String(code),
          message: graphErrorMessage(response.data, response.status),
        },
      };
    }
    return {
      ok: true,
      providerMessageId: typeof messageId === "string" ? messageId : null,
      status: response.status,
      raw: response.data,
    };
  }

  const recipient = (to: string) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
  });

  return {
    id: "meta_cloud",

    async sendText({ to, text }: SendTextParams): Promise<SendResult> {
      return toSendResult(await postMessages({ ...recipient(to), type: "text", text: { body: text } }));
    },

    async sendMedia(params: SendMediaParams): Promise<SendResult> {
      if (!params.mediaId && !params.link) {
        throw new Error("sendMedia requires mediaId or link");
      }
      const media: Record<string, unknown> = params.mediaId
        ? { id: params.mediaId }
        : { link: params.link };
      if (params.caption) media.caption = params.caption;
      if (params.filename) media.filename = params.filename;

      return toSendResult(
        await postMessages({ ...recipient(params.to), type: params.kind, [params.kind]: media }),
      );
    },

    async sendTemplate(params: SendTemplateParams): Promise<SendResult> {
      const template: Record<string, unknown> = {
        name: params.name,
        language: { code: params.languageCode },
      };
      if (params.components) template.components = params.components;

      return toSendResult(
        await postMessages({ ...recipient(params.to), type: "template", template }),
      );
    },

    async markAsRead({ providerMessageId }: MarkAsReadParams): Promise<void> {
      const response = await postMessages({
        messaging_product: "whatsapp",
        status: "read",
        message_id: providerMessageId,
      });
      if (!response.ok) {
        throw new Error(graphErrorMessage(response.data, response.status));
      }
    },

    async downloadMedia(_mediaId: string): Promise<DownloadedMedia> {
      throw new NotSupportedError("meta_cloud", "downloadMedia");
    },

    async getConnectionStatus(): Promise<{ connected: boolean; details: unknown }> {
      throw new NotSupportedError("meta_cloud", "getConnectionStatus");
    },

    async listTemplates(): Promise<TemplateSummary[]> {
      throw new NotSupportedError("meta_cloud", "listTemplates");
    },

    async createTemplate(_params: CreateTemplateParams): Promise<TemplateSummary> {
      throw new NotSupportedError("meta_cloud", "createTemplate");
    },

    async verifyWebhook(_req: Request, _rawBody: string): Promise<void> {
      throw new NotSupportedError("meta_cloud", "verifyWebhook");
    },

    parseWebhook(_rawBody: string): WebhookParseResult {
      throw new NotSupportedError("meta_cloud", "parseWebhook");
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/meta-provider-send.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp/meta-provider.ts tests/unit/meta-provider-send.test.ts
git commit -m "feat(whatsapp): envio de texto, midia e template pela Cloud API da Meta"
```

---

## Task 7: `MetaProvider` — webhook (`verifyWebhook`, `parseWebhook`)

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/meta-provider.ts`
- Test: `tests/unit/meta-provider-webhook.test.ts`

**Interfaces:**
- Consumes: `hmacSha256Hex`, `constantTimeEqual` (Task 1); `HttpError` (Task 1).
- Produces: `verifyWebhook` real (401 em assinatura ausente/inválida, 503 sem App
  Secret) e `parseWebhook` real devolvendo `{ inbound, statuses }`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/meta-provider-webhook.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMetaProvider } from "../../supabase/functions/_shared/whatsapp/meta-provider";
import { hmacSha256Hex } from "../../supabase/functions/_shared/hmac";

const config = {
  graphApiVersion: "v25.0",
  phoneNumberId: "106540352242922",
  accessToken: "EAAJB-token",
  appSecret: "app-secret-de-teste",
};

const textPayload = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "102290129340398",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
            contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
            messages: [
              {
                from: "16505551234",
                id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                timestamp: "1749416383",
                type: "text",
                text: { body: "Does it come in another color?" },
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
});

async function signedRequest(body: string, secret = config.appSecret) {
  const signature = await hmacSha256Hex(secret, body);
  return new Request("https://x.test/webhook", {
    method: "POST",
    headers: { "X-Hub-Signature-256": `sha256=${signature}` },
    body,
  });
}

describe("MetaProvider.verifyWebhook", () => {
  it("aceita assinatura válida", async () => {
    const provider = createMetaProvider(config);
    await expect(
      provider.verifyWebhook(await signedRequest(textPayload), textPayload),
    ).resolves.toBeUndefined();
  });

  it("rejeita assinatura de outro segredo", async () => {
    const provider = createMetaProvider(config);
    const req = await signedRequest(textPayload, "segredo-errado");
    await expect(provider.verifyWebhook(req, textPayload)).rejects.toMatchObject({ status: 401 });
  });

  it("rejeita quando o corpo foi alterado depois de assinado", async () => {
    const provider = createMetaProvider(config);
    const req = await signedRequest(textPayload);
    await expect(provider.verifyWebhook(req, textPayload + " ")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejeita sem header de assinatura", async () => {
    const provider = createMetaProvider(config);
    const req = new Request("https://x.test/webhook", { method: "POST", body: textPayload });
    await expect(provider.verifyWebhook(req, textPayload)).rejects.toMatchObject({ status: 401 });
  });

  it("falha fechado (503) quando o App Secret não está configurado", async () => {
    const provider = createMetaProvider({ ...config, appSecret: undefined });
    const req = await signedRequest(textPayload);
    await expect(provider.verifyWebhook(req, textPayload)).rejects.toMatchObject({ status: 503 });
  });
});

describe("MetaProvider.parseWebhook", () => {
  it("normaliza mensagem de texto", () => {
    const provider = createMetaProvider(config);
    const result = provider.parseWebhook(textPayload);
    expect(result.statuses).toEqual([]);
    expect(result.inbound).toEqual([
      {
        providerMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
        fromPhone: "16505551234",
        phoneNumberId: "106540352242922",
        type: "text",
        text: "Does it come in another color?",
        timestamp: "2025-06-08T20:59:43.000Z",
      },
    ]);
  });

  it("normaliza mensagem de imagem com media id, mime e caption", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.IMG",
                    timestamp: "1744344496",
                    type: "image",
                    image: {
                      caption: "Taj Mahal",
                      mime_type: "image/jpeg",
                      sha256: "SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=",
                      id: "1003383421387256",
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    });
    const [inbound] = provider.parseWebhook(payload).inbound;
    expect(inbound).toMatchObject({
      providerMessageId: "wamid.IMG",
      type: "image",
      media: { id: "1003383421387256", mimeType: "image/jpeg", caption: "Taj Mahal" },
    });
    expect(inbound.text).toBeUndefined();
  });

  it("tipo desconhecido vira unsupported", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "106540352242922" },
                messages: [{ from: "1", id: "wamid.X", timestamp: "1744344496", type: "sticker" }],
              },
            },
          ],
        },
      ],
    });
    expect(provider.parseWebhook(payload).inbound[0].type).toBe("unsupported");
  });

  it("normaliza statuses e descarta os fora da união", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "106540352242922" },
                statuses: [
                  { id: "wamid.A", status: "sent", timestamp: "1750263773", recipient_id: "1" },
                  { id: "wamid.B", status: "delivered", timestamp: "1750263774", recipient_id: "1" },
                  { id: "wamid.C", status: "played", timestamp: "1750263775", recipient_id: "1" },
                  {
                    id: "wamid.D",
                    status: "failed",
                    timestamp: "1750263776",
                    recipient_id: "1",
                    errors: [
                      {
                        code: 131049,
                        title: "This message was not delivered to maintain healthy ecosystem engagement.",
                        message: "This message was not delivered to maintain healthy ecosystem engagement.",
                        error_data: { details: "..." },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const result = provider.parseWebhook(payload);
    const { statuses } = result;
    // Payload só de statuses: o phone_number_id do resultado é o único caminho
    // para achar o tenant.
    expect(result.phoneNumberId).toBe("106540352242922");
    expect(statuses.map((s) => s.status)).toEqual(["sent", "delivered", "failed"]);
    expect(statuses[2].error).toEqual({
      code: "131049",
      message: "This message was not delivered to maintain healthy ecosystem engagement.",
    });
  });

  it("ignora changes de outro field", () => {
    const provider = createMetaProvider(config);
    const payload = JSON.stringify({
      entry: [{ changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }] }],
    });
    expect(provider.parseWebhook(payload)).toEqual({ inbound: [], statuses: [] });
  });

  it("corpo inválido não derruba o webhook", () => {
    const provider = createMetaProvider(config);
    expect(provider.parseWebhook("{}")).toEqual({ inbound: [], statuses: [] });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/meta-provider-webhook.test.ts`
Expected: FAIL — `NotSupportedError: Provider meta_cloud does not support verifyWebhook`.

- [ ] **Step 3: Implementar**

Em `meta-provider.ts`, adicionar imports e substituir os dois métodos:

```ts
import { HttpError } from "../http-error.ts";
import { constantTimeEqual, hmacSha256Hex } from "../hmac.ts";
import { type DeliveryStatus, type InboundMessage, type InboundMessageType, type StatusUpdate } from "./types.ts";

const MEDIA_TYPES: InboundMessageType[] = ["image", "audio", "video", "document"];
const KNOWN_TYPES: InboundMessageType[] = ["text", ...MEDIA_TYPES, "interactive"];
const KNOWN_STATUSES: DeliveryStatus[] = ["sent", "delivered", "read", "failed"];

function toIsoTimestamp(value: unknown): string {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date(0).toISOString();
}
```

e, dentro de `createMetaProvider`:

```ts
    async verifyWebhook(req: Request, rawBody: string): Promise<void> {
      if (!config.appSecret) {
        throw new HttpError(503, "META_APP_SECRET is not configured");
      }
      const header = req.headers.get("x-hub-signature-256");
      if (!header) {
        throw new HttpError(401, "Missing X-Hub-Signature-256 header");
      }
      const received = header.trim().replace(/^sha256=/i, "").toLowerCase();
      const expected = await hmacSha256Hex(config.appSecret, rawBody);
      if (!constantTimeEqual(received, expected)) {
        throw new HttpError(401, "Invalid webhook signature");
      }
    },

    parseWebhook(rawBody: string): WebhookParseResult {
      const inbound: InboundMessage[] = [];
      const statuses: StatusUpdate[] = [];
      let phoneNumberIdSeen: string | undefined;

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return { inbound, statuses };
      }

      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          if (change?.field !== "messages") continue;
          const value = change?.value ?? {};
          const phoneNumberId = value?.metadata?.phone_number_id;
          if (phoneNumberId && !phoneNumberIdSeen) phoneNumberIdSeen = String(phoneNumberId);

          for (const message of value?.messages ?? []) {
            const rawType = String(message?.type ?? "");
            const type = (KNOWN_TYPES as string[]).includes(rawType)
              ? (rawType as InboundMessageType)
              : "unsupported";
            const mediaObject = (MEDIA_TYPES as string[]).includes(rawType)
              ? message?.[rawType]
              : null;

            inbound.push({
              providerMessageId: String(message?.id ?? ""),
              fromPhone: String(message?.from ?? "").replace(/\D/g, ""),
              phoneNumberId: phoneNumberId ? String(phoneNumberId) : undefined,
              type,
              text: type === "text" ? String(message?.text?.body ?? "") : undefined,
              media: mediaObject
                ? {
                    id: String(mediaObject.id ?? ""),
                    mimeType: mediaObject.mime_type ? String(mediaObject.mime_type) : undefined,
                    caption: mediaObject.caption ? String(mediaObject.caption) : undefined,
                    filename: mediaObject.filename ? String(mediaObject.filename) : undefined,
                  }
                : undefined,
              timestamp: toIsoTimestamp(message?.timestamp),
            });
          }

          for (const status of value?.statuses ?? []) {
            const value_ = String(status?.status ?? "");
            // `played` existe na API e não faz parte do contrato do Bloco A.
            if (!(KNOWN_STATUSES as string[]).includes(value_)) continue;
            const firstError = status?.errors?.[0];

            statuses.push({
              providerMessageId: String(status?.id ?? ""),
              status: value_ as DeliveryStatus,
              timestamp: toIsoTimestamp(status?.timestamp),
              error: firstError
                ? {
                    code:
                      firstError.code === undefined || firstError.code === null
                        ? undefined
                        : String(firstError.code),
                    message: String(firstError.message ?? firstError.title ?? "unknown error"),
                  }
                : undefined,
            });
          }
        }
      }

      return { inbound, statuses, phoneNumberId: phoneNumberIdSeen };
    },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/meta-provider-webhook.test.ts tests/unit/meta-provider-send.test.ts`
Expected: PASS nos dois arquivos.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp/meta-provider.ts tests/unit/meta-provider-webhook.test.ts
git commit -m "feat(whatsapp): verificacao de assinatura e parse do webhook da Meta"
```

---

## Task 8: `MetaProvider` — mídia, status de conexão e templates

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/meta-provider.ts`
- Test: `tests/unit/meta-provider-management.test.ts`

**Interfaces:**
- Consumes: `MetaProviderConfig` (Task 6).
- Produces: `downloadMedia(mediaId): Promise<DownloadedMedia>`;
  `getConnectionStatus(): Promise<{connected, details}>`;
  `listTemplates(): Promise<TemplateSummary[]>`;
  `createTemplate(params): Promise<TemplateSummary>`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/meta-provider-management.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createMetaProvider } from "../../supabase/functions/_shared/whatsapp/meta-provider";

const config = {
  graphApiVersion: "v25.0",
  phoneNumberId: "106540352242922",
  wabaId: "102290129340398",
  accessToken: "EAAJB-token",
};

describe("MetaProvider.downloadMedia", () => {
  it("resolve a URL pelo media id e baixa o binário com Bearer", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            url: "https://lookaside.test/asset",
            mime_type: "image/jpeg",
            file_size: 3,
            id: "media-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const media = await provider.downloadMedia("media-1");

    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/media-1?phone_number_id=106540352242922",
    );
    expect(fetchFn.mock.calls[1][0]).toBe("https://lookaside.test/asset");
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe("Bearer EAAJB-token");
    expect(Array.from(media.bytes)).toEqual([1, 2, 3]);
    expect(media.mimeType).toBe("image/jpeg");
  });

  it("erro na resolução do id não tenta baixar", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), {
          status: 400,
        }),
      );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(provider.downloadMedia("media-1")).rejects.toThrow("Unsupported get request");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("MetaProvider.getConnectionStatus", () => {
  it("consulta o phone number id e devolve connected=true", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          display_phone_number: "15550783881",
          verified_name: "Eleve One",
          quality_rating: "GREEN",
          id: "106540352242922",
        }),
        { status: 200 },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const status = await provider.getConnectionStatus();
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/106540352242922?fields=display_phone_number,verified_name,quality_rating",
    );
    expect(status.connected).toBe(true);
    expect(status.details).toMatchObject({ quality_rating: "GREEN" });
  });

  it("token inválido devolve connected=false sem lançar", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }), {
        status: 401,
      }),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const status = await provider.getConnectionStatus();
    expect(status.connected).toBe(false);
    expect(JSON.stringify(status)).not.toContain("EAAJB-token");
  });
});

describe("MetaProvider.listTemplates", () => {
  it("lista templates do WABA", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              name: "order_delivery_update",
              components: [{ type: "BODY", text: "Good news {{1}}!" }],
              language: "en_US",
              status: "APPROVED",
              category: "UTILITY",
              id: "1667192013751005",
            },
          ],
          paging: { cursors: { before: "MAZDZD", after: "MjQZD" } },
        }),
        { status: 200 },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const templates = await provider.listTemplates();
    expect(fetchFn.mock.calls[0][0]).toBe(
      "https://graph.facebook.com/v25.0/102290129340398/message_templates?limit=200",
    );
    expect(templates).toEqual([
      {
        id: "1667192013751005",
        name: "order_delivery_update",
        language: "en_US",
        category: "UTILITY",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Good news {{1}}!" }],
      },
    ]);
  });

  it("sem wabaId configurado falha antes da rede", async () => {
    const fetchFn = vi.fn();
    const provider = createMetaProvider({ ...config, wabaId: undefined, fetchFn: fetchFn as any });
    await expect(provider.listTemplates()).rejects.toThrow("WABA id is not configured");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("MetaProvider.createTemplate", () => {
  it("cria o template e devolve id/status da Meta", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "1259544702043867", status: "APPROVED" }), { status: 200 }),
      );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    const template = await provider.createTemplate({
      name: "boas_vindas",
      category: "UTILITY",
      language: "pt_BR",
      components: [{ type: "BODY", text: "Olá {{1}}" }],
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/102290129340398/message_templates");
    expect(JSON.parse(init.body)).toEqual({
      name: "boas_vindas",
      category: "UTILITY",
      language: "pt_BR",
      components: [{ type: "BODY", text: "Olá {{1}}" }],
    });
    expect(template).toEqual({
      id: "1259544702043867",
      name: "boas_vindas",
      language: "pt_BR",
      category: "UTILITY",
      status: "APPROVED",
    });
  });

  it("rejeição da Meta vira erro com a mensagem dela", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Template name already exists", code: 100 } }),
        { status: 400 },
      ),
    );
    const provider = createMetaProvider({ ...config, fetchFn: fetchFn as any });
    await expect(
      provider.createTemplate({ name: "t", category: "UTILITY", language: "pt_BR", components: [] }),
    ).rejects.toThrow("Template name already exists");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/meta-provider-management.test.ts`
Expected: FAIL — `NotSupportedError: Provider meta_cloud does not support downloadMedia`.

- [ ] **Step 3: Implementar**

Em `meta-provider.ts`, substituir os quatro métodos:

```ts
    async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
      const lookup = await graphRequest(
        `${graphUrl(mediaId)}?phone_number_id=${config.phoneNumberId}`,
        { method: "GET", headers: authHeaders() },
      );
      if (!lookup.ok) {
        throw new Error(graphErrorMessage(lookup.data, lookup.status));
      }

      const url = String(lookup.data?.url ?? "");
      if (!url) throw new Error("Media lookup did not return a url");

      const download = await fetchFn(url, {
        method: "GET",
        headers: authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!download.ok) {
        throw new Error(`Erro ${download.status} ao baixar mídia`);
      }

      return {
        bytes: new Uint8Array(await download.arrayBuffer()),
        mimeType: String(lookup.data?.mime_type ?? "application/octet-stream"),
      };
    },

    async getConnectionStatus(): Promise<{ connected: boolean; details: unknown }> {
      const response = await graphRequest(
        `${graphUrl(config.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
        { method: "GET", headers: authHeaders() },
      );
      if (!response.ok) {
        return {
          connected: false,
          details: { status: response.status, error: graphErrorMessage(response.data, response.status) },
        };
      }
      return { connected: true, details: response.data };
    },

    async listTemplates(): Promise<TemplateSummary[]> {
      if (!config.wabaId) throw new Error("WABA id is not configured");

      const response = await graphRequest(
        `${graphUrl(`${config.wabaId}/message_templates`)}?limit=200`,
        { method: "GET", headers: authHeaders() },
      );
      if (!response.ok) {
        throw new Error(graphErrorMessage(response.data, response.status));
      }

      return (response.data?.data ?? []).map((template: Record<string, any>) => ({
        id: String(template.id ?? ""),
        name: String(template.name ?? ""),
        language: String(template.language ?? ""),
        category: String(template.category ?? ""),
        status: String(template.status ?? ""),
        components: template.components,
      }));
    },

    async createTemplate(params: CreateTemplateParams): Promise<TemplateSummary> {
      if (!config.wabaId) throw new Error("WABA id is not configured");

      const response = await graphRequest(graphUrl(`${config.wabaId}/message_templates`), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: params.name,
          category: params.category,
          language: params.language,
          components: params.components,
        }),
      });
      if (!response.ok) {
        throw new Error(graphErrorMessage(response.data, response.status));
      }

      return {
        id: String(response.data?.id ?? ""),
        name: params.name,
        language: params.language,
        category: String(response.data?.category ?? params.category),
        status: String(response.data?.status ?? "PENDING"),
      };
    },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/meta-provider-management.test.ts`
Expected: PASS.

- [ ] **Step 5: Conferir a suíte inteira e a cobertura**

Em `vitest.config.ts`, acrescentar a `coverage.include`:
`"supabase/functions/_shared/whatsapp/types.ts"`,
`"supabase/functions/_shared/whatsapp/crm-parse.ts"`,
`"supabase/functions/_shared/whatsapp/meta-provider.ts"`.

Run: `npm run test`
Expected: tudo verde, thresholds de 80% mantidos.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/whatsapp/meta-provider.ts tests/unit/meta-provider-management.test.ts vitest.config.ts
git commit -m "feat(whatsapp): midia, status de conexao e templates da Cloud API"
```

---

## Task 9: Migration `whatsapp_connections` + settings Meta

**Files:**
- Create: `supabase/migrations/20260725120000_whatsapp_connections.sql`
- Modify: `docs/staging.md` (nota sobre o novo secret) — só a seção de secrets

**Interfaces:**
- Consumes: `public.update_updated_at_column()` (existente).
- Produces: tabela `public.whatsapp_connections`; índice
  `idx_messages_user_whatsapp_id`; chaves em `global_settings`
  (`meta_graph_api_version`).

- [ ] **Step 1: Escrever a migration**

`supabase/migrations/20260725120000_whatsapp_connections.sql`:

```sql
-- Conexão oficial de WhatsApp (Meta Cloud API) por tenant. Não existe coluna
-- 'provider': a Evolution sai do produto na Task 16 e não há provedor
-- alternativo. A ausência de linha significa tenant sem WhatsApp configurado —
-- resolveProvider responde 409, nunca um fallback silencioso.
-- A migration é puramente aditiva: não toca nenhuma tabela existente.

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'disconnected', 'error')),
  meta_business_id text,
  waba_id text,
  phone_number_id text,
  display_phone_number text,
  display_name text,
  access_token_encrypted text,
  token_type text CHECK (token_type IN ('user', 'system_user')),
  token_expires_at timestamptz,
  coexistence_enabled boolean NOT NULL DEFAULT false,
  webhook_subscribed_at timestamptz,
  quality_rating text,
  messaging_limit_tier text,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Uma conexão ativa por tenant.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_tenant_id_key
  ON public.whatsapp_connections (tenant_id);

-- O mesmo número nunca pode pertencer a dois tenants.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_phone_number_id_key
  ON public.whatsapp_connections (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

-- Escrita é exclusiva do service role: nenhuma policy de INSERT/UPDATE/DELETE.
REVOKE ALL ON public.whatsapp_connections FROM anon, authenticated;

-- Leitura da própria linha, exceto o token. GRANT por coluna mantém
-- access_token_encrypted fora do alcance do browser mesmo com a policy abaixo.
GRANT SELECT (
  id, tenant_id, status, meta_business_id, waba_id, phone_number_id,
  display_phone_number, display_name, token_type, token_expires_at,
  coexistence_enabled, webhook_subscribed_at, quality_rating,
  messaging_limit_tier, last_sync_at, created_at, updated_at
) ON public.whatsapp_connections TO authenticated;

CREATE POLICY "Tenants read their own whatsapp connection"
  ON public.whatsapp_connections
  FOR SELECT
  TO authenticated
  USING (tenant_id = auth.uid());

DROP TRIGGER IF EXISTS update_whatsapp_connections_updated_at ON public.whatsapp_connections;
CREATE TRIGGER update_whatsapp_connections_updated_at
  BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- O webhook da Meta atualiza status por wamid; sem este índice a busca é
-- sequencial em messages.
CREATE INDEX IF NOT EXISTS idx_messages_user_whatsapp_id
  ON public.messages (user_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL;

-- Configuração global da integração. Os demais valores (app id, secret,
-- verify token, config id) são gravados pelo dono no Bloco B.
INSERT INTO public.global_settings (key, value)
VALUES ('meta_graph_api_version', 'v25.0')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Validar sintaxe e política sem aplicar em produção**

Run: `bash scripts/sb-staging.sh db lint --linked`
Expected: sem erro novo.

Este projeto não usa banco local: a validação é contra o Supabase remoto, pelo
wrapper `scripts/sb-staging.sh`. Depois do push, conferir no banco que a tabela,
os índices, a policy e o `GRANT` por coluna existem — e que o `GRANT` **não**
inclui `access_token_encrypted`.

- [ ] **Step 3: Conferir que o token não vaza para o cliente (revisão de contrato)**

O `GRANT SELECT` por coluna **não** inclui `access_token_encrypted`. Confirmar
lendo o arquivo que a coluna não aparece na lista do GRANT.

- [ ] **Step 4: Checkpoint com o dono antes de aplicar em produção**

Produção é `xlycuunqpgpyfmafgajr`. A migration é aditiva, mas aplicar é decisão do
dono. Pedir autorização explícita; só então:

```bash
bash scripts/sb-staging.sh db push --linked
```

E validar:

```bash
bash scripts/sb-staging.sh db query --linked "select count(*) from public.whatsapp_connections"
```
Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260725120000_whatsapp_connections.sql
git commit -m "feat(db): tabela whatsapp_connections com RLS por tenant e indice de wamid"
```

---

## Task 10: `resolveProvider` — ponto único de montagem do provider

**Files:**
- Create: `supabase/functions/_shared/whatsapp/index.ts`
- Create: `tests/unit/helpers/fake-supabase.ts`
- Test: `tests/unit/resolve-provider.test.ts`

**Interfaces:**
- Consumes: `createMetaProvider` (Task 6–8), `decryptSecret` (Task 2),
  `HttpError` (Task 1), tabela `whatsapp_connections` (Task 9).
- Produces:
  `resolveProvider(tenantId: string, deps: ProviderDeps): Promise<WhatsAppProvider>`;
  `ProviderDeps = { client: { from: (table: string) => any }; env: ProviderEnv; fetchFn?: typeof fetch }`;
  `ProviderEnv = { metaGraphApiVersion: string; metaAppSecret?: string; tokenEncryptionKey?: string }`.
  Também: `createFakeClient(db, options)` em `tests/unit/helpers/fake-supabase.ts`.

- [ ] **Step 1: Escrever o client fake (infraestrutura de teste)**

`tests/unit/helpers/fake-supabase.ts`:

```ts
// Client Supabase encadeável em memória, suficiente para os módulos _shared.
// Suporta select/eq/in/order/limit/maybeSingle/single/insert/update/rpc e
// registra as escritas para asserção.

export type Row = Record<string, any>;
export type FakeDb = Record<string, Row[]>;

export interface FakeWrite {
  table: string;
  kind: "insert" | "update";
  payload: Row;
  filters: Array<[string, any]>;
}

export interface FakeClientOptions {
  rpc?: Record<string, (args: Row) => { data: any; error: any }>;
  errors?: Record<string, { message: string }>;
}

export function createFakeClient(db: FakeDb, options: FakeClientOptions = {}) {
  const writes: FakeWrite[] = [];
  const rpcCalls: Array<{ name: string; args: Row }> = [];

  function matches(row: Row, filters: Array<[string, any]>, inFilters: Array<[string, any[]]>) {
    return (
      filters.every(([column, value]) => row[column] === value) &&
      inFilters.every(([column, values]) => values.includes(row[column]))
    );
  }

  function builder(table: string) {
    const filters: Array<[string, any]> = [];
    const inFilters: Array<[string, any[]]> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let limitCount: number | null = null;
    let orderColumn: string | null = null;
    let orderAscending = true;

    const resolve = () => {
      const error = options.errors?.[table] ?? null;
      if (error) return { data: null, error };

      const rows = db[table] ?? [];

      if (mode === "insert") {
        const inserted = Array.isArray(payload) ? payload : [payload];
        db[table] = [...rows, ...inserted];
        writes.push({ table, kind: "insert", payload, filters: [...filters] });
        return { data: inserted, error: null };
      }

      const selected = rows.filter((row) => matches(row, filters, inFilters));

      if (mode === "update") {
        for (const row of selected) Object.assign(row, payload);
        writes.push({ table, kind: "update", payload, filters: [...filters] });
        return { data: selected, error: null };
      }

      let result = [...selected];
      if (orderColumn) {
        result.sort((a, b) => {
          const left = a[orderColumn!];
          const right = b[orderColumn!];
          if (left === right) return 0;
          return (left > right ? 1 : -1) * (orderAscending ? 1 : -1);
        });
      }
      if (limitCount !== null) result = result.slice(0, limitCount);
      return { data: result, error: null };
    };

    const chain: any = {
      select: () => chain,
      eq: (column: string, value: any) => {
        filters.push([column, value]);
        return chain;
      },
      in: (column: string, values: any[]) => {
        inFilters.push([column, values]);
        return chain;
      },
      or: () => chain,
      lte: () => chain,
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderColumn = column;
        orderAscending = opts?.ascending !== false;
        return chain;
      },
      limit: (count: number) => {
        limitCount = count;
        return chain;
      },
      insert: (rows: Row) => {
        mode = "insert";
        payload = rows;
        return chain;
      },
      update: (patch: Row) => {
        mode = "update";
        payload = patch;
        return chain;
      },
      maybeSingle: async () => {
        const { data, error } = resolve();
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
      },
      single: async () => {
        const { data, error } = resolve();
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
      },
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };

    return chain;
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      const handler = options.rpc?.[name];
      return handler ? handler(args) : { data: null, error: null };
    },
    __writes: writes,
    __rpcCalls: rpcCalls,
  };
}
```

- [ ] **Step 2: Escrever o teste que falha**

> Revisado em 2026-07-25: sem provider duplo. A ausência de linha deixou de ser
> "cai para a Evolution" e passou a ser erro explícito 409 — o sistema não tem
> mais para onde cair, e um fallback silencioso viraria mensagem não entregue
> sem ninguém saber.

`tests/unit/resolve-provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveProvider } from "../../supabase/functions/_shared/whatsapp";
import { encryptSecret } from "../../supabase/functions/_shared/crypto";
import { HttpError } from "../../supabase/functions/_shared/http-error";
import { createFakeClient } from "./helpers/fake-supabase";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

const env = {
  metaGraphApiVersion: "v25.0",
  metaAppSecret: "app-secret",
  tokenEncryptionKey: KEY,
};

const deps = (db: any) => ({ client: createFakeClient(db) as any, env });

const connectedRow = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: "tenant-1",
  status: "connected",
  phone_number_id: "PNID",
  waba_id: "WABA",
  ...overrides,
});

describe("resolveProvider", () => {
  it("conectado devolve MetaProvider com o token descriptografado", async () => {
    const encrypted = await encryptSecret("EAAJB-token-real", KEY);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));

    const provider = await resolveProvider("tenant-1", {
      ...deps({
        whatsapp_connections: [connectedRow({ access_token_encrypted: encrypted })],
      }),
      fetchFn: fetchFn as any,
    });

    expect(provider.id).toBe("meta_cloud");
    const result = await provider.sendText({ to: "1", text: "x" });
    expect(fetchFn.mock.calls[0][0]).toBe("https://graph.facebook.com/v25.0/PNID/messages");
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer EAAJB-token-real");
    expect(result.providerMessageId).toBe("wamid.1");
  });

  it("sem linha falha com 409 explícito, nunca com fallback silencioso", async () => {
    const promise = resolveProvider("tenant-1", deps({ whatsapp_connections: [] }));
    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toThrow("Tenant has no WhatsApp connection configured");
    await expect(promise).rejects.toMatchObject({ status: 409 });
  });

  it("linha não conectada falha com 409", async () => {
    const promise = resolveProvider(
      "tenant-1",
      deps({
        whatsapp_connections: [
          connectedRow({ status: "disconnected", access_token_encrypted: "v1:aa.bb" }),
        ],
      }),
    );
    await expect(promise).rejects.toThrow("WhatsApp connection for this tenant is not connected");
    await expect(promise).rejects.toMatchObject({ status: 409 });
  });

  it("sem token falha claro", async () => {
    await expect(
      resolveProvider("tenant-1", deps({ whatsapp_connections: [connectedRow()] })),
    ).rejects.toThrow("WhatsApp connection is missing the encrypted access token");
  });

  it("sem phone_number_id falha claro", async () => {
    await expect(
      resolveProvider(
        "tenant-1",
        deps({
          whatsapp_connections: [
            connectedRow({ phone_number_id: null, access_token_encrypted: "v1:aa.bb" }),
          ],
        }),
      ),
    ).rejects.toThrow("WhatsApp connection is missing phone_number_id");
  });

  it("sem chave de criptografia falha antes de tentar decifrar", async () => {
    await expect(
      resolveProvider("tenant-1", {
        client: createFakeClient({
          whatsapp_connections: [connectedRow({ access_token_encrypted: "v1:aa.bb" })],
        }) as any,
        env: { ...env, tokenEncryptionKey: undefined },
      }),
    ).rejects.toThrow("WHATSAPP_TOKEN_ENC_KEY is required");
  });

  it("erro de leitura do banco não vira tenant sem conexão", async () => {
    const client = createFakeClient(
      { whatsapp_connections: [] },
      { errors: { whatsapp_connections: { message: "connection reset" } } },
    );
    await expect(resolveProvider("tenant-1", { client: client as any, env })).rejects.toThrow(
      "Failed to read whatsapp_connections: connection reset",
    );
  });

  it("resolve a linha do tenant certo", async () => {
    const encrypted = await encryptSecret("token-do-2", KEY);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "w" }] }), { status: 200 }));

    const provider = await resolveProvider("tenant-2", {
      ...deps({
        whatsapp_connections: [
          connectedRow({ access_token_encrypted: "v1:outro.tenant" }),
          connectedRow({
            tenant_id: "tenant-2",
            phone_number_id: "PNID-2",
            access_token_encrypted: encrypted,
          }),
        ],
      }),
      fetchFn: fetchFn as any,
    });

    await provider.sendText({ to: "1", text: "x" });
    expect(fetchFn.mock.calls[0][0]).toContain("/PNID-2/messages");
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/unit/resolve-provider.test.ts`
Expected: FAIL — módulo `_shared/whatsapp` não resolve.

- [ ] **Step 4: Implementar**

`supabase/functions/_shared/whatsapp/index.ts`:

```ts
// Único ponto do sistema que monta o provedor de um tenant.
// whatsapp_connections é a fonte de verdade: sem linha conectada não existe
// caminho alternativo de envio — o erro é explícito e o chamador decide.

import { HttpError } from "../http-error.ts";
import { decryptSecret } from "../crypto.ts";
import { createMetaProvider } from "./meta-provider.ts";
import { type WhatsAppProvider } from "./types.ts";

export * from "./types.ts";
export { createMetaProvider } from "./meta-provider.ts";

export interface ProviderEnv {
  metaGraphApiVersion: string;
  metaAppSecret?: string;
  tokenEncryptionKey?: string;
}

export interface ProviderDeps {
  client: { from: (table: string) => any };
  env: ProviderEnv;
  fetchFn?: typeof fetch;
}

export async function resolveProvider(
  tenantId: string,
  deps: ProviderDeps,
): Promise<WhatsAppProvider> {
  const { data: connection, error } = await deps.client
    .from("whatsapp_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) throw new Error(`Failed to read whatsapp_connections: ${error.message}`);

  if (!connection) {
    throw new HttpError(409, "Tenant has no WhatsApp connection configured");
  }
  if (connection.status !== "connected") {
    throw new HttpError(409, "WhatsApp connection for this tenant is not connected");
  }
  if (!connection.phone_number_id) {
    throw new HttpError(409, "WhatsApp connection is missing phone_number_id");
  }
  if (!connection.access_token_encrypted) {
    throw new HttpError(409, "WhatsApp connection is missing the encrypted access token");
  }
  if (!deps.env.tokenEncryptionKey) {
    throw new HttpError(503, "WHATSAPP_TOKEN_ENC_KEY is required");
  }

  const accessToken = await decryptSecret(
    connection.access_token_encrypted,
    deps.env.tokenEncryptionKey,
  );

  return createMetaProvider({
    graphApiVersion: deps.env.metaGraphApiVersion,
    phoneNumberId: connection.phone_number_id,
    wabaId: connection.waba_id ?? undefined,
    accessToken,
    appSecret: deps.env.metaAppSecret,
    fetchFn: deps.fetchFn,
  });
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/unit/resolve-provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/whatsapp/index.ts tests/unit/helpers/fake-supabase.ts tests/unit/resolve-provider.test.ts vitest.config.ts
git commit -m "feat(whatsapp): resolveProvider como ponto unico de escolha por tenant"
```

---

## Task 11: Superadmin — claim, gate e script de seed

**Files:**
- Create: `supabase/functions/_shared/platform-role.ts`
- Create: `scripts/set-superadmin.mjs`
- Modify: `supabase/functions/_shared/auth.ts` (adicionar `requireSuperadmin`)
- Create: `src/hooks/useIsSuperadmin.ts`
- Test: `tests/unit/platform-role.test.ts`

**Interfaces:**
- Consumes: `HttpError` (Task 1).
- Produces: `isSuperadmin(user: unknown): boolean`;
  `assertSuperadmin(user: unknown): void` (lança `HttpError(403)`);
  `generateWebhookVerifyToken(): string`;
  `requireSuperadmin(req: Request): Promise<{ userId: string; email: string | null }>` em `auth.ts`;
  hook React `useIsSuperadmin(): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/platform-role.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isSuperadmin,
  assertSuperadmin,
  generateWebhookVerifyToken,
} from "../../supabase/functions/_shared/platform-role";

describe("isSuperadmin", () => {
  it("verdadeiro só com app_metadata.platform_role === 'superadmin'", () => {
    expect(isSuperadmin({ app_metadata: { platform_role: "superadmin" } })).toBe(true);
  });

  it("ignora user_metadata (o cliente consegue escrever nele)", () => {
    expect(isSuperadmin({ user_metadata: { platform_role: "superadmin" } })).toBe(false);
  });

  it("falso para papel diferente, ausente, nulo ou objeto vazio", () => {
    expect(isSuperadmin({ app_metadata: { platform_role: "admin" } })).toBe(false);
    expect(isSuperadmin({ app_metadata: {} })).toBe(false);
    expect(isSuperadmin({})).toBe(false);
    expect(isSuperadmin(null)).toBe(false);
    expect(isSuperadmin(undefined)).toBe(false);
  });

  it("não aceita variação de caixa", () => {
    expect(isSuperadmin({ app_metadata: { platform_role: "SuperAdmin" } })).toBe(false);
  });
});

describe("assertSuperadmin", () => {
  it("não lança para superadmin", () => {
    expect(() => assertSuperadmin({ app_metadata: { platform_role: "superadmin" } })).not.toThrow();
  });

  it("lança 403 para qualquer outro", () => {
    expect(() => assertSuperadmin({ app_metadata: {} })).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
  });
});

describe("generateWebhookVerifyToken", () => {
  it("gera token hex de 64 caracteres, diferente a cada chamada", () => {
    const first = generateWebhookVerifyToken();
    const second = generateWebhookVerifyToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/platform-role.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`supabase/functions/_shared/platform-role.ts`:

```ts
// Papel de plataforma. Vive em app_metadata porque o cliente não consegue
// escrever nesse campo — user_metadata é editável pelo próprio usuário e não
// serve como autorização.

import { HttpError } from "./http-error.ts";

export const SUPERADMIN_ROLE = "superadmin";

export function isSuperadmin(user: unknown): boolean {
  const role = (user as { app_metadata?: { platform_role?: unknown } } | null)?.app_metadata
    ?.platform_role;
  return role === SUPERADMIN_ROLE;
}

export function assertSuperadmin(user: unknown): void {
  if (!isSuperadmin(user)) {
    throw new HttpError(403, "This operation is restricted to platform superadmins");
  }
}

export function generateWebhookVerifyToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

Em `supabase/functions/_shared/auth.ts`, ao final do arquivo:

```ts
import { assertSuperadmin } from "./platform-role.ts";

export { generateWebhookVerifyToken } from "./platform-role.ts";

/** Gate das operações administrativas da plataforma (config global da Meta). */
export async function requireSuperadmin(
  req: Request,
): Promise<{ userId: string; email: string | null }> {
  const bearerToken = getBearerToken(req);
  if (!bearerToken) throw new HttpError(401, "Authentication is required");

  const client = createClient(getSupabaseUrl(), getPublishableKey());
  const {
    data: { user },
    error,
  } = await client.auth.getUser(bearerToken);
  if (error || !user) throw new HttpError(401, "Invalid authentication token");

  assertSuperadmin(user);
  return { userId: user.id, email: user.email ?? null };
}
```

`scripts/set-superadmin.mjs`:

```js
#!/usr/bin/env node
// Semeia app_metadata.platform_role = 'superadmin' num usuário existente.
// Uso: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/set-superadmin.mjs <email>
// Produção só com autorização explícita do dono.

import { createClient } from "@supabase/supabase-js";

const email = process.argv[2];
const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!email || !url || !secretKey) {
  console.error("Uso: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/set-superadmin.mjs <email>");
  process.exit(1);
}

const admin = createClient(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: list, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) {
  console.error("Falha ao listar usuários:", listError.message);
  process.exit(1);
}

const user = list.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`Usuário não encontrado: ${email}`);
  process.exit(1);
}

const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
  app_metadata: { ...(user.app_metadata ?? {}), platform_role: "superadmin" },
});
if (updateError) {
  console.error("Falha ao atualizar:", updateError.message);
  process.exit(1);
}

console.log(`platform_role=superadmin aplicado em ${email} (${user.id}).`);
console.log("O usuário precisa renovar a sessão para o claim aparecer no token.");
```

`src/hooks/useIsSuperadmin.ts`:

```ts
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Somente cosmético: decide se a UI administrativa aparece. A autoridade é o
 * servidor, que relê o claim do token em toda operação.
 */
export function useIsSuperadmin(): boolean {
  const [isSuperadmin, setIsSuperadmin] = useState(false);

  useEffect(() => {
    let active = true;

    const read = async () => {
      const { data } = await supabase.auth.getUser();
      const role = (data.user?.app_metadata as { platform_role?: string } | undefined)?.platform_role;
      if (active) setIsSuperadmin(role === "superadmin");
    };

    void read();
    const { data: subscription } = supabase.auth.onAuthStateChange(() => {
      void read();
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return isSuperadmin;
}
```

Antes de escrever o hook, confirmar o caminho real do client:
Run: `ls src/integrations/supabase/client.ts`
Se o caminho ou o nome do export divergir, ajustar o import para o que existe.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/platform-role.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: 0 erros.

Run: `deno check supabase/functions/whatsapp-webhook/index.ts`
Expected: sem erro.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/platform-role.ts supabase/functions/_shared/auth.ts scripts/set-superadmin.mjs src/hooks/useIsSuperadmin.ts tests/unit/platform-role.test.ts vitest.config.ts
git commit -m "feat(auth): papel de superadmin por claim com gate no servidor"
```

---

## Task 12: Extrair o orquestrador de inbound

Movimento mecânico: o corpo da orquestração CRM sai de `whatsapp-webhook` para um
módulo compartilhado com dependências injetadas. **Nenhuma regra muda.**

**Files:**
- Create: `supabase/functions/_shared/whatsapp/inbound-orchestrator.ts`
- Modify: `supabase/functions/whatsapp-webhook/index.ts`
- Test: `tests/unit/inbound-orchestrator.test.ts`

**Interfaces:**
- Consumes: `callLLM`, `makeApiCallRecorder`, `getGlobalSetting` (`_shared/ai.ts`);
  `resolveExistingNextBlockId` (`_shared/flow-routing.ts`);
  `assertLeadCanReceiveMarketing` — **mover** de `auth.ts` para
  `_shared/marketing-consent.ts` (Deno-free) e reexportar em `auth.ts`;
  `isMarketingOptOutMessage`, `phoneVariants` (Task 4); `HttpError` (Task 1).
- Produces:
  ```ts
  export interface OrchestratorDeps {
    client: { from: (table: string) => any };
    fetchFn: typeof fetch;
    baseUrl: string;
    internalHeaders: () => Record<string, string>;
    openrouterKey: string | null;
  }
  export interface OrchestratorInput {
    tenantId: string;
    providerMessageId: string | null;
    fromPhone: string;
    text: string;
  }
  export interface OrchestratorResult {
    status: number;
    body: Record<string, unknown>;
  }
  export function handleInboundMessage(
    deps: OrchestratorDeps,
    input: OrchestratorInput,
  ): Promise<OrchestratorResult>;
  ```

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/inbound-orchestrator.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { handleInboundMessage } from "../../supabase/functions/_shared/whatsapp/inbound-orchestrator";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

function deps(db: any, fetchFn = vi.fn()) {
  return {
    client: createFakeClient(db) as any,
    fetchFn: fetchFn as any,
    baseUrl: "https://project.supabase.co",
    internalHeaders: () => ({ apikey: "service-key" }),
    openrouterKey: null,
  };
}

const input = {
  tenantId: TENANT,
  providerMessageId: "MSG-1",
  fromPhone: "5511999998888",
  text: "quero sim",
};

const lead = () => ({
  id: "lead-1",
  user_id: TENANT,
  phone_normalized: "5511999998888",
  name: "Cliente",
  company: "Empresa",
  phone: "5511999998888",
  stage_id: null,
  marketing_consent_status: "granted",
  is_suppressed: false,
  marketing_opted_out_at: null,
});

describe("handleInboundMessage — portões", () => {
  it("mensagem duplicada (mesmo providerMessageId) não é processada duas vezes", async () => {
    const db = {
      messages: [
        { id: "m1", user_id: TENANT, whatsapp_id: "MSG-1", direction: "inbound", content: "x" },
      ],
      leads: [lead()],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body).toMatchObject({ ignored: true, reason: "duplicate" });
    expect(db.messages).toHaveLength(1);
  });

  it("lead inexistente é ignorado com log", async () => {
    const db = { messages: [], leads: [], flow_executions: [], logs: [], pipeline_stages: [] };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body.ignored).toBe(true);
    expect(db.logs.some((l: any) => l.event === "webhook_lead_not_found")).toBe(true);
  });

  it("telefone ambíguo (2+ leads) é ignorado com log", async () => {
    const db = {
      messages: [],
      leads: [lead(), { ...lead(), id: "lead-2" }],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body).toMatchObject({ ignored: true, reason: "ambiguous_lead_phone" });
    expect(db.logs.some((l: any) => l.event === "webhook_ambiguous_lead_phone")).toBe(true);
  });

  it("opt-out suprime o lead e não segue para automação", async () => {
    const db = { messages: [], leads: [lead()], flow_executions: [], logs: [], send_queue: [], pipeline_stages: [] };
    const result = await handleInboundMessage(deps(db), { ...input, text: "PARE" });
    expect(result.body).toMatchObject({ opted_out: true });
    expect(db.leads[0].is_suppressed).toBe(true);
    expect(db.leads[0].marketing_consent_status).toBe("withdrawn");
  });

  it("lead sem consentimento não avança automação", async () => {
    const db = {
      messages: [],
      leads: [{ ...lead(), marketing_consent_status: "unknown" }],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body).toMatchObject({ ignored: true, reason: "lead_suppressed_or_opted_out" });
  });

  it("sem execução ativa, grava a mensagem e para", async () => {
    const db = { messages: [], leads: [lead()], flow_executions: [], logs: [], pipeline_stages: [] };
    const result = await handleInboundMessage(deps(db), input);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({ direction: "inbound", whatsapp_id: "MSG-1", user_id: TENANT });
    expect(db.logs.some((l: any) => l.event === "webhook_no_execution")).toBe(true);
    expect(result.status).toBe(200);
  });

  it("execução em modo agente delega a ai-agent-reply", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const db = {
      messages: [],
      leads: [lead()],
      flow_executions: [
        {
          id: "exec-1",
          user_id: TENANT,
          lead_id: "lead-1",
          flow_id: "flow-1",
          status: "waiting_response",
          context: { agent: { status: "active" } },
          created_at: "2026-07-25T00:00:00Z",
        },
      ],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db, fetchFn), input);
    expect(fetchFn.mock.calls[0][0]).toBe("https://project.supabase.co/functions/v1/ai-agent-reply");
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({
      execution_id: "exec-1",
      lead_id: "lead-1",
      reply_content: "quero sim",
    });
    expect(result.body).toMatchObject({ mode: "ai_agent" });
  });

  it("execução em modo sequence delega a execute-sequence", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const db = {
      messages: [],
      leads: [lead()],
      flow_executions: [
        {
          id: "exec-1",
          user_id: TENANT,
          lead_id: "lead-1",
          flow_id: "flow-1",
          status: "waiting_response",
          context: { mode: "sequence" },
          created_at: "2026-07-25T00:00:00Z",
        },
      ],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db, fetchFn), input);
    expect(fetchFn.mock.calls[0][0]).toBe("https://project.supabase.co/functions/v1/execute-sequence");
    expect(result.body).toMatchObject({ mode: "sequence" });
  });

  it("isolamento: lead de outro tenant não é encontrado", async () => {
    const db = {
      messages: [],
      leads: [{ ...lead(), user_id: "tenant-2" }],
      flow_executions: [],
      logs: [],
      pipeline_stages: [],
    };
    const result = await handleInboundMessage(deps(db), input);
    expect(result.body.ignored).toBe(true);
    expect(String(result.body.reason)).toContain("Lead não encontrado");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/inbound-orchestrator.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Mover o consentimento para módulo Deno-free**

Criar `supabase/functions/_shared/marketing-consent.ts` com
`assertLeadCanReceiveMarketing` **copiada verbatim** de `auth.ts:246-254`
(importando `HttpError` de `./http-error.ts`). Em `auth.ts`, apagar a função e
adicionar `export { assertLeadCanReceiveMarketing } from "./marketing-consent.ts";`.

Run: `deno check supabase/functions/process-queue/index.ts supabase/functions/execute-flow/index.ts`
Expected: sem erro.

- [ ] **Step 4: Criar o orquestrador movendo o corpo do webhook**

`supabase/functions/_shared/whatsapp/inbound-orchestrator.ts` recebe, na ordem:

1. o cabeçalho e os tipos:

```ts
// Orquestração CRM de uma mensagem recebida, compartilhada pelos webhooks da
// Evolution e da Meta. Movido de whatsapp-webhook/index.ts sem mudança de
// regra: dedupe, achar lead, opt-out, consentimento, classificação de etapa por
// IA e delegação a agente/sequence/flow.

import { resolveExistingNextBlockId } from "../flow-routing.ts";
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../ai.ts";
import { assertLeadCanReceiveMarketing } from "../marketing-consent.ts";
import { HttpError } from "../http-error.ts";
import { isMarketingOptOutMessage, phoneVariants } from "./evolution-parse.ts";

export interface OrchestratorDeps {
  client: { from: (table: string) => any };
  fetchFn: typeof fetch;
  baseUrl: string;
  internalHeaders: () => Record<string, string>;
  openrouterKey: string | null;
}

export interface OrchestratorInput {
  tenantId: string;
  providerMessageId: string | null;
  fromPhone: string;
  text: string;
}

export interface OrchestratorResult {
  status: number;
  body: Record<string, unknown>;
}
```

2. as funções `safeLog` e `recordMarketingOptOut` **copiadas verbatim** de
   `whatsapp-webhook/index.ts:107-163`;

3. `export async function handleInboundMessage(deps, input): Promise<OrchestratorResult>`
   com o corpo copiado de `whatsapp-webhook/index.ts:252-1005`, aplicando **só**
   estas substituições mecânicas:

| De | Para |
|---|---|
| `supabaseClient` | `deps.client` |
| `fetch(` | `deps.fetchFn(` |
| `Deno.env.get("SUPABASE_URL")` | `deps.baseUrl` |
| `internalJsonHeaders()` | `{ "Content-Type": "application/json", ...deps.internalHeaders() }` |
| `Deno.env.get("OPENROUTER_API_KEY")` | `deps.openrouterKey` |
| `msg.messageId` | `input.providerMessageId` |
| `msg.rawPhone` | `input.fromPhone` |
| `msg.text` | `input.text` |
| `instanceUserId` e `userId` | `input.tenantId` |
| `return new Response(JSON.stringify(X), { status: N, headers: ... })` | `return { status: N, body: X }` |
| `step = "..."` | manter (usado nos logs) |

O `throw new HttpError(403, "Execution flow does not belong to the instance tenant")`
da linha 592 permanece igual. O bloco `try/catch` externo (linhas 1006–1028)
**não** vem: fica no webhook.

- [ ] **Step 5: Emagrecer o `whatsapp-webhook`**

Em `whatsapp-webhook/index.ts`, o handler passa a ser: verificar assinatura →
parsear → aplicar a escada de motivos (linhas 190–222, inalterada) → resolver o
tenant pela instância (linhas 225–250, inalterada) → chamar o orquestrador:

```ts
const result = await handleInboundMessage(
  {
    client: supabaseClient,
    fetchFn: fetch,
    baseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    internalHeaders: internalAuthHeaders,
    openrouterKey: Deno.env.get("OPENROUTER_API_KEY") ?? null,
  },
  {
    tenantId: instanceUserId,
    providerMessageId: msg.messageId ? String(msg.messageId) : null,
    fromPhone: msg.rawPhone,
    text: msg.text,
  },
);

return new Response(JSON.stringify(result.body), {
  status: result.status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});
```

`safeLog` e `recordMarketingOptOut` saem do arquivo (agora vivem no orquestrador).

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run tests/unit/inbound-orchestrator.test.ts`
Expected: PASS.

Run: `npm run test`
Expected: suíte inteira verde.

Run: `deno check supabase/functions/whatsapp-webhook/index.ts`
Expected: sem erro.

Run: `npm run typecheck && npm run lint`
Expected: typecheck 0 erros; lint sem erro novo.

- [ ] **Step 7: Paridade contra o deploy real (gate obrigatório)**

Antes do deploy, com o webhook ainda na versão antiga:

```bash
set -a; source .env.staging; set +a; npx playwright test tests/e2e/inbound-webhook.spec.ts
```
Anotar o resultado (deve estar verde).

Publicar a função e repetir:

```bash
bash scripts/sb-staging.sh functions deploy whatsapp-webhook
set -a; source .env.staging; set +a; npx playwright test tests/e2e/inbound-webhook.spec.ts tests/e2e/agent-journey.spec.ts
```
Expected: mesmos testes verdes depois da extração. Se algo mudar, o refactor
introduziu regressão — reverter e reconciliar, não "ajustar o teste".

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/_shared/marketing-consent.ts supabase/functions/_shared/whatsapp/inbound-orchestrator.ts supabase/functions/_shared/auth.ts supabase/functions/whatsapp-webhook/index.ts tests/unit/inbound-orchestrator.test.ts vitest.config.ts
git commit -m "refactor(whatsapp): orquestracao de inbound compartilhada entre provedores"
```

---

## Task 13: Edge function `meta-whatsapp-webhook`

**Files:**
- Create: `supabase/functions/meta-whatsapp-webhook/index.ts`
- Create: `supabase/functions/_shared/whatsapp/status-sync.ts`
- Test: `tests/unit/status-sync.test.ts`

**Interfaces:**
- Consumes: `createMetaProvider` (Tasks 6–8), `handleInboundMessage` (Task 12),
  `getGlobalSetting` (`ai.ts`), `constantTimeEqual` (Task 1), `decryptSecret`
  (Task 2), tabela `whatsapp_connections` (Task 9).
- Produces:
  `applyStatusUpdates(client, tenantId, statuses): Promise<{ applied: number; skipped: number }>`
  em `status-sync.ts`; a edge function `meta-whatsapp-webhook`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/status-sync.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyStatusUpdates } from "../../supabase/functions/_shared/whatsapp/status-sync";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

const message = (whatsappId: string, status: string) => ({
  id: `m-${whatsappId}`,
  user_id: TENANT,
  whatsapp_id: whatsappId,
  direction: "outbound",
  status,
});

describe("applyStatusUpdates", () => {
  it("avança pending → sent → delivered → read", async () => {
    const db = { messages: [message("wamid.A", "pending")] };
    const client = createFakeClient(db) as any;

    for (const status of ["sent", "delivered", "read"] as const) {
      await applyStatusUpdates(client, TENANT, [
        { providerMessageId: "wamid.A", status, timestamp: "2026-07-25T00:00:00.000Z" },
      ]);
    }
    expect(db.messages[0].status).toBe("read");
  });

  it("não regride status já mais avançado (webhook fora de ordem)", async () => {
    const db = { messages: [message("wamid.A", "read")] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.A", status: "delivered", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(db.messages[0].status).toBe("read");
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  it("failed sempre vence", async () => {
    const db = { messages: [message("wamid.A", "read")] };
    const client = createFakeClient(db) as any;
    await applyStatusUpdates(client, TENANT, [
      {
        providerMessageId: "wamid.A",
        status: "failed",
        timestamp: "2026-07-25T00:00:00.000Z",
        error: { code: "131049", message: "não entregue" },
      },
    ]);
    expect(db.messages[0].status).toBe("failed");
  });

  it("é idempotente: reaplicar o mesmo status não conta como aplicado", async () => {
    const db = { messages: [message("wamid.A", "delivered")] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.A", status: "delivered", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  it("não toca mensagem de outro tenant", async () => {
    const db = { messages: [{ ...message("wamid.A", "sent"), user_id: "tenant-2" }] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.A", status: "read", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(db.messages[0].status).toBe("sent");
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  it("wamid desconhecido é ignorado sem erro", async () => {
    const db = { messages: [] };
    const client = createFakeClient(db) as any;
    const result = await applyStatusUpdates(client, TENANT, [
      { providerMessageId: "wamid.Z", status: "sent", timestamp: "2026-07-25T00:00:00.000Z" },
    ]);
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/status-sync.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar `status-sync.ts`**

```ts
// Aplica status de entrega em messages.status. Idempotente e monotônico: um
// webhook repetido ou fora de ordem nunca regride o estado de uma entrega.

import { type StatusUpdate } from "./types.ts";

const RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

export async function applyStatusUpdates(
  client: { from: (table: string) => any },
  tenantId: string,
  statuses: StatusUpdate[],
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const update of statuses) {
    if (!update.providerMessageId) {
      skipped += 1;
      continue;
    }

    const { data: message } = await client
      .from("messages")
      .select("id, status")
      .eq("user_id", tenantId)
      .eq("whatsapp_id", update.providerMessageId)
      .maybeSingle();

    if (!message) {
      skipped += 1;
      continue;
    }

    const isFailure = update.status === "failed";
    const currentRank = RANK[String(message.status ?? "pending")] ?? 0;
    const nextRank = RANK[update.status] ?? 0;

    if (!isFailure && nextRank <= currentRank) {
      skipped += 1;
      continue;
    }

    const { error } = await client
      .from("messages")
      .update({ status: update.status })
      .eq("id", message.id)
      .eq("user_id", tenantId);

    if (error) {
      skipped += 1;
      continue;
    }
    applied += 1;
  }

  return { applied, skipped };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/status-sync.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Implementar a edge function**

`supabase/functions/meta-whatsapp-webhook/index.ts`:

```ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import { getGlobalSetting } from "../_shared/ai.ts";
import { constantTimeEqual } from "../_shared/hmac.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { HttpError } from "../_shared/http-error.ts";
import { getHttpErrorStatus, internalAuthHeaders } from "../_shared/auth.ts";
import { createMetaProvider } from "../_shared/whatsapp/meta-provider.ts";
import { handleInboundMessage } from "../_shared/whatsapp/inbound-orchestrator.ts";
import { applyStatusUpdates } from "../_shared/whatsapp/status-sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function readSetting(client: any, key: string, envName: string): Promise<string | null> {
  return (await getGlobalSetting(client, key)) ?? Deno.env.get(envName) ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseClient = createServiceRoleClient();
  let step = "init";

  try {
    if (req.method === "GET") {
      step = "verify_subscription";
      const url = new URL(req.url);
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token") ?? "";
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      const expected = await readSetting(
        supabaseClient,
        "meta_webhook_verify_token",
        "META_WEBHOOK_VERIFY_TOKEN",
      );

      if (!expected) throw new HttpError(503, "meta_webhook_verify_token is not configured");
      if (mode !== "subscribe" || !constantTimeEqual(token, expected)) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders });
      }

      // A Meta exige exatamente o challenge, em texto puro.
      return new Response(challenge, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    if (req.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    step = "verify_signature";
    const rawBody = await req.text();
    const appSecretEncrypted = await getGlobalSetting(supabaseClient, "meta_app_secret_encrypted");
    const appSecret = appSecretEncrypted
      ? await decryptSecret(appSecretEncrypted, Deno.env.get("WHATSAPP_TOKEN_ENC_KEY") ?? "")
      : (Deno.env.get("META_APP_SECRET") ?? "");

    const graphApiVersion =
      (await readSetting(supabaseClient, "meta_graph_api_version", "META_GRAPH_API_VERSION")) ??
      "v25.0";

    // Provider só para verificar/parsear: sem número nem token nesta etapa.
    const parser = createMetaProvider({
      graphApiVersion,
      phoneNumberId: "",
      accessToken: "",
      appSecret: appSecret || undefined,
    });

    await parser.verifyWebhook(req, rawBody);

    step = "parse";
    const { inbound, statuses, phoneNumberId } = parser.parseWebhook(rawBody);
    if (inbound.length === 0 && statuses.length === 0) {
      return json({ success: true, ignored: true, reason: "no_actionable_event" });
    }

    step = "resolve_tenant";
    const results: unknown[] = [];
    const deps = {
      client: supabaseClient,
      fetchFn: fetch,
      baseUrl: Deno.env.get("SUPABASE_URL") ?? "",
      internalHeaders: internalAuthHeaders,
      openrouterKey: Deno.env.get("OPENROUTER_API_KEY") ?? null,
    };

    for (const message of inbound) {
      const tenantId = await tenantForPhoneNumberId(
        supabaseClient,
        message.phoneNumberId ?? phoneNumberId,
      );
      if (!tenantId) {
        results.push({ ignored: true, reason: "unknown_phone_number_id" });
        continue;
      }
      if (message.type !== "text" || !message.text) {
        results.push({ ignored: true, reason: `unsupported_type_${message.type}` });
        continue;
      }
      const outcome = await handleInboundMessage(deps, {
        tenantId,
        providerMessageId: message.providerMessageId || null,
        fromPhone: message.fromPhone,
        text: message.text,
      });
      results.push(outcome.body);
    }

    if (statuses.length > 0) {
      const tenantId = await tenantForPhoneNumberId(supabaseClient, phoneNumberId);
      if (tenantId) {
        results.push(await applyStatusUpdates(supabaseClient, tenantId, statuses));
      } else {
        results.push({ ignored: true, reason: "unknown_phone_number_id" });
      }
    }

    return json({ success: true, results });
  } catch (error: any) {
    console.error(`[MetaWebhook] Erro em step=${step}:`, error?.message || error);
    return json(
      { success: false, step, error: error?.message || String(error) },
      getHttpErrorStatus(error, 500),
    );
  }
});

async function tenantForPhoneNumberId(
  client: any,
  phoneNumberId: string | undefined,
): Promise<string | null> {
  if (!phoneNumberId) return null;
  const { data } = await client
    .from("whatsapp_connections")
    .select("tenant_id")
    .eq("phone_number_id", phoneNumberId)
    .eq("provider", "meta_cloud")
    .maybeSingle();
  return data?.tenant_id ?? null;
}
```

- [ ] **Step 6: Verificar**

Run: `deno check supabase/functions/meta-whatsapp-webhook/index.ts`
Expected: sem erro.

Run: `npm run test`
Expected: verde.

- [ ] **Step 7: Deploy e smoke do GET (sem credenciais Meta)**

```bash
bash scripts/sb-staging.sh secrets set WHATSAPP_TOKEN_ENC_KEY="$(openssl rand -base64 32)"
bash scripts/sb-staging.sh db query --linked "insert into public.global_settings (key,value) values ('meta_webhook_verify_token','<token gerado>') on conflict (key) do update set value = excluded.value"
bash scripts/sb-staging.sh functions deploy meta-whatsapp-webhook
curl --ssl-no-revoke -s -o /dev/null -w '%{http_code}\n' \
  "https://<project>.supabase.co/functions/v1/meta-whatsapp-webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=12345"
```
Expected: `200` e corpo exatamente `12345`. Com token errado: `403`.

`supabase/config.toml`: registrar a função com `verify_jwt = false` (a Meta não
manda JWT; a autenticação é a assinatura). Conferir como as outras funções
públicas estão declaradas antes de copiar.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/meta-whatsapp-webhook/index.ts supabase/functions/_shared/whatsapp/status-sync.ts supabase/functions/_shared/whatsapp/meta-provider.ts tests/unit/status-sync.test.ts tests/unit/meta-provider-webhook.test.ts supabase/config.toml vitest.config.ts
git commit -m "feat(whatsapp): webhook da Meta com verificacao, assinatura e sync de status"
```

---

## Task 14: `process-queue` envia pela abstração

> Reescrita em 2026-07-25 pela revisão de escopo. A versão anterior mantinha a
> Evolution como caminho padrão e injetava `evolutionApiUrl`/`verifyEvolutionWebhook`
> em `resolveProvider`. Sem provider duplo isso não existe mais.

**Files:**
- Modify: `supabase/functions/process-queue/index.ts`

**Interfaces:**
- Consumes: `resolveProvider` (Task 10), `getGlobalSetting` (`ai.ts`).
- Produces: nenhuma API nova.

**Efeito no comportamento — deliberado, não regressão:** um tenant sem linha
conectada em `whatsapp_connections` deixa de enviar. `resolveProvider` lança
`HttpError(409)`, o item vai para `failed` com motivo `no_whatsapp_connection` e
**não** é retentado — nenhuma retentativa resolve falta de configuração. Isso vale
para os tenants em produção a partir do deploy desta função.

- [ ] **Step 1: Trocar o import**

`sendWhatsAppText` sai; entram `resolveProvider` e `getGlobalSetting`.

- [ ] **Step 2: Trocar o `env_check`**

A checagem de `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` vira checagem de
`WHATSAPP_TOKEN_ENC_KEY` (sem ela nenhum token é descriptografável) e leitura de
`meta_graph_api_version` via `global_settings` com fallback em env e `v25.0`.

- [ ] **Step 3: Trocar o bloco de envio**

`resolveProvider(userId, { client, env })` dentro do próprio `try`, para
distinguir "sem conexão" (permanente) de "erro de envio" (retentável). Depois,
`provider.sendText({ to: phone, text: message })` e
`sendResult.providerMessageId` no lugar de `data.key.id`.

No ramo de erro: `step = "provider_api_error"`, mensagem de
`sendResult.error?.message`, diagnóstico com `provider`/`providerStatus`, motivo
`` `${provider.id}_${sendResult.status}` ``. `isPermanent` continua em
`status === 400`.

**Não mexer** em: claim, `claim_marketing_queue_item_v2`,
`complete_marketing_queue_delivery`, limites de horário/intervalo/diário,
`delivery_unknown` e o `catch` externo.

- [ ] **Step 4: Verificar**

Run: `deno check supabase/functions/process-queue/index.ts` · `npm run test` ·
`npm run typecheck`
Expected: verde.

- [ ] **Step 5: Paridade real — BLOQUEADO em credenciais**

Não há como provar envio real sem um número Meta conectado. O E2E de envio só
volta a ser executável depois que o dono fornecer as credenciais e uma linha
existir em `whatsapp_connections`. Registrar como pendência, **não** declarar
paridade provada.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/process-queue/index.ts
git commit -m "refactor(queue): envio pela abstracao de provedor"
```

---


## Task 15: Fechar o Bloco A — gates, cobertura e documentação

**Files:**
- Modify: `vitest.config.ts`
- Modify: `STATUS.md`
- Modify: `docs/specs/2026-07-24-migracao-whatsapp-meta-cloud-design.md` (status + desvios)
- Create: `docs/meta-whatsapp-setup.md` (esqueleto do que o dono precisa fornecer)

- [ ] **Step 1: Rodar todos os gates de conclusão e capturar a saída**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
for fn in supabase/functions/*/index.ts; do deno check "$fn" || echo "FALHOU: $fn"; done
```
Expected: lint sem erro novo; typecheck 0 erros; testes verdes com cobertura ≥80%
nos módulos incluídos; build verde; `deno check` limpo em todas as functions.

- [ ] **Step 2: Conferir que nenhum segredo vaza**

```bash
grep -rn "accessToken\|access_token\|appSecret\|WHATSAPP_TOKEN_ENC_KEY" supabase/functions --include=*.ts | grep -i "console\."
```
Expected: nenhuma linha. Se aparecer, remover o log.

- [ ] **Step 3: Atualizar o STATUS.md**

Acrescentar seção "Bloco A — migração Meta Cloud (2026-07-25)" com: o que foi
entregue, a saída real dos gates do Step 1, o que ficou travado em credenciais e
os próximos passos (Bloco B, Fase 2 em diante). Sem afirmar nada que não tenha
sido executado.

- [ ] **Step 4: Fechar o loop na spec**

Em `docs/specs/2026-07-24-migracao-whatsapp-meta-cloud-design.md`: mudar o Status
para `Bloco A implementado; Bloco B travado em credenciais` e incorporar os
desvios 1–6 deste plano na seção de decisões.

- [ ] **Step 5: `docs/meta-whatsapp-setup.md`**

Documento curto e operacional: onde achar App ID, App Secret, Config ID do
Embedded Signup, WABA ID e Phone Number ID no painel da Meta; qual URL registrar
como callback (`https://<project>.supabase.co/functions/v1/meta-whatsapp-webhook`);
como gerar e gravar o verify token; quais secrets do Supabase precisam existir
(`WHATSAPP_TOKEN_ENC_KEY`, `META_APP_SECRET`). Sem valores reais no arquivo.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts STATUS.md docs/specs/2026-07-24-migracao-whatsapp-meta-cloud-design.md docs/meta-whatsapp-setup.md
git commit -m "docs: fecha o bloco A da migracao para a Meta Cloud API"
```

---

## Task 16: Remoção da Evolution

> Adicionada em 2026-07-25 pela decisão de tirar a Evolution do produto. **Última
> da fila, e só depois da Task 15 fechada**: a Task 12 já terá mudado a
> orquestração do CRM de casa e a Task 13 já terá o webhook Meta de pé. Só então
> sobra código morto para apagar.

**Pré-condições — nenhuma é dispensável:**

1. Task 15 fechada: gates verdes com o caminho Meta completo.
2. Um número real conectado por `whatsapp_connections` e provado de ponta a ponta
   (envio + inbound), com credenciais Meta do dono.
3. **Decisão em aberto resolvida** (ver revisão de escopo no topo): o que
   substitui `src/pages/Whatsapp.tsx` como tela de conexão.
4. Autorização explícita do dono para o deploy que apaga o caminho de envio atual.

**Files (apagar):**
- `supabase/functions/whatsapp-webhook/` (após a Task 12 esvaziá-lo)
- `supabase/functions/whatsapp-proxy/` (QR/instância — 431 linhas)
- `supabase/functions/evolution-webhook-check/`
- `supabase/functions/_shared/evolution.ts`, `_shared/evolution-webhook.ts`
- `tests/unit/evolution.test.ts`, `tests/e2e/inbound-webhook.spec.ts`

**Files (editar):**
- `supabase/functions/_shared/auth.ts` — remover `verifyEvolutionWebhook`,
  `evolutionWebhookUrl`, `evolutionWebhookHeaders`, `getWebhookSecret`,
  `normaliseSignature` e o import de `hmacSha256Hex` que sobra
- `supabase/functions/process-queue/index.ts` — tirar o caminho Evolution
- `supabase/functions/_shared/ai.ts` — referências residuais
- `src/`: `pages/Whatsapp.tsx`, `hooks/use-whatsapp.ts`, `pages/Settings.tsx`,
  `pages/Onboarding.tsx`, `pages/Diagnostics.tsx`, `pages/FlowEditor.tsx`,
  `pages/FlowSequenceEditor.tsx`, `components/flows/FlowTestArea.tsx`,
  `components/flows/SafeFlowTestModal.tsx`, `lib/flow-test.ts`,
  `lib/account-secrets.functions.ts`
- `tests/e2e/agent-journey.spec.ts`, `tests/e2e/helpers/agent-seed.ts`
- `.env.example`, `docs/staging.md`, `STATUS.md`

- [ ] **Step 1: Substituir o E2E de inbound antes de apagar o antigo**

Escrever `tests/e2e/meta-inbound-webhook.spec.ts` cobrindo o mesmo contrato do
`inbound-webhook.spec.ts` atual contra `meta-whatsapp-webhook`. Ver verde.
Só então apagar o antigo. Nunca ficar sem cobertura de inbound entre os dois.

- [ ] **Step 2: Apagar backend e rodar os gates**

Run: `npx vitest run` · `npm run typecheck` · `deno check supabase/functions/*/index.ts`
Expected: verde. Nenhum import órfão de `evolution*`.

Run: `grep -rn -i "evolution" supabase/functions/ src/ tests/`
Expected: zero ocorrências fora de migrations históricas e docs de histórico.

- [ ] **Step 3: Apagar frontend e rodar os gates**

Run: `npm run lint` · `npm run typecheck` · `npm run build`
Expected: verde, sem rota nem link morto para a página removida.

- [ ] **Step 4: Retirar os secrets**

`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET` saem do
Supabase e do `.env.staging`. **Ação irreversível em produção: só com ok
explícito do dono, e depois do item 2 das pré-condições.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(whatsapp): remove a integracao Evolution do produto"
```

---

## Cobertura da spec por tarefa

| Item da spec | Tarefa |
|---|---|
| A1 abstração de provider (types) | 3 |
| A1 regra de contato/opt-out compartilhada | 4 |
| A1 meta-provider | 6, 7, 8 |
| A1 `resolveProvider` | 10 |
| A1 inbound-orchestrator | 12 |
| A2 `whatsapp_connections` + settings + RLS | 9 |
| A3 criptografia | 1, 2 |
| A4 superadmin + verify token | 11 |
| A5 webhook Meta (GET/POST/idempotência/status) | 7, 13 |
| A6 `process-queue` pela abstração | 14 |
| A7 testes (crypto, provider, webhook, idempotência, isolamento, erro explícito, gate, characterization) | 2, 4, 6, 7, 8, 10, 11, 12, 13 |
| Gates de conclusão do Bloco A | 15 |
| Remoção da Evolution (fora da spec original) | 16 |

Bloco B (Fases 2–13) permanece fora deste plano: cada fase depende de credencial
que só o dono fornece.
