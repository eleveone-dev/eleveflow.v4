# Spec — migração WhatsApp Evolution → Meta Cloud API

Data: 2026-07-24
Status: aprovado, **com revisão de escopo em 2026-07-25**. Bloco A implementado
em código (Tasks 1–15 de 16; **nada aplicado ou publicado** — migration, deploy e
E2E pendentes de autorização e de credenciais). Task 16 (remoção da Evolution)
travada em decisão de produto. Plano e evidência dos gates em
`docs/plans/2026-07-25-migracao-whatsapp-meta-cloud-bloco-a.md` e `STATUS.md`.
Bloco B travado em credenciais.

> ## Revisão de escopo — 2026-07-25 (decisão do dono)
>
> **A Evolution sai do produto.** Esta spec foi escrita mantendo-a como fallback
> por empresa; o dono reverteu essa decisão. Onde o texto abaixo disser
> "fallback", "rollback para Evolution" ou "sem linha = evolution", vale esta
> revisão:
>
> - Não há provider duplo. `WhatsAppProviderId` é só `meta_cloud`.
> - `whatsapp_connections` sem linha conectada = **erro 409 explícito**, não
>   fallback. Não existe caminho alternativo de envio.
> - Não há rollback para Baileys em nenhuma fase.
> - A remoção é a Task 16 do plano, **no fim da fila**: primeiro o caminho Meta
>   de pé e provado, depois apagar. A orquestração do CRM muda de casa (Task 12),
>   não some.
> - **Consequência aceita:** sem as credenciais Meta o produto não envia nem
>   recebe WhatsApp depois da Task 16.
> - Em aberto, trava a Task 16: substituto de `src/pages/Whatsapp.tsx` (conexão
>   por QR) enquanto o Embedded Signup (Bloco B, Fase 4) não existir.

## Contexto

O EleveOne opera atendimento, automações, IA e disparos por WhatsApp sobre a
Evolution API (Baileys, não-oficial). A Evolution é um provedor global único:
`EVOLUTION_API_URL`/`EVOLUTION_API_KEY`/`EVOLUTION_WEBHOOK_SECRET` vivem em
`Deno.env` e a separação por tenant é apenas o nome da instância
(`instanceName == accounts.user_id`, 1 número por conta).

O objetivo é migrar para a **WhatsApp Business Platform Cloud API** oficial da
Meta, sem interromper clientes atuais e mantendo todas as funcionalidades do CRM.
A Evolution permanece como **fallback por empresa** até a migração individual.

Esta spec cobre a migração inteira, mas detalha a **Fundação (Bloco A)** —
verificável sem credenciais Meta — e trata o **Bloco B (Meta-live)** como
roadmap travado nas credenciais/app que só o dono fornece.

## Estado atual (verificado no código, 2026-07-24)

- Tenant = `accounts.user_id` (auth user = empresa = número). RLS por `auth.uid()`.
- Envio: `send_queue` → `process-queue` (cron + on-demand) → `sendWhatsAppText`
  (`_shared/evolution.ts`). Idempotência/rate-limit por RPCs de claim no banco
  (`claim_marketing_queue_item_v2`, `complete_marketing_queue_delivery`).
- Recebimento: `whatsapp-webhook` (shape Evolution) → `verifyEvolutionWebhook`
  (segredo em header) → resolve tenant por `instance == user_id` → dedupe por
  `whatsapp_id` → IA classifica etapa → delega a `ai-agent-reply` /
  `execute-sequence` / `execute-flow`. Arquivo com ~1030 linhas, orquestração CRM
  acoplada ao parse Evolution.
- Segredos por tenant: `account_secrets` (service-role-only, RLS deny-all client),
  **plaintext jsonb**. O slot `integrations.evolution` é **morto** (nenhuma função
  lê; o envio usa `Deno.env` global).
