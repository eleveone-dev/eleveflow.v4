# Captura do histórico do WhatsApp (parte A): plano de implementação

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` ou `superpowers:executing-plans` para
> implementar tarefa a tarefa. Os passos usam checkbox (`- [x]`).

**Objetivo:** gravar no CRM a mensagem que o vendedor manda pelo aparelho e a mídia com
o tipo, pausar IA, fluxos e fila quando o vendedor fala, e recuperar o histórico da
Evolution que casa com lead.

**Arquitetura:** o parse da Evolution passa a classificar mídia e a devolver `fromMe`
como eco; o webhook entrega os ecos ao `handleEcho` (o mesmo da Meta, com uma guarda
contra o eco dos nossos envios) e a mídia sem legenda ao orquestrador, que só grava. O
`process-queue` reagenda item de lead em pausa. Um script único lê o armazenamento da
Evolution dentro do container e importa com deduplicação por `whatsapp_id`.

**Stack:** Edge Functions (Deno), Postgres, Vitest, Playwright, Node 22 com
`--experimental-strip-types` para o script.

**Spec:** `docs/specs/2026-09-25-captura-historico-whatsapp-design.md`.

**Base:** branch `feat/f1-evolution-provider`, `c3b291d`. Linha de base: 40 arquivos,
492 testes, verde.

## Global Constraints

- Português do Brasil em commits, comentários e docs. Commit sem acentuação.
- Conventional Commits atômicos. **Sem rastro de IA.**
- **TDD:** teste, ver falhar, implementar, ver passar.
- **Nada declarado pronto sem a saída do comando colada.**
- `_shared/`: sem `import` por URL e sem `Deno.env`.
- Banco: só aditivo. Nenhum `DROP`, nenhum `ALTER ... TYPE`.
- **Nunca logar** texto de mensagem nem telefone de quem não é lead.
- Evolution: **só leitura e só a instância da conta** (`instance_name = user_id`).
  Nunca `logout`, `delete` ou `connect`; a instância `Atual` é de cliente.
- **Gate do dono:** migration, deploy de função, frontend e recuperação só com OK.
- Todo comando Supabase via `bash scripts/sb-staging.sh` (é **produção**).
- Cobertura: o gate de 80% continua; módulo novo entra em `coverage.include`.

## Arquivos

| arquivo | mudança |
|---|---|
| `supabase/migrations/20260925135525_messages_media_type.sql` | coluna `media_type` |
| `src/integrations/supabase/types.ts` | `media_type` em `messages` |
| `supabase/functions/_shared/whatsapp/types.ts` | tipos `sticker`, `location`, `contact` |
| `supabase/functions/_shared/whatsapp/evolution-parse.ts` | classificação, eco, grupo, `@lid` |
| `supabase/functions/_shared/whatsapp/echo-handler.ts` | `mediaType`, guarda de envio próprio, log sem telefone |
| `supabase/functions/_shared/whatsapp/inbound-orchestrator.ts` | `mediaType`, mídia sem legenda só grava |
| `supabase/functions/whatsapp-webhook/index.ts` | roteia ecos e passa o tipo |
| `supabase/functions/process-queue/index.ts` | reagenda item de lead em pausa |
| `src/lib/midia-mensagem.ts` | rótulo e prévia de mídia |
| `src/hooks/use-conversations.ts`, `src/pages/Conversas.tsx` | tela |
| `scripts/lib/historico-evolution.ts` | lógica pura da recuperação |
| `scripts/recuperar-historico-evolution.ts` | recuperação (ensaio e aplicação) |
| `tests/unit/*` | testes novos e ajustados |
| `tests/e2e/evolution-inbound-webhook.spec.ts` | E2E novos |
| `vitest.config.ts` | cobertura |

---

### Task 1: Coluna `messages.media_type`

**Files:**
- Modify: `supabase/migrations/20260925135525_messages_media_type.sql` (criado vazio por
  `bash scripts/sb-staging.sh migration new messages_media_type`)
- Modify: `src/integrations/supabase/types.ts` (tabela `messages`: `Row`, `Insert`, `Update`)

**Interfaces:**
- Produces: `messages.media_type text null`, check em `audio`, `image`, `video`,
  `document`, `sticker`, `location`, `contact`, `other`.

- [x] **Passo 1: Migration**

```sql
-- Tipo da midia da mensagem; null e texto. Midia sem legenda grava content = ''.
-- Nada de transcricao: o tipo diz o que chegou, nao o que foi dito.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_type text;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_media_type_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_media_type_check
  CHECK (
    media_type IS NULL
    OR media_type IN ('audio', 'image', 'video', 'document', 'sticker', 'location', 'contact', 'other')
  );
```

- [x] **Passo 2: Tipos do front.** Em `src/integrations/supabase/types.ts`, tabela
  `messages`: `media_type: string | null;` em `Row` e `media_type?: string | null;` em
  `Insert` e `Update`, em ordem alfabética junto dos outros campos.

- [x] **Passo 3: Checar e commitar**

```bash
npx tsc --noEmit
git add supabase/migrations/20260925135525_messages_media_type.sql src/integrations/supabase/types.ts
git commit -m "feat(db): messages ganha media_type

Tipo da midia da mensagem, null para texto. Midia sem legenda passa a ser
gravada com content vazio em vez de descartada."
```

---

### Task 2: Parse da Evolution

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/types.ts` (`InboundMessageType`, comentário de `EchoMessage`)
- Modify: `supabase/functions/_shared/whatsapp/evolution-parse.ts`
- Test: `tests/unit/evolution-provider.test.ts` (bloco `parseEvolutionWebhook`)

**Interfaces:**
- Produces:
  - `InboundMessageType` ganha `"sticker" | "location" | "contact"`.
  - `classifyEvolutionContent(raw): { type: InboundMessageType; text: string } | null`
  - `mediaTypeColumn(type: InboundMessageType): string | null`
  - `parseEvolutionWebhook(rawBody)`: `fromMe` vira `echoes[0]` com `toPhone`; recebida
    vira `inbound[0]`; grupo, canal, transmissão e `@lid` sem telefone devolvem vazio.

- [x] **Passo 1: Testes que falham.** No bloco `describe("parseEvolutionWebhook")`,
  **substituir** os testes "mensagem propria e descartada", "mensagem sem texto
  resolvivel nao produz inbound", "legenda de imagem vira o texto" e "echoes e statuses
  ficam vazios..." por estes, e acrescentar os demais:

```ts
  const TS = new Date(1789000000 * 1000).toISOString();

  it("legenda de imagem vira o texto de uma mensagem do tipo image", () => {
    const r = parseEvolutionWebhook(
      upsert({ imageMessage: { caption: "olha isso", url: "https://x/y.enc" } }),
    );
    expect(r.inbound[0]).toMatchObject({ type: "image", text: "olha isso" });
  });

  it("audio sem legenda vira mensagem de audio com texto vazio", () => {
    const r = parseEvolutionWebhook(upsert({ audioMessage: { seconds: 12, ptt: true } }));
    expect(r.inbound[0]).toMatchObject({ type: "audio", text: "" });
  });

  it("figurinha, localizacao e contato tem tipo proprio", () => {
    expect(parseEvolutionWebhook(upsert({ stickerMessage: { url: "x" } })).inbound[0].type).toBe(
      "sticker",
    );
    expect(
      parseEvolutionWebhook(upsert({ locationMessage: { degreesLatitude: 1 } })).inbound[0].type,
    ).toBe("location");
    expect(
      parseEvolutionWebhook(upsert({ contactMessage: { displayName: "Fulano" } })).inbound[0].type,
    ).toBe("contact");
  });

  it("documento com legenda vem desembrulhado", () => {
    const r = parseEvolutionWebhook(
      upsert({
        documentWithCaptionMessage: {
          message: { documentMessage: { caption: "segue o contrato", fileName: "c.pdf" } },
        },
      }),
    );
    expect(r.inbound[0]).toMatchObject({ type: "document", text: "segue o contrato" });
  });

  it("mensagem efemera vem desembrulhada", () => {
    const r = parseEvolutionWebhook(
      upsert({ ephemeralMessage: { message: { conversation: "some em 24h" } } }),
    );
    expect(r.inbound[0]).toMatchObject({ type: "text", text: "some em 24h" });
  });

  it("reacao e protocolo continuam ignorados", () => {
    expect(
      parseEvolutionWebhook(upsert({ reactionMessage: { text: "👍" } })).inbound,
    ).toHaveLength(0);
    expect(parseEvolutionWebhook(upsert({ protocolMessage: { type: 0 } })).inbound).toHaveLength(0);
  });

  it("mensagem propria vira eco com o telefone do lead", () => {
    const r = parseEvolutionWebhook(
      upsert({ conversation: "respondi pelo celular" }, { key: { fromMe: true } }),
    );
    expect(r.inbound).toHaveLength(0);
    expect(r.echoes).toEqual([
      {
        providerMessageId: "3EB0ABC",
        toPhone: "5511987654321",
        type: "text",
        text: "respondi pelo celular",
        timestamp: TS,
      },
    ]);
  });

  it("audio mandado pelo aparelho vira eco de audio", () => {
    const r = parseEvolutionWebhook(upsert({ audioMessage: { ptt: true } }, { key: { fromMe: true } }));
    expect(r.echoes[0]).toMatchObject({ type: "audio", text: "" });
  });

  it("grupo, canal e transmissao sao ignorados", () => {
    for (const remoteJid of [
      "120363000000000000@g.us",
      "120363000000000001@newsletter",
      "status@broadcast",
    ]) {
      const r = parseEvolutionWebhook(upsert({ conversation: "oi" }, { key: { remoteJid } }));
      expect(r.inbound).toHaveLength(0);
      expect(r.echoes).toHaveLength(0);
    }
  });

  it("@lid usa o telefone de remoteJidAlt", () => {
    const r = parseEvolutionWebhook(
      upsert(
        { conversation: "oi" },
        { key: { remoteJid: "123456789012345@lid", remoteJidAlt: "5511987654321@s.whatsapp.net" } },
      ),
    );
    expect(r.inbound[0].fromPhone).toBe("5511987654321");
  });

  it("@lid sem telefone alternativo e ignorado", () => {
    const r = parseEvolutionWebhook(
      upsert({ conversation: "oi" }, { key: { remoteJid: "123456789012345@lid" } }),
    );
    expect(r.inbound).toHaveLength(0);
  });

  it("mensagem recebida nao gera eco nem status", () => {
    const r = parseEvolutionWebhook(upsert({ conversation: "oi" }));
    expect(r.statuses).toEqual([]);
    expect(r.echoes).toEqual([]);
  });
});

describe("mediaTypeColumn", () => {
  it("texto e null; midia usa o proprio tipo; interativo vira other", () => {
    expect(mediaTypeColumn("text")).toBeNull();
    expect(mediaTypeColumn("audio")).toBe("audio");
    expect(mediaTypeColumn("sticker")).toBe("sticker");
    expect(mediaTypeColumn("interactive")).toBe("other");
  });
```

E no topo do arquivo, o import passa a ser:

```ts
import {
  mediaTypeColumn,
  parseEvolutionWebhook,
} from "../../supabase/functions/_shared/whatsapp/evolution-parse";
```

- [x] **Passo 2: Ver falhar**

Run: `npx vitest run tests/unit/evolution-provider.test.ts`
Esperado: FAIL — `mediaTypeColumn is not a function` e os testes de tipo, eco, grupo e
`@lid`.

- [x] **Passo 3: Implementar.** Em `types.ts`:

```ts
export type InboundMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "interactive"
  | "unsupported";
```

e o comentário de `EchoMessage` passa a ser:

```ts
/** Mensagem que o dono mandou fora do CRM, pelo aparelho. Na Meta chega no campo
 *  `smb_message_echoes` (coexistência); na Evolution, como `messages.upsert` com
 *  `fromMe`. Atenção: aqui o lead é o `to`. */
