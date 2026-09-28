# F1 — Evolution como provider: plano de implementação

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA: use
> `superpowers:subagent-driven-development` ou `superpowers:executing-plans` para
> implementar tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** tornar a Evolution API o provider ativo de WhatsApp, atrás da
interface `WhatsAppProvider` que já existe, sem apagar o caminho Meta.

**Arquitetura:** `resolveProvider()` já é o único ponto do sistema que monta o
provedor de um tenant. Ele passa a ramificar por `whatsapp_connections.provider`.
Toda a orquestração de inbound (`handleInboundMessage`) já é escopada por tenant
e agnóstica de provider — recebe `{ tenantId, providerMessageId, fromPhone, text }`
e não sabe quem entregou a mensagem. Por isso o webhook da Evolution é fino:
verifica origem, parseia, resolve o tenant pela instância, delega.

**Base:** branch `feat/f1-evolution-provider`, criada de
`feat/whatsapp-meta-cloud` (`eccdb4a`, 2026-08-19). Baseline verde conferida em
2026-09-17: **30 arquivos, 345 testes, exit 0**.

**Contexto da decisão:** `docs/specs/2026-09-17-f0-estabilizar-flow3-design.md`
no repositório `eleve.flow.3` (arquivado) e o `STATUS.md` de lá. O projeto do
Lovable não é nosso; produção passa a ser `xlycuunqpgpyfmafgajr`.

## Global Constraints

- Português do Brasil em commits, comentários e documentos. Mensagem de commit
  sem acentuação, seguindo o histórico deste repositório.
- Conventional Commits, atômicos. **Sem rastro de IA** em commit, PR ou código.
- **TDD**: teste, ver falhar, implementar, ver passar. Teste que nunca falhou não
  conta.
- **Nada é declarado pronto sem a saída do comando colada.**
- Módulos em `_shared/`: proibido `import` por URL e proibido `Deno.env` por
  dentro. Ambiente entra por parâmetro. Quem lê ambiente é o `index.ts`.
- Mudanças de banco **aditivas**. Nenhum `DROP`, nenhum `ALTER ... TYPE`.
- **Nunca logar segredo**: `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET`,
  `access_token_encrypted`, `WHATSAPP_TOKEN_ENC_KEY`.
- O caminho Meta **não é apagado**. Toda mudança em `resolveProvider` mantém
  `meta_cloud` funcionando, e os testes existentes dele continuam verdes.
- Cobertura: o gate de 80% em `vitest.config.ts` continua valendo; módulos novos
  entram em `coverage.include`.

## Origem do código

Três fontes, todas já escritas e testadas. F1 é montagem, não invenção.

| Fonte | O que vem de lá |
|---|---|
| `eleve.flow2@c190faf^` | `_shared/evolution.ts` (envio de texto com fetch injetado), `evolutionWebhookPayloads`, o webhook de 205 linhas |
| `eleve.flow.3@feat/f0-isolamento-entre-contas` | `evolution-webhook.ts` (segredo por parâmetro, testável), `proxy-auth.ts`, `hmac.ts`, `http-error.ts` — os dois últimos já existem aqui |
| Branch atual | `WhatsAppProvider`, `resolveProvider`, `handleInboundMessage`, `resolveLead`, `message-dedupe`, `status-sync`, `human-takeover` |

---

### Task 1: Coluna de provider e de instância em `whatsapp_connections`

Hoje `whatsapp_connections` assume Meta: exige `phone_number_id` e
`access_token_encrypted`. A Evolution não tem nenhum dos dois — tem nome de
instância, e a credencial é global, não por tenant.

**Files:**
- Create: `supabase/migrations/20260918120000_whatsapp_connections_provider.sql`

**Interfaces:**
- Produces: `whatsapp_connections.provider text not null default 'meta_cloud'`,
  `whatsapp_connections.instance_name text`, índice único parcial
  `whatsapp_connections_instance_uidx`.

