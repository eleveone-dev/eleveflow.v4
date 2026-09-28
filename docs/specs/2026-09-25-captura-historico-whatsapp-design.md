# Spec — Captura do histórico do WhatsApp (parte A da integração com o Eleve Office)

Data: 2026-09-25
Status: desenho aprovado pelo dono em 2026-09-25 (decisões no fim). Não implementado.
Escopo: repositório `eleve.flow2`, projeto Supabase `xlycuunqpgpyfmafgajr` (produção),
servidor Evolution `evolutionapi.prismasolucoes.art` (só leitura, só a nossa instância).

## Contexto

O Eleve Office vai ter dois agentes lendo o EleveFlow: o **Agente SDR** (leads, chat e
pipeline, até o fechamento) e o **Nexo** (tarefas e lembretes). O pedido de 2026-09-25
foi dividido em quatro partes, cada uma com spec, plano e implementação próprios:

| parte | o quê | depende de |
|---|---|---|
| **A** | captura do histórico do WhatsApp (esta spec) | — |
| B | leitura comercial: tokens com escopo, leads, mensagens, eventos de etapa, sincronização incremental, OpenAPI | A |
| C | tarefas: escrita com idempotência e controle de conflito | B (tokens) |
| D | lembretes pessoais: registro no EleveFlow, entrega pelo Office | B, C |

A vem primeiro porque nenhuma API lê o que não foi gravado, e hoje metade de cada
conversa se perde na entrada.

## Estado atual (verificado em 2026-09-25)

Conta Eleve One (`14448933-86df-47d4-a082-df69dbddeff1`), WhatsApp pela Evolution.

**O que o CRM guarda:** 1.435 mensagens recebidas, 1.708 enviadas por fluxo ou IA (432
delas `pending` herdadas do app antigo) e **nenhuma enviada por humano**. Desde 19/09,
85 recebidas de 39 leads.

**O que se perde na entrada** (`supabase/functions/_shared/whatsapp/evolution-parse.ts`):

- `fromMe` é descartado. Mensagem que o vendedor manda pelo celular ou pelo WhatsApp Web
  não entra no CRM. Com a Meta existia o eco (`echo-handler.ts`), que gravava como
  `business_app` e pausava IA e fluxos por 24 h; com a Evolution isso não acontece.
- Mídia sem legenda (áudio, figurinha, localização, imagem sem texto) é descartada.
  Mídia com legenda vira texto, sem registro do tipo.
- Mensagem de grupo passa pelo inbound até `webhook_lead_not_found`: 1.164 logs em 4
  dias, de 2 grupos.

**O que a Evolution guarda** (consulta só leitura na nossa instância): banco Postgres com
`DATABASE_SAVE_DATA_NEW_MESSAGE`, `DATABASE_SAVE_MESSAGE_UPDATE` e
`DATABASE_SAVE_DATA_HISTORIC` ligados. 11.522 mensagens `fromMe` (28/01 a 25/09) e mais
de 20 mil recebidas, de todas as conversas do número:

- enviadas pelo celular (`source` android/ios): 2.420 textos e 1.219 mídias em conversas
  identificadas por telefone; 739 textos e 131 mídias em conversas `@lid`;
- das 1.811 conversas individuais, 1.654 são `@lid` e só 45 trazem `remoteJidAlt`;
- **105 conversas casam com lead pelo telefone**, de 03/09 a 25/09; nelas o vendedor
  mandou 4 textos pelo celular.

`source = web` mistura os nossos envios pela API (ids `3EB0…`) com o WhatsApp Web: não
separa humano de automação sozinho.

**A pausa humana não vale para a fila.** `shouldSkipAutomation` é checado no
`execute-flow` e no `ai-agent-reply`, mas o `process-queue` envia item de lead em pausa.
Com o disparo humanizado, um item pode ficar minutos na fila.

**Corrida com os nossos envios.** O `process-queue` grava o `key.id` da Evolution em
`messages.whatsapp_id` pelo `complete_marketing_queue_delivery`, que só trata conflito
em `queue_item_id`. Se o eco de um envio nosso chegasse antes e fosse gravado como
humano, o índice único `messages_user_wamid_uidx` derrubaria a entrega.

## Desenho

### 1. Dados (migration aditiva)