```

Em `evolution-parse.ts`, o import vira
`import type { EchoMessage, InboundMessage, InboundMessageType, WebhookParseResult } from "./types.ts";`,
a função `extractText` sai, e entram:

```ts
// Envelopes que o WhatsApp poe em volta da mensagem de verdade.
const ENVELOPES = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "documentWithCaptionMessage",
  "associatedChildMessage",
];

const MIDIAS: Array<[string, InboundMessageType]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["documentMessage", "document"],
  ["audioMessage", "audio"],
  ["stickerMessage", "sticker"],
  ["locationMessage", "location"],
  ["liveLocationMessage", "location"],
  ["contactMessage", "contact"],
  ["contactsArrayMessage", "contact"],
];

/** Tipo e texto de uma mensagem da Baileys. null = nao e mensagem de conversa
 *  (protocolo, reacao, edicao, enquete, botoes, contêiner de album). */
export function classifyEvolutionContent(
  raw: Record<string, any> | null | undefined,
): { type: InboundMessageType; text: string } | null {
  let message: Record<string, any> = raw ?? {};
  for (const envelope of ENVELOPES) {
    if (message[envelope]?.message) {
      message = message[envelope].message;
      break;
    }
  }

  const texto = String(message.conversation ?? message.extendedTextMessage?.text ?? "").trim();
  if (texto) return { type: "text", text: texto };

  for (const [chave, type] of MIDIAS) {
    if (message[chave]) return { type, text: String(message[chave].caption ?? "").trim() };
  }
  return null;
}

/** Valor de messages.media_type: null para texto. */
export function mediaTypeColumn(type: InboundMessageType): string | null {
  if (type === "text") return null;
  if (type === "interactive" || type === "unsupported") return "other";
  return type;
}

// Grupo, canal e transmissao nao sao conversa com lead.
const NAO_INDIVIDUAL = /@(g\.us|newsletter|broadcast)$/i;

/** Telefone do contato. JID @lid e identificador de privacidade, nao telefone:
 *  so vale o remoteJidAlt, quando vem. */
function telefoneDoContato(jid: string, alt: unknown): string {
  if (!/@lid$/i.test(jid)) return stripJid(jid);
  const alternativo = String(alt ?? "");
  return /@lid$/i.test(alternativo) ? "" : stripJid(alternativo);
}
```

E o corpo de `parseEvolutionWebhook`, depois do `if (!isInboundMessageEvent(...))`:

```ts
  const data = payload?.data ?? {};
  const key = data.key ?? {};

  const jid = String(key.remoteJid ?? data.remoteJid ?? "");
  if (!jid || NAO_INDIVIDUAL.test(jid)) return { ...EMPTY };

  const phone = telefoneDoContato(jid, key.remoteJidAlt);
  if (!phone) return { ...EMPTY };

  const conteudo = classifyEvolutionContent(data.message);
  if (!conteudo) return { ...EMPTY };

  const timestampSeconds = Number(data.messageTimestamp ?? 0);
  const timestamp = timestampSeconds
    ? new Date(timestampSeconds * 1000).toISOString()
    : new Date().toISOString();
  const providerMessageId = String(key.id ?? data.id ?? "");

  // fromMe e o dono falando fora do CRM (celular ou WhatsApp Web), ou o eco de um
  // envio nosso: quem separa os dois e o echo-handler.
  if (key.fromMe ?? data.fromMe ?? false) {
    const echo: EchoMessage = {
      providerMessageId,
      toPhone: phone,
      type: conteudo.type,
      text: conteudo.text,
      timestamp,
    };
    return { inbound: [], statuses: [], echoes: [echo] };
  }

  const inbound: InboundMessage = {
    providerMessageId,
    fromPhone: phone,
    type: conteudo.type,
    text: conteudo.text,
    timestamp,
  };
  return { inbound: [inbound], statuses: [], echoes: [] };
