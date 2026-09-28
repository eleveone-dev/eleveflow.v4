# Spec — coexistência WhatsApp: conexão correta e eco do WhatsApp Business App

Data: 2026-08-18
Status: aprovado (brainstorm de 2026-08-18). Não implementado.
Depende de: `docs/specs/2026-07-24-migracao-whatsapp-meta-cloud-design.md` (Bloco B,
Fase 4 — Embedded Signup, já em produção).

## Contexto

O App Review da Meta foi aprovado, o que libera o Embedded Signup em modo
coexistência: o cliente conecta ao EleveFlow um número que **continua em uso no
WhatsApp Business App do celular**, sem apagar a conta do aparelho.

Isso cria um problema que não existia enquanto o número era exclusivo da API. Com
coexistência, dono e robô compartilham a mesma linha. Se o dono responde um lead
pelo celular, o CRM não fica sabendo: o agente de IA responde por cima e o cliente
recebe duas respostas para a mesma pergunta — possivelmente contraditórias, e
possivelmente de madrugada, quando um fluxo agendado dispara.

Esta spec cobre duas coisas: (1) conectar o número certo e registrar que a conexão
é de coexistência; (2) capturar o que o dono manda pelo celular e calar as
automações enquanto o atendimento humano estiver em curso.

## Estado atual (verificado em 2026-08-18)

Banco de produção (`xlycuunqpgpyfmafgajr`), consultado via `scripts/sb-staging.sh`:

- `whatsapp_connections`: 1 linha. `status = connected`, `coexistence_enabled = false`,
  `display_name = "Teste"`, `waba_id = 2203121110258246`,
  `phone_number_id = 1267133593145045`, webhook inscrito em 2026-08-04.
- `global_settings`: `meta_app_id = 1742922410057266`,
  `meta_embedded_signup_config_id = 2302998863777075`,
  `meta_embedded_signup_enabled = true`, `meta_graph_api_version = v25.0`.
- `public.messages`: 5 linhas, 5 com `whatsapp_id`, **0 duplicatas** por
  `(user_id, whatsapp_id)`. O índice `idx_messages_user_whatsapp_id` **não** é único.
- `public.leads` e `public.messages` não têm nenhuma coluna de takeover, origem de
  mensagem ou pausa.

Código:

- `src/lib/meta-embedded-signup.ts:100` — o front detecta o evento
  `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` e expõe `coexistence: boolean`.
  **Esse valor nunca sai do browser**: nenhum arquivo em `supabase/functions/`
  menciona coexistência, e o upsert de `signup-onboarding.ts:103` não escreve a
  coluna. Ou seja, hoje uma conexão por coexistência é gravada como `false`.
- `signup-onboarding.ts:96` — `numbers[0]`: escolhe às cegas o primeiro número da
  WABA. Cliente com dois números conecta o errado sem aviso.
- `_shared/whatsapp/meta-provider.ts:286` — `if (change?.field !== "messages") continue;`.
  Os três campos de coexistência são descartados. Não há duplicação hoje, mas o
  CRM é cego para o celular.
- `_shared/whatsapp/inbound-orchestrator.ts` — 811 linhas. Contém dedupe por
  `whatsapp_id` (≈100-120) e resolução de lead com variantes de nono dígito
  (128-160) enterrados no meio da orquestração de IA, fluxo, estágio e opt-out.
  Número sem lead correspondente é **ignorado** (loga `webhook_lead_not_found`).
- Gates de envio existentes, que servem de padrão a imitar:
  `assertLeadCanReceiveMarketing(lead)` em `execute-flow/index.ts:324` e `:564`
  (os dois pontos de envio) e em `ai-agent-reply/index.ts:130`.
- Todo fluxo passa por `execute-flow` (`process-flows`, `resume-flow`,
  `trigger-flow-by-stage` e o orquestrador delegam para lá). Todo turno de IA passa
  por `ai-agent-reply`. Dois gates cobrem todos os caminhos de envio automático.

## O que a Meta exige (doc oficial consultada em 2026-08-18)

- **`POST /register` é proibido** na coexistência: o número já está registrado.
  O onboarding atual não chama — nada a fazer, mas fica registrado para não ser
  reintroduzido.