- [ ] **Passo 1: Escrever a migration**

```sql
-- A conexao deixa de ser sempre Meta. instance_name e a chave de resolucao do
-- inbound da Evolution: e por ela que o webhook descobre de quem e a mensagem.
ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta_cloud',
  ADD COLUMN IF NOT EXISTS instance_name text;

ALTER TABLE public.whatsapp_connections
  DROP CONSTRAINT IF EXISTS whatsapp_connections_provider_check;
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_provider_check
  CHECK (provider IN ('meta_cloud', 'evolution'));

-- Duas contas nao podem apontar para a mesma instancia: e o defeito de
-- isolamento do outro repositorio, impedido aqui pelo banco e nao por codigo.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_instance_uidx
  ON public.whatsapp_connections (instance_name)
  WHERE instance_name IS NOT NULL;

-- Conexao Evolution precisa de instance_name; conexao Meta precisa de
-- phone_number_id. Uma so regra, checada pelo banco.
ALTER TABLE public.whatsapp_connections
  DROP CONSTRAINT IF EXISTS whatsapp_connections_provider_fields_check;
ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_provider_fields_check
  CHECK (
    (provider = 'evolution' AND instance_name IS NOT NULL)
    OR (provider = 'meta_cloud' AND phone_number_id IS NOT NULL)
  );
```

- [ ] **Passo 2: Aplicar e conferir**

```bash
supabase db push
```

Conferir no banco:

```sql
select column_name, data_type, column_default
from information_schema.columns
where table_schema='public' and table_name='whatsapp_connections'
  and column_name in ('provider','instance_name');

select conname from pg_constraint
where conrelid='public.whatsapp_connections'::regclass;
```

Esperado: as duas colunas, e as duas constraints novas. A linha de teste
existente (`provider` default `meta_cloud`, com `phone_number_id`) continua
válida — conferir que a migration não falhou por causa dela.

- [ ] **Passo 3: Commit**

```bash
git add supabase/migrations/20260918120000_whatsapp_connections_provider.sql
git commit -m "feat(db): whatsapp_connections ganha provider e instance_name

A conexao deixa de ser sempre Meta. instance_name e a chave de resolucao do
inbound da Evolution, com indice unico parcial: duas contas apontando para a
mesma instancia passa a ser impossivel pelo banco."
```

---

### Task 2: Resolver tenant pela instância

**Files:**
- Create: `supabase/functions/_shared/whatsapp/instance-tenant.ts`
- Create: `tests/unit/instance-tenant.test.ts`

**Interfaces:**
- Produces:
  - `type InstanceTenant = { ok: true; tenantId: string } | { ok: false; reason: "missing_instance" | "unknown_instance" }`
  - `resolveTenantByInstance(client: { from(t: string): any }, instance: unknown): Promise<InstanceTenant>`

Adaptado de `eleve.flow.3@feat/f0-isolamento-entre-contas:supabase/functions/_shared/instance-tenant.ts`.
Diferença: lá a busca era em `accounts`; aqui é em `whatsapp_connections`, que é
a fonte de verdade de conexão neste repositório e tem o índice único da Task 1.

- [ ] **Passo 1: Escrever o teste**

Casos, usando o `fakeSupabase` de `tests/unit/helpers/fake-supabase.ts` (já
existe neste repositório — conferir a API antes de escrever):

1. instância conhecida e `status='connected'` devolve `{ ok: true, tenantId }`.
2. instância desconhecida devolve `{ ok: false, reason: "unknown_instance" }`.
3. instância ausente, vazia ou não-string devolve `missing_instance`.
4. instância que existe mas com `provider='meta_cloud'` devolve
   `unknown_instance` — não se resolve inbound de Evolution por linha Meta.

- [ ] **Passo 2: Rodar e ver falhar**

```bash
npx vitest run tests/unit/instance-tenant.test.ts
```

Esperado: FALHA por módulo inexistente.

- [ ] **Passo 3: Implementar**