- `messages.media_type text`, com check em `audio`, `image`, `video`, `document`,
  `sticker`, `location`, `contact`, `other`. `null` é texto.
- Mídia sem legenda grava `content = ''`. Nenhuma transcrição é criada ou suposta.
- `origin = 'business_app'` passa a significar "enviada fora do CRM, pelo aparelho
  (celular ou WhatsApp Web)". O check atual já aceita o valor.

### 2. Parse da Evolution

`parseEvolutionWebhook` passa a devolver `inbound` e `echoes`:

- **Ignorados antes de tudo:** JID de grupo (`@g.us`), canal (`@newsletter`) e
  transmissão (`@broadcast`, inclusive `status@broadcast`).
- **Telefone:** JID `@lid` usa o telefone de `key.remoteJidAlt`; sem ele, a mensagem é
  ignorada sem registrar o número. Os demais usam `stripJid(remoteJid)`, como hoje.
- **Envelopes desembrulhados** (um nível): `ephemeralMessage`, `viewOnceMessage`,
  `viewOnceMessageV2`, `documentWithCaptionMessage`, `associatedChildMessage`.
- **Tipo:** `conversation`/`extendedTextMessage` → texto; `imageMessage` → `image`;
  `videoMessage` → `video`; `documentMessage` → `document`; `audioMessage` → `audio`;
  `stickerMessage` → `sticker`; `locationMessage`/`liveLocationMessage` → `location`;
  `contactMessage`/`contactsArrayMessage` → `contact`. Legenda de imagem, vídeo e
  documento vira o texto. Qualquer outro tipo (protocolo, reação, edição, apagamento,
  enquete, botões, contêiner de álbum) continua ignorado.
- `fromMe = true` vira **eco**; `fromMe = false`, **inbound**.

### 3. Eco (`echo-handler.ts`), agora também para a Evolution

Na ordem:

1. Dedupe por `whatsapp_id` (já existe).
2. Resolve o lead pelo telefone. Não é lead: ignora e registra
   `echo_lead_not_found` **sem o número** — o aparelho conversa com muita gente que não
   é lead.
3. **Guarda de envio próprio:** se o lead tem item em `send_queue` com
   `status = 'sending'` e `sending_at` nos últimos 2 minutos, é envio nosso em curso;
   ignora com `own_send_in_flight` e deixa a entrega gravar. O
   `complete_marketing_queue_delivery` grava mensagem e status na mesma transação, então
   depois dele o dedupe do passo 1 cobre.
4. Grava `direction = 'outbound'`, `origin = 'business_app'`, `media_type`, texto ou
   `''`, `status = null`.
5. Pausa IA e fluxos do lead por `human_takeover_hours` (24 h), como já faz.

Limite aceito: mensagem humana mandada pelo aparelho ao mesmo lead nos mesmos segundos
de um envio nosso em curso é ignorada.

### 4. Pausa também na fila

O `process-queue`, antes de enviar, lê `human_takeover_until` do lead. Em pausa (e lead
que não é de teste), o item de **automação** volta a `pending` com `scheduled_at` no fim
da pausa e fica registrado `queue_item_deferred_takeover` em `logs`. Mesma regra do
`execute-flow` (`rescheduleForTakeover`).

Automação é item com `flow_id` — fluxo, sequência e resposta da IA sempre gravam.
Item sem `flow_id` é o próprio vendedor escrevendo pela tela de Conversas e sai
normalmente: a pausa cala a automação, não quem ela protege. (Achado na revisão antes do
deploy, 2026-09-25.)

### 5. Mídia recebida

- **Com legenda:** segue o caminho de hoje (a legenda vai para IA, fluxo e opt-out) e
  grava também o `media_type`.
- **Sem legenda:** só grava a mensagem (`status = 'received'`, `content = ''`,
  `media_type`). IA, fluxos, classificação de etapa e opt-out não reagem — como hoje,
  mas a mensagem passa a existir no histórico, na tela e nas APIs.

### 6. Tela de Conversas

- Mídia aparece pelo tipo: "Áudio · não transcrito", "Imagem", "Vídeo", "Documento",
  "Figurinha", "Localização", "Contato". Com legenda, a legenda aparece junto.