- **Sincronização de histórico e contatos**: `POST /{PHONE_NUMBER_ID}/smb_app_data`
  com `messaging_product=whatsapp` e `sync_type=history` (mensagens) ou
  `sync_type=smb_app_state_sync` (contatos). Responde `request_id`. Só funciona na
  **janela de 24h após o onboarding**. **Fora de escopo** desta spec (decisão do dono).
- **Campos de webhook**: `history`, `smb_app_state_sync`, `smb_message_echoes`.
  Marcados no App Dashboard (App Dashboard > WhatsApp > Configuration); a chamada
  `POST /{WABA_ID}/subscribed_apps` (`webhook-subscription.ts:76`) inscreve o app na
  WABA, mas não escolhe campos.
- **Payload do eco** (`field: "smb_message_echoes"`):

  ```json
  { "object": "whatsapp_business_account",
    "entry": [{ "id": "<WABA_ID>", "changes": [{
      "field": "smb_message_echoes",
      "value": { "messaging_product": "whatsapp",
                 "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
                 "message_echoes": [{ "from": "<NUMERO DO NEGOCIO>",
                                      "to": "<NUMERO DO CLIENTE>",
                                      "id": "<wamid>", "timestamp": "...",
                                      "type": "text" }] } }] }] }
  ```

  A Meta manda o mesmo campo para envio, **edição e revogação** de mensagem.
- **Limites da coexistência**: throughput fixo de 20 mps; sem verificação de negócio
  padrão; sem selo OBA; número COEX não migra entre WABAs; o dono precisa abrir o
  Business App a cada 13 dias e não pode desinstalar; app ≥ 2.24.17.

### Divergência a provar antes de depender

A página de onboarding de coexistência afirma: *"If `is_on_biz_app` is true and
`platform_type` is `CLOUD_API`, the business phone number is able to use Cloud API
and the WhatsApp Business app"*. A referência do node de número de telefone **não
lista** esses dois campos — lista `host_platform` (`CLOUD_API`/`ON_PREMISE`/`NOT_APPLICABLE`).

A mesma contradição vale para o evento de signup: a página de onboarding diz que o
evento devolve WABA ID **e** phone number ID; o payload de exemplo de
`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` traz só `waba_id`.

**Consequência de design:** nenhum dos dois pode ser pressuposto. A primeira tarefa
do plano é uma chamada real à Graph v25.0 que decide qual campo existe. O código
tem caminho para os dois casos.

## Decisões (brainstorm de 2026-08-18)

| # | Decisão | Motivo |
|---|---|---|
| 1 | Escopo: conexão + eco. Sem `smb_app_data` (histórico/contatos). | YAGNI. O eco é o que resolve o risco de produto; o import em massa traz risco próprio (disparar fluxo sobre conversa velha) sem demanda. |
| 2 | Eco pausa **IA e fluxos** do lead, com prazo. | Fluxo agendado é justamente o que fala de madrugada por cima do humano. Pausar só a IA deixa o furo aberto. |
| 3 | Prazo de 24h em `global_settings`, sem UI; botão "devolver para a IA" na conversa. | Escape manual sem construir tela de configuração que ninguém pediu. |
| 4 | Bolha marcada como "pelo celular" + faixa avisando da pausa. | O operador precisa entender por que o robô se calou; senão vira chamado de suporte. |
| 5 | Eco de número sem lead: **ignorar e logar**, igual ao inbound. | Coerência com `inbound-orchestrator.ts:138` e proteção da base — em coexistência o dono também fala com contato pessoal, entregador e grupo de família. |
| 6 | Gate no fundo do funil (`execute-flow` e `ai-agent-reply`), não na entrada. | `process-flows` chama `execute-flow` direto a partir de `flow_executions`, sem passar pelo webhook. Gate na entrada não veria isso. |

## Arquitetura

### Modelo de dados

Migration aditiva. O índice único é seguro agora: a tabela tem 5 linhas e 0
duplicatas (verificado acima).

```sql
alter table public.messages
  add column if not exists origin text
  check (origin is null or origin in ('crm', 'business_app'));

alter table public.leads
  add column if not exists human_takeover_until timestamptz;

create index if not exists leads_human_takeover_idx
  on public.leads (human_takeover_until)
  where human_takeover_until is not null;

create unique index if not exists messages_user_wamid_uidx
  on public.messages (user_id, whatsapp_id)
  where whatsapp_id is not null;
```