```

- [x] **Passo 4: Ver passar**

Run: `npx vitest run tests/unit/evolution-provider.test.ts`
Esperado: PASS.

- [x] **Passo 5: Lint, `deno check` e commit**

```bash
npx prettier --check --end-of-line auto supabase/functions/_shared/whatsapp/evolution-parse.ts supabase/functions/_shared/whatsapp/types.ts tests/unit/evolution-provider.test.ts
npx eslint supabase/functions/_shared/whatsapp/evolution-parse.ts tests/unit/evolution-provider.test.ts
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/whatsapp-webhook/index.ts supabase/functions/meta-whatsapp-webhook/index.ts
git add supabase/functions/_shared/whatsapp/evolution-parse.ts supabase/functions/_shared/whatsapp/types.ts tests/unit/evolution-provider.test.ts
git commit -m "feat(evolution): parse registra midia com tipo e mensagem do aparelho como eco

fromMe deixa de ser descartado e vira eco. Midia sem legenda passa a existir
com o tipo. Grupo, canal e transmissao param antes do inbound, e @lid sem
telefone alternativo e ignorado sem registrar o numero."
```

---

### Task 3: Eco com tipo, guarda de envio próprio e log sem telefone

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/echo-handler.ts`
- Test: `tests/unit/echo-handler.test.ts`

**Interfaces:**
- Consumes: `send_queue(user_id, lead_id, status, sending_at)`.
- Produces: `EchoInput.mediaType?: string | null`; `OWN_SEND_WINDOW_MS = 120000`;
  resultado `{ ignored: true, reason: "own_send_in_flight" }`.

- [x] **Passo 1: Testes que falham** (no fim do `describe("handleEcho")`):

```ts
  it("grava o tipo de midia do eco", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input({ text: "", mediaType: "audio" }));

    expect(db.messages[0]).toMatchObject({ content: "", media_type: "audio" });
  });

  it("eco de texto grava media_type nulo", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.messages[0].media_type).toBeNull();
  });

  it("ignora o eco de um envio nosso em curso", async () => {
    const db: any = dbComLead();
    db.send_queue = [
      {
        id: "q1",
        user_id: TENANT,
        lead_id: "lead-1",
        status: "sending",
        sending_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "own_send_in_flight" });
    expect(db.messages).toHaveLength(0);
    expect(db.leads[0].human_takeover_until).toBe(null);
  });

  it("item em sending ha mais de 2 minutos nao e envio nosso em curso", async () => {
    const db: any = dbComLead();
    db.send_queue = [
      {
        id: "q1",
        user_id: TENANT,
        lead_id: "lead-1",
        status: "sending",
        sending_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
    ];
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.messages).toHaveLength(1);
  });

  it("envio em curso para outro lead nao segura o eco", async () => {
    const db: any = dbComLead();
    db.send_queue = [
      {
        id: "q1",
        user_id: TENANT,
        lead_id: "lead-9",
        status: "sending",
        sending_at: new Date().toISOString(),
      },
    ];
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.messages).toHaveLength(1);
  });

  it("numero que nao e lead nao vai para o log", async () => {
    const db = dbComLead();
    db.leads = [];
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.logs.map((l: any) => l.event)).toContain("echo_lead_not_found");
    expect(JSON.stringify(db.logs)).not.toContain("987654321");
  });
```

- [x] **Passo 2: Ver falhar**

Run: `npx vitest run tests/unit/echo-handler.test.ts`
Esperado: FAIL nos 6 novos (`media_type` indefinido, eco gravado com envio em curso,
telefone no log).

- [x] **Passo 3: Implementar** em `echo-handler.ts`. O comentário do topo passa a dizer
  que vale para Meta e Evolution. Mudanças:

```ts
export interface EchoInput {
  tenantId: string;
  providerMessageId: string | null;
  toPhone: string;
  text: string;
  timestamp: string;
  /** Valor de messages.media_type; null ou ausente = texto. */
  mediaType?: string | null;
}

// O process-queue marca o item como `sending` antes de chamar o provedor, e o eco
// do envio pode chegar antes de a entrega gravar a mensagem. Gravar esse eco como
// humano pausaria a IA sem motivo e derrubaria a entrega no indice unico de
// whatsapp_id.
export const OWN_SEND_WINDOW_MS = 2 * 60 * 1000;

async function hasOwnSendInFlight(
  client: EchoDeps["client"],
  tenantId: string,
  leadId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("send_queue")
    .select("id, sending_at")
    .eq("user_id", tenantId)
    .eq("lead_id", leadId)
    .eq("status", "sending");
  if (error) throw error;

  const limite = Date.now() - OWN_SEND_WINDOW_MS;
  return (data ?? []).some(
    (item: { sending_at: string | null }) =>
      item.sending_at !== null && new Date(item.sending_at).getTime() >= limite,
  );
}
```

No `resolution.kind === "none"`, o log fica sem telefone (o aparelho fala com muita
gente que não é lead):

```ts
    await safeLog(deps.client, {
      user_id: input.tenantId,
      event: "echo_lead_not_found",
      details: {},
    });
```

Depois de `const lead = resolution.lead;`:

```ts
  setStep("echo_own_send_check");
  if (await hasOwnSendInFlight(deps.client, input.tenantId, lead.id)) {
    return { status: 200, body: { success: true, ignored: true, reason: "own_send_in_flight" } };
  }
```

E no insert: `content: input.text ?? "",` e `media_type: input.mediaType ?? null,`.

- [x] **Passo 4: Ver passar**

Run: `npx vitest run tests/unit/echo-handler.test.ts`
Esperado: PASS (os 6 antigos e os 6 novos).

- [x] **Passo 5: Lint e commit**

```bash
npx prettier --check --end-of-line auto supabase/functions/_shared/whatsapp/echo-handler.ts tests/unit/echo-handler.test.ts
npx eslint supabase/functions/_shared/whatsapp/echo-handler.ts tests/unit/echo-handler.test.ts
git add supabase/functions/_shared/whatsapp/echo-handler.ts tests/unit/echo-handler.test.ts
git commit -m "feat(eco): grava o tipo, ignora eco de envio nosso e nao loga numero de quem nao e lead

Item da fila em sending ha menos de 2 minutos para o mesmo lead e envio nosso:
quem grava e a entrega. Conversa de quem nao e lead nao deixa telefone no log."
```

---