- Config global: `global_settings` (key/value, service-role-only).
- **Não existe**: abstração de provider, tabela `whatsapp_connections`, conceito
  de superadmin (zero refs em `src/`), criptografia (sem pgsodium/Vault), templates,
  mídia (sistema é texto puro).
- Restrição de plataforma: módulos `_shared/*` rodam em **Deno (edge) e Node/Vitest
  (testes)** — sem APIs exclusivas de Deno nem import por URL nesses módulos.

## Objetivos

1. Abstração de provedor: automações, IA, filas e telas usam uma interface única,
   nunca chamam Evolution ou Meta direto.
2. Cada tenant tem um provider ativo (`evolution` | `meta_cloud`); um número nunca
   envia pelas duas APIs.
3. Conexão oficial Meta por credencial administrativa (dev/análise) e por Embedded
   Signup (clientes), incluindo coexistência de número já usado no WhatsApp Business App.
4. Enviar/receber, criar/listar/acompanhar templates, manter IA/atendimento/automações.
5. Evolution permanece como fallback por empresa; migração individual controlada com
   rollback.
6. Segredos criptografados; telas administrativas protegidas; isolamento por tenant;
   webhook autenticado, idempotente e anti-replay.

## Decisões (fechadas com o dono)

### Seleção de provider — `whatsapp_connections` autoritativa, evolution implícito

- `whatsapp_connections` é a fonte de verdade do provider ativo por tenant.
- **Sem linha = `evolution`** (via env global + instância = `user_id`, comportamento
  atual). Linha existe quando o tenant conecta/migra para `meta_cloud`.
- Rollback de migração = remover a linha ou voltar `provider` para `evolution`.
- Não toca os tenants atuais; expressa fallback e rollback por empresa naturalmente;
  `accounts.whatsapp_status` fica intacto para a UI atual.

### Criptografia de tokens — AES-256-GCM app-level

- Módulo `_shared/crypto.ts` com Web Crypto (roda em Deno e Vitest).
- Chave de 32 bytes num secret novo `WHATSAPP_TOKEN_ENC_KEY` (base64), **nunca no
  banco**. Descartado pgsodium/Vault: não habilitado, churn recente do Supabase e
  não testável no Vitest sem banco — quebraria a história de testes do `_shared`.
- Formato versionado `v1:base64(iv).base64(ct+tag)` para rotação futura.

### Superadmin — claim no JWT (`app_metadata.platform_role`)

- `app_metadata.platform_role === 'superadmin'` no usuário dono.
- Server lê do token (sem query extra), não falsificável pelo cliente.
- Semear via `scripts/set-superadmin.mjs` (service role, `auth.admin.updateUserById`).
  Produção só com autorização explícita do dono.
- Frontend lê o claim apenas para exibir/ocultar UI; o server é a autoridade.

### Versão da Graph API — variável, nunca fixa

- `META_GRAPH_API_VERSION` (env/`global_settings`). Nenhuma versão fixa no código.
- A implementação do MetaProvider segue a **documentação oficial atual da Meta**
  como fonte de verdade (consultada na implementação, não do conhecimento de treino).

## Ajustes fechados no planejamento (2026-07-25)

Levantados ao escrever o plano de implementação, conferindo o código atual e a
documentação oficial da Meta. Alteram detalhes da spec, não as decisões.

1. **`encryptSecret`/`decryptSecret` são assíncronos e recebem a chave por
   parâmetro** — `(plaintext, keyBase64) => Promise<string>`, não
   `(plaintext) => string`. Web Crypto é assíncrona e `_shared/crypto.ts` precisa
   ser Deno-free para rodar no Vitest; quem lê `WHATSAPP_TOKEN_ENC_KEY` de
   `Deno.env` é a edge function.
2. **A Cloud API tem um quinto status, `played`** (voice message ouvida), fora da
   união `sent|delivered|read|failed`. `parseWebhook` descarta status fora da
   união; tratar `played` fica para o Bloco B.
3. **`interactive` não vira texto no Bloco A.** O tipo é normalizado, mas extrair
   o título de button_reply/list_reply exige a referência específica da Meta, que
   não foi confirmada nesta consulta. Fica para a Fase 7.
