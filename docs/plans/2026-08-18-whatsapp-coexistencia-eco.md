# Plano de implementação — coexistência WhatsApp: conexão correta e eco do Business App

> **Para executores agênticos:** SUB-SKILL OBRIGATÓRIA — usar
> `superpowers:subagent-driven-development` (recomendado) ou
> `superpowers:executing-plans` para executar tarefa a tarefa. Os passos usam
> checkbox (`- [ ]`) para rastreio.

**Spec:** `docs/specs/2026-08-18-whatsapp-coexistencia-eco-design.md`

**Objetivo:** capturar as mensagens que o dono envia pelo WhatsApp Business App do
celular, calar IA e fluxos enquanto o atendimento humano estiver em curso, e gravar
corretamente qual número foi conectado e se a conexão é de coexistência.

**Arquitetura:** o webhook da Meta passa a reconhecer o campo `smb_message_echoes`
além de `messages`. Um handler curto grava o eco como mensagem `outbound` marcada e
carimba um prazo de pausa no lead. Os dois pontos de envio automático do sistema
(`execute-flow` e `ai-agent-reply`) checam esse prazo antes de falar. Duas funções
enterradas no orquestrador de 811 linhas (resolver lead, deduplicar por wamid) saem
para módulos próprios porque o handler do eco precisa das duas.

**Stack:** Deno (edge functions), TypeScript, Vitest (unit), Postgres/Supabase,
React 19 + TanStack Start + Tailwind 4 (front).

## Constraints globais

Valem para **todas** as tarefas:

- **Dinheiro em centavos, custo de API em `cost_usd_micros`** (bigint). Nunca float.
- **Regra de negócio no servidor.** O front nunca decide o que pode ser enviado.
- **Comando de teste:** `npm run test` (vitest run). Um arquivo só:
  `npx vitest run tests/unit/<arquivo>.test.ts`.
- **Lint/typecheck:** `npm run lint` e `npm run typecheck`.
- **Migrations são aditivas.** O banco `xlycuunqpgpyfmafgajr` é **produção viva**.
- **Todo comando `supabase` passa pelo wrapper** `bash scripts/sb-staging.sh`
  (o `.env` da raiz aponta para um projeto legado; TLS interceptado pelo Avast).
  Consulta read-only: `bash scripts/sb-staging.sh db query --linked "SQL"`.
- **Módulos `_shared` rodam em Deno e em Node/Vitest.** Recebem dependências por
  parâmetro (client, fetch, env). Nada de `Deno.env` dentro de `_shared`.
- **Imports entre módulos `_shared` usam extensão `.ts`**; os testes importam sem
  extensão (padrão já existente no repo).
- **Commits:** Conventional Commits, em português, atômicos. **Sem qualquer menção a
  IA ou ferramenta de IA** em mensagem de commit, código ou doc.
- **Não commitar mudanças alheias.** O working tree tem `deno.lock`, `package.json` e
  `package-lock.json` modificados por outro trabalho: `git add` sempre por caminho
  explícito, nunca `git add -A`.
- **Nada é declarado pronto sem saída de comando colada.**

## Estrutura de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `supabase/migrations/20260818_coexistencia_eco.sql` (criar) | colunas `messages.origin`, `leads.human_takeover_until`, índices | 1 |
| `supabase/functions/_shared/whatsapp/lead-resolver.ts` (criar) | achar lead por telefone, com variantes | 2 |
| `supabase/functions/_shared/whatsapp/message-dedupe.ts` (criar) | saber se um wamid já foi gravado | 2 |
| `supabase/functions/_shared/whatsapp/inbound-orchestrator.ts` (modificar) | passa a consumir os dois módulos acima | 2 |
| `supabase/functions/_shared/whatsapp/human-takeover.ts` (criar) | ler/gravar/limpar o prazo de pausa | 3 |
| `supabase/functions/_shared/whatsapp/types.ts` (modificar) | `EchoMessage`, `echoes` no resultado do parse | 4 |
| `supabase/functions/_shared/whatsapp/meta-provider.ts` (modificar) | rotear `field` e parsear o eco | 4 |
| `supabase/functions/_shared/whatsapp/echo-handler.ts` (criar) | gravar o eco e iniciar a pausa | 5 |
| `supabase/functions/meta-whatsapp-webhook/index.ts` (modificar) | fiação do eco | 5 |
| `supabase/functions/ai-agent-reply/index.ts` (modificar) | gate da pausa | 6 |
| `supabase/functions/execute-flow/index.ts` (modificar) | gate da pausa, com reagendamento | 7 |
| `supabase/functions/_shared/whatsapp/meta-diagnostics.ts` (modificar) | ler sinal de coexistência da Graph | 8 |
| `supabase/functions/_shared/whatsapp/signup-onboarding.ts` (modificar) | escolher o número certo, gravar a flag | 8 |
| `supabase/functions/meta-whatsapp-admin/index.ts` (modificar) | repassar a dica de coexistência | 8 |
| `src/components/whatsapp/MetaEmbeddedSignupButton.tsx` (modificar) | enviar a dica de coexistência | 8 |
| `src/hooks/use-conversations.ts` (modificar) | trazer `origin` e o prazo de pausa | 9 |
| `src/pages/Conversas.tsx` (modificar) | marca "pelo celular", faixa de pausa, botão | 9 |
| `STATUS.md` (modificar) | estado ao fim do bloco | 10 |

---

### Task 1: Migration — colunas de origem e de pausa

**Files:**
- Create: `supabase/migrations/20260818_coexistencia_eco.sql`

**Interfaces:**
- Consumes: nada.
- Produces: coluna `public.messages.origin text` (`'crm' | 'business_app' | null`);
  coluna `public.leads.human_takeover_until timestamptz`; índice único parcial
  `messages_user_wamid_uidx (user_id, whatsapp_id) where whatsapp_id is not null`;
  índice `leads_human_takeover_idx`.

- [ ] **Step 1: Conferir que a premissa do índice único continua verdadeira**

O índice único só é seguro se não houver duplicata hoje. Rodar antes de escrever:

```bash
bash scripts/sb-staging.sh db query --linked "select count(*) filter (where whatsapp_id is not null) as com_wamid, count(*) filter (where whatsapp_id is not null) - count(distinct (user_id, whatsapp_id)) filter (where whatsapp_id is not null) as duplicatas from public.messages;"
```

Esperado: `duplicatas` igual a `0`. **Se vier maior que zero, parar e reportar** — o
índice único falharia na aplicação e a decisão de deduplicar dado histórico é do dono.

- [ ] **Step 2: Escrever a migration**

```sql
-- Coexistência: origem da mensagem e pausa por atendimento humano.
--
-- `origin` nulo = legado ou envio do CRM. Só o eco do WhatsApp Business App
-- grava 'business_app'. Sem backfill: dado histórico é congelado no momento do
-- fato e nulo já carrega a informação necessária.

alter table public.messages
  add column if not exists origin text;

alter table public.messages
  drop constraint if exists messages_origin_check;

alter table public.messages
  add constraint messages_origin_check
  check (origin is null or origin in ('crm', 'business_app'));

alter table public.leads
  add column if not exists human_takeover_until timestamptz;

create index if not exists leads_human_takeover_idx
  on public.leads (human_takeover_until)
  where human_takeover_until is not null;

-- Cinto sobre suspensório. O dedupe por wamid existe em código, mas é SELECT
-- seguido de INSERT: duas entregas simultâneas do mesmo eco passam pelas duas.
create unique index if not exists messages_user_wamid_uidx
  on public.messages (user_id, whatsapp_id)
  where whatsapp_id is not null;
```

- [ ] **Step 3: Aplicar em produção**

```bash
bash scripts/sb-staging.sh db push --linked
```

Esperado: a migration `20260818_coexistencia_eco` listada como aplicada, sem erro.

- [ ] **Step 4: Conferir as quatro alterações no banco**

```bash
bash scripts/sb-staging.sh db query --linked "select (select count(*) from information_schema.columns where table_name='messages' and column_name='origin') as col_origin, (select count(*) from information_schema.columns where table_name='leads' and column_name='human_takeover_until') as col_takeover, (select count(*) from pg_indexes where indexname='messages_user_wamid_uidx') as idx_wamid, (select count(*) from pg_indexes where indexname='leads_human_takeover_idx') as idx_takeover;"
```

