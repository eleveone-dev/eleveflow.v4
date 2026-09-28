# STATUS

> Atualização de retomada: 2026-09-26. Esta seção substitui o status operacional
> anterior quando houver conflito.

## Integração com o Eleve Office: parte C no ar (2026-09-26)

Tarefas pela `office-api` para o Nexo. Spec: `docs/specs/2026-09-25-tarefas-office-design.md`
(esclarecimentos da implementação no fim). Plano: `docs/plans/2026-09-25-tarefas-office.md`.
Guia do Office: `docs/api/office-api.md` (seção Tarefas). Contrato: `openapi.json` 1.1.0,
com `operationId` em toda operação.

**No ar:**

- Rotas `GET`/`POST /v1/tarefas`, `GET`/`PATCH /v1/tarefas/{id}` e
  `POST /v1/tarefas/{id}/entrega`, escopo por método (`tarefas:leitura` lê,
  `tarefas:escrita` grava). Criação idempotente (`Idempotency-Key`: 201, e 200 na
  repetição), conflito por versão (`If-Match`: 412 com a tarefa atual, 428 sem ele),
  status só entre pendente e em andamento (409 fora disso), entrega leva a
  `aguardando_revisao`. Nenhuma rota conclui, apaga ou reabre; 405 traz `Allow`.
- `personal_tasks` ganhou lead, criador, responsável (agente pela `ref` do Office),
  origem, ordem externa, resultado, versão e chave de idempotência; status
  `aguardando_revisao`. Triggers: versão, lead da conta, histórico
  (`personal_task_history`: ator `api:<rótulo>`, `tela` ou `sistema`; nomes de campo e
  status, sem texto) e tombstone `task`.
- `GET /v1/exclusoes` aceita `comercial:leitura` ou `tarefas:leitura`; cada escopo vê as
  entidades dele. O token comercial vê o mesmo de antes.
- Tela Minhas Tarefas: grupo "Esperando sua revisão" com Concluir e Devolver, resultado e
  link, origem, agente e lead no cartão, filtro "Para revisar".
- Tokens: `Nexo` (Eleve One, `tarefas:leitura` e `tarefas:escrita`, texto entregue ao
  dono uma vez) e `E2E tarefas` (`STAGING_OFFICE_TOKEN_TAREFAS`).

**Verificado:** unit 50 arquivos, 593 testes (cobertura 95% de linhas, 85% de branches).
Contrato válido no Redocly, sem aviso. Antes do push, ensaio da migration em produção
dentro de um comando desfeito (API, tela com RLS, histórico e tombstone; nada ficou). E2E
contra produção: os de tarefas falharam antes do deploy pelo motivo certo (404) e passaram
depois; **23 passed** (8 de tarefas, 8 da `office-api`, 7 do `sales-coach`). Tela
conferida em produção na conta E2E, com fotos: Devolver e Concluir gravam o status certo
com ator `tela`. Token do Nexo: lê as 5 tarefas do dono (versão 1) e leva 403 em leads.

**Pendente:** instalar o token do Nexo no Office e a primeira chamada dele; o teste entre
os dois sistemas (o Nexo cria, altera e entrega uma tarefa de verdade, e o dono conclui na
tela); a primeira chamada do Agente SDR com o token comercial (`last_used_at` ainda
vazio). Visto na conferência, fora desta parte: no celular o menu lateral ocupa mais da
metade da tela em qualquer página (layout do app).

**Retomada:** parte D (lembretes) não começou: brainstorming, spec, plano. O canal de
entrega é decisão do dono; não implementar WhatsApp ou e-mail por suposição.

## Integração com o Eleve Office: parte B no ar (2026-09-25)

API de leitura comercial para o Agente SDR. Spec:
`docs/specs/2026-09-25-api-leitura-comercial-office-design.md`. Plano:
`docs/plans/2026-09-25-api-leitura-comercial-office.md`. Guia do Office:
`docs/api/office-api.md`. Contrato: `supabase/functions/office-api/openapi.json`, também
em `GET .../office-api/v1/openapi.json` (sem token).

**No ar:**

- `office-api` em `https://xlycuunqpgpyfmafgajr.supabase.co/functions/v1/office-api/v1/`:
  `leads`, `leads/{id}`, `leads/{id}/mensagens`, `leads/{id}/etapas` e os feeds
  `mensagens`, `etapas` e `exclusoes`, com cursor opaco. Escopo `comercial:leitura`,
  120 chamadas por minuto por token, auditoria em `api_request_log` (90 dias).
- Tokens em `api_tokens` (hash, conta, escopos, limite). O token do Eleve Office e o de
  E2E foram importados com `comercial:leitura`; o segredo `SALES_COACH_TOKENS` foi
  apagado. Criar ou importar token: `scripts/criar-token-api.ts`. Revogar: preencher
  `revoked_at`.
- `sales-coach` lê o token da tabela; contrato igual.
- Resposta da IA passa a ser gravada com `origin = 'ia'` (`send_queue.origin` copiado
  pela entrega); evento de etapa guarda nome e tipo da época em `metadata`;
  `messages.inserted_at` é o cursor do feed; exclusão de lead e mensagem vira tombstone
  em `api_deleted_records`.

**Verificado:** unit 47 arquivos, 560 testes. Corpos SQL validados só com leitura em
dado real antes do push. E2E contra produção: **25 passed** (8 da `office-api`: escopo,
401/403/405/400, 429 com `Retry-After`, isolamento entre duas contas, paginação sem
perda nem repetição com mensagens no mesmo instante, ordem cronológica, origem IA,
perda/reabertura/ganho com nome da época, lead importado perdido sem `fechado_em`,
exclusões sem duplicar a cascata; 7 do `sales-coach` antes e depois de apagar o
segredo; 10 do webhook). `openapi.json` sem token → 200.

**Pendente:** a primeira chamada do Office com o token dele (`last_used_at` ainda vazio
na importação); um envio real pela fila depois da migration da entrega (no intervalo da
conferência não houve envio; o caminho foi exercitado pelo E2E da origem IA).

**Tokens de E2E** (texto só no `.env.staging`): `STAGING_OFFICE_TOKEN_CONTA_B`
(`admin@eleveflow.test`), `STAGING_OFFICE_TOKEN_SEM_ESCOPO` e
`STAGING_OFFICE_TOKEN_LIMITE` (limite 3/min).

## Integração com o Eleve Office: parte A no ar (2026-09-25)

O pedido de 2026-09-25 (Agente SDR e Nexo lendo o EleveFlow) foi dividido em quatro
partes, cada uma com spec, plano e implementação: **A** captura do histórico do
WhatsApp → **B** leitura comercial (tokens com escopo, leads, mensagens, eventos de
etapa, sincronização, OpenAPI) → **C** tarefas → **D** lembretes. A, B e C estão no
ar; D não começou.

Spec: `docs/specs/2026-09-25-captura-historico-whatsapp-design.md`.
Plano: `docs/plans/2026-09-25-captura-historico-whatsapp.md` (com um desvio registrado).

**O que se perdia antes** (medido na Eleve One):

- Com a Evolution, mensagem `fromMe` era descartada: o que o vendedor manda pelo celular
  ou pelo WhatsApp Web não entrava no CRM (0 mensagens humanas gravadas). A pausa de IA
  e fluxos quando o dono fala, que existia na Meta, também tinha sumido.
- Mídia sem legenda era descartada; com legenda virava texto sem tipo.
- Mensagem de grupo passava pelo inbound: 1.164 `webhook_lead_not_found` em 4 dias, de
  2 grupos.
- A pausa não valia para a fila: automação já enfileirada saía com o vendedor falando.

**No ar:**

- Migration `20260925135525`: `messages.media_type` (`audio`, `image`, `video`,
  `document`, `sticker`, `location`, `contact`, `other`; `null` é texto).
- `whatsapp-webhook`: `fromMe` vai para o `handleEcho` (grava `business_app` e pausa IA
  e automação do lead por 24 h); mídia com tipo; grupo, canal e transmissão ignorados;
  `@lid` só com `remoteJidAlt`. Guarda de envio próprio: item da fila em `sending` há
  menos de 2 min para o mesmo lead é envio nosso, e quem grava é a entrega.
- `process-queue`: automação (item com `flow_id`) de lead em pausa volta para o fim da
  pausa e deixa `queue_item_deferred_takeover` em `logs`. Mensagem do vendedor pela tela
  de Conversas (sem `flow_id`) sai normalmente.
- Conversas: mídia aparece pelo tipo ("Áudio · não transcrito" etc.). Deployment
  `eleveflow-5rwff6b6l`, alias `eleveflow-tan.vercel.app` reapontado, bundle aponta só
  para `xlycuunqpgpyfmafgajr`.
- Recuperação do histórico (`scripts/recuperar-historico-evolution.ts`): 3 mensagens
  inseridas (2 do aparelho, 1 contato); 297 já estavam no CRM; 44 enviadas pela web
  ficaram de fora por origem ambígua. O ensaio seguinte deu 0 a inserir.

**Verificado:** unit 42 arquivos, 533 testes. E2E contra produção: **17 passed** (10 do
webhook, 7 do sales-coach). Os 5 E2E novos falhavam antes do deploy pelo motivo certo;
o da mensagem manual passa antes e depois (é guarda de regressão).

**Confirmado com tráfego real (2026-09-25):** às 15:31 UTC uma mensagem que o vendedor
mandou pelo aparelho entrou como `business_app` (com `whatsapp_id`) e pôs o lead em
pausa; às 15:51 UTC um áudio de lead entrou como `media_type = audio` com texto vazio.
Desde o deploy, nenhum `webhook_lead_not_found` (antes, ~31 por hora, dos grupos).

**Achados no caminho:**

- A Evolution guarda o histórico inteiro do número (`DATABASE_SAVE_*` ligados): 11.522
  mensagens `fromMe` desde 28/01. Das 1.811 conversas individuais, 1.654 são `@lid` sem
  telefone; só 105 casam com lead pelo telefone.
- A revisão antes do deploy pegou um defeito do plano: o envio manual da tela também
  passa pela fila, e a primeira versão adiaria a resposta do próprio vendedor. Corrigido
  com `queueDeferralUntil` (commit `ef20139`).

**Débitos novos:** o log `message_received` copia o texto da mensagem (tratar na parte
B, com a auditoria); conversas `@lid` sem telefone não são recuperáveis sem mapear LID
para telefone; status de entrega da Evolution (`MESSAGES_UPDATE`) não é consumido.

## Sales Coach: API de leitura no ar (2026-09-24)

Spec: `docs/specs/2026-09-23-sales-coach-api-design.md` (decisões 1 a 4).
Plano: `docs/plans/2026-09-24-sales-coach-api.md` (Tasks 1 a 5 feitas; na 6, falta o
aceite do lado do Eleve Office).

**No ar:**

- `GET https://xlycuunqpgpyfmafgajr.supabase.co/functions/v1/sales-coach`, com
  `Authorization: Bearer efsc_…` (token nosso, `verify_jwt = false`). Parâmetros:
  `periodo_dias` (30, 1–90), `parado_dias` (7, 1–90), `followup_horas` (24, 1–720),
  `limite` (50, 1–200). Só lê.
- `public.sales_coach_snapshot` (migration `20260924192907`): `STABLE`,
  `SECURITY INVOKER`, `search_path=""`. ACL conferido depois do push:
  `postgres=X/postgres service_role=X/postgres`, sem `anon`, `authenticated` nem
  PUBLIC.