### Task 4: Orquestrador grava o tipo e só grava mídia sem legenda

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/inbound-orchestrator.ts`
- Test: `tests/unit/inbound-orchestrator.test.ts`

**Interfaces:**
- Produces: `OrchestratorInput.mediaType?: string | null`; resultado
  `{ success: true, recorded_only: true, reason: "media_without_text" }`.

- [x] **Passo 1: Testes que falham** (novo `describe` no fim do arquivo):

```ts
describe("handleInboundMessage — midia", () => {
  const db = () => ({
    messages: [] as any[],
    leads: [lead()],
    flow_executions: [
      { id: "exec-1", user_id: TENANT, lead_id: "lead-1", status: "waiting_response", flow_id: "f1" },
    ],
    logs: [] as any[],
    pipeline_stages: [],
  });

  it("midia sem legenda e gravada com o tipo e nao segue para automacao", async () => {
    const banco = db();
    const fetchFn = vi.fn();

    const result = await handleInboundMessage(deps(banco, fetchFn), {
      ...input,
      text: "",
      mediaType: "audio",
    });

    expect(result.body).toMatchObject({ recorded_only: true, reason: "media_without_text" });
    expect(banco.messages[0]).toMatchObject({ content: "", media_type: "audio", direction: "inbound" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("midia com legenda grava o tipo e segue o caminho do texto", async () => {
    const banco = { ...db(), flow_executions: [] };

    const result = await handleInboundMessage(deps(banco), {
      ...input,
      text: "olha a foto da fachada",
      mediaType: "image",
    });

    expect(result.body.recorded_only).toBeUndefined();
    expect(banco.messages[0]).toMatchObject({ content: "olha a foto da fachada", media_type: "image" });
  });

  it("texto grava media_type nulo", async () => {
    const banco = { ...db(), flow_executions: [] };

    await handleInboundMessage(deps(banco), input);

    expect(banco.messages[0].media_type).toBeNull();
  });
});
```

- [x] **Passo 2: Ver falhar**

Run: `npx vitest run tests/unit/inbound-orchestrator.test.ts`
Esperado: FAIL nos 3 novos.

- [x] **Passo 3: Implementar.** `OrchestratorInput` ganha
  `/** Valor de messages.media_type; null ou ausente = texto. */ mediaType?: string | null;`.
  O insert de `save_inbound` ganha `media_type: input.mediaType ?? null,`. Logo depois do
  `safeLog` de `message_received`, antes do opt-out:

```ts
  // Midia sem legenda nao tem o que IA, fluxo ou opt-out leiam. Fica gravada para o
  // historico e as APIs, e a automacao segue sem reagir, como antes.
  if (!input.text.trim()) {
    return {
      status: 200,
      body: { success: true, recorded_only: true, reason: "media_without_text" },
    };
  }
```

- [x] **Passo 4: Ver passar**

Run: `npx vitest run tests/unit/inbound-orchestrator.test.ts`
Esperado: PASS.

- [x] **Passo 5: Lint e commit**

```bash
npx prettier --check --end-of-line auto supabase/functions/_shared/whatsapp/inbound-orchestrator.ts tests/unit/inbound-orchestrator.test.ts
npx eslint supabase/functions/_shared/whatsapp/inbound-orchestrator.ts tests/unit/inbound-orchestrator.test.ts
git add supabase/functions/_shared/whatsapp/inbound-orchestrator.ts tests/unit/inbound-orchestrator.test.ts
git commit -m "feat(inbound): grava o tipo da midia e so registra midia sem legenda

Midia sem legenda entra no historico e para antes de opt-out, IA e fluxo.
Com legenda, segue o caminho do texto e grava o tipo."
```

---

### Task 5: Webhook roteia ecos; fila respeita a pausa

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.ts`
- Modify: `supabase/functions/process-queue/index.ts`

**Interfaces:**
- Consumes: `handleEcho` (Task 3), `mediaTypeColumn` (Task 2), `handleInboundMessage` com
  `mediaType` (Task 4), `humanTakeoverUntil` de `_shared/whatsapp/human-takeover.ts`.
- Produces: log `queue_item_deferred_takeover` com `{ queue_item_id, until }`; motivo
  `human_takeover` em `skipped`.

O comportamento das duas funções é coberto pelo E2E (Task 7), porque as duas são
`index.ts` de Deno.

- [x] **Passo 1: Webhook.** Imports novos:
  `import { handleEcho } from "../_shared/whatsapp/echo-handler.ts";` e
  `mediaTypeColumn` no import de `evolution-parse.ts`. O trecho do `step = "parse"` em
  diante vira:

```ts
    step = "parse";
    const { inbound, echoes } = parseEvolutionWebhook(rawBody);
    if (inbound.length === 0 && echoes.length === 0) return ignored("no_actionable_event");

    const deps = {
      client: supabaseClient,
      fetchFn: fetch,
      baseUrl: Deno.env.get("SUPABASE_URL") ?? "",
      internalHeaders: internalAuthHeaders,
      openrouterKey: Deno.env.get("OPENROUTER_API_KEY") ?? null,
      onStep: (value: string) => {
        step = value;
      },
    };

    const results: unknown[] = [];
    // Eco primeiro: o dono falando pelo aparelho pausa IA e fluxos antes de o
    // inbound do mesmo lote decidir alguma coisa.
    for (const echo of echoes) {
      const outcome = await handleEcho(
        { client: supabaseClient, onStep: deps.onStep },
        {
          tenantId,
          providerMessageId: echo.providerMessageId || null,
          toPhone: echo.toPhone,
          text: echo.text ?? "",
          timestamp: echo.timestamp,
          mediaType: mediaTypeColumn(echo.type),
        },
      );
      results.push(outcome.body);
    }
    for (const message of inbound) {
      const outcome = await handleInboundMessage(deps, {
        tenantId,
        providerMessageId: message.providerMessageId || null,
        fromPhone: message.fromPhone,
        text: message.text ?? "",
        mediaType: mediaTypeColumn(message.type),
      });
      results.push(outcome.body);
    }

    return json({ success: true, results });
```

O comentário do topo do arquivo ganha: "Mensagem `fromMe` é o dono falando pelo aparelho
(ou o eco de um envio nosso) e vai para o `handleEcho`."

- [x] **Passo 2: Fila.** Import:
  `import { humanTakeoverUntil } from "../_shared/whatsapp/human-takeover.ts";`.
  No select do `dispatchItem`, `leads(...)` ganha `human_takeover_until, is_test`. Logo
  depois do bloco `try { assertLeadCanReceiveMarketing(dispatchLead); } catch { ... }`:

```ts
        // A pausa por atendimento humano vale tambem para o que ja estava na fila:
        // o vendedor falou pelo aparelho, e o item volta para depois da pausa. Uma
        // leitura so do prazo: checar e ler em dois tempos deixaria scheduled_at
        // nulo se a pausa vencesse no meio, e o item nunca mais sairia.
        const until = dispatchLead.is_test === true ? null : humanTakeoverUntil(dispatchLead);
        if (until) {
          await supabaseClient
            .from("send_queue")
            .update({ status: "pending", sending_at: null, claim_token: null, scheduled_at: until })
            .eq("id", item.id)
            .eq("status", "sending")
            .eq("claim_token", claimToken);
          await supabaseClient.from("logs").insert({
            user_id: userId,
            lead_id: item.lead_id,
            event: "queue_item_deferred_takeover",
            details: { queue_item_id: item.id, until },
          });
          skipped.push({ id: item.id, reason: "human_takeover" });
          continue;
        }
```

- [x] **Passo 3: Checar e commitar**

```bash
DENO_CERT="$(pwd)/.avast-ca.pem" deno check supabase/functions/whatsapp-webhook/index.ts supabase/functions/process-queue/index.ts
npx prettier --check --end-of-line auto supabase/functions/whatsapp-webhook/index.ts supabase/functions/process-queue/index.ts
npx eslint supabase/functions/whatsapp-webhook/index.ts supabase/functions/process-queue/index.ts
npx vitest run
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(webhook): mensagem do aparelho vai para o eco e o tipo da midia chega ao orquestrador"
git add supabase/functions/process-queue/index.ts
git commit -m "fix(fila): item de lead em pausa humana volta para depois da pausa

A pausa calava IA e fluxos, mas o que ja estava na fila saia mesmo com o
vendedor na conversa. Mesma regra do execute-flow."
```

---

### Task 6: Tela de Conversas

**Files:**
- Create: `src/lib/midia-mensagem.ts`
- Test: `tests/unit/midia-mensagem.test.ts`
- Modify: `src/hooks/use-conversations.ts`, `src/pages/Conversas.tsx`, `vitest.config.ts`

**Interfaces:**
- Produces: `rotuloMidia(mediaType): string | null`;
  `previaMensagem(content, mediaType): string`; `ConversationMessage.mediaType`.

- [x] **Passo 1: Teste que falha** (`tests/unit/midia-mensagem.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { previaMensagem, rotuloMidia } from "../../src/lib/midia-mensagem";

describe("rotuloMidia", () => {
  it("texto nao tem rotulo", () => {
    expect(rotuloMidia(null)).toBeNull();
    expect(rotuloMidia(undefined)).toBeNull();
  });

  it("audio avisa que nao foi transcrito", () => {
    expect(rotuloMidia("audio")).toBe("Áudio · não transcrito");
  });

  it("cada tipo tem nome proprio e o desconhecido vira Mídia", () => {
    expect(rotuloMidia("image")).toBe("Imagem");
    expect(rotuloMidia("sticker")).toBe("Figurinha");
    expect(rotuloMidia("location")).toBe("Localização");
    expect(rotuloMidia("tipo-novo")).toBe("Mídia");
  });
});

describe("previaMensagem", () => {
  it("texto passa como esta", () => {
    expect(previaMensagem("oi, tudo bem?", null)).toBe("oi, tudo bem?");
  });

  it("midia sem legenda mostra so o rotulo", () => {
    expect(previaMensagem("", "audio")).toBe("Áudio · não transcrito");
  });

  it("midia com legenda junta rotulo e legenda", () => {
    expect(previaMensagem("fachada nova", "image")).toBe("Imagem: fachada nova");
  });
});
```

- [x] **Passo 2: Ver falhar**

Run: `npx vitest run tests/unit/midia-mensagem.test.ts`
Esperado: FAIL — `Cannot find module '../../src/lib/midia-mensagem'`.

- [x] **Passo 3: Implementar** (`src/lib/midia-mensagem.ts`):

```ts
// Rotulo de mensagem de midia. A midia nao e baixada nem transcrita: a tela diz o
// tipo e, no audio, que ninguem transcreveu.

const ROTULOS: Record<string, string> = {
  audio: "Áudio · não transcrito",
  image: "Imagem",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato",
  other: "Mídia",
};

export function rotuloMidia(mediaType: string | null | undefined): string | null {
  if (!mediaType) return null;
  return ROTULOS[mediaType] ?? ROTULOS.other;
}

/** Texto curto da ultima mensagem na lista de conversas. */
export function previaMensagem(content: string, mediaType: string | null | undefined): string {
  const rotulo = rotuloMidia(mediaType);
  if (!rotulo) return content;
  return content ? `${rotulo}: ${content}` : rotulo;
}
```

- [x] **Passo 4: Ver passar**

Run: `npx vitest run tests/unit/midia-mensagem.test.ts`
Esperado: PASS, 6 testes.

- [x] **Passo 5: Hook e tela, com a skill `frontend-design`.**
  - `use-conversations.ts`: os dois `select` de `messages` ganham `media_type`;
    `ConversationMessage` ganha `mediaType: string | null` (mapeado de
    `row.media_type ?? null`); `lastContent` passa a ser
    `previaMensagem(row.content ?? "", row.media_type)`.
  - `Conversas.tsx`, no `Bubble`: com `mediaType`, uma linha com ícone do lucide
    (`Mic`, `Image`, `Video`, `FileText`, `Sticker`, `MapPin`, `Contact`, `Paperclip` para
    os demais) e o `rotuloMidia`, acima da legenda; o parágrafo de texto só aparece com
    conteúdo. O selo "pelo celular" do `business_app` continua. Cores pelos tokens que o
    `Bubble` já usa nos dois lados (enviada e recebida).
  - `vitest.config.ts`: `"src/lib/midia-mensagem.ts"` em `coverage.include`.

- [x] **Passo 6: Checar e commitar**

```bash
npx tsc --noEmit
npx prettier --check --end-of-line auto src/lib/midia-mensagem.ts tests/unit/midia-mensagem.test.ts src/hooks/use-conversations.ts src/pages/Conversas.tsx vitest.config.ts
npx eslint src/lib/midia-mensagem.ts src/hooks/use-conversations.ts src/pages/Conversas.tsx
npm run build:staging
git add src/lib/midia-mensagem.ts tests/unit/midia-mensagem.test.ts src/hooks/use-conversations.ts src/pages/Conversas.tsx vitest.config.ts
git commit -m "feat(conversas): midia aparece pelo tipo, e o audio avisa que nao foi transcrito"
```

---

### Task 7: E2E contra produção (vermelho antes do deploy)

**Files:**
- Modify: `tests/e2e/evolution-inbound-webhook.spec.ts`

**Interfaces:**
- Consumes: tenant `admin@eleveflow.test`, `INSTANCIA`, `TELEFONE`, `comSegredo`,
  `adminClient()`, `tenantId` do arquivo; `STAGING_INTERNAL_FUNCTION_SECRET`,
  `stagingServiceKey()`.

- [x] **Passo 1: Testes novos** no fim do arquivo. Helpers de payload locais:

```ts
function upsert(message: Record<string, unknown>, key: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: "messages.upsert",
    instance: INSTANCIA,
    data: {
      key: { remoteJid: `${TELEFONE}@s.whatsapp.net`, fromMe: false, id: `E2E-${Date.now()}`, ...key },
      message,
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  });
}

async function leadId(): Promise<string> {
  const { data } = await adminClient()
    .from("leads")
    .select("id")
    .eq("user_id", tenantId)
    .eq("phone", TELEFONE)
    .single();
  return data!.id;
}

test("mensagem mandada pelo aparelho vira saida business_app e pausa o lead por 24 h", async ({
  request,
}) => {
  const id = `E2E-ECO-${Date.now()}`;
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: upsert({ conversation: "respondi pelo celular" }, { fromMe: true, id }),
  });
  expect(res.status()).toBe(200);

  const admin = adminClient();
  const { data: msg } = await admin
    .from("messages")
    .select("direction, origin, media_type, content")
    .eq("whatsapp_id", id)
    .single();
  expect(msg).toEqual({
    direction: "outbound",
    origin: "business_app",
    media_type: null,
    content: "respondi pelo celular",
  });

  const { data: lead } = await admin
    .from("leads")
    .select("human_takeover_until")
    .eq("id", await leadId())
    .single();
  const horas = (new Date(lead!.human_takeover_until).getTime() - Date.now()) / 3_600_000;
  expect(horas).toBeGreaterThan(23);
  expect(horas).toBeLessThan(25);
  await admin.from("leads").update({ human_takeover_until: null }).eq("id", await leadId());
});

test("audio sem legenda e gravado com o tipo e nao aciona automacao", async ({ request }) => {
  const id = `E2E-AUDIO-${Date.now()}`;
  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: upsert({ audioMessage: { seconds: 7, ptt: true } }, { id }),
  });
  expect(res.status()).toBe(200);
  const corpo = await res.json();
  expect(corpo.results[0]).toMatchObject({ recorded_only: true, reason: "media_without_text" });

  const { data: msg } = await adminClient()
    .from("messages")
    .select("direction, media_type, content")
    .eq("whatsapp_id", id)
    .single();
  expect(msg).toEqual({ direction: "inbound", media_type: "audio", content: "" });
});

test("mensagem de grupo e ignorada sem deixar log", async ({ request }) => {
  const admin = adminClient();
  const antes = new Date().toISOString();

  const res = await request.post(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
    headers: comSegredo,
    data: upsert({ conversation: "oi grupo" }, { remoteJid: "120363000000000000@g.us" }),
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ignored: true, reason: "no_actionable_event" });

  const { count } = await admin
    .from("logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", tenantId)
    .eq("event", "webhook_lead_not_found")
    .gte("created_at", antes);
  expect(count).toBe(0);
});

test("item da fila de lead em pausa volta para depois da pausa", async ({ request }) => {
  const admin = adminClient();
  const lead = await leadId();
  const ate = new Date(Date.now() + 2 * 3_600_000).toISOString();
  // Consentimento liberado: sem ele o item cai no portao de marketing antes da
  // pausa, e o teste passaria a medir outra coisa.
  await admin
    .from("leads")
    .update({ human_takeover_until: ate, marketing_consent_status: "not_required" })
    .eq("id", lead);

  const { data: item } = await admin
    .from("send_queue")
    .insert({
      user_id: tenantId,
      lead_id: lead,
      content: "mensagem que nao pode sair na pausa",
      status: "pending",
      scheduled_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  try {
    const res = await request.post(`${SUPABASE_URL}/functions/v1/process-queue`, {
      headers: {
        apikey: stagingServiceKey(),
        "x-internal-function-secret": process.env.STAGING_INTERNAL_FUNCTION_SECRET!,
        "Content-Type": "application/json",
      },
      data: { queueItemId: item!.id, force: true },
    });
    expect(res.ok()).toBeTruthy();

    const { data: depois } = await admin
      .from("send_queue")
      .select("status, scheduled_at")
      .eq("id", item!.id)
      .single();
    expect(depois!.status).toBe("pending");
    expect(new Date(depois!.scheduled_at).getTime()).toBe(new Date(ate).getTime());

    const { count } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("queue_item_id", item!.id);
    expect(count).toBe(0);
  } finally {
    await admin.from("send_queue").delete().eq("id", item!.id);
    await admin.from("leads").update({ human_takeover_until: null }).eq("id", lead);
  }
});
```

Imports a acrescentar: `stagingServiceKey` de `./helpers/supabase-admin`. E no topo, junto
do `SECRET`: exigir `STAGING_INTERNAL_FUNCTION_SECRET` com o mesmo `throw` dos outros.

- [x] **Passo 2: Ver falhar pelo motivo certo**

```bash
set -a; source .env.staging; set +a
NODE_EXTRA_CA_CERTS="$(pwd)/.avast-ca.pem" E2E_BASE_URL=https://eleveflow-tan.vercel.app \
  npx playwright test tests/e2e/evolution-inbound-webhook.spec.ts
```

Esperado: os 5 antigos passam; os 4 novos FALHAM — eco não gravado (o parse de produção
descarta `fromMe`), `recorded_only` ausente, log de grupo presente e item da fila enviado
ou falho em vez de reagendado.

- [x] **Passo 3: Lint e commit**

```bash
npx prettier --check --end-of-line auto tests/e2e/evolution-inbound-webhook.spec.ts
npx eslint tests/e2e/evolution-inbound-webhook.spec.ts
git add tests/e2e/evolution-inbound-webhook.spec.ts
git commit -m "test(e2e): eco do aparelho, audio sem legenda, grupo ignorado e fila em pausa"
```

---

### Task 8: Recuperação do histórico

**Files:**
- Create: `scripts/lib/historico-evolution.ts`
- Test: `tests/unit/historico-evolution.test.ts`
- Create: `scripts/recuperar-historico-evolution.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `classifyEvolutionContent`, `mediaTypeColumn` (Task 2).
- Produces:
  - `chaveTelefone(digitos): string` — `55` + DDD + 8 dígitos finais para celular BR.
  - `telefoneDoRegistro(key): string` — sem dependências (vai para dentro do container).
  - `planejarImportacao(registros, leadPorChave, wamidsExistentes, userId): { inserir, contagem }`.

- [x] **Passo 1: Teste que falha** (`tests/unit/historico-evolution.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import {
  chaveTelefone,
  planejarImportacao,
  telefoneDoRegistro,
  type RegistroEvolution,
} from "../../scripts/lib/historico-evolution";

const CONTA = "conta-1";
const leadPorChave = new Map([[chaveTelefone("5527999998888"), "lead-1"]]);

const registro = (over: Partial<RegistroEvolution> = {}): RegistroEvolution => ({
  key: { id: "A1", fromMe: false, remoteJid: "5527999998888@s.whatsapp.net" },
  message: { conversation: "oi" },
  messageTimestamp: 1789000000,
  source: "android",
  ...over,
});

describe("chaveTelefone", () => {
  it("celular BR com e sem o nono digito da a mesma chave", () => {
    expect(chaveTelefone("5527999998888")).toBe(chaveTelefone("552799998888"));
  });

  it("numero que nao e celular BR fica como esta", () => {
    expect(chaveTelefone("14155550123")).toBe("14155550123");
  });
});

describe("telefoneDoRegistro", () => {
  it("jid de telefone vira digitos", () => {
    expect(telefoneDoRegistro({ remoteJid: "5527999998888@s.whatsapp.net" })).toBe("5527999998888");
  });

  it("@lid usa o remoteJidAlt; sem ele, vazio", () => {
    expect(
      telefoneDoRegistro({ remoteJid: "1@lid", remoteJidAlt: "5527999998888@s.whatsapp.net" }),
    ).toBe("5527999998888");
    expect(telefoneDoRegistro({ remoteJid: "1@lid" })).toBe("");
  });

  it("grupo e vazio", () => {
    expect(telefoneDoRegistro({ remoteJid: "120363000000000000@g.us" })).toBe("");
  });
});

describe("planejarImportacao", () => {
  const planejar = (registros: RegistroEvolution[], wamids: string[] = []) =>
    planejarImportacao(registros, leadPorChave, new Set(wamids), CONTA);

  it("recebida que falta entra com a data original", () => {
    const { inserir } = planejar([registro()]);
    expect(inserir).toEqual([
      {
        user_id: CONTA,
        lead_id: "lead-1",
        direction: "inbound",
        content: "oi",
        media_type: null,
        origin: null,
        status: "received",
        whatsapp_id: "A1",
        created_at: new Date(1789000000 * 1000).toISOString(),
      },
    ]);
  });

  it("audio recebido entra com o tipo e texto vazio", () => {
    const { inserir } = planejar([registro({ message: { audioMessage: { ptt: true } } })]);
    expect(inserir[0]).toMatchObject({ media_type: "audio", content: "" });
  });

  it("enviada pelo celular entra como business_app", () => {
    const { inserir } = planejar([
      registro({ key: { id: "B1", fromMe: true, remoteJid: "5527999998888@s.whatsapp.net" } }),
    ]);
    expect(inserir[0]).toMatchObject({ direction: "outbound", origin: "business_app", status: null });
  });

  it("enviada pela web que nao esta no CRM fica de fora como origem ambigua", () => {
    const { inserir, contagem } = planejar([
      registro({
        key: { id: "C1", fromMe: true, remoteJid: "5527999998888@s.whatsapp.net" },
        source: "web",
      }),
    ]);
    expect(inserir).toHaveLength(0);
    expect(contagem.origem_ambigua).toBe(1);
  });

  it("mensagem que o CRM ja tem e duplicada", () => {
    const { inserir, contagem } = planejar([registro()], ["A1"]);
    expect(inserir).toHaveLength(0);
    expect(contagem.duplicada).toBe(1);
  });

  it("o mesmo id duas vezes entra uma vez", () => {
    const { inserir, contagem } = planejar([registro(), registro()]);
    expect(inserir).toHaveLength(1);
    expect(contagem.duplicada).toBe(1);
  });

  it("conversa sem lead e protocolo ficam de fora", () => {
    const { inserir, contagem } = planejar([
      registro({ key: { id: "D1", fromMe: false, remoteJid: "5511000000000@s.whatsapp.net" } }),
      registro({ key: { id: "E1", fromMe: false, remoteJid: "5527999998888@s.whatsapp.net" }, message: { protocolMessage: {} } }),
    ]);
    expect(inserir).toHaveLength(0);
    expect(contagem).toMatchObject({ sem_lead: 1, tipo_ignorado: 1 });
  });
});
```

- [x] **Passo 2: Ver falhar**

Run: `npx vitest run tests/unit/historico-evolution.test.ts`
Esperado: FAIL — módulo não encontrado.

- [x] **Passo 3: Implementar** (`scripts/lib/historico-evolution.ts`):

```ts
// Logica pura da recuperacao do historico da Evolution. telefoneDoRegistro e
// chaveTelefone nao dependem de nada: o script os envia como texto para rodar
// dentro do container, onde filtram as conversas antes de sair do servidor.

import {
  classifyEvolutionContent,
  mediaTypeColumn,
} from "../../supabase/functions/_shared/whatsapp/evolution-parse.ts";

export interface ChaveEvolution {
  id?: string;
  fromMe?: boolean;
  remoteJid?: string;
  remoteJidAlt?: string;
}

export interface RegistroEvolution {
  key: ChaveEvolution;
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | string;
  source?: string;
}

export interface LinhaMensagem {
  user_id: string;
  lead_id: string;
  direction: "inbound" | "outbound";
  content: string;
  media_type: string | null;
  origin: string | null;
  status: string | null;
  whatsapp_id: string;
  created_at: string;
}

export function chaveTelefone(digitos: string | null | undefined): string {
  const d = String(digitos ?? "").replace(/\D/g, "");
  // Celular BR aparece com e sem o nono digito: compara DDD + 8 finais.
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    return "55" + d.slice(2, 4) + d.slice(-8);
  }
  return d;
}

export function telefoneDoRegistro(key: { remoteJid?: string; remoteJidAlt?: string }): string {
  const jid = String(key.remoteJid ?? "");
  if (/@(g\.us|newsletter|broadcast)$/i.test(jid)) return "";
  if (!/@lid$/i.test(jid)) return jid.split("@")[0].replace(/\D/g, "");
  const alt = String(key.remoteJidAlt ?? "");
  return !alt || /@lid$/i.test(alt) ? "" : alt.split("@")[0].replace(/\D/g, "");
}

export function planejarImportacao(
  registros: RegistroEvolution[],
  leadPorChave: Map<string, string>,
  wamidsExistentes: Set<string>,
  userId: string,
): { inserir: LinhaMensagem[]; contagem: Record<string, number> } {
  const contagem: Record<string, number> = {
    duplicada: 0,
    sem_lead: 0,
    tipo_ignorado: 0,
    origem_ambigua: 0,
    sem_id: 0,
  };
  const vistos = new Set(wamidsExistentes);
  const inserir: LinhaMensagem[] = [];

  for (const r of registros) {
    const id = r.key?.id;
    if (!id) {
      contagem.sem_id++;
      continue;
    }
    if (vistos.has(id)) {
      contagem.duplicada++;
      continue;
    }
    const leadId = leadPorChave.get(chaveTelefone(telefoneDoRegistro(r.key)));
    if (!leadId) {
      contagem.sem_lead++;
      continue;
    }
    const conteudo = classifyEvolutionContent(r.message as Record<string, any>);
    if (!conteudo) {
      contagem.tipo_ignorado++;
      continue;
    }
    const doAparelho = r.source === "android" || r.source === "ios";
    // Enviada pela web ou de origem desconhecida pode ser envio automatico antigo
    // ou WhatsApp Web: origem inventada e pior que ausente.
    if (r.key.fromMe && !doAparelho) {
      contagem.origem_ambigua++;
      continue;
    }

    vistos.add(id);
    inserir.push({
      user_id: userId,
      lead_id: leadId,
      direction: r.key.fromMe ? "outbound" : "inbound",
      content: conteudo.text,
      media_type: mediaTypeColumn(conteudo.type),
      origin: r.key.fromMe ? "business_app" : null,
      status: r.key.fromMe ? null : "received",
      whatsapp_id: id,
      created_at: new Date(Number(r.messageTimestamp ?? 0) * 1000).toISOString(),
    });
  }
  return { inserir, contagem };
}
```

- [x] **Passo 4: Ver passar**

Run: `npx vitest run tests/unit/historico-evolution.test.ts`
Esperado: PASS.

- [x] **Passo 5: Script** (`scripts/recuperar-historico-evolution.ts`):

```ts
// Recupera o historico da Evolution que casa com lead, uma vez.
//
//   set -a; source .env.staging; set +a
//   NODE_EXTRA_CA_CERTS=.avast-ca.pem node --experimental-strip-types \
//     scripts/recuperar-historico-evolution.ts --conta <user_id> [--aplicar]
//
// Sem --aplicar e ensaio: so contagens. Le a Evolution por SSH (Host hostinger),
// dentro do container, e so a instancia da conta. Nunca imprime texto nem telefone.

import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  chaveTelefone,
  planejarImportacao,
  telefoneDoRegistro,
  type RegistroEvolution,
} from "./lib/historico-evolution.ts";

const args = process.argv.slice(2);
const conta = args[args.indexOf("--conta") + 1];
const aplicar = args.includes("--aplicar");
if (!conta || !/^[0-9a-f-]{36}$/.test(conta)) throw new Error("--conta <user_id> obrigatorio");

const url = process.env.VITE_SUPABASE_URL;
const chave = process.env.STAGING_SUPABASE_SECRET_KEY;
if (!url || !chave) throw new Error("VITE_SUPABASE_URL e STAGING_SUPABASE_SECRET_KEY obrigatorios");

// Chave sb_secret nao e JWT: vai so no apikey, sem o Bearer sintetico.
const admin = createClient(url, chave, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("apikey", chave);
      if (headers.get("Authorization") === `Bearer ${chave}`) headers.delete("Authorization");
      return fetch(input, { ...init, headers });
    },
  },
});