Esperado: os quatro valores iguais a `1`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260818_coexistencia_eco.sql
git commit -m "feat(whatsapp): colunas de origem da mensagem e de pausa por atendimento humano"
```

---

### Task 2: Extrair `lead-resolver` e `message-dedupe` do orquestrador

Refactor puro: nenhum comportamento muda. O handler do eco (Task 5) precisa das duas
funções, e hoje elas vivem dentro de `handleInboundMessage`.

**Files:**
- Create: `supabase/functions/_shared/whatsapp/lead-resolver.ts`
- Create: `supabase/functions/_shared/whatsapp/message-dedupe.ts`
- Modify: `supabase/functions/_shared/whatsapp/inbound-orchestrator.ts:96-165`
- Test: `tests/unit/lead-resolver.test.ts`, `tests/unit/message-dedupe.test.ts`

**Interfaces:**
- Consumes: `phoneVariants` de `./crm-parse.ts` (já existe).
- Produces:
  - `resolveLead(client, tenantId, phone): Promise<LeadResolution>` onde
    `type LeadResolution = { kind: "found"; lead: any; normalized: string } | { kind: "none"; normalized: string } | { kind: "ambiguous"; leads: Array<{ id: string }>; normalized: string }`
  - `isAlreadyRegistered(client, tenantId, wamid, direction): Promise<boolean>`
    com `direction: "inbound" | "outbound"`.

- [ ] **Step 1: Escrever os testes que falham**

`tests/unit/lead-resolver.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveLead } from "../../supabase/functions/_shared/whatsapp/lead-resolver";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

describe("resolveLead", () => {
  it("acha o lead pelo telefone normalizado", async () => {
    const client = createFakeClient({
      leads: [{ id: "lead-1", user_id: TENANT, phone_normalized: "5534953285885" }],
    });

    const result = await resolveLead(client as any, TENANT, "+55 34 95328-5885");

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.lead.id).toBe("lead-1");
  });

  it("acha o lead gravado sem o nono digito", async () => {
    const client = createFakeClient({
      leads: [{ id: "lead-2", user_id: TENANT, phone_normalized: "553453285885" }],
    });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.lead.id).toBe("lead-2");
  });

  it("devolve none quando nenhum lead casa", async () => {
    const client = createFakeClient({ leads: [] });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("none");
    expect(result.normalized).toBe("5534953285885");
  });

  it("devolve ambiguous quando mais de um lead casa", async () => {
    const client = createFakeClient({
      leads: [
        { id: "lead-a", user_id: TENANT, phone_normalized: "5534953285885" },
        { id: "lead-b", user_id: TENANT, phone_normalized: "553453285885" },
      ],
    });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.leads).toHaveLength(2);
  });

  it("ignora lead de outro tenant", async () => {
    const client = createFakeClient({
      leads: [{ id: "lead-x", user_id: "outro-tenant", phone_normalized: "5534953285885" }],
    });

    const result = await resolveLead(client as any, TENANT, "5534953285885");

    expect(result.kind).toBe("none");
  });
});
```

`tests/unit/message-dedupe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAlreadyRegistered } from "../../supabase/functions/_shared/whatsapp/message-dedupe";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