- Segredo `SALES_COACH_TOKENS` = `{"<sha256 hex do token>": "<user_id>"}`, com dois
  hashes: o token de E2E (conta `e2e@eleveflow.test`; texto no `.env.staging`, como
  `STAGING_SALES_COACH_E2E_TOKEN`) e o token do Eleve Office (conta Eleve One,
  `14448933-…`; texto só com o dono e no servidor do Eleve Office).

**Verificado:**

- Unit: 40 arquivos, 492 testes. `sales-coach.ts` com 100% de linhas, branches e
  funções.
- E2E `tests/e2e/sales-coach.spec.ts` contra produção: **7 passed**. Cobre 401 sem
  token e com token errado (mesmo corpo), 405 no POST, 400 em `limite=0`, lead
  semeado com inbound de 30 h em `follow_ups_atrasados`, isolamento (todo
  `lead_id` devolvido é da conta do token, conferido no banco) e RPC direta negada
  com `42501` para usuário logado e anônimo. Antes do deploy os 7 falhavam (`404` e
  `PGRST202`).
- Smoke: `sem token: 401`, `com token: 200`.

**Pré-requisito feito:** `funnel_key` das etapas da Eleve One marcadas por SQL, a
pedido do dono. São 8 etapas; "Respondeu" e "lead morno / vai comprar" ficam sem
chave. Isso também conserta o card de funil do Dashboard, que contava "Não tem
Interesse" como Interessado.

**Decisão do dono (spec, decisão 4):** listas do atraso mais recente para o mais
antigo, mais `totais`. Medido na Eleve One: 219 follow-ups atrasados e 454
parados. Na ordem da spec original, o coach recebia só conversas de 73–100 dias.

**Token: gerar, trocar, revogar.**

```bash
node -e "const c=require('node:crypto');const t='efsc_'+c.randomBytes(32).toString('base64url');console.log(t);console.log(c.createHash('sha256').update(t).digest('hex'))"
```

O JSON com aspas não atravessa o `npx.cmd` na linha de comando, então o segredo vai
por arquivo: `printf "SALES_COACH_TOKENS='{\"<hash>\":\"<user_id>\"}'\n" > tmp.env`,
depois `bash scripts/sb-staging.sh secrets set --env-file tmp.env` e `rm tmp.env`.
O `secrets set` **substitui o valor inteiro**: repetir todos os hashes que continuam
valendo. Revogar é tirar o hash.

**Token do Eleve Office (Task 6):** gerado em 2026-09-24 e mostrado uma vez ao dono,
que escolheu entregar a instalação ao agente do Eleve Office por um prompt (variáveis
`ELEVE_FLOW_SALES_COACH_URL` e `ELEVE_FLOW_SALES_COACH_TOKEN`). Conferido daqui com o
token do Office: `200` em 0,39 s, `"conta": "Eleve One"`, `totais` 220/454/0;
`limite=0` dá `400`; sem token, `401`. E2E de novo com os dois hashes: 7 passed.
**Falta:** o aceite do lado do Eleve Office (401/200/400 de lá, token fora do front e
dos logs).

**Achados no caminho:**

- O primeiro `db push` caiu com `FATAL: (EAUTHQUERY) auth_query secret check timed
  out` no pooler. Conferido que nada foi aplicado; a segunda tentativa passou.
  Falha transitória.
- Rodando num agente, o Vitest 4 liga `skipFull` sozinho e **esconde da tabela de
  texto arquivo com 100% em tudo**. Arquivo ausente da tabela não é arquivo sem
  cobertura: o número real está em `coverage/coverage-final.json`.
- `leads.city` e `leads.state` existem no banco e faltam no `types.ts` (débito de
  tipos defasados, abaixo).
- `E2E_PASSWORD` não existe nesta máquina. O teste do REVOKE pega sessão do usuário
  de E2E por link mágico do admin (`generateLink` + `verifyOtp`), sem senha e sem
  e-mail.

## Saída ligada em mais de um bloco agora roda inteira (2026-09-22)

Achado ao investigar o envio em dobro, corrigido depois a pedido.

**O defeito (commit `d478f5a`):** `findNextBlockId` pegava a primeira edge que
casava com a saída e o motor seguia só aquele ramo. No fluxo "Agente de IA —
Abordagem" a saída Objetivo está ligada em mensagem E em mover etapa: a mensagem
saía e o lead nunca ia para Interessado. Depois da mensagem de Desistiu, o mesmo
(ligada em fim e em mover etapa).

**Como ficou:**

- `findAllNextBlockIds` devolve todos os blocos da MESMA saída, o principal na
  frente. `true`/`false` da condição continuam excludentes; caminho que não veio
  de edge (`config.next_if_*`, `next_block_id`) não tem irmão. 9 testes.
- `execute-flow` percorre o ramo principal e depois os irmãos, na mesma
  invocação: fila de pendentes, guarda de bloco já executado, o limite de 20
  passos de antes.
- **Irmão só entra na fila se o bloco não pausou.** Quem pausa ainda não decidiu
  a saída. Sem essa trava, a abertura do agente disparava tudo que estava
  pendurado no Objetivo antes do lead responder — apareceu no primeiro deploy,
  com a objeção do teste acontecendo duas vezes.
- Ponteiro da execução congela no primeiro ramo que para: é por ele que o fluxo
  retoma quando o lead responde.
- `ai-agent-reply` resolve as saídas do agente e manda os irmãos em
  `parallel_block_ids`.

**E2E:** saída Objetivo ligada em mensagem e em objeção. Objeção, e não mover
etapa, porque o classificador de etapa por IA também move o lead — mover etapa
passaria mesmo com o motor errado (aconteceu: o teste passou por engano antes de
trocar o efeito medido). Falhou contra o código anterior, passou com o novo.

**Ordem verificada em produção** (uma rodada do E2E): `ai_agent_opened` sozinho
na abertura; depois `ai_agent_reply_suppressed`, `flow_completed`,
`objection_created` e `stage_changed` — cada ramo uma vez.

**Bloco vazio parecia configurado (commit `068b1a6`):** o canvas mostrava "Mover
para Estágio" e "Gatilho: Estágio" mesmo sem etapa escolhida. Três blocos "mover
etapa" do fluxo do agente estão assim (o motor passa por eles e não move
ninguém). Agora aparece "Escolher etapa de destino...", etapa apagada vira
"etapa removida", e o motor registra `flow_block_sem_configuracao`.

**Verificado:** unit 479/479; E2E 21 passed, 1 skipped. Frontend publicado
(`eleveflow-q2nmb9vyk`), alias reapontado.

## "Tem hora que está enviando 2 coisas" (2026-09-22)

Relato do usuário testando em produção. Duas causas independentes, as duas
medidas nos logs da conta Eleve One com o lead de teste (…4747).

**1. Saída do agente falava junto com o fluxo (commit `cb58ab8`)**

- Ao decidir `goal`/`giveup`/`limit`, o `ai-agent-reply` enfileirava a resposta
  do LLM e o `execute-flow` seguia pela saída e mandava a mensagem configurada.
- Medido às 12:10: agente "Perfeito! Posso enviar a prévia aqui pelo WhatsApp
  agora ou prefere que eu envie por e-mail?" (12:10:16) e fluxo "Perfeito! vou
  criar demonstração e te envio!" (12:10:22).
- Era o previsto na spec (§4.2, "envia a última reply quando houver"), e a spec
  estava errada para fluxo com mensagem na saída.
- Agora: se o caminho da saída já fala, quem encerra é o fluxo. A resposta do
  agente não sai e o motivo vai para `logs` (`ai_agent_reply_suppressed`).
- `findSpeakingBlockAhead` (`_shared/flow-routing.ts`, 9 testes): mensagem e
  agente falam; mover etapa e objeção são atravessados; espera, condição e fim
  encerram a busca — nada que dependa de tempo ou do lead conta como "fala
  junto". Guarda contra ciclo.

**2. Mudança de etapa inscrevia lead que já estava conversando (commit
`831c4d5`)**

- `trigger-flow-by-stage` só barrava segunda execução do MESMO fluxo.
- O classificador de etapa por IA move o lead a cada mensagem recebida. Com
  "Abordagem + Follow- UP" ativo na etapa Prospecção, o lead em conversa com o
  agente entrava também nesse fluxo (12:02:09 e 12:05:35).
- Pior: o inbound entrega a mensagem à execução MAIS RECENTE, então a resposta
  seguinte do lead foi para a abordagem — a conversa do agente foi sequestrada
  (12:03:41, `webhook_message_queued` label 2).
- Agora: lead com execução `waiting_response` noutro fluxo não entra em fluxo
  novo pela etapa (`flow_stage_trigger_skipped` em `logs`). Execução `running`
  não conta, para não quebrar encadeamento por `move_pipeline`.
- Efeito colateral aceito: enquanto o lead está numa conversa, mudar de etapa
  não inscreve em fluxo novo. Nenhum lead de produção tinha duas execuções
  `waiting_response` quando isto foi medido.

**Verificado:** unit 470/470; E2E 21 passed, 1 skipped (o que exige token real
da Meta). Os dois testes novos falharam contra o código anterior antes de
passarem com o novo. Em produção ficaram registrados `ai_agent_reply_suppressed`
(14:35:03) e `flow_stage_trigger_skipped` (14:35:58).

**Débito achado no caminho, NÃO corrigido — o motor segue uma ligação por
saída:**

- `findNextBlockId` pega a primeira edge que casa. No fluxo "Agente de IA —
  Abordagem" a saída Objetivo liga em mensagem E em mover etapa: só a mensagem
  roda, e o "mover para Interessado" nunca acontece. O mesmo depois da mensagem
  de Desistiu (liga em fim e em mover etapa).
- Três dos quatro blocos `move_pipeline` desse fluxo estão sem `target_stage_id`
  (o bloco vira no-op).
- Correção exigiria fan-out no motor (executar todos os ramos da saída) ou
  bloquear no editor a segunda ligação na mesma saída.

## "Motor do fluxo falhou" no Testar fluxo, e o agente que só abria (2026-09-22)

**Sintoma relatado:** `Motor do fluxo falhou: Edge Function returned a non-2xx
status code` ao clicar em Testar fluxo.

**Causa:** o lead de teste é reaproveitado entre rodadas. Na segunda rodada, a
trigger `prevent_duplicate_send_queue` descartava em silêncio a mensagem que
ele já tinha recebido (RETURN NULL). O `execute-flow` inseria com `.single()`,
a linha ausente virava exceção e o motor devolvia 500. Lead real que volta ao
fluxo caía no mesmo erro, sem ninguém olhando.

**Correção (commits `54070e4`, `0b9c19c`):**

- Insert com `.maybeSingle()`. No teste, devolve 200
  `paused: "duplicate_blocked"` com o motivo. Com lead real, não repete a
  mensagem e segue o fluxo. O descarte vai para `logs` como
  `send_queue_duplicate_blocked`.
- O modal de teste limpa fila, mensagens e execuções do lead de teste antes
  de cada rodada.

**Achado na investigação — o agente de IA nunca passava da abertura (commit
`310974d`):**