async function todas<T>(consulta: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: any }>) {
  const linhas: T[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await consulta(de, de + 999);
    if (error) throw error;
    linhas.push(...(data ?? []));
    if (!data || data.length < 1000) return linhas;
  }
}

const { data: conexao, error: erroConexao } = await admin
  .from("whatsapp_connections")
  .select("instance_name, provider")
  .eq("tenant_id", conta)
  .single();
if (erroConexao) throw erroConexao;
// Convencao do sistema: instancia = user_id. Qualquer outra coisa (a Atual, por
// exemplo) nao e nossa.
if (conexao.provider !== "evolution" || conexao.instance_name !== conta) {
  throw new Error("instancia da conta fora da convencao instance_name = user_id");
}

const leads = await todas<{ id: string; phone: string; phone_normalized: string | null }>((de, ate) =>
  admin
    .from("leads")
    .select("id, phone, phone_normalized")
    .eq("user_id", conta)
    .not("is_test", "is", true)
    .range(de, ate),
);
const porChave = new Map<string, string>();
const ambiguas = new Set<string>();
for (const lead of leads) {
  const k = chaveTelefone(lead.phone_normalized || lead.phone);
  if (porChave.has(k)) ambiguas.add(k);
  porChave.set(k, lead.id);
}
for (const k of ambiguas) porChave.delete(k);