4. **`WebhookParseResult` ganha `phoneNumberId` no nível do resultado.** Um
   payload que traz só `statuses[]` não permite achar o tenant de outra forma —
   `StatusUpdate` não carrega o número.
5. **O webhook Meta processa de forma síncrona antes do 200**, como o da
   Evolution já faz. O processamento assíncrono descrito em A5 mudaria o modelo
   do webhook atual e quebraria a paridade que o Bloco A precisa provar; fica
   para a Fase 7, quando houver mídia em volume.
6. **`EvolutionProvider.parseWebhook` existe para a interface e para o teste de
   paridade**, mas o `whatsapp-webhook` continua usando `extractIncomingMessage`
   direto, preservando byte a byte os códigos de motivo dos 200 atuais
   (`unsupported_event`, `fromMe`, `unresolved_lid`, `no_phone`,
   `empty_or_unsupported_content`, `missing_instance`).
7. **`HttpError`, `hmacSha256Hex`, `constantTimeEqual` e
   `assertLeadCanReceiveMarketing` saem de `auth.ts`** para módulos Deno-free
   (`http-error.ts`, `hmac.ts`, `marketing-consent.ts`), reexportados por
   `auth.ts`. Sem isso o orquestrador compartilhado não é testável no Vitest.
8. **Characterization test em duas camadas.** Não há como testar o corpo de
   `serve()` antes de extraí-lo: a camada real é unit sobre as funções puras
   movidas (`extractIncomingMessage`, `phoneVariants`,
   `isMarketingOptOutMessage`, `phoneFromSenderIdentifier`), mais os E2E
   `inbound-webhook` e `agent-journey` verdes **antes e depois** da extração.

## Arquitetura — Bloco A (Fundação)

Princípio-guia: **comportamento do Evolution intocado**. A abstração embrulha o
código atual; nenhuma reescrita. Extrações de código são guardadas por
*characterization tests* que fixam o comportamento atual antes de mover.

### A1. Abstração de provider — `_shared/whatsapp/`

`types.ts` — interface e DTOs normalizados:

```ts
type WhatsAppProviderId = "evolution" | "meta_cloud";

interface SendResult {
  ok: boolean;
  providerMessageId: string | null;
  status: number;
  raw: unknown;
  error?: { code?: string; message: string };
}

interface InboundMessage {
  providerMessageId: string;      // wamid (Meta) | key.id (Evolution)
  fromPhone: string;              // dígitos normalizados
  phoneNumberId?: string;         // Meta: identifica o tenant
  instance?: string;              // Evolution: identifica o tenant
  type: "text" | "image" | "audio" | "video" | "document" | "interactive" | "unsupported";
  text?: string;
  media?: { id: string; mimeType?: string; caption?: string };
  timestamp: string;
}

interface StatusUpdate {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  error?: { code?: string; message: string };
}

interface WebhookParseResult { inbound: InboundMessage[]; statuses: StatusUpdate[] }

interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  sendText(p): Promise<SendResult>;
  sendMedia(p): Promise<SendResult>;
  sendTemplate(p): Promise<SendResult>;
  markAsRead(p): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  getConnectionStatus(): Promise<{ connected: boolean; details: unknown }>;
  listTemplates(): Promise<TemplateSummary[]>;
  createTemplate(p): Promise<TemplateSummary>;
  verifyWebhook(req: Request, rawBody: string): Promise<void>;   // lança em falha
  parseWebhook(rawBody: string): WebhookParseResult;
}
```

O `handleWebhook()` da prompt é dividido em **`verifyWebhook` + `parseWebhook`** no
limite do provider. A **orquestração CRM** (dedupe, achar lead por telefone, IA de
etapa, delegar a agente/sequence/flow) sai para
`_shared/whatsapp/inbound-orchestrator.ts`, **compartilhada** pelos dois webhooks.