describe("isAlreadyRegistered", () => {
  it("reconhece wamid ja gravado na mesma direcao", async () => {
    const client = createFakeClient({
      messages: [
        { id: "m1", user_id: TENANT, whatsapp_id: "wamid.AAA", direction: "inbound" },
      ],
    });

    expect(await isAlreadyRegistered(client as any, TENANT, "wamid.AAA", "inbound")).toBe(true);
  });

  it("nao confunde direcoes diferentes", async () => {
    const client = createFakeClient({
      messages: [
        { id: "m1", user_id: TENANT, whatsapp_id: "wamid.AAA", direction: "inbound" },
      ],
    });

    expect(await isAlreadyRegistered(client as any, TENANT, "wamid.AAA", "outbound")).toBe(false);
  });

  it("nao vaza entre tenants", async () => {
    const client = createFakeClient({
      messages: [
        { id: "m1", user_id: "outro", whatsapp_id: "wamid.AAA", direction: "inbound" },
      ],
    });

    expect(await isAlreadyRegistered(client as any, TENANT, "wamid.AAA", "inbound")).toBe(false);
  });

  it("devolve false para wamid vazio", async () => {
    const client = createFakeClient({ messages: [] });

    expect(await isAlreadyRegistered(client as any, TENANT, "", "inbound")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/lead-resolver.test.ts tests/unit/message-dedupe.test.ts
```

Esperado: FAIL — `Failed to resolve import ".../lead-resolver"` e o equivalente para
`message-dedupe`.

- [ ] **Step 3: Escrever `lead-resolver.ts`**

```ts
// Resolução de lead por telefone, compartilhada pelo inbound e pelo eco do
// WhatsApp Business App. Saiu de dentro do inbound-orchestrator sem mudança de
// regra: mesmas variantes de nono dígito, mesmo corte em 3.

import { phoneVariants } from "./crm-parse.ts";

export type LeadResolution =
  | { kind: "found"; lead: any; normalized: string }
  | { kind: "none"; normalized: string }
  | { kind: "ambiguous"; leads: Array<{ id: string }>; normalized: string };

export async function resolveLead(
  client: { from: (table: string) => any },
  tenantId: string,
  phone: string,
): Promise<LeadResolution> {
  const variants = phoneVariants(phone);
  const normalized = variants[0];

  const { data, error } = await client
    .from("leads")
    .select("*")
    .eq("user_id", tenantId)
    .in("phone_normalized", variants)
    .limit(3);

  if (error) throw error;

  const leads = data || [];
  if (leads.length === 0) return { kind: "none", normalized };
  if (leads.length > 1) return { kind: "ambiguous", leads, normalized };
  return { kind: "found", lead: leads[0], normalized };
}
```

- [ ] **Step 4: Escrever `message-dedupe.ts`**

```ts
// Dedupe por wamid. A Meta reentrega webhook: sem isto, a mesma mensagem vira
// duas linhas e, no caso do eco, renovaria a pausa indevidamente.

export async function isAlreadyRegistered(
  client: { from: (table: string) => any },
  tenantId: string,
  providerMessageId: string | null | undefined,
  direction: "inbound" | "outbound",
): Promise<boolean> {
  if (!providerMessageId) return false;

  const { data } = await client
    .from("messages")
    .select("id")
    .eq("whatsapp_id", providerMessageId)
    .eq("direction", direction)
    .eq("user_id", tenantId)
    .limit(1)
    .maybeSingle();

  return Boolean(data);
}
```

- [ ] **Step 5: Rodar e ver passar**

```bash
npx vitest run tests/unit/lead-resolver.test.ts tests/unit/message-dedupe.test.ts
```

Esperado: PASS, 9 testes.

- [ ] **Step 6: Trocar o corpo do orquestrador pelos módulos**

Em `supabase/functions/_shared/whatsapp/inbound-orchestrator.ts`, adicionar aos imports:

```ts
import { resolveLead } from "./lead-resolver.ts";
import { isAlreadyRegistered } from "./message-dedupe.ts";
```

Substituir o bloco de dedupe (o `if (input.providerMessageId) { ... }` que hoje começa
na linha 96) por:

```ts
  if (await isAlreadyRegistered(deps.client, input.tenantId, input.providerMessageId, "inbound")) {
    console.log(
      "Mensagem duplicada ignorada (whatsapp_id já registrado):",
      input.providerMessageId,
    );
    return {
      status: 200,
      body: {
        success: true,
        ignored: true,
        reason: "duplicate",
        whatsapp_id: input.providerMessageId,
      },
    };
  }
```

Substituir o bloco de busca de lead (de `const variants = phoneVariants(...)` até a
linha `const lead = leads[0];`) por:

```ts
  setStep("find_lead");
  const resolution = await resolveLead(deps.client, input.tenantId, input.fromPhone);
  const normalized = resolution.normalized;
  console.log("Numero normalizado:", normalized);

  if (resolution.kind === "none") {
    const reason = `Lead não encontrado para número ${normalized}`;
    console.log(reason);
    await safeLog(deps.client, {
      user_id: input.tenantId,
      event: "webhook_lead_not_found",
      details: { phone: normalized },
    });
    return { status: 200, body: { success: true, ignored: true, reason } };
  }

  if (resolution.kind === "ambiguous") {
    if (isMarketingOptOutMessage(input.text)) {
      setStep("record_opt_out_ambiguous_contact");
      await recordMarketingOptOut(
        deps.client,
        input.tenantId,
        resolution.leads,
        input.providerMessageId,
      );
      return { status: 200, body: { success: true, opted_out: true, ambiguous: true } };
    }
    await safeLog(deps.client, {
      user_id: input.tenantId,
      event: "webhook_ambiguous_lead_phone",
      details: { phone: normalized, matching_leads: resolution.leads.length },
    });
    return { status: 200, body: { success: true, ignored: true, reason: "ambiguous_lead_phone" } };
  }

  const lead = resolution.lead;
  console.log("Lead encontrado:", lead.id);
```

Se `phoneVariants` deixar de ser referenciado no arquivo, remover o símbolo do import
de `./crm-parse.ts` — `isMarketingOptOutMessage` continua sendo usado.

- [ ] **Step 7: Provar que o inbound não mudou de comportamento**

```bash
npx vitest run tests/unit/inbound-orchestrator.test.ts
```

Esperado: PASS, sem nenhuma alteração no arquivo de teste. Esta é a prova de
equivalência do refactor — **se um teste precisar ser editado para passar, o refactor
mudou comportamento e está errado.**

- [ ] **Step 8: Suíte inteira e lint**

```bash
npm run test && npm run lint && npm run typecheck
```

Esperado: tudo verde.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/whatsapp/lead-resolver.ts supabase/functions/_shared/whatsapp/message-dedupe.ts supabase/functions/_shared/whatsapp/inbound-orchestrator.ts tests/unit/lead-resolver.test.ts tests/unit/message-dedupe.test.ts
git commit -m "refactor(whatsapp): extrai resolucao de lead e dedupe do orquestrador"
```

---

### Task 3: Módulo de pausa por atendimento humano

**Files:**
- Create: `supabase/functions/_shared/whatsapp/human-takeover.ts`
- Test: `tests/unit/human-takeover.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `isUnderHumanTakeover(lead: { human_takeover_until?: string | null } | null, now?: Date): boolean`
  - `humanTakeoverUntil(lead): string | null`
  - `startHumanTakeover(client, tenantId, leadId, hours: number, now?: Date): Promise<string>` — devolve o instante ISO gravado
  - `endHumanTakeover(client, tenantId, leadId): Promise<void>`
  - `DEFAULT_TAKEOVER_HOURS = 24`

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/human-takeover.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_TAKEOVER_HOURS,
  endHumanTakeover,
  humanTakeoverUntil,
  isUnderHumanTakeover,
  startHumanTakeover,
} from "../../supabase/functions/_shared/whatsapp/human-takeover";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";
const NOW = new Date("2026-08-18T12:00:00.000Z");

describe("isUnderHumanTakeover", () => {
  it("é verdadeiro enquanto o prazo não venceu", () => {
    const lead = { human_takeover_until: "2026-08-18T18:00:00.000Z" };
    expect(isUnderHumanTakeover(lead, NOW)).toBe(true);
  });

  it("é falso depois do prazo", () => {
    const lead = { human_takeover_until: "2026-08-18T06:00:00.000Z" };
    expect(isUnderHumanTakeover(lead, NOW)).toBe(false);
  });

  it("é falso no instante exato do vencimento", () => {
    const lead = { human_takeover_until: "2026-08-18T12:00:00.000Z" };
    expect(isUnderHumanTakeover(lead, NOW)).toBe(false);
  });

  it("é falso quando não há prazo", () => {
    expect(isUnderHumanTakeover({ human_takeover_until: null }, NOW)).toBe(false);
    expect(isUnderHumanTakeover({}, NOW)).toBe(false);
    expect(isUnderHumanTakeover(null, NOW)).toBe(false);
  });

  it("é falso quando o valor gravado não é data", () => {
    expect(isUnderHumanTakeover({ human_takeover_until: "amanhã" }, NOW)).toBe(false);
  });
});

describe("humanTakeoverUntil", () => {
  it("devolve o prazo quando ativo e null quando não", () => {
    expect(humanTakeoverUntil({ human_takeover_until: "2026-08-18T18:00:00.000Z" }, NOW)).toBe(
      "2026-08-18T18:00:00.000Z",
    );
    expect(humanTakeoverUntil({ human_takeover_until: "2026-08-18T06:00:00.000Z" }, NOW)).toBe(
      null,
    );
  });
});

describe("startHumanTakeover", () => {
  it("grava agora mais as horas pedidas", async () => {
    const db: any = { leads: [{ id: "lead-1", user_id: TENANT, human_takeover_until: null }] };
    const client = createFakeClient(db);

    const until = await startHumanTakeover(client as any, TENANT, "lead-1", 24, NOW);

    expect(until).toBe("2026-08-19T12:00:00.000Z");
    expect(db.leads[0].human_takeover_until).toBe("2026-08-19T12:00:00.000Z");
  });

  it("usa 24 horas como padrão do sistema", () => {
    expect(DEFAULT_TAKEOVER_HOURS).toBe(24);
  });
});

describe("endHumanTakeover", () => {
  it("limpa o prazo", async () => {
    const db: any = {
      leads: [{ id: "lead-1", user_id: TENANT, human_takeover_until: "2026-08-19T12:00:00.000Z" }],
    };
    const client = createFakeClient(db);

    await endHumanTakeover(client as any, TENANT, "lead-1");

    expect(db.leads[0].human_takeover_until).toBe(null);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/human-takeover.test.ts
```

Esperado: FAIL — `Failed to resolve import ".../human-takeover"`.

- [ ] **Step 3: Implementar**

```ts
// Pausa por atendimento humano. Quando o dono responde pelo WhatsApp Business
// App do celular, IA e fluxos daquele lead ficam calados por um prazo — senão o
// cliente recebe duas respostas para a mesma pergunta.
//
// O núcleo é puro de propósito: os gates de envio precisam decidir sem tocar o
// banco, e a decisão precisa de teste sem client.

export const DEFAULT_TAKEOVER_HOURS = 24;

interface LeadLike {
  human_takeover_until?: string | null;
}

export function humanTakeoverUntil(lead: LeadLike | null | undefined, now = new Date()): string | null {
  const raw = lead?.human_takeover_until;
  if (!raw) return null;

  const until = new Date(raw);
  if (Number.isNaN(until.getTime())) return null;

  return until.getTime() > now.getTime() ? until.toISOString() : null;
}

export function isUnderHumanTakeover(lead: LeadLike | null | undefined, now = new Date()): boolean {
  return humanTakeoverUntil(lead, now) !== null;
}

export async function startHumanTakeover(
  client: { from: (table: string) => any },
  tenantId: string,
  leadId: string,
  hours: number,
  now = new Date(),
): Promise<string> {
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

  const { error } = await client
    .from("leads")
    .update({ human_takeover_until: until })
    .eq("id", leadId)
    .eq("user_id", tenantId);

  if (error) throw error;
  return until;
}

export async function endHumanTakeover(
  client: { from: (table: string) => any },
  tenantId: string,
  leadId: string,
): Promise<void> {
  const { error } = await client
    .from("leads")
    .update({ human_takeover_until: null })
    .eq("id", leadId)
    .eq("user_id", tenantId);

  if (error) throw error;
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
npx vitest run tests/unit/human-takeover.test.ts
```

Esperado: PASS, 10 testes.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp/human-takeover.ts tests/unit/human-takeover.test.ts
git commit -m "feat(whatsapp): pausa de automacoes por atendimento humano"
```

---

### Task 4: Parser do eco no provider da Meta

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/types.ts:75-90`
- Modify: `supabase/functions/_shared/whatsapp/meta-provider.ts:272-345`
- Test: `tests/unit/meta-provider-webhook.test.ts` (arquivo já existe; adicionar casos)

**Interfaces:**
- Consumes: `InboundMessageType` de `./types.ts`.
- Produces:
  - `interface EchoMessage { providerMessageId: string; toPhone: string; phoneNumberId?: string; type: InboundMessageType; text?: string; timestamp: string }`
  - `WebhookParseResult` ganha `echoes: EchoMessage[]`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao fim de `tests/unit/meta-provider-webhook.test.ts` (mantendo os imports do
arquivo; se `createMetaProvider` já estiver importado, não duplicar):

```ts
describe("parseWebhook — eco do WhatsApp Business App", () => {
  const parser = () =>
    createMetaProvider({
      graphApiVersion: "v25.0",
      phoneNumberId: "",
      accessToken: "",
      appSecret: "segredo",
    });

  const echoPayload = (echo: Record<string, unknown>) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "2203121110258246",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+55 34 95328-5885",
                  phone_number_id: "1267133593145045",
                },
                message_echoes: [echo],
              },
            },
          ],
        },
      ],
    });

  it("le o eco e usa o destinatario como telefone do lead", () => {
    const result = parser().parseWebhook(
      echoPayload({
        from: "5534953285885",
        to: "5511987654321",
        id: "wamid.ECHO1",
        timestamp: "1755518400",
        type: "text",
        text: { body: "Bom dia! Vou te passar o preço" },
      }),
    );

    expect(result.echoes).toHaveLength(1);
    expect(result.echoes[0].providerMessageId).toBe("wamid.ECHO1");
    expect(result.echoes[0].toPhone).toBe("5511987654321");
    expect(result.echoes[0].text).toBe("Bom dia! Vou te passar o preço");
    expect(result.echoes[0].type).toBe("text");
    expect(result.phoneNumberId).toBe("1267133593145045");
  });

  it("nunca deixa o eco vazar para inbound", () => {
    const result = parser().parseWebhook(
      echoPayload({
        from: "5534953285885",
        to: "5511987654321",
        id: "wamid.ECHO2",
        timestamp: "1755518400",
        type: "text",
        text: { body: "oi" },
      }),
    );

    expect(result.inbound).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
  });

  it("marca tipo desconhecido como unsupported", () => {
    const result = parser().parseWebhook(
      echoPayload({
        from: "5534953285885",
        to: "5511987654321",
        id: "wamid.ECHO3",
        timestamp: "1755518400",
        type: "sticker",
      }),
    );

    expect(result.echoes[0].type).toBe("unsupported");
    expect(result.echoes[0].text).toBeUndefined();
  });

  it("descarta eco sem destinatario", () => {
    const result = parser().parseWebhook(
      echoPayload({ from: "5534953285885", id: "wamid.ECHO4", timestamp: "1755518400", type: "text" }),
    );

    expect(result.echoes).toHaveLength(0);
  });

  it("continua descartando campos alheios", () => {
    const result = parser().parseWebhook(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "2203121110258246",
            changes: [{ field: "history", value: { history: [] } }],
          },
        ],
      }),
    );

    expect(result.echoes).toHaveLength(0);
    expect(result.inbound).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
  });

  it("devolve echoes vazio para payload comum de mensagem", () => {
    const result = parser().parseWebhook(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "2203121110258246",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "1267133593145045" },
                  messages: [
                    {
                      from: "5511987654321",
                      id: "wamid.IN1",
                      timestamp: "1755518400",
                      type: "text",
                      text: { body: "oi" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(result.echoes).toEqual([]);
    expect(result.inbound).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/meta-provider-webhook.test.ts
```

Esperado: FAIL nos casos novos, com `expected undefined to have length 1` (a
propriedade `echoes` ainda não existe). Os casos antigos continuam passando.

- [ ] **Step 3: Estender os tipos**

Em `supabase/functions/_shared/whatsapp/types.ts`, adicionar antes de
`WebhookParseResult`:

```ts
/** Mensagem que o dono enviou pelo WhatsApp Business App do celular. Chega no
 *  campo `smb_message_echoes` e só existe em conexão de coexistência.
 *  Atenção: aqui o lead é o `to`; o `from` é o número do próprio negócio. */
export interface EchoMessage {
  providerMessageId: string;
  toPhone: string;
  phoneNumberId?: string;
  type: InboundMessageType;
  text?: string;
  timestamp: string;
}
```

E acrescentar o campo em `WebhookParseResult`:

```ts
export interface WebhookParseResult {
  inbound: InboundMessage[];
  statuses: StatusUpdate[];
  /** Ecos do WhatsApp Business App. Vazio fora de coexistência. */
  echoes: EchoMessage[];
  /** Número que recebeu o evento. Único caminho para achar o tenant quando o
   *  payload traz apenas statuses. */
  phoneNumberId?: string;
}
```

- [ ] **Step 4: Rotear por campo no parser**

Em `supabase/functions/_shared/whatsapp/meta-provider.ts`, incluir `EchoMessage` no
import de tipos vindo de `./types.ts`. Dentro de `parseWebhook`, declarar o acumulador
junto dos outros:

```ts
      const echoes: EchoMessage[] = [];
```

Trocar a linha de descarte `if (change?.field !== "messages") continue;` por:

```ts
          const field = String(change?.field ?? "");
          if (field !== "messages" && field !== "smb_message_echoes") continue;

          const value = change?.value ?? {};
          const phoneNumberId = value?.metadata?.phone_number_id;
          if (phoneNumberId && !phoneNumberIdSeen) phoneNumberIdSeen = String(phoneNumberId);

          if (field === "smb_message_echoes") {
            for (const echo of value?.message_echoes ?? []) {
              const toPhone = String(echo?.to ?? "").replace(/\D/g, "");
              // Sem destinatário não há lead a associar: o eco é inútil e não
              // pode virar mensagem órfã.
              if (!toPhone) continue;

              const rawType = String(echo?.type ?? "");
              const type = (KNOWN_TYPES as string[]).includes(rawType)
                ? (rawType as InboundMessageType)
                : "unsupported";

              echoes.push({
                providerMessageId: String(echo?.id ?? ""),
                toPhone,
                phoneNumberId: phoneNumberId ? String(phoneNumberId) : undefined,
                type,
                text: type === "text" ? String(echo?.text?.body ?? "") : undefined,
                timestamp: toIsoTimestamp(echo?.timestamp),
              });
            }
            continue;
          }
```

A declaração `const value = change?.value ?? {};` e as duas linhas de
`phoneNumberId` que existiam logo abaixo do `continue` antigo passam a ser as do bloco
acima — **remover as duplicatas** para não redeclarar `value` no mesmo escopo.

Trocar o `return` final por:

```ts
      return { inbound, statuses, echoes, phoneNumberId: phoneNumberIdSeen };
```

- [ ] **Step 5: Rodar e ver passar**

```bash
npx vitest run tests/unit/meta-provider-webhook.test.ts tests/unit/whatsapp-types.test.ts
```

Esperado: PASS, incluindo os 6 casos novos.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/whatsapp/types.ts supabase/functions/_shared/whatsapp/meta-provider.ts tests/unit/meta-provider-webhook.test.ts
git commit -m "feat(whatsapp): parser reconhece o eco do Business App"
```

---

### Task 5: Handler do eco e fiação no webhook

**Files:**
- Create: `supabase/functions/_shared/whatsapp/echo-handler.ts`
- Modify: `supabase/functions/meta-whatsapp-webhook/index.ts:100-160`
- Test: `tests/unit/echo-handler.test.ts`

**Interfaces:**
- Consumes: `resolveLead` (Task 2), `isAlreadyRegistered` (Task 2),
  `startHumanTakeover` e `DEFAULT_TAKEOVER_HOURS` (Task 3), `EchoMessage` (Task 4),
  `safeLog` de `./inbound-orchestrator.ts`, `getGlobalSetting` de `../ai.ts`.
- Produces: `handleEcho(deps: EchoDeps, input: EchoInput): Promise<EchoResult>` com
  `EchoDeps = { client; onStep?: (step: string) => void }`,
  `EchoInput = { tenantId: string; providerMessageId: string | null; toPhone: string; text: string; timestamp: string }`,
  `EchoResult = { status: number; body: Record<string, unknown> }`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/echo-handler.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { handleEcho } from "../../supabase/functions/_shared/whatsapp/echo-handler";
import { createFakeClient } from "./helpers/fake-supabase";

const TENANT = "tenant-1";

const input = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  providerMessageId: "wamid.ECHO1",
  toPhone: "5511987654321",
  text: "Bom dia! Vou te passar o preço",
  timestamp: "2026-08-18T12:00:00.000Z",
  ...over,
});

const dbComLead = () => ({
  leads: [
    {
      id: "lead-1",
      user_id: TENANT,
      phone_normalized: "5511987654321",
      human_takeover_until: null,
    },
  ],
  messages: [] as any[],
  logs: [] as any[],
  global_settings: [{ key: "human_takeover_hours", value: "24" }],
});

describe("handleEcho", () => {
  it("grava a mensagem como saida marcada como do celular", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      user_id: TENANT,
      lead_id: "lead-1",
      direction: "outbound",
      origin: "business_app",
      whatsapp_id: "wamid.ECHO1",
      content: "Bom dia! Vou te passar o preço",
      status: null,
    });
  });

  it("carimba a pausa no lead", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    await handleEcho({ client: client as any }, input());

    expect(db.leads[0].human_takeover_until).toBeTruthy();
    expect(new Date(db.leads[0].human_takeover_until).getTime()).toBeGreaterThan(Date.now());
  });

  it("ignora eco repetido sem gravar nada", async () => {
    const db = dbComLead();
    db.messages.push({
      id: "m1",
      user_id: TENANT,
      whatsapp_id: "wamid.ECHO1",
      direction: "outbound",
    });
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "duplicate" });
    expect(db.messages).toHaveLength(1);
    expect(db.leads[0].human_takeover_until).toBe(null);
  });

  it("ignora eco de numero sem lead, sem criar lead", async () => {
    const db = dbComLead();
    db.leads = [];
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "lead_not_found" });
    expect(db.messages).toHaveLength(0);
    expect(db.leads).toHaveLength(0);
  });

  it("ignora eco de telefone ambiguo", async () => {
    const db = dbComLead();
    db.leads.push({
      id: "lead-2",
      user_id: TENANT,
      phone_normalized: "551187654321",
      human_takeover_until: null,
    });
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input());

    expect(result.body).toMatchObject({ ignored: true, reason: "ambiguous_lead_phone" });
    expect(db.messages).toHaveLength(0);
  });

  it("grava a mensagem mesmo sem texto, sem quebrar", async () => {
    const db = dbComLead();
    const client = createFakeClient(db);

    const result = await handleEcho({ client: client as any }, input({ text: "" }));

    expect(result.status).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.leads[0].human_takeover_until).toBeTruthy();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/echo-handler.test.ts
```

Esperado: FAIL — `Failed to resolve import ".../echo-handler"`.

- [ ] **Step 3: Implementar o handler**

```ts
// Eco do WhatsApp Business App: o dono respondeu pelo celular.
//
// Faz três coisas e nada mais: registra a mensagem na conversa, marca que ela
// veio do aparelho e cala IA e fluxos daquele lead por um prazo. Não classifica
// etapa, não chama IA, não dispara fluxo — o dono já está falando.

import { getGlobalSetting } from "../ai.ts";
import { safeLog } from "./inbound-orchestrator.ts";
import { isAlreadyRegistered } from "./message-dedupe.ts";
import { resolveLead } from "./lead-resolver.ts";
import { DEFAULT_TAKEOVER_HOURS, startHumanTakeover } from "./human-takeover.ts";

export interface EchoDeps {
  client: { from: (table: string) => any };
  onStep?: (step: string) => void;
}

export interface EchoInput {
  tenantId: string;
  providerMessageId: string | null;
  toPhone: string;
  text: string;
  timestamp: string;
}

export interface EchoResult {
  status: number;
  body: Record<string, unknown>;
}

async function takeoverHours(client: EchoDeps["client"]): Promise<number> {
  const raw = await getGlobalSetting(client as any, "human_takeover_hours");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TAKEOVER_HOURS;
}

export async function handleEcho(deps: EchoDeps, input: EchoInput): Promise<EchoResult> {
  const setStep = (step: string) => deps.onStep?.(step);

  setStep("echo_dedupe");
  if (await isAlreadyRegistered(deps.client, input.tenantId, input.providerMessageId, "outbound")) {
    return {
      status: 200,
      body: {
        success: true,
        ignored: true,
        reason: "duplicate",
        whatsapp_id: input.providerMessageId,
      },
    };
  }

  setStep("echo_find_lead");
  const resolution = await resolveLead(deps.client, input.tenantId, input.toPhone);

  if (resolution.kind === "none") {
    // Mesma regra do inbound: em coexistência o dono também fala com contato
    // pessoal e entregador. Criar lead aqui poluiria a base.
    await safeLog(deps.client, {
      user_id: input.tenantId,
      event: "echo_lead_not_found",
      details: { phone: resolution.normalized },
    });
    return { status: 200, body: { success: true, ignored: true, reason: "lead_not_found" } };
  }

  if (resolution.kind === "ambiguous") {
    await safeLog(deps.client, {
      user_id: input.tenantId,
      event: "echo_ambiguous_lead_phone",
      details: { phone: resolution.normalized, matching_leads: resolution.leads.length },
    });
    return {
      status: 200,
      body: { success: true, ignored: true, reason: "ambiguous_lead_phone" },
    };
  }

  const lead = resolution.lead;

  setStep("echo_save_message");
  const { error: insertError } = await deps.client.from("messages").insert({
    user_id: input.tenantId,
    lead_id: lead.id,
    content: input.text,
    direction: "outbound",
    origin: "business_app",
    whatsapp_id: input.providerMessageId,
    status: null,
  });
  if (insertError) throw insertError;

  setStep("echo_start_takeover");
  const hours = await takeoverHours(deps.client);
  const until = await startHumanTakeover(deps.client, input.tenantId, lead.id, hours);

  await safeLog(deps.client, {
    user_id: input.tenantId,
    lead_id: lead.id,
    event: "human_takeover_started",
    details: { until, hours, whatsapp_id: input.providerMessageId },
  });

  return {
    status: 200,
    body: { success: true, lead_id: lead.id, human_takeover_until: until },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
npx vitest run tests/unit/echo-handler.test.ts
```

Esperado: PASS, 6 testes.

Se o teste do wamid duplicado falhar por o insert ter gravado assim mesmo, conferir
que `isAlreadyRegistered` está sendo chamado com `"outbound"` — o eco é saída.

- [ ] **Step 5: Ligar o eco no webhook**

Em `supabase/functions/meta-whatsapp-webhook/index.ts`, adicionar ao topo:

```ts
import { handleEcho } from "../_shared/whatsapp/echo-handler.ts";
```

Trocar a desestruturação do parse e a guarda de payload vazio:

```ts
    step = "parse";
    const { inbound, statuses, echoes, phoneNumberId } = parser.parseWebhook(rawBody);
    if (inbound.length === 0 && statuses.length === 0 && echoes.length === 0) {
      return json({ success: true, ignored: true, reason: "no_actionable_event" });
    }
```

Depois do laço `for (const message of inbound) { ... }` e antes do bloco
`if (statuses.length > 0)`, inserir:

```ts
    for (const echo of echoes) {
      const tenantId = await tenantForPhoneNumberId(
        supabaseClient,
        echo.phoneNumberId ?? phoneNumberId,
      );
      if (!tenantId) {
        results.push({ ignored: true, reason: "unknown_phone_number_id" });
        continue;
      }
      if (echo.type !== "text") {
        // Edição, revogação e mídia chegam no mesmo campo. Tratar cada uma é
        // feature própria; ignorar em silêncio esconderia o caso do log.
        await safeLog(supabaseClient, {
          user_id: tenantId,
          event: "echo_unsupported_operation",
          details: { type: echo.type, whatsapp_id: echo.providerMessageId },
        });
        results.push({ ignored: true, reason: `unsupported_echo_type_${echo.type}` });
        continue;
      }

      const outcome = await handleEcho(
        { client: supabaseClient, onStep: (value: string) => (step = value) },
        {
          tenantId,
          providerMessageId: echo.providerMessageId || null,
          toPhone: echo.toPhone,
          text: echo.text ?? "",
          timestamp: echo.timestamp,
        },
      );
      results.push(outcome.body);
    }
```

Incluir `safeLog` no import que já traz `handleInboundMessage` de
`../_shared/whatsapp/inbound-orchestrator.ts`.

- [ ] **Step 6: Suíte inteira, lint e typecheck**

```bash
npm run test && npm run lint && npm run typecheck
```

Esperado: tudo verde. Atenção ao arquivo de teste do webhook, se existir: a
desestruturação agora exige `echoes` no retorno do parse mockado.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/whatsapp/echo-handler.ts supabase/functions/meta-whatsapp-webhook/index.ts tests/unit/echo-handler.test.ts
git commit -m "feat(whatsapp): registra o eco do celular e inicia a pausa do lead"
```

---

### Task 6: Gate da pausa no agente de IA

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts:105-135`
- Test: `tests/unit/human-takeover.test.ts` (adicionar bloco de decisão do gate)

**Interfaces:**
- Consumes: `isUnderHumanTakeover`, `humanTakeoverUntil` (Task 3).
- Produces: resposta `{ success: true, paused: "human_takeover", until }` com status 200.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar em `tests/unit/human-takeover.test.ts`:

```ts
import { shouldSkipAutomation } from "../../supabase/functions/_shared/whatsapp/human-takeover";

describe("shouldSkipAutomation", () => {
  const NOW2 = new Date("2026-08-18T12:00:00.000Z");

  it("pula quando a pausa está ativa", () => {
    const lead = { human_takeover_until: "2026-08-18T18:00:00.000Z" };
    expect(shouldSkipAutomation(lead, { isTest: false, now: NOW2 })).toBe(true);
  });

  it("não pula quando a pausa venceu", () => {
    const lead = { human_takeover_until: "2026-08-18T06:00:00.000Z" };
    expect(shouldSkipAutomation(lead, { isTest: false, now: NOW2 })).toBe(false);
  });

  it("não pula em teste manual, mesmo com pausa ativa", () => {
    const lead = { human_takeover_until: "2026-08-18T18:00:00.000Z" };
    expect(shouldSkipAutomation(lead, { isTest: true, now: NOW2 })).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/human-takeover.test.ts
```

Esperado: FAIL — `shouldSkipAutomation is not a function`.

- [ ] **Step 3: Implementar a decisão no módulo**

Acrescentar em `supabase/functions/_shared/whatsapp/human-takeover.ts`:

```ts
/** Decisão única usada pelos dois gates de envio. `isTest` fura a pausa: teste
 *  do editor é o dono clicando de propósito, não pode ser calado pela pausa que
 *  ele mesmo criou. */
export function shouldSkipAutomation(
  lead: LeadLike | null | undefined,
  options: { isTest?: boolean; now?: Date } = {},
): boolean {
  if (options.isTest) return false;
  return isUnderHumanTakeover(lead, options.now ?? new Date());
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
npx vitest run tests/unit/human-takeover.test.ts
```

Esperado: PASS, 13 testes.

- [ ] **Step 5: Aplicar o gate no `ai-agent-reply`**

Em `supabase/functions/ai-agent-reply/index.ts`, adicionar ao topo:

```ts
import {
  humanTakeoverUntil,
  shouldSkipAutomation,
} from "../_shared/whatsapp/human-takeover.ts";
```

Logo **antes** da linha `assertLeadCanReceiveMarketing(lead);` (hoje linha 130),
inserir:

```ts
    if (shouldSkipAutomation(lead)) {
      // Silêncio deliberado, não erro: o dono está respondendo pelo celular.
      // Retorna 200 sem consumir turno nem token.
      console.log(`[Agent] lead ${lead_id} em atendimento humano — turno ignorado`);
      return json({
        success: true,
        paused: "human_takeover",
        until: humanTakeoverUntil(lead),
      });
    }
```

Conferir no arquivo o nome do helper de resposta (`json`) e reusar o mesmo já
utilizado nas linhas vizinhas.

- [ ] **Step 6: Typecheck e suíte**

```bash
npm run typecheck && npm run test
```

Esperado: verde.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/whatsapp/human-takeover.ts supabase/functions/ai-agent-reply/index.ts tests/unit/human-takeover.test.ts
git commit -m "feat(whatsapp): agente de IA se cala durante atendimento humano"
```

---

### Task 7: Gate da pausa nos envios de fluxo

`execute-flow` é o único caminho de envio automático de fluxo — `process-flows`,
`resume-flow`, `trigger-flow-by-stage` e o orquestrador de inbound todos delegam para
ele. Por isso o gate mora aqui, e não na entrada do webhook.

**Files:**
- Modify: `supabase/functions/execute-flow/index.ts:318-330` e `:558-570`
- Test: `tests/unit/human-takeover.test.ts` (bloco de reagendamento)

**Interfaces:**
- Consumes: `shouldSkipAutomation`, `humanTakeoverUntil` (Tasks 3 e 6).
- Produces: `rescheduleForTakeover(client, executionId, until): Promise<void>` em
  `human-takeover.ts`.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar em `tests/unit/human-takeover.test.ts`:

```ts
import { rescheduleForTakeover } from "../../supabase/functions/_shared/whatsapp/human-takeover";

describe("rescheduleForTakeover", () => {
  it("adia a execucao para o fim da pausa e a mantem rodando", async () => {
    const db: any = {
      flow_executions: [{ id: "exec-1", status: "running", scheduled_at: null }],
    };
    const client = createFakeClient(db);

    await rescheduleForTakeover(client as any, "exec-1", "2026-08-19T12:00:00.000Z");

    expect(db.flow_executions[0].scheduled_at).toBe("2026-08-19T12:00:00.000Z");
    expect(db.flow_executions[0].status).toBe("running");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/human-takeover.test.ts
```

Esperado: FAIL — `rescheduleForTakeover is not a function`.

- [ ] **Step 3: Implementar**

Acrescentar em `supabase/functions/_shared/whatsapp/human-takeover.ts`:

```ts
/** Adia a execução para quando a pausa vencer. `process-flows` recolhe depois e
 *  o fluxo continua de onde parou, em vez de morrer. */
export async function rescheduleForTakeover(
  client: { from: (table: string) => any },
  executionId: string,
  until: string,
): Promise<void> {
  const { error } = await client
    .from("flow_executions")
    .update({ scheduled_at: until, status: "running" })
    .eq("id", executionId);

  if (error) throw error;
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
npx vitest run tests/unit/human-takeover.test.ts
```

Esperado: PASS, 14 testes.

- [ ] **Step 5: Aplicar o gate nos dois pontos de envio**

Em `supabase/functions/execute-flow/index.ts`, adicionar ao topo:

```ts
import {
  humanTakeoverUntil,
  rescheduleForTakeover,
  shouldSkipAutomation,
} from "../_shared/whatsapp/human-takeover.ts";
```

Em **cada** um dos dois pontos onde hoje se lê `assertLeadCanReceiveMarketing(lead);`
(linhas 324 e 564), inserir **imediatamente antes** o mesmo bloco:

```ts
            const takeoverUntil = humanTakeoverUntil(lead);
            if (shouldSkipAutomation(lead, { isTest: is_test })) {
              if (execution_id && takeoverUntil) {
                await rescheduleForTakeover(supabaseClient, execution_id, takeoverUntil);
              }
              console.log(
                `[ExecuteFlow] lead ${lead_id} em atendimento humano — envio adiado para ${takeoverUntil}`,
              );
              return new Response(
                JSON.stringify({
                  success: true,
                  paused: "human_takeover",
                  until: takeoverUntil,
                  rescheduled: Boolean(execution_id && takeoverUntil),
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
```

Ajustar a indentação ao bloco onde está sendo inserido. Se o ponto de envio estiver
dentro de função aninhada que não enxergue `execution_id`, `is_test` ou `lead_id`,
passar os valores por parâmetro em vez de capturar — não duplicar a leitura do body.

- [ ] **Step 6: Typecheck, suíte e lint**

```bash
npm run typecheck && npm run test && npm run lint
```

Esperado: verde.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/whatsapp/human-takeover.ts supabase/functions/execute-flow/index.ts tests/unit/human-takeover.test.ts
git commit -m "feat(whatsapp): fluxos adiam envio durante atendimento humano"
```

---

### Task 8: Onboarding — número certo e flag de coexistência

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/meta-diagnostics.ts:151-164`
- Modify: `supabase/functions/_shared/whatsapp/signup-onboarding.ts:44-130`
- Modify: `supabase/functions/meta-whatsapp-admin/index.ts:92-112`
- Modify: `src/components/whatsapp/MetaEmbeddedSignupButton.tsx:60-135`
- Test: `tests/unit/signup-onboarding.test.ts` (adicionar casos)

**Interfaces:**
- Consumes: `listPhoneNumbers`, `getPhoneNumber`, `PhoneNumberInfo`.
- Produces: `PhoneNumberInfo` ganha `isOnBizApp?: boolean | null` e
  `platformType?: string | null`; `completeSignupOnboarding` aceita um quarto
  parâmetro `options?: { phoneNumberId?: string | null; coexistenceHint?: boolean }`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar em `tests/unit/signup-onboarding.test.ts`:

```ts
describe("escolha do número e coexistência", () => {
  const segundoNumero = () => ({
    id: "999888777666555",
    display_phone_number: "+55 34 95328-5885",
    verified_name: "Segundo Número",
    quality_rating: "GREEN",
  });

  it("recusa quando a WABA tem mais de um numero e nada indica qual", async () => {
    const db: any = { whatsapp_connections: [] };
    const client = createFakeClient(db);
    const fetchFn = onboardingFetch([defaultNumber(), segundoNumero()]);

    const result = await completeSignupOnboarding(deps(client, fetchFn), TENANT, "CODE");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ambiguous_phone_number");
      expect(result.error.message).toContain("999888777666555");
    }
    expect(db.whatsapp_connections).toHaveLength(0);
  });

  it("usa o numero indicado pelo evento quando a WABA tem varios", async () => {
    const db: any = { whatsapp_connections: [] };
    const client = createFakeClient(db);
    const fetchFn = onboardingFetch([defaultNumber(), segundoNumero()]);

    const result = await completeSignupOnboarding(deps(client, fetchFn), TENANT, "CODE", {
      phoneNumberId: "106540352242922",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phoneNumber.phoneNumberId).toBe("106540352242922");
  });

  it("grava coexistence_enabled quando a Graph diz que o numero esta no Business App", async () => {
    const db: any = { whatsapp_connections: [] };
    const client = createFakeClient(db);
    const fetchFn = onboardingFetch([
      { ...defaultNumber(), is_on_biz_app: true, platform_type: "CLOUD_API" },
    ]);

    const result = await completeSignupOnboarding(deps(client, fetchFn), TENANT, "CODE");

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections[0].coexistence_enabled).toBe(true);
  });

  it("cai na dica do evento quando a Graph nao expoe o campo", async () => {
    const db: any = { whatsapp_connections: [] };
    const client = createFakeClient(db);
    const fetchFn = onboardingFetch([defaultNumber()]);

    const result = await completeSignupOnboarding(deps(client, fetchFn), TENANT, "CODE", {
      coexistenceHint: true,
    });

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections[0].coexistence_enabled).toBe(true);
  });

  it("grava false quando nada indica coexistencia", async () => {
    const db: any = { whatsapp_connections: [] };
    const client = createFakeClient(db);
    const fetchFn = onboardingFetch([defaultNumber()]);

    const result = await completeSignupOnboarding(deps(client, fetchFn), TENANT, "CODE");

    expect(result.ok).toBe(true);
    expect(db.whatsapp_connections[0].coexistence_enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/signup-onboarding.test.ts
```

Esperado: FAIL nos cinco casos novos — hoje `numbers[0]` conecta o primeiro sem
reclamar e `coexistence_enabled` nunca é escrita.

- [ ] **Step 3: Ler o sinal de coexistência na listagem**

Em `supabase/functions/_shared/whatsapp/meta-diagnostics.ts`, estender a interface:

```ts
export interface PhoneNumberInfo {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus?: string | null;
  /** Coexistência: número compartilhado com o WhatsApp Business App. A doc da
   *  Meta diverge entre páginas sobre a existência destes campos — quando a
   *  Graph não os devolve, ficam undefined e o onboarding usa a dica do evento. */
  isOnBizApp?: boolean | null;
  platformType?: string | null;
}
```

E fazer `listPhoneNumbers` pedir e mapear os campos:

```ts
export async function listPhoneNumbers(
  config: MetaApiConfig & { wabaId: string },
): Promise<PhoneNumberInfo[]> {
  const result = await graphGet(
    config,
    `${config.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type`,
  );
  // Campo desconhecido derruba a chamada inteira (erro 100). Nesse caso repete
  // sem os campos de coexistência: listar os números é obrigatório, saber da
  // coexistência é desejável.
  const fallback = result.ok ? result : await graphGet(config, `${config.wabaId}/phone_numbers`);
  if (!fallback.ok) throw new Error(errorFrom(fallback.data, fallback.status).message);

  const rows = Array.isArray(fallback.data?.data) ? fallback.data.data : [];
  return rows.map((row: Record<string, any>) => ({
    phoneNumberId: String(row.id ?? ""),
    displayPhoneNumber: row.display_phone_number ? String(row.display_phone_number) : null,
    verifiedName: row.verified_name ? String(row.verified_name) : null,
    qualityRating: row.quality_rating ? String(row.quality_rating) : null,
    isOnBizApp: typeof row.is_on_biz_app === "boolean" ? row.is_on_biz_app : undefined,
    platformType: row.platform_type ? String(row.platform_type) : undefined,
  }));
}
```

- [ ] **Step 4: Escolher o número e gravar a flag**

Em `supabase/functions/_shared/whatsapp/signup-onboarding.ts`, adicionar o tipo de
opções e o parâmetro:

```ts
export interface OnboardingOptions {
  /** Número indicado pelo evento do Embedded Signup, quando a Meta o envia. */
  phoneNumberId?: string | null;
  /** Sinal do evento FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING, vindo do browser.
   *  É dado do cliente: só vale quando a Graph não expõe `is_on_biz_app`, e
   *  nunca serve de base para decisão de segurança. */
  coexistenceHint?: boolean;
}

export async function completeSignupOnboarding(
  deps: OnboardingDeps,
  tenantId: string,
  code: string,
  options: OnboardingOptions = {},
): Promise<OnboardingResult> {
```

Trocar a escolha cega do número (`numbers[0]`) por:

```ts
  const wanted = options.phoneNumberId?.trim();
  const chosen = wanted ? numbers.find((n) => n.phoneNumberId === wanted) : undefined;

  if (wanted && !chosen) {
    return {
      ok: false,
      error: {
        code: "phone_number_not_in_waba",
        message: `O número ${wanted} não está na conta autorizada.`,
      },
    };
  }

  if (!chosen && numbers.length > 1) {
    // Conectar o número errado em silêncio é pior do que falhar: o tenant só
    // descobriria quando a primeira mensagem saísse pela linha errada.
    const lista = numbers
      .map((n) => `${n.phoneNumberId} (${n.displayPhoneNumber ?? "sem número"})`)
      .join(", ");
    return {
      ok: false,
      error: {
        code: "ambiguous_phone_number",
        message: `A conta autorizada tem ${numbers.length} números e nenhum foi indicado: ${lista}.`,
      },
    };
  }

  const selected = chosen ?? numbers[0];
```

Trocar a releitura para usar o número escolhido:

```ts
  let confirmed: PhoneNumberInfo;
  try {
    confirmed = await getPhoneNumber({ ...api, phoneNumberId: selected.phoneNumberId });
  } catch (error: any) {
    return { ok: false, error: { message: error?.message ?? "Falha ao ler o número escolhido" } };
  }
```

Calcular a flag e incluí-la no upsert:

```ts
  // Servidor manda; a dica do browser só entra quando a Graph não expõe o campo.
  const coexistence =
    typeof selected.isOnBizApp === "boolean"
      ? selected.isOnBizApp
      : Boolean(options.coexistenceHint);
```

No objeto do upsert, acrescentar a linha:

```ts
      coexistence_enabled: coexistence,
```

E ajustar a lista de "outros números" para excluir o escolhido, se o código hoje
assume `numbers.slice(1)`:

```ts
    otherNumbers: numbers.filter((n) => n.phoneNumberId !== selected.phoneNumberId),
```

- [ ] **Step 5: Rodar e ver passar**

```bash
npx vitest run tests/unit/signup-onboarding.test.ts
```

Esperado: PASS, incluindo os casos antigos sem edição.

- [ ] **Step 6: Repassar as duas informações pelo admin**

Em `supabase/functions/meta-whatsapp-admin/index.ts`, na ação `exchange-code`, trocar
a chamada para incluir o quarto parâmetro:

```ts
        userId,
        String(body?.code ?? ""),
        {
          phoneNumberId: body?.phoneNumberId ? String(body.phoneNumberId) : null,
          coexistenceHint: body?.coexistence === true,
        },
      );
```

- [ ] **Step 7: Enviar a dica a partir do front**

Em `src/components/whatsapp/MetaEmbeddedSignupButton.tsx`, guardar o último evento
também em ref — o `FB.login` devolve o código por callback e pode chegar antes do
render que gravaria o estado:

```tsx
  const lastEventRef = useRef<SignupEvent | null>(null);
```

No listener de mensagens, logo após `setLastEvent(parsed)`:

```tsx
      if (parsed) {
        lastEventRef.current = parsed;
        setLastEvent(parsed);
      }
```

(substituindo a linha `if (parsed) setLastEvent(parsed);`)

E no `invoke`, mandar os dois campos:

```tsx
          .invoke("meta-whatsapp-admin", {
            body: {
              action: "exchange-code",
              code,
              coexistence:
                lastEventRef.current?.kind === "finish"
                  ? lastEventRef.current.coexistence
                  : false,
              phoneNumberId:
                lastEventRef.current?.kind === "finish"
                  ? lastEventRef.current.phoneNumberId
                  : null,
            },
          })
```

- [ ] **Step 8: Suíte, lint e typecheck**

```bash
npm run test && npm run lint && npm run typecheck
```

Esperado: verde.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/whatsapp/meta-diagnostics.ts supabase/functions/_shared/whatsapp/signup-onboarding.ts supabase/functions/meta-whatsapp-admin/index.ts src/components/whatsapp/MetaEmbeddedSignupButton.tsx tests/unit/signup-onboarding.test.ts
git commit -m "feat(whatsapp): conecta o numero indicado e registra a coexistencia"
```

---

### Task 9: Conversa mostra o que saiu do celular e a pausa

**SUB-SKILL OBRIGATÓRIA:** invocar a skill `frontend-design` antes de escrever a UI —
exigência do `CLAUDE.md` deste projeto.

**Files:**
- Modify: `src/hooks/use-conversations.ts:90-140`
- Modify: `src/pages/Conversas.tsx:20-170`

**Interfaces:**
- Consumes: colunas `messages.origin` e `leads.human_takeover_until` (Task 1).
- Produces: `ConversationMessage` ganha `origin: string | null`; o hook expõe
  `humanTakeoverUntil: string | null` da conversa aberta e uma mutation
  `releaseToAi(leadId)`.

- [ ] **Step 1: Trazer os dois campos no hook**

Em `src/hooks/use-conversations.ts`, incluir `origin` no select das mensagens (hoje
`"id, direction, content, status, whatsapp_id, created_at"`):

```ts
        .select("id, direction, content, status, whatsapp_id, origin, created_at")
```

E mapear no objeto devolvido, junto de `status`:

```ts
        origin: row.origin ?? null,
```

Acrescentar `origin: string | null;` na interface da mensagem (perto de
`direction: "inbound" | "outbound";`, linha 17).

- [ ] **Step 2: Ler e limpar a pausa do lead**

Ainda em `src/hooks/use-conversations.ts`, adicionar:

```ts
export function useHumanTakeover(leadId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["human-takeover", leadId],
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("human_takeover_until")
        .eq("id", leadId!)
        .maybeSingle();
      if (error) throw error;

      const until = data?.human_takeover_until ?? null;
      if (!until) return null;
      return new Date(until).getTime() > Date.now() ? until : null;
    },
  });

  const release = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("leads")
        .update({ human_takeover_until: null })
        .eq("id", leadId!);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["human-takeover", leadId] });
    },
  });

  return { until: query.data ?? null, isLoading: query.isLoading, release };
}
```

Conferir que `useQuery`, `useMutation` e `useQueryClient` estão importados de
`@tanstack/react-query` no topo do arquivo; acrescentar o que faltar.

- [ ] **Step 3: Marcar a bolha e mostrar a faixa**

Em `src/pages/Conversas.tsx`, no componente da bolha (perto da linha 65, onde hoje se
lê `const enviada = message.direction === "outbound";`):

```tsx
  const enviada = message.direction === "outbound";
  const doCelular = enviada && message.origin === "business_app";
```

Trocar a renderização do status (linha 85) para não mostrar ícone de entrega no eco —
a Meta não emite `statuses` para mensagem enviada pelo aparelho:

```tsx
          {enviada && !doCelular && <DeliveryStatus status={message.status} />}
          {doCelular && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Smartphone className="h-3 w-3" aria-hidden="true" />
              pelo celular
            </span>
          )}
```

Importar `Smartphone` de `lucide-react` junto dos demais ícones do arquivo.

Acima da lista de mensagens da conversa aberta, renderizar a faixa:

```tsx
      {takeover.until && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <span>
            IA pausada — você assumiu esta conversa pelo celular. Volta{" "}
            {new Date(takeover.until).toLocaleString("pt-BR")}.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={takeover.release.isPending}
            onClick={() => takeover.release.mutate()}
          >
            Devolver para a IA
          </Button>
        </div>
      )}
```

Ligar o hook no componente da conversa aberta:

```tsx
  const takeover = useHumanTakeover(conversaAberta?.leadId ?? null);
```

Usar o nome real do identificador do lead na conversa selecionada do arquivo — o hook
`use-conversations` já agrupa por lead.

- [ ] **Step 4: Ver rodando**

```bash
npm run dev
```

Abrir `/conversas`, escolher uma conversa e conferir: nenhuma quebra de layout, faixa
ausente quando não há pausa. Fechar com `Ctrl+C`.

- [ ] **Step 5: Lint, typecheck e build**

```bash
npm run lint && npm run typecheck && npm run build
```

Esperado: verde nos três.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-conversations.ts src/pages/Conversas.tsx
git commit -m "feat(whatsapp): conversa mostra mensagem do celular e a pausa da IA"
```

---

### Task 10: Deploy e prova com mensagem real

Nada nesta tarefa é opcional: é aqui que se descobre se `is_on_biz_app` existe de
verdade na v25.0 e se o eco chega.

**Files:**
- Modify: `STATUS.md`

**Interfaces:**
- Consumes: tudo das tarefas 1-9.
- Produces: `STATUS.md` atualizado.

- [ ] **Step 1: Marcar os três campos no App Dashboard**

Em App Dashboard > WhatsApp > Configuration > Webhook fields, assinar
`smb_message_echoes`. (`history` e `smb_app_state_sync` ficam fora deste bloco —
os syncs não foram implementados; assinar campos que ninguém consome só geraria
ruído no log.) Registrar no `STATUS.md` que ficaram pendentes de propósito.

- [ ] **Step 2: Publicar as functions alteradas**

```bash
bash scripts/sb-staging.sh functions deploy meta-whatsapp-webhook --linked
bash scripts/sb-staging.sh functions deploy meta-whatsapp-admin --linked
bash scripts/sb-staging.sh functions deploy ai-agent-reply --linked
bash scripts/sb-staging.sh functions deploy execute-flow --linked
```

Esperado: quatro deploys concluídos sem erro.

- [ ] **Step 3: Provar o eco com mensagem real**

Do celular conectado, mandar uma mensagem no WhatsApp Business App para um lead de
teste que exista na base. Em seguida:

```bash
bash scripts/sb-staging.sh db query --linked "select m.id, m.direction, m.origin, m.whatsapp_id, m.content, l.human_takeover_until from public.messages m join public.leads l on l.id = m.lead_id where m.origin = 'business_app' order by m.created_at desc limit 5;"
```

Esperado: pelo menos uma linha com `direction = outbound`, `origin = business_app`,
`whatsapp_id` preenchido e `human_takeover_until` no futuro.

**Se vier vazio**, checar nesta ordem, sem chutar: (1) o campo
`smb_message_echoes` está marcado no App Dashboard; (2) a conexão é mesmo de
coexistência (`coexistence_enabled`); (3) os logs da função:

```bash
bash scripts/sb-staging.sh functions logs meta-whatsapp-webhook --linked
```

- [ ] **Step 4: Provar que a automação se cala**

```bash
bash scripts/sb-staging.sh db query --linked "select event, details, created_at from public.logs where event in ('human_takeover_started','echo_lead_not_found','echo_ambiguous_lead_phone','echo_unsupported_operation') order by created_at desc limit 10;"
```

Esperado: `human_takeover_started` com `until` e `hours` no `details`.

Em seguida, com a pausa ativa, mandar uma mensagem **do lead** para o número e
conferir que o agente não respondeu — a resposta do webhook traz
`paused: "human_takeover"`.

- [ ] **Step 5: Conferir qual caminho de coexistência funcionou**

```bash
bash scripts/sb-staging.sh db query --linked "select phone_number_id, display_phone_number, coexistence_enabled, updated_at from public.whatsapp_connections;"
```

Registrar no `STATUS.md` se `coexistence_enabled` veio da Graph (`is_on_biz_app`
presente) ou da dica do evento — é a resposta à divergência de documentação
levantada na spec.

- [ ] **Step 6: Atualizar o `STATUS.md`**

Acrescentar uma seção com: o que ficou verde (com a saída dos comandos), os campos de
webhook assinados, o resultado da questão `is_on_biz_app`, e o que ficou de fora
(`smb_app_data`, histórico e contatos, edição/revogação de mensagem).

- [ ] **Step 7: Commit**

```bash
git add STATUS.md
git commit -m "docs: registra a coexistencia com eco do Business App em producao"
```

---

## Notas de execução

- **Ordem importa.** Tarefas 2 e 3 são pré-requisito da 5; a 4 é pré-requisito da 5;
  a 6 e a 7 dependem da 3. A 8 e a 9 são independentes entre si.
- **Task 2 é refactor puro.** Se um teste existente precisar mudar para passar, o
  refactor está errado — reverter e refazer.
- **Nunca `git add -A`.** `deno.lock`, `package.json` e `package-lock.json` estão
  modificados por trabalho alheio e não entram em nenhum commit deste plano.