const programa = `
const telefoneDoRegistro = ${telefoneDoRegistro.toString()};
const chaveTelefone = ${chaveTelefone.toString()};
const chaves = new Set(${JSON.stringify([...porChave.keys()])});
(async () => {
  const inst = ${JSON.stringify(conta)};
  if (inst === "Atual") throw new Error("instancia proibida");
  const headers = { apikey: process.env.AUTHENTICATION_API_KEY, "Content-Type": "application/json" };
  for (const fromMe of [true, false]) {
    for (let page = 1; page <= 200; page++) {
      const r = await fetch("http://localhost:8080/chat/findMessages/" + inst, {
        method: "POST", headers,
        body: JSON.stringify({ where: { key: { fromMe } }, page, offset: 500 }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const p = (await r.json()).messages;
      for (const m of p.records ?? []) {
        if (!chaves.has(chaveTelefone(telefoneDoRegistro(m.key ?? {})))) continue;
        console.log(JSON.stringify({ key: m.key, message: m.message, messageTimestamp: m.messageTimestamp, source: m.source }));
      }
      if (!p.pages || page >= p.pages) break;
    }
  }
})().catch((e) => { console.error("erro: " + e.message); process.exit(1); });
`;

const container = spawnSync(
  "ssh",
  ["-o", "BatchMode=yes", "hostinger", "docker ps --filter name=evolutionapi_evolution-api --format '{{.Names}}' | head -1"],
  { encoding: "utf8" },
).stdout.trim();
if (!container) throw new Error("container da Evolution nao encontrado");