- `evolution-provider.ts`: embrulha `sendWhatsAppText` (texto) e o parse/verify
  atuais. `sendMedia`/`sendTemplate`/`listTemplates`/`createTemplate`/`downloadMedia`
  lançam `NotSupportedError` — a Evolution neste código é texto puro.
- `meta-provider.ts`: real contra `https://graph.facebook.com/${META_GRAPH_API_VERSION}/…`,
  usando `phone_number_id` + access token descriptografado da conexão. Todos os
  métodos implementados; **unit-testados com `fetch` injetado/mockado** — nenhuma
  chamada real no Bloco A.
- `index.ts` → `resolveProvider(tenantId, deps): Promise<WhatsAppProvider>`: lê
  `whatsapp_connections`; sem linha ou `provider='evolution'` → EvolutionProvider;
  `provider='meta_cloud'` → MetaProvider ligado à conexão (token descriptografado).
  **Único ponto** do sistema que escolhe provider → garante "nunca as duas APIs".

### A2. Banco — migration aditiva

`whatsapp_connections`:

| coluna | tipo | notas |
|---|---|---|
| id | uuid pk | |
| tenant_id | uuid | references auth.users; **unique** (1 conexão/tenant) |
| provider | text not null | check in ('evolution','meta_cloud') |
| status | text not null default 'pending' | pending\|connected\|disconnected\|error |
| meta_business_id | text | |
| waba_id | text | |
| phone_number_id | text | **unique parcial** (where not null) |
| display_phone_number | text | |
| display_name | text | |
| access_token_encrypted | text | payload AES-GCM; nunca ao cliente |
| token_type | text | user \| system_user |
| token_expires_at | timestamptz | |
| coexistence_enabled | boolean not null default false | |
| webhook_subscribed_at | timestamptz | |
| quality_rating | text | |
| messaging_limit_tier | text | |
| last_sync_at | timestamptz | |
| created_at / updated_at | timestamptz | trigger `update_updated_at_column` |

- Índices: unique `tenant_id`; unique parcial `phone_number_id` não-nulo (impede o
  mesmo número em dois tenants).
- RLS: **deny-all** de escrita ao cliente (só service role escreve). SELECT da
  própria linha via **GRANT por-coluna** para `authenticated`, **excluindo**
  `access_token_encrypted` (única coluna secreta da tabela), com policy
  `tenant_id = auth.uid()`. O token nunca chega ao browser.
- Config global Meta em `global_settings` (service-role-only): `meta_app_id`,
  `meta_graph_api_version`, `meta_embedded_signup_config_id`, `meta_public_base_url`,
  `meta_webhook_verify_token` (gerado crypto-random), `meta_app_secret_encrypted`
  (AES-GCM). Nada disso é legível pelo cliente; acesso só via edge function com gate
  superadmin.

### A3. Criptografia — `_shared/crypto.ts`

`encryptSecret(plaintext): string` / `decryptSecret(payload): string` com AES-256-GCM
(Web Crypto), IV aleatório de 12 bytes, tag de 16 bytes, chave de
`WHATSAPP_TOKEN_ENC_KEY`. Formato `v1:base64(iv).base64(ct+tag)`. Lança erro claro
se a chave faltar ou tiver tamanho inválido. Nunca loga plaintext nem chave.

### A4. Superadmin — `_shared/auth.ts`

`requireSuperadmin(req): Promise<{ userId; email }>` — resolve o usuário via
`getUser`, exige `app_metadata.platform_role === 'superadmin'`, senão `HttpError(403)`.
`generateWebhookVerifyToken()` — token crypto-random para o webhook. Frontend: hook
`useIsSuperadmin()` lê o claim da sessão (cosmético).

### A5. Webhook Meta — edge function `meta-whatsapp-webhook`

- **GET** (verificação): valida `hub.mode === 'subscribe'`, compara `hub.verify_token`
  (constant-time) com `meta_webhook_verify_token`; devolve **exatamente** `hub.challenge`
  (200) quando válido; 403 caso contrário.