`origin` nulo significa legado ou envio do CRM; só o eco grava `'business_app'`.
Sem backfill: dado histórico é congelado no momento do fato, e nulo já carrega a
informação necessária.

O índice único é cinto sobre suspensório. O dedupe por `whatsapp_id` já existe em
código, mas é `SELECT` seguido de `INSERT`: duas entregas simultâneas do mesmo eco
passam pelas duas verificações. O insert do eco usa `on conflict do nothing`.

`whatsapp_connections.coexistence_enabled` já existe; passa a ser escrita.

### Módulos

Quatro módulos novos e pequenos, cada um com um propósito. Dois deles saem de dentro
do `inbound-orchestrator.ts` — o arquivo de 811 linhas perde peso em vez de ganhar.

- **`_shared/whatsapp/lead-resolver.ts`**
  `resolveLead(client, tenantId, phone) → { kind: 'found', lead } | { kind: 'none' } | { kind: 'ambiguous', count }`.
  Extraído de `inbound-orchestrator.ts:128-160`, com `phoneVariants` (nono dígito) e
  o corte em `.limit(3)` preservados. O inbound passa a chamá-lo — comportamento
  idêntico, provado por teste antes e depois.

- **`_shared/whatsapp/message-dedupe.ts`**
  `isAlreadyRegistered(client, tenantId, wamid) → boolean`. Extraído de
  `inbound-orchestrator.ts` (≈100-120).

- **`_shared/whatsapp/human-takeover.ts`**
  `isUnderHumanTakeover(lead, now) → boolean` (puro, testável sem banco);
  `startHumanTakeover(client, leadId, hours, now)`; `endHumanTakeover(client, leadId)`.

- **`_shared/whatsapp/echo-handler.ts`**
  Orquestra o eco e nada mais.

### Fluxo do eco

1. `parseWebhook` (`meta-provider.ts`) passa a rotear por `field`: `"messages"` como
   hoje, `"smb_message_echoes"` lê `value.message_echoes[]`, qualquer outro campo
   segue descartado. Novo retorno: `{ inbound, statuses, echoes, phoneNumberId }`.
2. `meta-whatsapp-webhook` resolve o tenant pelo `phone_number_id` (caminho que já
   existe) e chama `handleEcho` por eco.
3. `handleEcho`:
   1. dedupe por wamid → `{ ignored: 'duplicate' }`;
   2. `resolveLead(to)` → `none` ou `ambiguous` logam e retornam ignorado;
   3. insere em `messages`: `direction: 'outbound'`, `origin: 'business_app'`,
      `status: null`, `whatsapp_id: wamid`, `content` do texto;
   4. `startHumanTakeover(lead.id, horas, now)`.

**A inversão que o parser tem que acertar:** no eco, o lead é o **`to`**. O `from` é
o número do próprio negócio. Tratar eco como inbound criaria um lead fantasma com o
telefone da empresa.

Contrato:

```ts
interface EchoMessage {
  providerMessageId: string;   // wamid
  toPhone: string;             // cliente, só dígitos
  type: InboundMessageType;    // reusa KNOWN_TYPES
  text?: string;
  timestamp: string;
}
```

Edição e revogação de mensagem chegam no mesmo campo. O MVP ignora e loga
`echo_unsupported_operation` — tratá-las é feature própria.

### Gates de pausa

Nos mesmos três pontos onde `assertLeadCanReceiveMarketing` já é chamado.

- **`ai-agent-reply/index.ts:130`** — pausa ativa devolve 200 com
  `{ success: true, paused: 'human_takeover' }`. Sem turno, sem token, sem custo.
  Não é erro: é silêncio deliberado.
- **`execute-flow/index.ts:324` e `:564`** — pausa ativa **com** `execution_id`:
  grava `flow_executions.scheduled_at = human_takeover_until`, mantém
  `status: 'running'` e retorna sem enviar. `process-flows` recolhe a execução
  depois que a pausa vence e o fluxo continua de onde parou, em vez de morrer.
  Sem `execution_id` (início direto de fluxo) não há o que reagendar: aborta e loga.
- **`is_test: true` fura o gate.** Teste do editor é o dono clicando de propósito;
  não pode ser silenciado pela pausa que ele mesmo criou.

Prazo: `global_settings.human_takeover_hours`, default `24`, lido por
`getGlobalSetting`.