- Abertura e respostas usavam o mesmo `block_id`. Resposta seguinte à
  abertura: primeiro descartada pela trigger; depois recusada pelo índice
  único `send_queue_unique_active_delivery_idx`, que conta
  pending/sending/**sent**.
- Pior: quem inseria gravava a resposta em `messages` mesmo assim. Medido na
  conta Eleve One: 3 aberturas no histórico, 1 item na fila.
- Correção: a resposta do agente entra na fila **sem `block_id`** (o vínculo
  com o bloco fica em `messages`) e sai com `force`, como a M2 — resposta a
  quem acabou de escrever não espera intervalo, horário nem limite diário.
- Só entra em `messages` o que entrou na fila. Se não entrou, fica
  `ai_agent_message_not_queued` em `logs`.
- No teste e no disparo manual, a abertura do agente sai na hora, depois de
  gravar a conversa ativa. Antes ia para o próximo slot, e o Testar fluxo
  recebia `queue_item_not_found`.
- Migrations: `20260922120000` isentava o agente da trigger, mas não bastava
  por causa do índice. `20260922130000` restaura a trigger original. Nada de
  DROP: o índice fica como estava.

**Verificado em produção:**

- Migration aplicada. `pg_get_functiondef` da trigger sem a isenção
  (`tem_isencao: 0`).
- `execute-flow` e `ai-agent-reply` deployados. Frontend publicado
  (`eleveflow-3us2xvuq4`), com o alias `eleveflow-tan.vercel.app` reapontado.
- E2E completo contra o deploy real: **17 passed, 1 skipped** (o skipped depende
  de token real da Meta).
- Conversa em dois turnos (`agent-journey-evolution.spec.ts`): o agente
  continuou (`turns: 2`) sem nenhum `ai_agent_message_not_queued`.
- Unit: 461/461.

**Mensagem enviada aparecia duas vezes na conversa — corrigido (commit
`452ff6a`):**

- Causa: `execute-flow` (bloco de mensagem e abertura do agente) e
  `ai-agent-reply` gravavam em `messages` ao enfileirar (`pending`, sem
  `queue_item_id`). A entrega (`complete_marketing_queue_delivery`) grava de
  novo (`sent`, ligada ao item). Medido: os 8 últimos envios de produção tinham
  2 linhas cada.
- Efeito: cada saída aparecia duas vezes na conversa, uma presa em "pendente".
  O agente relia as próprias falas repetidas. A que nunca saía ficava
  "pendente" para sempre.
- Correção: a entrega é a única fonte, como já era no envio manual pela
  conversa. Os três pontos pararam de gravar ao enfileirar.
- E2E novo: nenhuma saída no histórico sem item de fila ligado.
- Histórico limpo em produção: apagadas 66 linhas `pending` sem
  `queue_item_id`, todas de 19/09 em diante. Eram 54 cópias de mensagens
  entregues, 3 de itens ainda na fila e 9 que nunca saíram.
- A limpeza não apagou nenhuma linha que fosse o único registro de algo
  enviado (ensaio antes: 0 casos).
- O dado migrado do app antigo (até 10/09) não foi tocado.
- Depois da limpeza, os 8 últimos envios têm 1 linha cada.
- E2E completo: 18 passed, 1 skipped.

## Disparo com cara de gente, portado do app antigo (2026-09-21)

O app antigo (`eleve.flow.3`, `process-queue`) tinha uma dinâmica de envio que o
atual não tinha. Portado:

| técnica | onde ficou | o que faz |
|---|---|---|
| intervalo sorteado | `next_send_slot` + `send_gap` | segundos contínuos entre mín e máx, nunca minuto redondo |
| pausa longa | `next_send_slot` | em média a cada ~11 envios, 10–25 min |
| abertura variável | `next_send_slot` | primeiro envio do dia em até 20 min após o início |
| JID real | `EvolutionProvider.sendText` | pergunta ao WhatsApp a forma certa do número antes de enviar |
| "digitando…" | `EvolutionProvider.sendText` | 2–5 s sorteados antes de cada mensagem |
| spintax | `message-humanize.ts` | `{Oi\|Olá\|Opa}` sorteia por envio |
| variáveis | `message-humanize.ts` | `{{primeiro_nome}}`, `{{saudacao}}`, `{{Saudacao}}` |

Chaves em `accounts.settings`: `send_interval_min_minutes` e
`send_interval_max_minutes`, com campos na tela de Configurações. Resposta de
cliente continua fora desse ritmo — sai na hora.

**Por que o JID importa.** Medido na conta Eleve One consultando a própria
Evolution: nos DDDs 37 e 46 o JID é de 12 dígitos, **sem** o nono, mesmo com o lead
cadastrado com 13. A Evolution 2.3.7 resolve as duas formas para o mesmo JID — por
isso os envios de hoje chegaram —, mas o app antigo registrou que com a forma errada
a mensagem sumia: a Evolution aceitava, devolvia id, e ninguém recebia. Resolver
explícito não depende da versão do servidor. E `exists: false` vira verdade sobre
"tem WhatsApp": o item falha sem retentativa e o cadastro do lead é corrigido.

**Dois defeitos antigos, achados ao testar a migration:**

- `next_send_slot` fazia `(settings->>'start_hour')::int` e **derrubava** para conta
  com a hora gravada como `"08:00"`. O `execute-flow` ignorava o erro da RPC e caía
  num fallback em JS **sem sorteio e sem limite diário**, em silêncio. Corrigido, e
  o erro da RPC passa a ser logado.
- a função pulava fim de semana fixo no código e ignorava `days` e
  `respect_business_hours`, que a tela oferece e a trava do envio já respeitava.
  Agendamento e envio discordavam.

**Conferido em produção:** 60 sorteios de `send_gap(4, 8)` entre 244 e 479 s, 54
valores distintos, nenhum minuto redondo. Terça 21h → quarta 08:04; sábado →
segunda 08:03. Suíte: 461 unitários, 14 E2E.

**O que ainda não foi observado:** um envio real pelo provedor humanizado. A fila da
conta estava vazia no deploy (37 enviadas, 4 falhas, último envio 12:31). O próximo —
resposta de cliente ou extração nova — é a prova; os logs do `process-queue` mostram
o JID resolvido.

**O que ficou de fora, de propósito:**

- **Aquecimento de número** (limite diário de 10/20/40/80 conforme a idade do chip).
  No app antigo era opcional, ligado por `warmup_started_at`. Não portei: exige campo
  novo na conexão e, ligado agora, **cortaria** a vazão de um número que já está
  ativo. Vale para número novo.
- **Número do Paraguai** (DDI 595) no normalizador: é a fase F2.
- **Prévia de spintax no editor de fluxo**: o app antigo sorteava um exemplo na tela.
  O envio já entende a sintaxe; a prévia é cosmética.

## Agente de IA: cobertura E2E pelo caminho vivo (2026-09-21)

**O que estava sem teste.** O `agent-journey.spec.ts` cobre a jornada pela Cloud
API, mas a metade que importa — o lead responde, o agente decide e o fluxo sai
pela saída Objetivo — fica atrás de `test.skip(!STAGING_META_HAS_REAL_TOKEN)`.
Esse token não existe desde que a Meta foi parqueada, então a **decisão do agente
não era exercitada por teste nenhum**. Linha de base medida antes de mexer: 2
passaram, 1 pulado — e o pulado era justamente esse.

**`tests/e2e/agent-journey-evolution.spec.ts`** cobre a jornada inteira pelo
caminho que está no ar:

1. abertura pelo LLM real, com contexto de agente ativo e item na fila;
2. o lead responde pelo **webhook real da Evolution**, com verificação de origem;
3. a resposta entra no histórico como inbound;
4. o agente decide objetivo atingido e o fluxo segue até o `move_pipeline`;
5. `api_calls` registra as duas chamadas com tokens, latência e custo > 0.

Mais um caso: lead com telefone fixo é recusado **antes** de gastar chamada de
LLM, a execução encerra como `blocked`, nada é enfileirado e o motivo fica no log.

A entrega pelo provedor não é o alvo desse teste: a instância de teste não existe
no servidor da Evolution. O que se mede é o cérebro do agente e o caminho de
inbound que leva até ele.

**Dois defeitos corrigidos no bloco `ai_agent`.** Ele tinha as mesmas duas falhas
que o bloco de mensagem já tinha: `assertLeadCanReceiveMarketing` solto — que
deixava a execução presa em `running` com `scheduled_at` nulo, fora do alcance do
cron e do gatilho — e nenhuma checagem de telefone, então gastava uma chamada de
LLM para abrir conversa com quem não pode receber. O encerramento por bloqueio
virou `encerrarPorBloqueio`, usado nos três pontos.

**Regressão minha, encontrada pelo próprio teste novo.** O portão recusava quando
`has_whatsapp` era `false`. As duas colunas têm `DEFAULT false` no banco: `false`
é o padrão, não evidência. Qualquer lead criado sem preencher a flag era barrado —
inclusive o do seed do E2E, e foi o que fez a abertura do agente falhar. Agora
quem decide é a **forma do número**, que é o que o provedor recusa; as flags
seguem servindo para a tela, porque o portão as corrige quando recusa.

A tela passou a importar a **mesma função** do módulo compartilhado em vez de
reimplementar a regra: duas cópias divergiriam e o aviso passaria a dizer o
contrário do que o fluxo faz.

**Débito dos 442 fechado.** `whatsAppSendPhone` entra no caminho de envio e dá o
nono dígito ao celular no formato antigo de 8 dígitos. Fixo sai como está — não se
inventa número, e quem recusa fixo é o portão, antes de enfileirar.

**O que ficou de fora, de propósito:** a saída GIVEUP não tem E2E. Ela depende do
LLM classificar uma recusa, e um teste que depende de julgamento de modelo falha
aleatoriamente. A saída LIMITE é determinística (`maxTurns`) e já tem teste.

**Estado da suíte E2E: 14 passam, 1 pulado, zero falhas.** O pulado é o teste da
Meta que exige token real; na prática foi substituído pela versão Evolution, que
roda.

Dois testes de navegador estavam falhando e não era o produto. Primeiro faltava o
Chromium (`npx playwright install chromium`). Depois apareceu o motivo real: eles
tinham a senha `e2e-password-123` **escrita no código**, e a senha do usuário de
E2E havia sido rotacionada. O sintoma era `waitForURL` estourando em /login, que
manda investigar navegação — e o problema era credencial. Agora email e senha vêm
de `E2E_EMAIL`/`E2E_PASSWORD`, e o teste recusa rodar sem a variável em vez de
falhar com mensagem enganosa.

## Painéis de administração e superadmin (2026-09-21)

`adm.eleveone@gmail.com` passou a ter `app_metadata.platform_role = superadmin`
(decisão do dono; é a conta que ele usa). Vale lembrar que é também a conta de
cliente com os 965 leads: quem entrar nela vê o painel de administração junto.
O claim só aparece no token depois de renovar a sessão — sair e entrar de novo.

**Observabilidade** saiu do menu de quem não é superadmin, e a rota também recusa,
porque esconder do menu não impede quem digita a URL. A guarda é cosmética: os
dados já são limitados ao tenant pela RLS.

**O campo da chave da SerpAPI** saiu das Configurações do cliente. Quem extrai usa
a chave global do projeto (`SERPAPI_KEY` nos secrets), não a do cadastro — o campo
sugeria que cada conta precisa da própria e mostrava a chave de quem preencheu.

`useIsSuperadmin` passou a devolver `undefined` enquanto lê o papel, para quem
guarda rota distinguir "não é admin" de "ainda não sei" — senão a tela pisca
"restrito" para o próprio admin.

## Fuso horário: o sistema está certo, os relatórios estavam errados

O banco guarda `timestamptz` em UTC, e Brasília é UTC−3. Conferido: UTC 14:01 =
Brasília 11:01. A lógica de janela de envio é correta nos três lugares:

- `next_send_slot` (RPC) usa `AT TIME ZONE 'America/Sao_Paulo'` para hora, dia da
  semana e contagem do limite diário.
- `isWithinSchedule` (process-queue) converte para o fuso de São Paulo antes de
  comparar com `start_hour`/`end_hour`.
- `getNextValidQueueTime` (execute-flow) faz o mesmo e devolve em UTC.

Config da conta Eleve One: 8h–20h, 4 min entre envios, 40/dia, respeitando horário
comercial. **Ao relatar horário para o dono, converter para Brasília**: os
timestamps crus do banco são UTC e já geraram confusão de 3 horas.

## "O fluxo só manda a primeira mensagem" (2026-09-21)

Não era o fluxo. A M2 **era** enfileirada: o cliente respondia, o inbound retomava
a execução, a condição `any_response` dava verdadeiro e a mensagem 2 entrava na
fila. Conferido no banco: 9 respostas reais de clientes entre 12:55 e 13:37, as
execuções chegaram ao bloco `end`, e havia 6 itens de M2 na fila.

**O problema era o horário.** A M2 recebia o próximo slot do `next_send_slot` — o
espaçamento de ~4 min que protege o número na prospecção. Quem respondia às 13:23
só receberia a M2 às 14:10. Para quem está conversando, isso é o robô não
responder.

**E o mesmo filtro explicava o erro do teste de fluxo.** O `execute-flow` chama o
`process-queue` na hora para o item recém-criado, mas lá a consulta é
`status = pending AND scheduled_at <= agora` (a menos que venha `force`, que só
vale para chamador service_role). Item agendado para o futuro não era encontrado:

```
{"success":false,"step":"queue_item_not_found","error":"Item da fila não encontrado"}
```

**Corrigido:** `reply_received`, `manual` e `is_test` agendam para agora e passam
`force` no despacho interno. O espaçamento continua valendo para prospecção, que é
onde ele protege — quem acabou de escrever está em conversa, não em disparo em
série. Os 6 itens de M2 que já estavam presos foram adiantados à mão; o primeiro
saiu em seguida.

O teste de fluxo também deixou de acusar falha quando o item já foi enviado entre
a leitura e a chamada: `queue_item_not_found` passa a ser conferido pelo status do
item no banco.

## Selo de WhatsApp dizia desconectado com a conta conectada

O selo do Dashboard olhava só o diagnóstico da Meta. Conta na Evolution não tem
credencial Meta, então aparecia desconectada ali enquanto a tela `/whatsapp`
mostrava conectada — a mesma pergunta com duas respostas. Agora ele segue o
provedor da conta, e o `useEvolutionConnection` ganhou `enabled` para não chamar o
proxy em conta que não usa Evolution.

## Telefone que o WhatsApp recusa (2026-09-21)

A Evolution respondia `Bad Request` para número de fixo **depois** de o item já
estar na fila: aparecia como falha de envio, quando o problema era o cadastro.

**Agora o bloco de mensagem checa o destino antes de enfileirar**, por
`_shared/whatsapp/phone-target.ts`, que classifica pela forma do número com a
mesma regra de nono dígito do `phoneVariants`:

| forma | classificação | envia? |
|---|---|---|
| assinante de 9 dígitos começando em 9 | celular | sim |
| assinante de 8 dígitos começando em 6–9 | celular no formato antigo | sim |
| assinante de 8 dígitos começando em 2–5 | **fixo** | não |
| menos de 10 dígitos | **inutilizável** | não |
| `has_whatsapp = false` ou `phone_valid = false` | marcado pelo extrator | não |

Ausência de evidência não recusa: `has_whatsapp` nulo passa, `false` recusa.

**A forma do número vale mais que a flag, de propósito.** Nos leads migrados do
sistema antigo a flag veio errada: o número que falhou (`554232315889`) estava
marcado `has_whatsapp = true` e é fixo. Todos os 441 leads de 12 dígitos vieram
marcados como WhatsApp.

Recusa encerra a execução como `blocked`, grava `lead_phone_not_whatsapp` no log
da conta e corrige `has_whatsapp` para false — dado derivado do telefone. A tela
avisa no card do lead e no cadastro: "Este número pode estar errado: não parece um
WhatsApp. O fluxo não envia para ele." Quem discordar edita o cadastro: o campo
`whatsapp` vence o `phone`.

**Na conta Eleve One**, depois da correção das flags por forma do número: 71 leads
com aviso, 68 deles em Prospecção. Os 3 itens já enfileirados antes do portão
existir vão falhar do jeito antigo — 2 fixos e 1 sem DDD.

**O que sobra, e é maior:** 442 leads da conta têm celular no **formato antigo de
8 dígitos**, sem o nono. Eles passam pelo portão (podem ser celular), mas o envio
usa o número como está cadastrado, e o WhatsApp provavelmente recusa. Estão todos
no lote migrado, que segue com consentimento `unknown` e portanto sem enviar
nada. Antes de liberar esse lote, o caminho de envio precisa usar a variante com o
nono dígito — `classifyPhone` já devolve ela em `withNinthDigit`.

## Lead extraído não chegava na fila de envio (2026-09-21)

**Sintoma:** a conta Eleve One extraiu 28 leads, eles entraram em Prospecção, o
gatilho disparou, 28 `flow_started` no log — e a fila de envio ficou vazia.

**Causa:** o portão de consentimento. `assertLeadCanReceiveMarketing` exige
`granted` ou `not_required`, e lead extraído nascia `unknown` — o extrator não
definia nada. O assert rodava solto no bloco de mensagem do `execute-flow`, antes
do insert em `send_queue`: lançava, e nada era enfileirado.

**O defeito pior, que o primeiro escondia:** quando o assert lançava, a execução
ficava `running` com `scheduled_at` nulo. O `process-flows` só retoma
`scheduled_at <= agora`, e nulo nunca casa; o `trigger-flow-by-stage` pula lead
com execução `running`. O lead saía do fluxo **para sempre**, mesmo depois de o
consentimento ser resolvido. Eram 28 execuções presas.

**Corrigido:**

- O bloqueio agora encerra a execução como `blocked`, grava
  `marketing_automation_blocked` no log da conta com o motivo e devolve 200.
- O reuso de execução do `execute-flow` passou a excluir `blocked` junto de
  `completed`. Antes, `.neq("status","completed")` reaproveitava uma execução
  bloqueada e a fazia avançar mantendo o status — e o inbound deixava de retomá-la,
  porque ele só procura `waiting_response`, `running` e `active`. Foi exatamente o
  que aconteceu ao destravar as 28: avançaram ainda marcadas `blocked` e
  precisaram ser corrigidas para `waiting_response` à mão.
- O extrator (`src/pages/Extractor.tsx`, inserção individual e em lote) grava
  `marketing_consent_status = not_required` e `marketing_consent_source =
  extrator-google`. Decisão do dono em 2026-09-21: contato comercial de empresa a
  partir de dado público. O opt-out continua valendo — quem pede para sair vira
  `withdrawn` e suprimido pelo inbound.

**Aplicado nos 28 leads de hoje** (os 936 migrados seguem `unknown`, por decisão
do dono), execuções destravadas e gatilho reativado por
`trigger-flow-by-stage`: 28 disparos, 0 pulados, 0 erros. A fila encheu com 28
itens, espaçados ~4 min pelo `next_send_slot`, de 12:37 a 14:25.

**Primeiro envio real pela Evolution saiu às 12:42.**

**Uma falha esperada:** 1 item deu `provider_api_error / Bad Request` — número
`554232315889`, fixo de 8 dígitos, não é WhatsApp. Dos 28 leads, 3 têm
`has_whatsapp` diferente de true; devem falhar igual. Nem o fluxo nem a fila
filtram por `has_whatsapp` antes de enfileirar — vale decidir se passam a filtrar.

**Defeito pré-existente encontrado no caminho:** cada mensagem enviada gera
**duas** linhas em `messages` — uma `pending` escrita pelo `execute-flow` no
momento do enfileiramento, sem `queue_item_id`, e uma `sent` escrita pelo caminho
de envio, com `queue_item_id` e o id do WhatsApp. Na conversa a mensagem aparece
duplicada. O índice único parcial em `messages.queue_item_id` sugere que o desenho
pretendido era uma linha por item de fila, atualizada — não duas.

## F3 — conta Eleve One migrada para o xlycu (2026-09-19)

**Fonte:** `eleve.flow.3/supabase/happy-thread-weaver_260918.backup.zip`, pg_dump
custom do projeto legado tirado em 18/09 (ignorado pelo git). Não o dump de julho
em `migracao/`, que estava defasado: tinha 345 leads da conta, o backup tem 937.

**Migrado para `adm.eleveone@gmail.com`** (legado `eb22ef7b…` → `xlycu` `14448933…`),
conferido no banco e depois **com o token do próprio dono, pela RLS**:

| estágios | fluxos | blocos | leads | mensagens | tarefas |
|---|---|---|---|---|---|
| 10 | 1 (desativado) | 6 | 937 | 3020 | 5 |

Os 4 estágios padrão que o cadastro criou saíram (nada os referenciava): o funil
ficou igual ao do sistema antigo. 564 leads com cidade e 801 com estado entraram
nas colunas novas `city`/`state` (migration `20260919120000`).

**Nada disparou.** Fila de envio da conta: 0. Execuções de fluxo: 0. Os 937
eventos `lead_created` saíram com a data original de cada lead — nenhum com data
de hoje, então o dashboard não mostra 937 entradas no dia.

**Como isso foi garantido:**

- O trigger `leads_auto_trigger_flow_on_stage` roda `AFTER INSERT` e dispara
  `trigger-flow-by-stage` para fluxo ativo no estágio do lead. O fluxo da conta
  ("Abordagem + Follow-UP", gatilho em Prospecção) entrou **desativado**, então
  nenhum dos 937 inserts virou envio — sem desligar trigger de produção.
- `send_queue` (1513) e `flow_executions` (945) **não** foram migrados: item
  pendente importado dispararia mensagem velha assim que a conta parear o
  WhatsApp, e o cron retomaria execução em espera. O conteúdo enviado já está em
  `messages`. `logs` também ficou de fora.
- Estado de execução zerado nos 497 leads que estavam "aguardando resposta".
- O opt-out (1 lead) virou `marketing_consent_status = withdrawn` com supressão; os
  70 números inválidos ficaram suprimidos com motivo `phone_invalid`.

**Três consertos que a migração exigiu antes de rodar:**

1. O leitor de dump corrompia JSON (escapes do COPY decodificados em passes
   separados): atingia 8 de 9 fluxos, 15 de 69 blocos e 68 leads. Corrigido com
   teste (`bd2537a`).
2. O legado guardava cópia da mesma mensagem (retentativa da Evolution, 19 linhas
   em 10 chaves, todas com texto idêntico). O destino deduplica por
   `(user_id, whatsapp_id, direction)` e recusou o primeiro lote — sem gravar nada,
   porque cada lote é uma transação. Fica a mais antiga de cada chave.
3. `city`/`state` não existiam no destino. Migration aditiva.

**O que o dono precisa saber antes de religar o fluxo:** todo lead importado tem
`marketing_consent_status = unknown` — o sistema antigo não tinha esse conceito. O
`assertLeadCanReceiveMarketing` bloqueia automação para `unknown`, então religar o
fluxo não manda nada para esses leads até o consentimento ser definido
(`granted` ou `not_required`). Isso é decisão do dono, não da migração.

**Perdas conhecidas:** `messages.whatsapp_url` em 28 mensagens (o destino não tem
coluna de mídia). A coluna `about` veio com `[object Object]` em parte dos leads:
é lixo gravado pelo app antigo, não corrupção da migração.

**Divergência:** o que a conta fizer no app antigo depois de 18/09 não está aqui.
Risco baixo — o último login dela no legado foi em 03/07.

**Faltam as outras contas do backup**, nenhuma com usuário no `xlycu` ainda (o
script precisa do `user_id` de destino):

| conta | e-mail | leads | último login no legado |
|---|---|---|---|
| Nickolas Gregorio | onickolasgregorio@gmail.com | 1144 | **16/09 — ativa no legado** |
| eleve one 3 | sellerkingai@gmail.com | 376 | 08/07 |
| CONTA DANILO | gregobtc@gmail.com | 157 | 10/08 |
| PARAGUAY | nickolassenniresendegregorio@gmail.com | 15 | 25/07 |
| Mestre | joao@joao.com.br | 6 | 04/07 |

**Como repetir:** `scripts/migrar-tenant.mjs` gera o SQL (fora do repositório) e
cada arquivo vai com `bash scripts/sb-staging.sh db query --linked -f <arquivo>`,
em ordem, parando no primeiro erro. Idempotente.

## Correções e E2E do F1 (2026-09-19, depois do deploy)

**Gate de admin do proxy.** O `whatsapp-proxy` consultava `user_roles`, tabela que
não existe neste schema — nem a função `has_role`. O erro era engolido (só `data`
desestruturado), então `isAdmin` era sempre falso e admin nunca alcançava outra
conta. Agora usa `app_metadata.platform_role` via
`getAuthUserWithPlatformRole`. Conferido em produção depois de publicar:

```
sem sessao                                  -> 401 Authentication required
conta comum com targetUserId de outra conta -> 403 Not allowed to act on another account
conta comum na propria conta                -> 200, instancia = proprio user_id
superadmin com targetUserId de outra conta  -> 200, instancia da conta alvo
```

`e2e@eleveflow.test` tem `platform_role = superadmin`; `adm.eleveone@gmail.com` e
`admin@eleveflow.test` não têm.

**`meta-whatsapp-admin` estava com type error.** `readEnv` devolve
`metaGraphApiVersion` e a ação `discover-connection` lia `env.graphApiVersion`,
undefined — a Graph API era chamada com a versão vazia na URL, então o botão "Já
concluí na Meta" não funcionava. Entrou no `aa906a9` (19/08), fora do F1;
apareceu porque o `deno check` passou a rodar nas catorze functions. Corrigido e
publicado. As catorze passam no `deno check`.

**E2E do inbound da Evolution escrito** (`tests/e2e/evolution-inbound-webhook.spec.ts`),
cinco casos verdes contra o deploy real. Ele revelou uma regra que vale registrar:
número sem lead é ignorado de propósito (`webhook_lead_not_found`,
`inbound-orchestrator.ts:122`) — contato desconhecido não vira cadastro sozinho,
em nenhum provedor. Quem for provar inbound precisa semear o lead antes.

**Erro cometido e corrigido no mesmo dia.** A primeira versão da limpeza do E2E
apagava lead por telefone **sem escopo de tenant**, e o spec usava
`5511999990001` — o mesmo número do fixture GOAL do `agent-journey`, de outra
conta de teste. Na primeira rodada ela levou embora aquele lead e o histórico
dele. Nada quebrou: `seedAgentFlow` recria o lead quando falta. A limpeza passou
a exigir `tenantId` e o spec da Evolution usa `5511999990003`, só dele. Telefone
não é único entre contas.

**Acesso ao Supabase.** O `db query --linked` voltou a funcionar. A conta alcança
só a organização `Prisma` (`xlycuunqpgpyfmafgajr` e `ydphiastnnadeuskczwg`); o
projeto legado `aoanpviozfabrrxjqayk` devolve **403** — segue sendo de outra
conta, como a spec do F0 registrou. Export do legado continua dependendo da sessão
do próprio dono, por `scripts/exportar-legado.mjs`.

## Diagnóstico: `adm.eleveone@gmail.com` sem acesso e sem contatos (2026-09-19)

Dois problemas distintos, um confirmado e um em aberto.

**Os contatos nunca foram migrados.** Produção tem 4 leads no total, todos do
usuário de E2E. A conta `adm.eleveone@gmail.com` (id `14448933-86df-47d4-a082-df69dbddeff1`,
criada em 2026-08-19, `accounts.name = "Eleve One"`) tem **zero**. No dump de
`migracao/` (16/07) o mesmo dono aparece como `eb22ef7b-df8a-45dd-b773-154bd342f7bb`
com 345 leads, 1110 mensagens, 550 itens de fila, 353 execuções, 1 fluxo, 8
estágios e 2570 logs. Não é RLS nem permissão: é ausência de dados — a migração é
a F3 e nunca rodou. O `user_id` mudou entre os projetos, então qualquer
importação precisa remapear.

**O login não é a infraestrutura.** Conferido: a conta existe com e-mail
confirmado e tinha login bem-sucedido às 12:23Z do mesmo dia; a chave publicável
do bundle no ar é aceita (senha errada devolve `400 invalid_credentials`, não
`401`); login real pela mesma chave devolve token, e com token de usuário as
leituras que a tela faz — `leads`, `accounts`, `whatsapp_connections`, `messages` —
respondem 200, inclusive as colunas novas de provider. Restaram duas causas
prováveis: aba aberta desde antes do deploy das 20h, porque o asset antigo
`index-zyI5XVlf.js` agora dá 404 e o HTML é `max-age=0, must-revalidate` (recarga
forçada resolve), ou senha — a conta do `xlycu` é separada da do app do Lovable.
Senha temporária definida pela Admin API em 2026-09-19 e conferida por login
real; o dono deve trocar.

**Export fresco antes de importar.** O dump é de 16/07: o que foi criado no app
antigo depois disso não está nele. `scripts/exportar-legado.mjs` faz o export com
a sessão do próprio dono (a RLS limita às linhas dele), lendo
`LEGADO_EMAIL`/`LEGADO_PASSWORD` de `.env.legado` — nunca de argumento de linha
de comando. Não temos service key do projeto legado, só a publicável.

**Débito achado no caminho:** `whatsapp-proxy` consulta `user_roles` para decidir
`isAdmin`, e essa tabela **não existe** no `xlycu` — nem a função `has_role`. O
erro é engolido (só `data` é desestruturado), então `isAdmin` é sempre falso e
admin não alcança outra conta; o pareamento normal não é afetado. O padrão real
do repositório é `app_metadata.platform_role === 'superadmin'`, em
`_shared/platform-role.ts`. Corrigir e republicar.

**Operacional:** `bash scripts/sb-staging.sh db query --linked` passou a devolver
`403 LegacyDbConfigLoginRoleStatusError` neste dia, depois de ter funcionado pela
manhã. A leitura de produção foi feita por PostgREST e Auth Admin API com a
`STAGING_SUPABASE_SECRET_KEY` do `.env.staging`, que continua valendo.

## F1 — Evolution como provider: publicada em produção (2026-09-19)

Plano: `docs/plans/2026-09-17-f1-evolution-provider.md`. Tasks 1 a 8 fechadas;
Task 9 nos passos 1 a 4 e 8.

**Onde vive a Evolution.** VPS Hostinger `srv1057879` (`72.60.254.94`), Easypanel,
container `evolutionapi_evolution-api`, imagem `evoapicloud/evolution-api:v2.3.7`,
`SERVER_URL=https://evolutionapi.prismasolucoes.art`. Acesso por SSH root com
`~/.ssh/hostinger_vps` (`Host hostinger` no `~/.ssh/config`); o painel fica em
túnel (`ssh -N painel` → `http://localhost:3000`). A credencial mestra é
`AUTHENTICATION_API_KEY` no env do container — é de lá que ela sai, nunca do
repositório.

**O servidor é compartilhado; isto é risco, não detalhe.** A stack `wa-agent` no
mesmo VPS usa a **mesma key mestra**. Hoje existe uma única instância: `Atual`,
status `open`, número 5527981860995, perfil "Atual Barbearia" — **produção de
cliente, intocável**. Com a key mestra o `whatsapp-proxy` alcança `logout` e
`delete` dela; o que impede é a convenção `instance_name = user_id`, que nunca
colide com `Atual`. Isolar de verdade (key por instância, ou servidor separado)
fica como débito.

**Secrets gravados em 2026-09-19** no `xlycuunqpgpyfmafgajr`: `EVOLUTION_API_URL`,
`EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET` (64 chars, gerado novo — o do
`wa-agent` não foi reusado para não misturar a origem dos dois webhooks). O
plaintext do segredo do webhook está só no `.env.staging`, como
`STAGING_EVOLUTION_WEBHOOK_SECRET`. No servidor, `WEBHOOK_GLOBAL_ENABLED=false`:
o registro é por instância, feito pelo `whatsapp-proxy` no `connect`.

**Publicadas** com `--use-api`: `whatsapp-webhook`, `whatsapp-proxy`,
`process-queue`. Migrations todas sincronizadas, inclusive `20260918120000` —
nada a empurrar.

**Frontend publicado em 2026-09-19.** `npm run build:staging` +
`vercel deploy --prebuilt --prod`, deployment `eleveflow-d5t83zvam`, com o alias
`eleveflow-tan.vercel.app` reapontado à mão — `--prod` não move alias manual.
Antes de publicar, conferido que o bundle carrega só `xlycuunqpgpyfmafgajr` e
nenhum `aoanp…`: é o check do incidente de 2026-08-19. No ar, `/` e `/whatsapp`
respondem 200 e o chunk `Whatsapp-*.js` traz "Parear um aparelho",
"Evolution API" e "Ver a Cloud API".

**Smoke contra produção (2026-09-19):**

- `POST /whatsapp-webhook` sem segredo → `401` em `verify_webhook`,
  `"Webhook authentication failed"`.
- `POST /whatsapp-webhook` com o segredo e instância inexistente → `200`
  `ignored/unknown_instance`.
- `POST /whatsapp-proxy` sem sessão → `401` em `resolve_instance`,
  `"Authentication required"`.

A guarda de implantação do webhook (passar sem verificar) só vale enquanto o
segredo não existe. Com ele gravado, requisição sem header já é recusada — o
primeiro smoke é a prova, e é o passo 8 da Task 9.

**Falta:** parear um número pela tela, inbound real e outbound real (Task 9,
passos 5 a 7, dependem de celular). E o E2E
`tests/e2e/evolution-inbound-webhook.spec.ts`, previsto no passo 4 da Task 5,
não existe.

## Coexistência do WhatsApp — eco do Business App (2026-08-19)

Spec: `docs/specs/2026-08-18-whatsapp-coexistencia-eco-design.md`
Plano: `docs/plans/2026-08-18-whatsapp-coexistencia-eco.md`

**Problema que isso resolve.** Com coexistência, o dono e o robô dividem a mesma
linha. Se o dono respondia um lead pelo celular, o CRM não ficava sabendo: a IA
respondia por cima e o cliente recebia duas respostas para a mesma pergunta —
inclusive de madrugada, quando um fluxo agendado disparava.

**Verde (bateria completa em 2026-08-19):** 343 testes em 30 arquivos,
`tsc --noEmit` limpo, `vite build` OK.

**Em produção (`xlycuunqpgpyfmafgajr`), conferido por query:**

- `messages.origin` (`'crm' | 'business_app' | null`) e `leads.human_takeover_until`
  (timestamptz) presentes.
- Índice único `messages_user_wamid_direction_uidx` sobre
  `(user_id, whatsapp_id, direction)` ativo; o `messages_user_wamid_uidx` da
  primeira versão foi removido — sem `direction` ele colidia com o
  `ON CONFLICT (queue_item_id)` do RPC de finalização de entrega e podia estourar
  exceção **depois** do envio já aceito pela Meta.
- `global_settings.human_takeover_hours = 24` (ajustável por SQL, sem deploy).
- Functions publicadas: `meta-whatsapp-webhook`, `ai-agent-reply`, `execute-flow`,
  `meta-whatsapp-admin`.

**Como funciona.** O parser reconhece o campo `smb_message_echoes` (antes descartava
tudo que não fosse `messages`). No eco, o lead é o `to` — o `from` é o número do
próprio negócio. O `echo-handler` deduplica por wamid, resolve o lead, grava a
mensagem como `outbound` marcada `origin='business_app'` e carimba a pausa.
Os gates ficam nos dois pontos de envio automático, ao lado do
`assertLeadCanReceiveMarketing` que já existia: `ai-agent-reply` devolve 200 com
`paused: 'human_takeover'` sem consumir turno nem token; `execute-flow` reagenda a
execução para o fim da pausa (`scheduled_at`, `status: 'running'`), então o
`process-flows` a recolhe depois e o fluxo continua de onde parou em vez de morrer.
`is_test: true` fura o gate — teste do editor é o dono clicando de propósito.

**Onboarding.** `numbers[0]` saiu: com mais de um número e nenhuma indicação, o
onboarding falha com 409 listando os números, em vez de conectar o errado em
silêncio. `coexistence_enabled` passa a ser gravada, preferindo `is_on_biz_app` da
Graph e caindo na dica do evento do browser quando a Graph não expõe o campo.

**Refactor no caminho.** `lead-resolver.ts` e `message-dedupe.ts` saíram de dentro do
`inbound-orchestrator.ts` (811 linhas) porque o eco precisa das duas funções.
Equivalência provada: os testes do orquestrador passaram sem edição.

### Pendente de verificação com tráfego real

Nada disso foi exercitado por uma mensagem real ainda (`select count(*) from
messages where origin='business_app'` = 0). Falta:

1. **Marcar `smb_message_echoes`** no App Dashboard > WhatsApp > Configuration >
   Webhook fields. Sem isso a Meta não envia eco nenhum. (`history` e
   `smb_app_state_sync` ficaram de fora de propósito: os syncs não foram
   implementados e assinar campo sem consumidor só gera ruído no log.)
2. Enviar mensagem do celular para um lead existente e conferir: eco no log, bolha
   marcada na tela, `human_takeover_until` gravado, IA recusando com `paused`,
   execução agendada reaparecendo depois que a pausa vence.
3. **Divergência da doc da Meta em aberto:** a página de coexistência afirma que o
   número expõe `is_on_biz_app` e `platform_type`; a referência do node não lista
   esses campos. O código trata os dois casos, mas só uma conexão real dirá qual
   vale — conferir se `coexistence_enabled` veio da Graph ou do fallback.

### Fora de escopo (decisão do dono)

- `POST /{phone_number_id}/smb_app_data` — import de histórico e de contatos, com
  janela de 24h após o onboarding.
- Criação automática de lead a partir de eco de número desconhecido (segue a regra
  do inbound: loga e ignora).
- Edição e revogação de mensagem vindas do app (chegam no mesmo campo; hoje logam
  `echo_unsupported_operation`).
- Tela de configuração do prazo de pausa.

### Limites da coexistência (informação de operação)

Throughput fixo de 20 mps; sem verificação de negócio padrão; sem selo OBA; número
COEX não migra entre WABAs; o dono precisa abrir o Business App a cada 13 dias e não
pode desinstalar; app ≥ 2.24.17.

## Estado real do banco (verificado em 2026-07-30)

Só existem dois usuários: `e2e@eleveflow.test` e `admin@eleveflow.test`. **Os
tenants migrados do Lovable não existem mais** — foram deletados em 16–17/07 e o
CASCADE levou os 917 leads e as 3.542 mensagens. A seção sobre a migração, mais
abaixo, descreve o que foi feito em 16/07, não o estado de hoje.

`messages` foi zerada em 30/07 a pedido do dono: as 34 linhas eram todas
artificiais (18 sem `whatsapp_id`, 7 `E2E-*`, 7 `wamid.E2E-*`, 2 `mock-*`),
nenhuma com wamid real da Meta. Nenhuma FK aponta para `messages`, então não
ficou referência órfã. Restam 3 leads, 2 itens `failed` em `send_queue`, 2
`flow_executions` e 34 `api_calls` (custo real de LLM, mantidos de propósito).

## Correção do diagnóstico da conexão (2026-07-30)

**O que estava errado:** a página `/whatsapp` afirmava "Este número está no ar"
lendo campos gravados em `whatsapp_connections`. Em 25/07 eu semeei ali uma linha
de teste (`E2E-PNID-…`, `E2E-WABA`, `5511999990000`, token fictício) com
`status='connected'` e `webhook_subscribed_at` preenchidos à mão — e a tela
repetiu isso como se fosse verdade. A causa não foram os valores em si: era
confiar no banco como prova.

**Correção:** nada é afirmado sem verificação contra a Graph API.

- `_shared/whatsapp/meta-diagnostics.ts`: `debug_token`, detalhe da WABA, detalhe
  do número e `subscribed_apps`. Verificação em cadeia — token inválido
  interrompe, e nada depois dele é dado como verdadeiro por omissão.
- `_shared/whatsapp/connection-state.ts`: agrega o diagnóstico e deriva
  envio/recebimento de `messages` (mensagem que existiu), nunca de flag.
  `untested` é distinto de `failed`.
- Edge function `meta-whatsapp-admin` com `diagnose`, `validate-token` e
  `save-connection`. Todo contato com a Meta acontece nela; o access token nunca
  chega ao navegador.
- Configuração em dois passos: valida o token, lista os números reais da WABA e
  o operador escolhe um. Não há campo para digitar Phone Number ID à mão.
- `scripts/seed-whatsapp-connection.mjs` só grava depois que a Meta confirma o
  token e o número; os campos exibidos vêm da resposta dela.
- Conexão fictícia agora vive só dentro dos testes, com `beforeAll`/`afterAll`
  próprios. Verificado após a suíte: `whatsapp_connections` com 0 linhas.
- A frase "Mensagens saem e chegam por ele" saiu. A página mostra badge de
  ambiente e, em cada item, de onde veio a informação.

**Gates:** 182 testes unitários verdes (19 arquivos) · cobertura 95,76% stmts /
81,33% branches / 100% funcs / 96,83% lines · typecheck 0 erros · `deno check`
limpo · build verde · lint com 0 erros reais · E2E 7 passaram / 1 pulado.

**Publicado:** `meta-whatsapp-admin` no ar; frontend em
https://eleveflow-tan.vercel.app.

**Pendente:** as credenciais reais da Meta. Sem elas o endpoint responde
`configured: false` e a página mostra "WhatsApp oficial ainda não configurado" —
que é a verdade.

## Bloco A — migração WhatsApp para a Meta Cloud API (2026-07-25)

Branch `feat/whatsapp-meta-cloud`. **16 de 16 tarefas feitas, aplicadas e publicadas em produção.** Plano:
`docs/plans/2026-07-25-migracao-whatsapp-meta-cloud-bloco-a.md`.

### Decisão de escopo (2026-07-25): a Evolution sai do produto

A spec original mantinha a Evolution como fallback por empresa. O dono reverteu.
Não há provider duplo, nem rollback para Baileys. A ordem escolhida foi: levantar
o caminho Meta primeiro, remover a Evolution por último (Task 16), para nenhum
commit ficar vermelho no meio.

**Consequência aceita:** sem as credenciais Meta o produto não envia nem recebe
WhatsApp depois que `process-queue` for publicado.

### Task 16 — Evolution removida do código (2026-07-25)

Saíram: as edge functions `whatsapp-webhook`, `whatsapp-proxy` e
`evolution-webhook-check`; `_shared/evolution.ts` e `_shared/evolution-webhook.ts`;
os helpers de webhook do `auth.ts` (`verifyEvolutionWebhook`, `getWebhookSecret`,
`evolutionWebhookUrl/Headers`, `redactWebhookUrl`); `src/hooks/use-whatsapp.ts` e
`src/services/evolutionService.ts`; o card de credenciais em Settings; o slot
morto `integrations.evolution`; `tests/unit/evolution.test.ts` e o E2E
`inbound-webhook.spec.ts`.

Entraram: `tests/e2e/meta-inbound-webhook.spec.ts` (inbound + assinatura inválida
+ verificação de inscrição), `src/lib/phone.ts` (só `normalizeBrazilPhone`, que
era genérica) e a nova `/whatsapp`.

A página `/whatsapp` deixou de ser QR e virou estado da conexão: mostra a cadeia
de pré-requisitos da Cloud API (número → token → webhook → qualidade) e para no
primeiro elo não cumprido, com os identificadores copiáveis. Falta de
configuração aparece em âmbar, não em vermelho: não é erro, é "ainda não".
Dashboard, Onboarding e Diagnostics passaram a ler `whatsapp_connections`.

`grep -rn -i "evolution" supabase/functions/ src/` → nenhuma ocorrência.
Sobram só migrations históricas (já aplicadas, intocáveis).

**Secrets removidos em 2026-07-25** com autorização do dono: `EVOLUTION_API_URL`,
`EVOLUTION_API_KEY` e `EVOLUTION_WEBHOOK_SECRET` saíram do Supabase e do
`.env.staging`. As três edge functions da Evolution foram apagadas do projeto
remoto — nada da Evolution responde mais.

### Entregue (Tasks 1–15 de 16, commits em `feat/whatsapp-meta-cloud`)

- `_shared/http-error.ts`, `_shared/hmac.ts`: `HttpError`, `hmacSha256Hex` e
  `constantTimeEqual` fora do `auth.ts` (que importa `esm.sh` e não roda no Vitest).
- `_shared/crypto.ts`: AES-256-GCM versionado (`v1:<iv>.<ct+tag>`), chave por
  parâmetro. Adulteração e chave errada dão o mesmo erro genérico, de propósito.
- `_shared/whatsapp/types.ts`: interface `WhatsAppProvider` e DTOs normalizados.
  `WhatsAppProviderId` é só `meta_cloud`.
- `_shared/whatsapp/crm-parse.ts`: `phoneVariants` e `isMarketingOptOutMessage`
  movidas verbatim do webhook, com characterization test.
- `_shared/whatsapp/meta-provider.ts`: envio (texto, mídia, template), markAsRead,
  download de mídia, status de conexão, listar/criar templates, verificação de
  `X-Hub-Signature-256` e parse do webhook. Versão da Graph API sempre de
  configuração, nunca fixa. `fetch` injetado — nenhuma chamada real à Meta.
- `_shared/whatsapp/index.ts`: `resolveProvider`. Sem linha conectada em
  `whatsapp_connections` → `HttpError(409)` explícito, nunca fallback silencioso.
- `_shared/whatsapp/status-sync.ts`: aplica status de entrega em `messages.status`,
  idempotente e monotônico (webhook fora de ordem não regride; `failed` sempre vence).
- `_shared/whatsapp/inbound-orchestrator.ts`: a orquestração CRM saiu do
  `whatsapp-webhook` (1004 → 205 linhas) com dependências injetadas. Nenhuma regra
  mudou; o passo corrente volta por callback `onStep` para o corpo do erro e o log
  `webhook_error` continuarem exatos.
- `_shared/platform-role.ts` + `requireSuperadmin` no `auth.ts` +
  `scripts/set-superadmin.mjs` + hook `useIsSuperadmin`. O papel vive em
  `app_metadata` porque o cliente não escreve nesse campo.
- `_shared/marketing-consent.ts`: `assertLeadCanReceiveMarketing` em módulo
  Deno-free, reexportada pelo `auth.ts`.
- Edge function `meta-whatsapp-webhook` (GET de verificação + POST de eventos),
  `verify_jwt = false` no `config.toml`.
- `process-queue` envia por `resolveProvider`. Tenant sem conexão → item `failed`
  com motivo `no_whatsapp_connection`, sem retentativa.
- Migration `20260725120000_whatsapp_connections.sql`: tabela + índices únicos
  (um tenant por conexão, um número por tenant) + RLS + `GRANT SELECT` por coluna
  que exclui `access_token_encrypted` + índice `(user_id, whatsapp_id)` em
  `messages` + `meta_graph_api_version` em `global_settings`.

### Gates executados em 2026-07-25

- `npx vitest run`: **154 testes, 17 arquivos, todos verdes** (baseline eram 55; os 4 testes a menos são o `evolution.test.ts` removido junto do módulo).
- Cobertura: statements 96,38% · branches 84,37% · funcs 100% · lines 97,55% —
  gate de 80% verde.
- `npm run typecheck`: 0 erros.
- `deno check` em cada uma das **11** edge functions restantes: todas limpas.
- `npm run build`: verde (`built in 27.20s`, nitro/vercel gerado), rodado de novo depois da Task 16.
- `npm run lint`: **0 erros reais.** Os milhares de "erros" reportados são, um por linha,
  `prettier/prettier: Delete ␍` — efeito de `core.autocrlf=true` no Windows contra
  o prettier em LF. Afeta todo o repo desde antes deste bloco. Provado por
  `npx prettier --check --end-of-line auto` nos arquivos tocados:
  `All matched files use Prettier code style!`
- Varredura de segredo em log (`accessToken|access_token|appSecret|WHATSAPP_TOKEN_ENC_KEY`
  junto de `console.`): nenhuma ocorrência.

### Aplicado e provado em PRODUÇÃO (`xlycuunqpgpyfmafgajr`) em 2026-07-25

Sequência executada com autorização explícita do dono:

1. **Migration aplicada** (`supabase db push`). Verificado no banco: tabela criada
   com 0 linhas, RLS ligada, 1 policy, 3 índices, `idx_messages_user_whatsapp_id`
   criado, `meta_graph_api_version = v25.0` semeado. O `GRANT SELECT` concede 17
   colunas e **não** inclui `access_token_encrypted` — conferido em
   `information_schema.column_privileges`.
2. **Secrets gravados**: `WHATSAPP_TOKEN_ENC_KEY` (32 bytes, gerada nesta sessão)
   e `META_APP_SECRET`. O verify token do webhook foi gravado em
   `global_settings.meta_webhook_verify_token`. Cópia local em `.env.staging`
   (gitignored) — **perder a chave de criptografia torna todo token irrecuperável**.
3. **11 edge functions publicadas**, incluindo a nova `meta-whatsapp-webhook`.
4. **3 functions da Evolution apagadas do projeto remoto**: `whatsapp-webhook`,
   `whatsapp-proxy`, `evolution-webhook-check`. Não respondem mais.
5. **Frontend publicado na Vercel** (`npm run build:staging` + `vercel deploy
   --prebuilt --prod`), alias `eleveflow-tan.vercel.app` reapontado para o build
   novo. Backend e frontend na mesma versão.
6. **3 secrets da Evolution removidos** (`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`,
   `EVOLUTION_WEBHOOK_SECRET`) e a linha correspondente saiu do `.env.staging`.
   Restam 12 secrets no projeto, nenhum da Evolution.

**Smoke do webhook Meta contra produção:** GET com verify token correto → `200` e
corpo exatamente `12345`; com token errado → `403`; POST sem assinatura → `401`.

**E2E contra produção: 7 passaram, 1 pulado.**
- `meta-inbound-webhook.spec.ts` 3/3: inbound registrado no banco, assinatura
  inválida rejeitada com 401, verificação de inscrição devolvendo o challenge.
- `agent-journey.spec.ts`: saída LIMITE verde com LLM real pelo webhook Meta.
- `login` e `observabilidade` verdes.
- Pulado: a asserção de entrega real (ver limite abaixo).

**Caminho de envio provado até a Graph API.** Com `force: true`, o `process-queue`
leu `whatsapp_connections`, descriptografou o token, montou o `MetaProvider`,
chamou a Graph API real e recebeu `401`. O item foi para `skipped` com motivo
`meta_cloud_401` e o log registrou
`"Invalid OAuth access token - Cannot parse access token"`, `providerStatus: 401`,
**sem token nem chave no conteúdo**. Cada elo funciona; falta só a credencial.

### Limite atual — o que ainda não pode ser provado

- **Entrega real de mensagem.** O token semeado é `TOKEN-DE-TESTE-NAO-E-REAL` com
  um `phone_number_id` fictício; a Meta responde 401. Quando o token real existir,
  rodar com `STAGING_META_HAS_REAL_TOKEN=true` para o E2E exigir `sent`.
- **`META_APP_SECRET` é provisório** (gerado nesta sessão só para assinar os
  testes). Precisa ser trocado pelo App Secret real, senão o webhook vai rejeitar
  os eventos da Meta de verdade.
- **A linha de teste em `whatsapp_connections`** aponta o tenant `e2e@eleveflow.test`
  para um número fictício. Remover ou sobrescrever ao conectar o número real.
- **Tela `/whatsapp` não aberta em navegador.** Está publicada e responde 200,
  e o E2E passa contra o deploy — mas ninguém olhou o render. Hoje ela mostra
  "Nenhum número conectado" para os tenants reais: a única linha em
  `whatsapp_connections` é a de teste, do usuário `e2e@eleveflow.test`.

### Achado colateral (pré-existente, não é regressão)

O E2E de envio dependia do dia da semana sem declarar: `getNextValidQueueTime`
(`execute-flow/index.ts:17`) usa `activeDays` default seg–sex, então num sábado o
item é agendado para a segunda e o teste estourava o timeout esperando `sent`.
Corrigido passando `force: true` na chamada do `process-queue` dentro do teste.

### Próximos passos

1. Credenciais Meta (`META_APP_ID`, `META_APP_SECRET`, access token, WABA e
   Phone Number ID reais) — ver `docs/meta-whatsapp-setup.md`. **É o único
   bloqueio restante:** toda a infraestrutura já está no ar esperando por elas.
2. Trocar o `META_APP_SECRET` provisório pelo real (senão a Meta de verdade é
   rejeitada) e gravar a conexão do número com
   `node scripts/seed-whatsapp-connection.mjs <email> <phone_number_id> <waba_id> <token>`.
3. Rodar o E2E com `STAGING_META_HAS_REAL_TOKEN=true` para exigir entrega real.
4. Reativar os flows dos tenants migrados, que continuam desativados.
5. Domínio próprio na Vercel, se desejado.
6. Bloco B, Fase 2 em diante (telas de configuração, Embedded Signup, templates).

### Débito conhecido do Bloco A

- `inbound-orchestrator.ts` está fora do `coverage.include`: os portões têm unit
  test (9 casos), mas as trilhas profundas (classificação por IA, execução de
  blocos) são cobertas por E2E. Incluí-lo exigiria baixar o threshold ou escrever
  teste raso só pelo número.
- `platform-role.ts` e `marketing-consent.ts` somem da tabela de cobertura apesar
  dos testes passarem — mesmo sintoma já registrado para `evolution.ts`.


## Frontend em produção na Vercel (2026-07-16)

- Projeto Vercel `eleveflow` (scope `lacerdas-projects-9f9ac935`), alias público
  https://eleveflow-tan.vercel.app (aliases `eleveflow.vercel.app` era de terceiro).
- Deploy: `npm run build:staging` (nitro preset `vercel`, baked com env do
  `.env.staging` = projeto `xlycu...`) → `vercel deploy --prebuilt --prod`.
- Runtime env na Vercel (production+preview): `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (sb_secret moderno).
- E2E: 6/6 VERDES contra o deploy real em 2026-07-16 (`E2E_BASE_URL=...`):
  login, inbound webhook, jornada do agente com LLM real (10,8s, custo em
  `api_calls`), saída LIMITE, observabilidade.
- Secrets no Supabase: `OPENROUTER_API_KEY` configurado; `EVOLUTION_WEBHOOK_SECRET`
  rotacionado (plaintext só no `.env.staging`).
- Integrações reais (2026-07-16): `EVOLUTION_API_URL=https://evolutionapi.prismasolucoes.art`
  (v2.3.7) + `EVOLUTION_API_KEY` configurados; `EVOLUTION_MOCK` REMOVIDO — envio
  de fila agora é real. Smoke: login e2e + whatsapp-proxy fetchInstances → 200.
  `SERPAPI_KEY` setada (pelo usuário), mas cota do Free Plan esgotada (250/250) —
  extração volta quando a cota renovar.
- `.env.staging` corrigido: `STAGING_SUPABASE_SECRET_KEY` (sb_secret do `xlycu...`),
  chave legada do `cdnck...` desativada; `STAGING_INTERNAL_FUNCTION_SECRET` e
  `STAGING_EVOLUTION_WEBHOOK_SECRET` adicionados.

## Decisão 2026-07-15: produção é `xlycuunqpgpyfmafgajr`

- O projeto `eleveflow-marketing` (sa-east-1, conta própria) é a PRODUÇÃO oficial.
- `aoanpviozfabrrxjqayk` (Lovable) está abandonado — conta inacessível, ignorar.
  O `.env` da raiz ainda carrega esse ref legado; não confiar nele.
- Disciplina de produção vale aqui: mudanças aditivas, smoke pós-deploy.

## Produção segura de marketing — estado atual

- Projeto `xlycuunqpgpyfmafgajr` (`eleveflow-marketing`, sa-east-1) foi criado
  do zero. Todas as migrations locais foram aplicadas e `db lint` não encontrou
  erros.
- Edge Functions: autenticação explícita, chaves Supabase modernas, webhook da
  Evolution com segredo em header, isolamento por tenant, opt-out irrevogável e
  respostas do provedor redigidas.
- Fila: claim serializado por tenant, token de lease, finalização transacional de
  `messages` + `send_queue`, limite diário/intervalo protegido, cancelamento por
  opt-out e estado conservador `delivery_unknown` para falha após aceite do provedor.
- Validação local: Deno check das 13 functions, `npm run typecheck`, 55 testes
  unitários, cobertura 96,39% statements, `npm run build`, `npm audit` sem high/
  critical e lint com 0 erros (368 avisos legados).
- Edge Functions: as 13 funções foram publicadas e estão ativas. Os segredos
  internos, o modo `EVOLUTION_MOCK=true` e os dois cron jobs protegidos estão
  configurados; smoke autenticado de fila/fluxos passou e a fila sem credencial
  responde HTTP 401.
- Próximo gate: apontar um host de frontend para este staging e executar E2E com
  uma chave administrativa nova. Integrações externas (OpenRouter, SerpAPI e
  Evolution) continuam desativadas até receberem suas credenciais próprias.

Atualizado: 2026-07-14

## Infra

- Repo git local (fases B+C mergeadas em `main`; bloco de marketing em
  `feat/producao-segura-marketing`). Sem remote.
- Stack: React + Vite + TanStack Router (`src/routes/`), Supabase (edge functions em `supabase/functions/`, migrations em `supabase/migrations/`).
- Gerenciador: npm (package-lock.json). bun.lock legado do export, ignorar.
- `.env` local fora do repo; `.env.staging` (gitignored) com chaves do staging + `OPENROUTER_API_KEY`.
- Spec: `docs/specs/2026-07-04-agente-ia-e2e-observabilidade-design.md`.
- Planos: fase A `docs/plans/2026-07-04-fase-a-harness.md`; fases B+C
  `docs/plans/2026-07-06-fases-bc-agente-observabilidade.md`.

## Verificado (fases B+C fechadas em 2026-07-09, no staging)

- Unit: 52 testes VERDES em 5 arquivos; cobertura gate ≥80% ativo
  (stmts 96,4% | branches 87,2% | funcs 100% | lines 98,8% nos módulos incluídos).
- E2E Playwright: 5/5 VERDES contra staging — login, inbound, jornada do agente
  (saída OBJETIVO com LLM real 9,3s; saída LIMITE forçada 6,2s), página de
  observabilidade (gasto real visível, transcript abre).
- Smoke real: `stage_classifier` via OpenRouter → `api_calls` com
  `cost_usd_micros=30`, 159+34 tokens, 834ms (critério §8.1 provado).
- `npm run build` VERDE; `npm run typecheck` VERDE (0 erros).
- Lint: arquivos novos das fases B+C limpos; baseline legado inalterado
  (~5,2k em arquivos não tocados; `any` legados em ConfigPanel/FlowNode/AppLayout
  pré-existentes, fora do escopo).
- Staging `cdnckhzqvqvrtaeyafon`: 3 migrations novas aplicadas, 13 functions
  deployadas (inclui `ai-agent-reply`), secrets `EVOLUTION_MOCK` + `OPENROUTER_API_KEY`,
  cron versionado com 2 jobs ativos.

## Fases B+C — entregue

- Motor do agente: case `ai_agent` no `execute-flow` (abertura) + edge function
  `ai-agent-reply` (turno com lock otimista via `context.agent.processing_since`,
  decisão commitada antes da fila, saídas goal/giveup/limit roteadas por
  sourceHandle). Webhook delega inbound ao agente.
- `_shared/ai.ts`: `callLLM` OpenRouter (usage real → `cost_usd_micros`), retry
  1x em 429/5xx/rede, timeout 60s, registro SEMPRE em `api_calls`.
- `_shared/agent-prompt.ts`: guardrails fixos §4.6 + parse de decisão tolerante.
- `_shared/serp.ts`: toda chamada SerpAPI instrumentada (custo derivado,
  api_key nunca logada). Classificador de etapa e vision migrados p/ OpenRouter.
- Tabela `api_calls` (RLS: leitura própria, escrita service role) + 4 views
  `security_invoker` + página `/observabilidade` (cards, gráfico 14d empilhado,
  feed do agente com transcript, tabela com drill-down).
- Bloco `ai_agent` no canvas: modelos reais, `goal_description`, `max_turns`,
  3 saídas nomeadas.
- Cron `process-flows`/`process-queue` versionado em migration (parametrizado
  via `global_settings`).

## Próximos passos

- OBSOLETO (decisão 2026-07-15): o gate de produção contra `aoanpviozfabrrxjqayk`
  não existe mais — produção agora é `xlycuunqpgpyfmafgajr`, já migrado e com as
  13 functions deployadas.
- ~~Apontar host de frontend + E2E~~ FEITO 2026-07-16 (Vercel, 6/6 verdes).
- ~~OpenRouter~~ FEITO 2026-07-16 (`OPENROUTER_API_KEY` no Supabase, provado por E2E).
- ~~Evolution real + fim do mock~~ FEITO 2026-07-16 (smoke via proxy autenticado).
- ~~SerpAPI~~ chave setada 2026-07-16; aguardando cota renovar (Free 250/250).
- Migração Lovable→produção FEITA 2026-07-16: tenants Nickolas Gregorio
  (nickolas@eleveflow.test, 572 leads, 2 flows, 2.432 msgs) e Eleve One
  (eleveone@eleveflow.test, 345 leads, 1 flow, 1.110 msgs) a partir dos CSVs em
  `migracao/` (gitignored). ids originais preservados, user_id remapeado,
  flows importados DESATIVADOS, estado de fluxo dos leads zerado, consentimento
  default 'unknown'. NÃO migrados: send_queue, logs, flow_executions,
  account_secrets, tenants "Mestre" e "eleve one 3". Verificado no banco:
  917 leads, 3.542 msgs, phone_normalized 100%, 0 flows ativos, fila 0.
  Senhas temporárias entregues ao usuário (trocar no primeiro acesso).
- Restante:
  1. Conectar WhatsApp real pelo app (página Whatsapp → criar/conectar instância
     via QR; webhook auto-registra com header secreto). Instância "Atual"
     pré-existente no servidor é ignorada pelo app.
  2. Teste inbound real (mensagem de WhatsApp de verdade → webhook → agente).
  3. Reativar flows migrados conscientemente (envio real ligado).
  4. Domínio próprio na Vercel, se desejado.
- Fase D (UI/UX): auditoria visual + design tokens, conforme spec §6.
- Definir remote (GitHub) e push, se desejado.

## Incidente de deploy — frontend apontou para o projeto legado (2026-08-19)

Um deploy do frontend pela CLI da Vercel publicou uma build que apontava para
`aoanpviozfabrrxjqayk` (legado Lovable) em vez de `xlycuunqpgpyfmafgajr`. Sintoma:
"invalid credentials" no login, porque o site conversava com outro banco. Sem escrita
de dados — a falha ocorria antes de qualquer operação. Corrigido no mesmo dia.

**Causa:** as variáveis na Vercel eram `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`,
**sem o prefixo `VITE_`**. O Vite só expõe ao cliente o que começa com `VITE_`, então
a build caiu no `.env` da raiz, que carrega o ref legado.

**Corrigido:** `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` criadas no
ambiente Production da Vercel, com os valores de produção.

**Regra para build local** (a Vercel só injeta as próprias variáveis quando o build
roda lá):

```bash
set -a; source .env.staging; set +a   # apesar do nome, aponta para PRODUÇÃO
npm run build
grep -rl "aoanpviozfabrrxjqayk" .vercel/output/   # tem que sair vazio
npx vercel deploy --prebuilt --prod
```

Conferir o destino do bundle publicado antes de considerar o deploy pronto:

```bash
ASSET=$(curl -s "https://eleveflow-tan.vercel.app/" | tr -d '\0' \
  | grep -aoE '/assets/index-[a-zA-Z0-9._-]+\.js' | head -1)
curl -s "https://eleveflow-tan.vercel.app$ASSET" | tr -d '\0' \
  | grep -aoE "https://[a-z0-9]+\.supabase\.co" | sort -u
```

## Débitos conhecidos (não bloqueantes)

- **Sem remote git neste clone** (`git remote -v` vazio): os commits da coexistência
  existem apenas na máquina local. Definir o remote e publicar. Enquanto isso,
  deploys pela CLI são avulsos e um push futuro pode sobrescrevê-los.
- `src/integrations/supabase/types.ts` defasado desde 2026-07-15 (5 migrations sem
  refletir). A tarefa da UI de conversas aplicou um patch cirúrgico de 6 linhas para
  `origin` e `human_takeover_until`; outras colunas recentes seguem ausentes.
  Regenerar quando houver folga.
- `supabase functions deploy` **não aceita `--linked`** (só os comandos `db` aceitam).
  A forma correta é `bash scripts/sb-staging.sh functions deploy <nome> --use-api`.
- `npm run lint` no projeto inteiro estoura o tempo limite por ruído de CRLF.
  Validar por escopo: `npx prettier --check --end-of-line auto <arquivos>` e
  `npx eslint <arquivos>`.
- Nomenclatura "staging" defasada: `.env.staging`, `build:staging` e
  `scripts/sb-staging.*` hoje apontam para PRODUÇÃO (`xlycu...`). Renomear
  quando houver folga (mexer também em docs/staging.md e workflows).

- **Evolution sem prova de tráfego por evento.** A tela `/whatsapp` mostra
  instância, pareamento e webhook, mas não "recebimento provado" nem "envio
  provado": para a Meta isso vem de `recordInboundProof`/`recordOutboundProof`,
  gravados por evento na conexão. A Evolution não tem equivalente — falta coluna
  na conexão e escrita no `whatsapp-webhook` (inbound) e no `process-queue`
  (outbound). Varrer `messages` para isso é proibido por `connection-proof.ts`.

- ~~`evolution.ts` some da TABELA de cobertura~~ Obsoleto em 2026-09-24:
  `_shared/evolution.ts` não existe mais. Arquivo com 100% em tudo some da tabela
  de texto porque o Vitest 4 liga `skipFull` quando roda num agente; ver a seção do
  Sales Coach.
- Views sem `GRANT SELECT` explícito (funciona via default privileges).
- Cron job sem guarda NULL-url se `global_settings` faltar chave (trigger de
  estágio tem a guarda; considerar hardening).
- `finishAgent` não checa `{error}` do update (backstop: takeover de 2min).
- Transcript da observabilidade pega as 80 mensagens mais antigas do lead.

## Notas de retomada

- Desde 2026-09-24 as sessões abrem direto no `eleve.flow2`, o sistema real. O
  `eleve.flow.3` (export do Lovable) está arquivado: só consulta.
- Ambiente Windows: TLS interceptado pelo Avast + `.env` com project id LEGADO
  (`aoanp...`) → TODO comando supabase via `scripts/sb-staging.sh`. Ver docs/staging.md.
  ATENÇÃO: o wrapper agora aponta para o que É produção — cuidado redobrado.
- Verificação read-only: `bash scripts/sb-staging.sh db query --linked "SQL"`.
- E2E requer `.env.staging` e roda com
  `set -a; source .env.staging; set +a; npm run test:e2e`.