- **POST** (eventos): lê raw body; valida `X-Hub-Signature-256` =
  `sha256=` + HMAC-SHA256(`meta_app_secret`, rawBody) constant-time → 401 se inválido.
  Parse via `MetaProvider.parseWebhook`. Resolve tenant por `phone_number_id` em
  `whatsapp_connections`. Idempotente por `wamid`. Inbound → **mesmo**
  `inbound-orchestrator`. Status sent/delivered/read/failed → atualiza `messages.status`
  por `whatsapp_id` (idempotente). Responde 200 rápido; processamento pesado assíncrono.
  Erros registrados sem expor dados sensíveis.
- Callback registrado na Meta = URL da edge function Supabase (raw body + segredo perto
  do banco). Expor no path `/api/integrations/meta/whatsapp/webhook` via rewrite do app
  fica para o Bloco B, se desejado o domínio próprio.

### A6. Envio — refactor de `process-queue`

Troca a chamada direta `sendWhatsAppText(...)` por
`const provider = await resolveProvider(userId, deps); const res = await provider.sendText(...)`
e lê `res.providerMessageId`. Para `evolution` o comportamento é idêntico (env global +
instância = `user_id`). Claim, rate-limit, horário e RPCs de idempotência
**inalterados**. `whatsapp-proxy` (fluxo de QR/instância) permanece Evolution-específico
no Bloco A; conexão Meta não usa QR.

### A7. Testes (TDD, tudo com mock)

- `crypto`: round-trip, detecção de adulteração, ausência de chave.
- `evolution-provider`: `sendText` delega correto; paridade de parse/verify.
- `meta-provider`: `sendText`/`sendMedia`/`sendTemplate`/`createTemplate` montam a
  request certa (URL contém `META_GRAPH_API_VERSION`, body no formato Cloud API, header
  de auth presente mas **token nunca logado**); `parseWebhook` sobre fixtures reais de
  payload; `verifyWebhook` (X-Hub-Signature-256 com segredo conhecido).
- webhook: GET verify válido/ inválido; POST assinatura válida/ inválida/ ausente → 401.
- idempotência: mesmo `wamid` duas vezes → um processamento.
- isolamento multi-tenant: `phone_number_id` resolve o tenant certo; cross-tenant negado.
- `resolveProvider`: sem linha → evolution; `meta_cloud` → meta com token descriptografado.
- fallback e **troca de provider**: flipar a linha → próximo envio usa o novo provider.
- gate superadmin: não-superadmin → 403.
- characterization: comportamento do `whatsapp-webhook` Evolution preservado após a
  extração do orchestrator.

### Gates de conclusão do Bloco A

`deno check` das functions · `npm run typecheck` · `npm run test` (unit verdes,
cobertura mantida) · `npm run lint` · `npm run build` · migration aplicada em
local/staging (produção **só com autorização do dono**). Nenhuma chamada real à Meta.

## Roadmap — Bloco B (Meta-live, travado em credenciais)

Cada item exige credenciais/ativos que só o dono fornece; nada é "feito" sem evidência
real. UI sempre via skill `frontend-design`.

- **Fase 2 (tela)**: Configurações › Integrações › Meta WhatsApp (superadmin). Formulário
  de config global, geração/exibição única do verify token, URL de callback, teste de
  App ID/Secret **sem revelar valores**, status por requisito. *Gate: App ID/Secret.*
- **Fase 3**: conexão administrativa manual (dev/análise). Validar access token, descobrir
  WABA/números, inscrever webhook, tela de diagnóstico. *Gate: access token Meta.*
- **Fase 4**: Embedded Signup (SDK oficial, Config ID, troca `code`→token no backend,
  descoberta e persistência de WABA/Phone Number ID, inscrição de webhook, sync de
  templates) + caminho de **coexistência** não-destrutivo (`coexistence_enabled`).
  *Gate: App aprovado + Config ID.*