Consulta `whatsapp_connections` por `instance_name = instance.trim()` **e**
`provider = 'evolution'`, devolvendo `tenant_id`.

- [ ] **Passo 4: Rodar e ver passar**

```bash
npx vitest run tests/unit/instance-tenant.test.ts
```

Esperado: 4 passed.

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/whatsapp/instance-tenant.ts tests/unit/instance-tenant.test.ts
git commit -m "feat(whatsapp): resolve o tenant pela instancia da Evolution"
```

---

### Task 3: `EvolutionProvider`

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/types.ts` (`WhatsAppProviderId`)
- Create: `supabase/functions/_shared/whatsapp/evolution-provider.ts`
- Create: `supabase/functions/_shared/whatsapp/evolution-parse.ts`
- Create: `tests/unit/evolution-provider.test.ts`

**Interfaces:**
- Consumes: `WhatsAppProvider`, `SendResult`, `SendTextParams`, `InboundMessage`,
  `WebhookParseResult` de `types.ts`.
- Produces:
  - `WhatsAppProviderId = "meta_cloud" | "evolution"`
  - `createEvolutionProvider(config: { apiUrl: string; apiKey: string; instance: string; webhookSecret?: string; fetchFn?: typeof fetch }): WhatsAppProvider`
  - `parseEvolutionWebhook(payload: unknown): WebhookParseResult`
  - `extractIncomingMessage(payload: any)` — movido verbatim do
    `eleve.flow.3:supabase/functions/whatsapp-webhook/index.ts:30-72`

- [ ] **Passo 1: Estender `WhatsAppProviderId`**

```ts
export type WhatsAppProviderId = "meta_cloud" | "evolution";
```

Rodar a suíte inteira. Os testes que fixam `"meta_cloud"` continuam verdes; se
algum quebrar por exaustividade de `switch`, é sinal de onde falta ramificar.

- [ ] **Passo 2: Escrever os testes**

Envio (modelados em `eleve.flow2@c190faf^:tests/unit/evolution.test.ts`):
1. `sendText` faz `POST {apiUrl}/message/sendText/{instance}` com header `apikey`.
2. normaliza barra final da `apiUrl`.
3. resposta não-JSON vira `{ raw }` sem lançar.
4. `sendTemplate`, `listTemplates` e `createTemplate` lançam `HttpError(501)` —
   conceito só da Meta.

Parse de webhook:
5. `messages.upsert` com `conversation` devolve a mensagem.
6. `extendedTextMessage.text` e `imageMessage.caption` também.
7. `fromMe: true` é descartado.
8. evento que não é `messages.upsert` devolve resultado vazio.
9. JID `@s.whatsapp.net` e `@c.us` viram só dígitos.

`fetchFn` injetado em todos: **nenhuma chamada real à Evolution nos testes.**

- [ ] **Passo 3: Rodar e ver falhar**
- [ ] **Passo 4: Implementar**

`evolution-parse.ts` recebe `extractIncomingMessage` e `parseEvolutionWebhook`.
`evolution-provider.ts` implementa a interface: envio por
`{apiUrl}/message/sendText/{instance}` e `/message/sendMedia/{instance}`,
`markAsRead` por `/chat/markMessageAsRead/{instance}`, `getConnectionStatus` por
`/instance/connectionState/{instance}`, `verifyWebhook` delegando a
`verifyEvolutionWebhook`. Os três métodos de template lançam `HttpError(501)`.

- [ ] **Passo 5: Rodar e ver passar** — suíte inteira, não só o arquivo novo.
- [ ] **Passo 6: Commit**

---

### Task 4: `resolveProvider` ramifica

**Files:**
- Modify: `supabase/functions/_shared/whatsapp/index.ts`
- Modify: `tests/unit/resolve-provider.test.ts`
- Modify: `vitest.config.ts` (`coverage.include` dos módulos novos)