### Onboarding de coexistência

Três correções em `signup-onboarding.ts`:

1. **Escolha do número.** `numbers[0]` sai. Ordem: usa o `phone_number_id` do evento
   quando vier; senão, lista de um número resolve sozinha; **mais de um número sem
   dica → `HttpError(409)` explícito** listando os números encontrados. Conectar o
   número errado em silêncio é pior do que falhar.
2. **Gravar `coexistence_enabled`.** Fonte preferida é o servidor:
   `GET /{waba_id}/phone_numbers` pedindo `is_on_biz_app` e `platform_type`. Se a
   Graph aceitar, esse valor manda. Se rejeitar (erro 100 de campo desconhecido),
   o fallback é o sinal do evento, enviado pelo front no body — registrado como
   dado do cliente, portanto informativo e nunca base para decisão de segurança.
3. **Campos de webhook.** Item de checklist manual (App Dashboard), com verificação
   objetiva: eco real aparecendo no log.

### UI

`src/pages/Conversas.tsx`:

- bolha `outbound` com `origin === 'business_app'` ganha marca 📱 "pelo celular";
- `DeliveryStatus` (linha 23) não renderiza para essa bolha. A Meta não emite
  `statuses` para mensagem enviada pelo app: o status fica nulo e o ícone sumiria
  de qualquer forma. Melhor explícito que acidental;
- faixa no topo da conversa enquanto a pausa vale, com tempo restante e botão
  "Devolver para a IA" → `endHumanTakeover`.

`src/hooks/use-conversations.ts` passa a selecionar `origin` (linha ≈95) e o
`human_takeover_until` do lead.

A implementação da UI invoca a skill `frontend-design`, conforme CLAUDE.md.

## Testes (TDD: vermelho antes de verde)

Unitários, sem rede, sem banco onde possível:

- **parser**: eco com `to`/`from` invertidos; tipo desconhecido; edit/revoke
  ignorados; `field` alheio segue descartado; **eco não vaza para `inbound[]`**
  (regressão que quebraria produção).
- **lead-resolver**: variantes de nono dígito, ambíguo, ausente — comportamento
  idêntico ao de hoje depois da extração.
- **message-dedupe**: wamid conhecido e desconhecido.
- **echo-handler**: duplicado; lead ausente; lead ambíguo; grava `origin`;
  carimba o prazo.
- **human-takeover**: pausa ativa, expirada, nula; `is_test` fura o gate;
  `execute-flow` reagenda em vez de abortar quando há `execution_id`.
- **onboarding**: escolhe pelo id do evento; lista de um; erro 409 com mais de um
  sem dica; grava `coexistence_enabled` pelos dois caminhos (Graph e fallback).

## Verificação (nada é declarado pronto sem isto)

1. `npm run lint`, typecheck e suíte unitária verdes, com a saída colada.
2. Migration aplicada em produção e as quatro alterações conferidas por query.
3. Functions deployadas.
4. Mensagem real enviada **do celular** para um lead de teste, e então:
   eco no log; bolha marcada na tela; `human_takeover_until` gravado;
   `ai-agent-reply` recusando com `paused`; execução agendada reaparecendo depois
   que a pausa vence.
5. Conexão de coexistência real gravando `coexistence_enabled = true`.

## Fora de escopo

- `POST /smb_app_data` (histórico e contatos) e a janela de 24h.
- Criação automática de lead a partir de eco de número desconhecido.
- Edição e revogação de mensagem vindas do app.
- Tela de configuração do prazo de pausa.
- Troca do `display_name` "Teste" e do perfil do número (WhatsApp Manager, fora do código).

## Riscos

- **Campo `is_on_biz_app` pode não existir** na v25.0. Mitigado pelo fallback e pela
  chamada real na primeira tarefa do plano.
- **Extrair código do orquestrador mexe no caminho crítico** que hoje funciona em
  produção. Mitigado por teste de equivalência antes da extração: o inbound continua
  passando na suíte existente sem alteração de comportamento.
- **Índice único em `messages`** transforma duplicata silenciosa em erro. Mitigado
  pelo `on conflict do nothing` no insert do eco e pelas 0 duplicatas atuais.
- **Coexistência exige o dono abrir o Business App a cada 13 dias.** Nada a fazer em
  código; é aviso de operação para quem for vender o recurso.