const extracao = spawnSync("ssh", ["-o", "BatchMode=yes", "hostinger", `docker exec -i ${container} node -`], {
  input: programa,
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
if (extracao.status !== 0) throw new Error(`extracao falhou: ${extracao.stderr.slice(0, 200)}`);
const registros: RegistroEvolution[] = extracao.stdout
  .split("\n")
  .filter(Boolean)
  .map((linha) => JSON.parse(linha));

const wamids = await todas<{ whatsapp_id: string }>((de, ate) =>
  admin
    .from("messages")
    .select("whatsapp_id")
    .eq("user_id", conta)
    .not("whatsapp_id", "is", null)
    .range(de, ate),
);
const plano = planejarImportacao(registros, porChave, new Set(wamids.map((w) => w.whatsapp_id)), conta);

const porTipo: Record<string, number> = {};
for (const linha of plano.inserir) {
  const k = `${linha.direction}${linha.origin ? "/" + linha.origin : ""}/${linha.media_type ?? "texto"}`;
  porTipo[k] = (porTipo[k] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      modo: aplicar ? "aplicar" : "ensaio",
      leads: leads.length,
      telefones_ambiguos: ambiguas.size,
      registros_de_leads: registros.length,
      a_inserir: plano.inserir.length,
      por_tipo: porTipo,
      fora: plano.contagem,
    },
    null,
    2,
  ),
);

if (aplicar) {
  let inseridas = 0;
  for (let i = 0; i < plano.inserir.length; i += 200) {
    const lote = plano.inserir.slice(i, i + 200);
    const { error } = await admin.from("messages").insert(lote);
    if (error) throw error;
    inseridas += lote.length;
  }
  console.log(`inseridas: ${inseridas}`);
}
```

- [x] **Passo 6: Cobertura, lint e commit**

`vitest.config.ts`: `"scripts/lib/historico-evolution.ts"` em `coverage.include`.

```bash
npx vitest run --coverage 2>&1 | grep -E "Test Files|Tests  |ERROR"
npx prettier --check --end-of-line auto scripts/lib/historico-evolution.ts scripts/recuperar-historico-evolution.ts tests/unit/historico-evolution.test.ts vitest.config.ts
npx eslint scripts/lib/historico-evolution.ts scripts/recuperar-historico-evolution.ts tests/unit/historico-evolution.test.ts
git add scripts/lib/historico-evolution.ts scripts/recuperar-historico-evolution.ts tests/unit/historico-evolution.test.ts vitest.config.ts
git commit -m "feat(scripts): recuperacao do historico da Evolution que casa com lead

Le o armazenamento da Evolution dentro do container, so da instancia da
conta, e so conversa que casa com lead sai do servidor. Deduplica por
whatsapp_id; envio web fora do CRM fica de fora por origem ambigua."
```

---

### Task 9: Implantação — gate do dono

**Nada aqui roda sem OK explícito.** Um pedido cobre migration, as duas funções e o
frontend; a recuperação tem OK próprio, depois do ensaio.

- [x] **Passo 1: Conferir o que sobe.** `bash scripts/sb-staging.sh db push --dry-run`
  (esperado: só `20260925135525_messages_media_type.sql`) e `git log` das funções.

- [x] **Passo 2: Pedir o OK** para migration, `whatsapp-webhook`, `process-queue` e
  frontend.

- [x] **Passo 3: Publicar**

```bash
bash scripts/sb-staging.sh db push
bash scripts/sb-staging.sh functions deploy whatsapp-webhook --use-api
bash scripts/sb-staging.sh functions deploy process-queue --use-api
set -a; source .env.staging; set +a
npm run build:staging
grep -rl "aoanpviozfabrrxjqayk" .vercel/output/ || echo "bundle sem o ref legado"
npx vercel deploy --prebuilt --prod
```

Depois do deploy, reapontar o alias `eleveflow-tan.vercel.app` para o deployment novo
(`--prod` não move alias manual) e conferir o destino do bundle publicado (receita no
`STATUS.md`, incidente de 2026-08-19).

- [x] **Passo 4: E2E verde**

```bash
set -a; source .env.staging; set +a
NODE_EXTRA_CA_CERTS="$(pwd)/.avast-ca.pem" E2E_BASE_URL=https://eleveflow-tan.vercel.app \
  npx playwright test tests/e2e/evolution-inbound-webhook.spec.ts tests/e2e/sales-coach.spec.ts
```

Esperado: 9 + 7 passed.

- [x] **Passo 5: Recuperação, ensaio**

```bash
set -a; source .env.staging; set +a
NODE_EXTRA_CA_CERTS=.avast-ca.pem node --experimental-strip-types \
  scripts/recuperar-historico-evolution.ts --conta 14448933-86df-47d4-a082-df69dbddeff1
```

Levar o relatório ao dono e pedir o OK para `--aplicar`. Depois de aplicar, rodar o ensaio
de novo: `a_inserir` tem de ser 0.

- [x] **Passo 6: Conferência em produção** (só leitura): `media_type` e `business_app`
  aparecendo com tráfego real; nenhum `webhook_lead_not_found` de grupo depois do
  deploy; `queue_item_deferred_takeover` quando houver pausa.

- [x] **Passo 7: STATUS.md e commit**

```bash
git add STATUS.md docs/plans/2026-09-25-captura-historico-whatsapp.md
git commit -m "docs: registra a captura do historico do WhatsApp em producao"
```

---

## Desvio registrado na execução (2026-09-25)

Na revisão antes do deploy apareceu um defeito da Task 5 como escrita: o envio manual
da tela de Conversas também passa pela fila (`useSendMessage` insere em `send_queue` e
chama o `process-queue`). Adiar todo item de lead em pausa seguraria por 24 h a resposta
do próprio vendedor.

Correção (commit `ef20139`): `queueDeferralUntil(item, lead)` em
`_shared/whatsapp/human-takeover.ts` decide o adiamento e só adia item com `flow_id`
(fluxo, sequência e IA sempre gravam; o envio manual nunca). Testes: 4 unitários do
predicado; o E2E da fila virou dois — automação adiada e mensagem manual não adiada.