**Interfaces:**
- Consumes: `createEvolutionProvider` (Task 3), `resolveTenantByInstance` (Task 2).
- Produces: `ProviderEnv` ganha `evolutionApiUrl?: string` e `evolutionApiKey?: string`.

Hoje `resolveProvider` exige `phone_number_id`, `access_token_encrypted` e
`tokenEncryptionKey` **antes** de saber o provider. Isso passa a valer só para
`meta_cloud`. A Evolution usa credencial global de ambiente, não token por
tenant — não há o que descriptografar.

- [ ] **Passo 1: Escrever os testes**

1. conexão `provider='evolution'` e `status='connected'` devolve provider com
   `id === "evolution"`, sem exigir `phone_number_id` nem token.
2. conexão `evolution` sem `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` no env →
   `HttpError(503)`.
3. conexão `meta_cloud` continua exigindo token e `phone_number_id` — **os testes
   existentes deste arquivo não mudam.**
4. tenant sem linha → `HttpError(409)`, como hoje.

- [ ] **Passo 2: Rodar e ver falhar**
- [ ] **Passo 3: Implementar** — ramificar por `connection.provider` antes de
      qualquer validação específica de Meta.
- [ ] **Passo 4: Rodar a suíte inteira e ver passar**
- [ ] **Passo 5: Commit**

---

### Task 5: Edge function `whatsapp-webhook`

**Files:**
- Create: `supabase/functions/whatsapp-webhook/index.ts`
- Modify: `supabase/config.toml` (`verify_jwt = false`)
- Create: `tests/e2e/evolution-inbound-webhook.spec.ts`

**Interfaces:**
- Consumes: `verifyEvolutionWebhook`, `parseEvolutionWebhook` (Task 3),
  `resolveTenantByInstance` (Task 2), `handleInboundMessage` (já existe).

Estrutura de `eleve.flow2@c190faf^:supabase/functions/whatsapp-webhook/index.ts`
(205 linhas), com a verificação de origem na forma testável do
`eleve.flow.3` — segredo por parâmetro, e a guarda de implantação.

- [ ] **Passo 1: Escrever a função**

Ordem dos passos, com os mesmos nomes de `step` e motivos de recusa do original:

```
verify_webhook  → corpo cru (req.text()), verifyEvolutionWebhook
parse_body      → JSON.parse; falha → HttpError(400)
                  evento != messages.upsert → 200 ignored/unsupported_event
                  fromMe                    → 200 ignored/fromMe
                  sem telefone              → 200 ignored/no_phone
                  sem texto                 → 200 ignored/empty_or_unsupported_content
resolve_instance_tenant → resolveTenantByInstance
                  ausente      → 200 ignored/missing_instance
                  desconhecida → 200 ignored/unknown_instance
handleInboundMessage({ tenantId, providerMessageId, fromPhone, text })
```

Tudo que não é nosso responde 200: a Evolution reenvia o que falha.

- [ ] **Passo 2: `verify_jwt = false` no `config.toml`**, com comentário
      explicando que a origem é verificada por segredo em header.
- [ ] **Passo 3: `deno check`**
- [ ] **Passo 4: E2E** — modelado em `tests/e2e/meta-inbound-webhook.spec.ts`:
      inbound registrado no banco, segredo inválido rejeitado com 401, evento
      não suportado ignorado.
- [ ] **Passo 5: Commit**

---

### Task 6: Edge function `whatsapp-proxy`

Gestão de conexão: criar instância, QR, estado, logout, apagar, registrar
webhook. É o que a tela `/whatsapp` consome.

**Files:**
- Create: `supabase/functions/whatsapp-proxy/index.ts`
- Create: `supabase/functions/_shared/whatsapp/evolution-admin.ts`
- Create: `tests/unit/evolution-admin.test.ts`
- Modify: `supabase/config.toml` (`verify_jwt = true`)