- **Fase 7 (wiring)**: envio real de mídia/áudio/vídeo/documento/interativo/templates,
  markAsRead, upload/download; janela de 24h e exigência de template fora dela; opt-out;
  transferência IA→humano; retentativas limitadas. *Gate: número conectado.*
- **Fase 8**: WhatsApp › Modelos de mensagem — listar/filtrar/criar/sincronizar via
  Management API real; bloquear envio de template não aprovado. *Gate: WABA.*
- **Fase 9**: migração Evolution→Meta por empresa (verificar conexão, testar webhook,
  enviar teste real, pausar automações, flipar provider, reativar, manter rollback,
  impedir envio duplo). Preserva o histórico do CRM; não importa histórico do app WhatsApp.
- **Fase 10**: "Demonstração para análise da Meta" (API real) para os dois vídeos
  (`whatsapp_business_messaging` e `whatsapp_business_management`).
- **Fase 11**: checklist visual de configuração com erros claros em português e "onde
  achar cada dado no painel da Meta".
- **Docs (Fase 13)**: `docs/meta-whatsapp-setup.md`, `docs/meta-embedded-signup.md`,
  `docs/meta-app-review.md`, `docs/migration-evolution-to-meta.md`,
  `docs/meta-webhook-troubleshooting.md`; atualizar README e `.env.example`.

## Segurança (Fase 12, mapeada)

Tokens criptografados (A3) · secret manager = `WHATSAPP_TOKEN_ENC_KEY` + Supabase secrets ·
tokens fora de logs/erros (redação já praticada no `whatsapp-proxy`) · telas admin com
gate superadmin (A4) · tenant validado em toda operação · anti-replay/idempotência por
`wamid` (A5) · validação de tipo/tamanho/origem de mídia (Bloco B) · rate limiting ·
proibição de informar Phone Number ID de outro tenant (unique parcial + resolução
server-side) · App Secret/token nunca em resposta do backend.

## Rollout

1. Bloco A: migration aditiva + secret `WHATSAPP_TOKEN_ENC_KEY` em local/staging; gates
   executáveis; sem tocar produção sem ok.
2. Semear superadmin na conta do dono (staging; produção com ok).
3. Bloco B por fase, cada uma atrás de sua credencial, com smoke real antes de declarar pronto.
4. Migração de clientes uma empresa por vez, com rollback para Evolution disponível.

## Fora de escopo desta entrega

- ~~Remoção da Evolution (permanece como fallback).~~ **Revertido em 2026-07-25:
  a remoção entrou no escopo como Task 16 do plano.**
- Reescrita do editor de fluxos, do worker de fila ou do modelo de tenant.
- Multi-número por tenant (YAGNI: 1 conexão ativa por tenant; revisitar se um cliente exigir).
- Importar histórico do app WhatsApp por meios não oficiais.
- Redesign visual amplo fora das telas novas.

## Dados externos que o dono precisa fornecer (para o Bloco B)

- `META_APP_ID`, `META_APP_SECRET` (App da Meta configurado).
- `META_EMBEDDED_SIGNUP_CONFIG_ID` (configuração de Embedded Signup).
- Access token administrativo (Fase 3) e/ou app com permissões aprovadas
  (`whatsapp_business_messaging`, `whatsapp_business_management`).
- WABA e Phone Number ID (obtidos pelo fluxo oficial, não digitados).
- Autorização para semear superadmin e aplicar migration em produção.

## Roteiro dos dois vídeos (Fase 10, referência)

**whatsapp_business_messaging**: conexão oficial ativa → abrir conversa → enviar pelo
EleveOne → mostrar ID retornado pela Meta → mensagem chegando no WhatsApp → responder pelo
WhatsApp → resposta aparecendo no EleveOne → status enviado/entregue/lido.

**whatsapp_business_management**: abrir templates → criar template de teste → chamada real
executada sem revelar token → template retornado pela Meta → sincronizar lista → status
real do template.