- Mensagem `business_app` mantém o selo de enviada pelo aparelho.
- Implementação com a skill `frontend-design`.

### 7. Recuperação do histórico (script único)

`scripts/recuperar-historico-evolution.mjs`, com modo ensaio (só contagens) e modo real.

1. **Extração, dentro do container da Evolution** (`node -`, só leitura, só a instância
   da Eleve One): recebe pela entrada os telefones dos leads e devolve só mensagens de
   conversas que casam com lead. O casamento compara DDD + 8 dígitos finais, porque o
   celular aparece com e sem o nono dígito. Conversa pessoal não sai do servidor.
2. **Importação, com a chave de serviço:**
   - dedupe por `whatsapp_id`;
   - recebida que falta: `direction = 'inbound'`, `status = 'received'`, `media_type`,
     `created_at` da mensagem original;
   - enviada pelo aparelho (`source` android ou ios): `origin = 'business_app'`,
     `status = null`;
   - enviada `web`/`unknown` que não está no CRM: **fica de fora e é contada** — pode ser
     envio automático antigo ou WhatsApp Web, e origem inventada é pior que ausente;
   - não pausa lead, não aciona IA nem fluxo, não copia texto para `logs`.
3. Relatório: casadas, importadas por tipo, duplicadas, puladas por origem ambígua.

Conversas `@lid` sem telefone ficam fora (ver "Fora de escopo").

### 8. Efeito no sales-coach

O contrato não muda. Lead respondido pelo aparelho deixa de aparecer em
`follow_ups_atrasados`, porque a resposta passa a existir. Se a última mensagem do lead
for mídia sem legenda, `ultima_msg_do_lead` vem vazio.

## Testes

Unitários:

- parse: `fromMe` de texto e de áudio viram eco; imagem com legenda vira inbound com
  tipo e texto; áudio sem legenda vira inbound com texto vazio; grupo, canal e
  transmissão ignorados; `@lid` com `remoteJidAlt` usa o telefone; `@lid` sem ele é
  ignorado; protocolo e reação ignorados; envelopes desembrulhados.
- eco: guarda de envio próprio (item `sending` de 1 min ignora; de 3 min não), grava
  `media_type`, lead não encontrado não loga telefone.
- orquestrador: mídia sem legenda grava e não chama IA nem fluxo; com legenda segue e
  grava o tipo.

E2E contra produção (usuário de E2E, instância fictícia, como a suíte atual):

- webhook com `fromMe` → mensagem `business_app` e `human_takeover_until` ~24 h à frente;
- áudio sem legenda → mensagem com `media_type = 'audio'`, sem item na fila e sem
  chamada de LLM;
- mensagem de grupo → 200 ignorada, sem linha em `logs`;
- item de automação de lead em pausa → reagendado para o fim da pausa, não enviado;
- mensagem do vendedor pela tela, com o lead em pausa → não é adiada;
- `tests/e2e/sales-coach.spec.ts` continua verde.

## Fora de escopo

- Transcrição, análise ou download de mídia.
- Status de entrega da Evolution (`MESSAGES_UPDATE`): as enviadas continuam `sent`.
- Recuperação de conversas `@lid` sem telefone (até 739 textos e 131 mídias do
  aparelho): exige mapear LID para telefone; fica como investigação à parte.
- Texto de resposta a botão e lista, edição e apagamento de mensagem.
- Tirar o texto da mensagem do log `message_received` (débito anotado; é da parte B,
  que trata auditoria).

## Implantação

Tudo com OK do dono antes:

1. Migration (`db push`).
2. Deploy de `whatsapp-webhook` e `process-queue`.
3. Frontend (tela de Conversas) na Vercel.
4. Recuperação: ensaio, relatório ao dono, depois modo real.
5. Conferência em produção: mensagens `business_app` e mídia aparecendo com tráfego
   real; nenhum `webhook_lead_not_found` de grupo; E2E verde.

## Decisões do dono (2026-09-25)

1. **Ordem:** A → B → C → D.
2. **Mensagem do aparelho:** grava e pausa IA e fluxos do lead por 24 h.
3. **Recuperação:** importar o que casa com lead pelo telefone, com deduplicação.
4. **Desenho aprovado**, inclusive a fila reagendando item de lead em pausa.