**Interfaces:**
- Consumes: `requireUser` / `getAuthUser` do `_shared/auth.ts`, `has_role`.
- Produces:
  - `resolveProxyInstance({ client, authUserId, isAdmin, targetUserId }): Promise<string>`
    — portado de `eleve.flow.3@feat/f0-isolamento-entre-contas:supabase/functions/_shared/proxy-auth.ts`,
    com a busca em `whatsapp_connections` no lugar de `accounts`.
  - `evolutionWebhookPayloads(url, headers)` — de `c190faf^`, três formatos.

**Regra que não pode ser afrouxada:** o nome da instância **nunca** vem do corpo.
É derivado do `auth.uid()`. Admin alcança outra conta por `targetUserId`
explícito, checado por `has_role`. Foi exatamente o defeito 2 do outro
repositório.

- [ ] **Passo 1: Escrever os testes** de `resolveProxyInstance` (401 sem usuário,
      403 apontando para outra conta sem ser admin, admin com `targetUserId`,
      409 sem conexão registrada) e de `evolutionWebhookPayloads` (os três
      formatos carregam o header).
- [ ] **Passo 2: Rodar e ver falhar**
- [ ] **Passo 3: Implementar**
- [ ] **Passo 4: Rodar e ver passar**
- [ ] **Passo 5: `deno check`**
- [ ] **Passo 6: Commit**

---

### Task 7: Conferir o caminho de envio — FEITA em 2026-09-18

Auditoria, sem codigo novo. Escrever um teste que mocka o `process-queue`
inteiro nao provaria nada alem do que a composicao ja garante, e o elo que falta
so e exercitavel contra deploy real, na Task 9.

**Nenhuma suposicao de Meta fora do `resolveProvider`.**

```
grep -rn "meta_cloud|phone_number_id|graph.facebook|wamid"   supabase/functions/process-queue supabase/functions/execute-flow
-> nenhuma ocorrencia
```

O envio toca apenas `provider.id` e `provider.sendText()`, ambos da interface.

**Todo portao esta a montante do provedor.**

```
execute-flow    :329 takeover  :347 consentimento   (ponto 1 de envio)
execute-flow    :587 takeover  :605 consentimento   (ponto 2)
ai-agent-reply  :137 takeover  :141 consentimento
process-queue   :278 consentimento  :494 consentimento
                :525 resolve_provider  :563 provider.sendText
```

`execute-flow` e `ai-agent-reply` nao mencionam `resolveProvider`: eles
enfileiram. Quem envia e o `process-queue`, e la o consentimento e checado 247
linhas antes de o provedor existir. Trocar de provedor nao tem como furar
`assertLeadCanReceiveMarketing` nem a pausa por atendimento humano.

**Elo restante:** entrega real pela Evolution, que exige credencial e numero
pareado. Fica na Task 9, passos 6 e 7.

### Task 8: Tela `/whatsapp` volta a ter QR — FEITA em 2026-09-18

**Decisão do Passo 1: ramificar, não trocar.** Conta com linha `meta_cloud`
continua na Cloud API — migrar de provedor mexe em número pareado e é cutover
por tenant (F4), não um botão de tela. Conta nova ou com linha `evolution` entra
pelo pareamento por QR. A troca de painel só aparece para quem ainda não está na
Meta.

**Files:**
- Modify: `src/pages/Whatsapp.tsx` — só a ramificação; o conteúdo da Meta saiu
  para `MetaPanel.tsx` sem mudança de comportamento.
- Create: `src/components/whatsapp/{EvolutionPanel,MetaPanel,ConnectionChain}.tsx`
- Create: `src/hooks/use-evolution-connection.ts` (`useWhatsappProvider`,
  `useEvolutionConnection`, `useEvolutionConnect`, `useEvolutionDisconnect`)
- Create: `src/lib/evolution-connection-view.ts` + `tests/unit/evolution-connection-view.test.ts`
- Modify: `vitest.config.ts` (`coverage.include`), `src/integrations/supabase/types.ts`

`use-whatsapp.ts` não existe neste repositório: o hook da Meta é
`use-whatsapp-connection.ts` e não foi tocado.

- [x] **Passo 1: Ler a tela atual** e decidir. Decisão registrada no commit.
- [x] **Passo 2: Implementar o fluxo de QR** consumindo o `whatsapp-proxy`.
      Nenhuma chamada manda `instanceName` no corpo — o servidor deriva do
      `auth.uid()`. O QR conta 45s e a pessoa pede outro; recarregar sozinho
      brigaria com quem está com o celular na mão.
- [x] **Passo 3:** `npm run typecheck` (exit 0), `npm run build` (built in 3m 8s,
      exit 0), `npx vitest run` (36 arquivos, 420 testes, exit 0),
      `npx vitest run --coverage` (exit 0).
- [x] **Passo 4: Commit** — `fix(types)` + `feat(whatsapp)`.

**Dois defeitos corrigidos no caminho:**

1. `types.ts` não tinha `whatsapp_connections` — a tabela inteira faltava desde
   `20260725120000`, e o typecheck quebrava em 5 pontos. As 25 colunas foram
   conferidas contra produção por `information_schema.columns`.
2. A primeira versão do hook provava tráfego varrendo `messages`. É o que
   `connection-proof.ts` documenta e proíbe: foi assim que mock da Evolution e
   fixture de E2E marcaram "envio testado" em conta sem conexão. Pior aqui,
   porque sem escopo de conexão uma mensagem da era Meta provaria tráfego da
   Evolution.

**Fora desta task, por consequência:** os elos de recebimento e envio provados
não existem para a Evolution. Provar exige gravação por evento — coluna nova na
conexão, escrita pelo `whatsapp-webhook` (inbound) e pelo `process-queue`
(outbound), como `recordInboundProof`/`recordOutboundProof` fazem para a Meta.
A Task 9, passos 6 e 7, prova o tráfego real conferindo `messages` no banco;
a tela mostra os três elos que o servidor sabe agora: instância, pareamento e
webhook. Débito registrado no `STATUS.md`.

---

### Task 9: Publicar no `xlycu` e provar — passos 1 a 4 e 8 FEITOS em 2026-09-19

- [x] **Passo 1: Suíte verde.**

```
npx vitest run             -> 36 arquivos, 420 testes, exit 0
npx vitest run --coverage  -> exit 0 (gate de 80% mantido)
npm run typecheck          -> exit 0
npm run build              -> built in 3m 8s, exit 0
deno check                 -> whatsapp-webhook, whatsapp-proxy, process-queue, os tres limpos
```

- [x] **Passo 2: Secrets.** `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e
      `EVOLUTION_WEBHOOK_SECRET` (64 chars, gerado novo) gravados no
      `xlycuunqpgpyfmafgajr` por `secrets set --env-file`, com o arquivo fora do
      repositório e apagado depois. A key mestra saiu do env do container
      `evolutionapi_evolution-api` no VPS `srv1057879`, por SSH — não existia
      copia dela no repositório nem no Credential Manager. Detalhes do servidor,
      e o aviso de que ele é compartilhado com o `wa-agent`, no `STATUS.md`.

```
supabase secrets list -> EVOLUTION_API_KEY, EVOLUTION_API_URL, EVOLUTION_WEBHOOK_SECRET
```

- [x] **Passo 3: banco conferido, `db push` não foi preciso.** `migration list`
      mostra todas as locais com remota correspondente, inclusive
      `20260918120000`. As colunas e as duas constraints de provider existem em
      produção.

- [x] **Passo 4: Publicar as functions.** `whatsapp-webhook`, `whatsapp-proxy` e
      `process-queue`, com `--use-api`. `process-queue` entra porque importa o
      `resolveProvider` que passou a ramificar e recebeu o env da Evolution.

- [ ] **Passo 5: Conectar um número de teste** pela tela: QR, parear, conferir a
      linha em `whatsapp_connections` com `provider='evolution'` e
      `instance_name` preenchido. **Depende de celular.** O frontend já está
      publicado (2026-09-19, deployment `eleveflow-d5t83zvam`, alias
      `eleveflow-tan.vercel.app`), então falta só ler o QR.
- [ ] **Passo 6: Inbound real.** Depende do passo 5.
- [ ] **Passo 7: Outbound real.** Depende do passo 5.

- [x] **Passo 8: Webhook sem segredo → 401.** Conferido contra produção:

```
POST /whatsapp-webhook sem header   -> 401 {"step":"verify_webhook","error":"Webhook authentication failed"}
POST /whatsapp-webhook com segredo  -> 200 {"ignored":true,"reason":"unknown_instance"}
POST /whatsapp-proxy sem sessao     -> 401 {"step":"resolve_instance","message":"Authentication required"}
```

A guarda de implantação (passar sem verificar) valia só enquanto o segredo não
existia; com ele gravado a recusa já está em vigor.

- [x] **Passo 9: Atualizar o `STATUS.md`** — seção "F1 — Evolution como provider:
      publicada em produção (2026-09-19)".

**A instância `Atual` é intocável.** Decisão do dono em 2026-09-19: é produção de
cliente no mesmo servidor. Nenhum `logout` ou `delete` foi chamado, e nenhum
deve ser. O pareamento do passo 5 cria instância nova, nomeada pelo `user_id`.

## Divergencias registradas

- **Task 5, passo 4 — resolvida em 2026-09-19.** O E2E
  `tests/e2e/evolution-inbound-webhook.spec.ts` foi escrito e passa contra o
  deploy real, com cinco casos: mensagem registrada no banco, sem segredo 401,
  segredo errado 401, instância desconhecida ignorada com 200 e evento que não é
  `messages.upsert` ignorado com 200. O tenant é `admin@eleveflow.test`, não o de
  E2E, porque só existe uma conexão por tenant e semear Evolution no outro
  derrubaria a conexão Meta do E2E de inbound da Meta.
- **Comportamento que o E2E revelou:** número sem lead é ignorado de propósito
  (`webhook_lead_not_found`, `inbound-orchestrator.ts:122`). Contato desconhecido
  não vira cadastro sozinho, em nenhum provedor. Quem for provar inbound precisa
  de lead semeado antes.
- **Task 6 — `verify_jwt`.** O `whatsapp-proxy` ficou com `verify_jwt = false`, e
  isso está consistente: **todas** as catorze entradas do `config.toml` são
  `false`. O padrão do repositório é verificar no código, onde o gate de admin
  mora junto. Smoke sem sessão devolve 401.
- **Task 6 — gate de admin, corrigido em 2026-09-19.** A implementação consultava
  `user_roles`, tabela que não existe neste schema, com o erro engolido: `isAdmin`
  era sempre falso e admin nunca alcançava outra conta. Passou a usar
  `app_metadata.platform_role` por `getAuthUserWithPlatformRole`. Conferido em
  produção: conta comum apontando para outra conta → 403; superadmin → 200.
- **Task 6 — `resolveProxyInstance` não devolve 409** sem conexão registrada, como
  o plano previa: cai na convenção `instance_name = user_id`, senão o primeiro
  pareamento seria impossível. O dump do projeto legado confirma que nunca houve
  outro nome gravado.
- **Fora do F1, achado pelo `deno check`:** `meta-whatsapp-admin` lia
  `env.graphApiVersion` onde `readEnv` devolve `metaGraphApiVersion`, então a ação
  `discover-connection` chamava a Graph API com a versão vazia na URL. Entrou no
  `aa906a9` (19/08). Corrigido e publicado.

## Fora deste plano

- F2: features do `flow.3` (contas/crédito, anti-ban, Paraguai, Instagram score).
- F3: migração dos dados dos três tenants.
- F4: cutover por tenant.
- Apagar o caminho Meta. Ele fica parqueado, verde e sem credencial.
