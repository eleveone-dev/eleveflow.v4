# Spec — API de leitura comercial para o Eleve Office (parte B)

Data: 2026-09-25
Status: desenho aprovado pelo dono em 2026-09-25 (decisões no fim). Não implementado.
Escopo: repositório `eleve.flow2`, projeto Supabase `xlycuunqpgpyfmafgajr` (produção).

## Contexto

Parte B de quatro da integração com o Eleve Office (A captura do histórico, no ar desde
2026-09-25; C tarefas; D lembretes). O consumidor é o **Agente SDR**: lê leads, chat e
pipeline, acompanha cada oportunidade até ganho ou perda e recomenda melhorias com base
em evidência. A API só lê. Escrita de tarefas é da parte C.

O endpoint `sales-coach` continua com contrato e comportamento. Muda só a origem do
token: sai do segredo `SALES_COACH_TOKENS` e vai para a tabela desta spec.

## Estado atual (verificado em 2026-09-25)

- **Não existe oportunidade separada.** Cada lead tem um `stage_id`; a conta tem um
  pipeline só (as etapas de `pipeline_stages`). Reabrir é voltar de etapa. Lead e
  oportunidade são a mesma entidade.
- **Não existe responsável por lead.** A conta tem um usuário, que é o vendedor.
- **Não existe campo de motivo de perda.** A etapa de perda é o motivo registrado pelo
  vendedor ("Não tem Interesse", "Não Respondeu", "morreu na demonstração").
- **Origem das mensagens** (`messages`): recebida; `origin = 'business_app'` (aparelho,
  desde a parte A); saída sem `flow_id` (vendedor pela tela); saída com bloco `message`
  (fluxo); bloco `ai_agent` (IA). A resposta da IA vai para a fila **sem bloco** desde
  2026-09-22 (`ai-agent-reply`) e a entrega (`complete_marketing_queue_delivery`) grava
  a mensagem sem bloco e sem origem: hoje ela é indistinguível de automação. Só 1
  mensagem do banco tem bloco `ai_agent`.
- **`messages` não tem data de gravação.** `created_at` é o instante da mensagem; a
  recuperação da parte A gravou mensagens com data antiga. Cursor por `created_at`
  perderia essas linhas.
- **Eventos de etapa** (`lead_stage_events`, trigger `record_lead_stage_event`):
  `lead_created` e `stage_changed`, com `from_stage_id`, `to_stage_id`, `changed_by`
  (`auth.uid()`, nulo para automação e importação) e `occurred_at`. Guardam só ids: o
  nome da etapa é o atual. Transições reais só desde 2026-09-21 (47 automáticas, 1
  manual na Eleve One); antes disso, o `lead_created` de lead importado traz a etapa do
  momento da importação e a data de criação original.
- **Exclusões acontecem**: a tela apaga lead (Kanban, Configurações, área de teste) e a
  operação já apagou mensagem. Nada registra a exclusão.
- **Autenticação de terceiros**: só o `sales-coach`, pelo segredo `SALES_COACH_TOKENS`
  (dois hashes: E2E e Eleve Office). Sem escopo, sem limite, sem auditoria.

## Desenho

### 1. Tokens e escopos

Tabela `public.api_tokens`:

| coluna | tipo | nota |
|---|---|---|
| `id` | uuid | pk |
| `user_id` | uuid | conta dona; fk `auth.users` |
| `label` | text | "Eleve Office", "E2E" |
| `token_hash` | text | SHA-256 hex, único |
| `scopes` | text[] | subconjunto de `comercial:leitura`, `tarefas:leitura`, `tarefas:escrita` |
| `rate_limit_per_minute` | int | padrão 120 |
| `created_at`, `revoked_at`, `last_used_at` | timestamptz | |

RLS ligada e sem política; `REVOKE ALL` de `anon` e `authenticated`. Só o
`service_role` lê.

- Token no formato atual (`efsc_` + 32 bytes base64url). O Supabase guarda só o hash.
- Os dois hashes de `SALES_COACH_TOKENS` viram linhas com `comercial:leitura` (decisão
  do dono: o token do Office ganha leitura comercial). O `sales-coach` passa a exigir
  esse escopo pela tabela; o segredo sai depois da conferência.
- Token revogado ou inexistente: 401. Token sem o escopo da rota: 403.
- `last_used_at` atualizado no máximo uma vez por minuto por token.

### 2. Função `office-api`

Uma Edge Function, `verify_jwt = false`, com rotas em
`https://xlycuunqpgpyfmafgajr.supabase.co/functions/v1/office-api/v1/`:

| rota | escopo | ordem da paginação |
|---|---|---|
| `GET leads` | `comercial:leitura` | `atualizado_em`, `lead_id` |
| `GET leads/{id}` | `comercial:leitura` | — |
| `GET leads/{id}/mensagens` | `comercial:leitura` | `enviada_em`, `mensagem_id` |
| `GET leads/{id}/etapas` | `comercial:leitura` | `ocorreu_em`, `evento_id` |
| `GET mensagens` (feed) | `comercial:leitura` | `gravada_em`, `mensagem_id` |
| `GET etapas` (feed) | `comercial:leitura` | `gravado_em`, `evento_id` |
| `GET exclusoes` (feed) | `comercial:leitura` | `excluido_em`, `id` |
| `GET openapi.json` | nenhum | — |

Cada rota lê por uma função SQL (`STABLE`, `SECURITY INVOKER`, `search_path = ''`,
`REVOKE` de `PUBLIC`, `anon` e `authenticated`, `GRANT` só a `service_role`) que recebe
a conta resolvida pelo token e filtra por ela em toda consulta. A conta nunca vem da
requisição. Lead de outra conta responde 404, igual a lead inexistente. Leads de teste
(`is_test`) ficam fora de tudo.

### 3. Contratos

Listas respondem `{ "dados": [...], "proximo_cursor": "...", "tem_mais": true }`.
`proximo_cursor` é o do último item devolvido (ou o recebido, se a página veio vazia):
guardado pelo Office, retoma a sincronização de onde parou. Cursor é opaco (base64url
de `[instante, id]`) e só vale com os mesmos filtros. `limite`: 1 a 500, padrão 100.

**Lead** — filtros de `GET leads`: `atualizado_desde`, `criado_de`, `criado_ate`
(ISO 8601), `etapa_id`, `situacao` (`em_andamento`, `ganha`, `perdida`).

```json
{
  "lead_id": "uuid",
  "nome": "Barbearia Exemplo",
  "empresa": "Barbearia Exemplo",
  "origem": "extrator-google",
  "responsavel": null,
  "etapa": { "id": "uuid", "nome": "Interessado", "tipo": "interested" },
  "situacao": "em_andamento",
  "fechado_em": null,
  "motivo_perda": null,
  "criado_em": "2026-09-21T10:29:20Z",
  "atualizado_em": "2026-09-24T22:25:19Z"
}
```

- `situacao` vem do `funnel_key` da etapa atual: `won` ganha, `lost` perdida, o resto em
  andamento (inclusive lead sem etapa).
- `fechado_em`: instante da última mudança **registrada** (`stage_changed`) para a etapa
  de ganho ou perda em que o lead está. Lead importado já fechado fica `null` — a data
  de criação não é data de fechamento.
- `motivo_perda`: nome da etapa de perda, só com `situacao = perdida`.
- `responsavel`: sempre `null`; o CRM não registra dono por lead. Não há filtro por
  responsável.
- Sem telefone e sem e-mail.

**Mensagem** (`GET leads/{id}/mensagens` e feed `GET mensagens`):

```json
{
  "mensagem_id": "uuid",
  "lead_id": "uuid",
  "conversa_id": "uuid",
  "enviada_em": "2026-09-25T13:53:51Z",
  "gravada_em": "2026-09-25T13:53:52Z",
  "direcao": "recebida",
  "origem": "lead",
  "atendente_id": null,
  "tipo": "texto",
  "texto": "Oi, pode me mandar o orçamento?",
  "tem_texto": true,
  "transcricao": null,
  "status": "recebida"
}
```

- `conversa_id` é o `lead_id`: uma conversa de WhatsApp por lead.
- `origem`, nesta ordem: recebida → `lead`; `origin = 'business_app'` →
  `humano_aparelho`; `origin = 'ia'` ou bloco `ai_agent` → `ia`; saída sem `flow_id` →
  `humano_crm`; demais → `automacao`.
- `atendente_id`: `null`; o CRM não registra qual usuário enviou.
- `tipo`: `texto`, `audio`, `imagem`, `video`, `documento`, `figurinha`, `localizacao`,
  `contato`, `outro`. `texto` integral (sem corte); vazio em mídia sem legenda, com
  `tem_texto = false`. `transcricao` sempre `null`: nada é transcrito.
- `status`: `recebida`, `pendente`, `enviada`, `falhou` (o que o CRM grava hoje) ou
  `null` (mensagem do aparelho).

**Evento de etapa** (`GET leads/{id}/etapas` e feed `GET etapas`):

```json
{
  "evento_id": "uuid",
  "lead_id": "uuid",
  "tipo": "mudanca",
  "de": { "id": "uuid", "nome": "Demonstração", "tipo": "demo" },
  "para": { "id": "uuid", "nome": "Não tem Interesse", "tipo": "lost" },
  "nome_da_epoca": true,
  "ocorreu_em": "2026-09-24T22:25:19Z",
  "gravado_em": "2026-09-24T22:25:19Z",
  "autor": { "tipo": "automacao_ou_importacao", "id": null },
  "resultado": "perda",
  "motivo_perda": "Não tem Interesse"
}
```

- `tipo`: `criacao` (`lead_created`) ou `mudanca` (`stage_changed`).
- `resultado`, só em `mudanca`: `ganho` (entrou em `won`), `perda` (entrou em `lost`),
  `reabertura` (saiu de `won`/`lost` para etapa ativa) ou `null`.
- `autor.tipo`: `usuario` (com `id`) ou `automacao_ou_importacao` (`changed_by` nulo).
- Nome da etapa: o gravado no evento (ver item 5) com `nome_da_epoca = true`; evento
  antigo usa o nome atual, com `nome_da_epoca = false`. Etapa apagada: `null`.

**Exclusão** (`GET exclusoes`):
`{ "entidade": "lead" | "mensagem", "id": "uuid", "excluido_em": "..." }`.

### 4. Origem IA registrada na entrega

- `send_queue.origin text` (nulo = como hoje).
- `ai-agent-reply` enfileira a resposta com `origin = 'ia'`.
- `complete_marketing_queue_delivery` copia `origin` do item para `messages.origin`; o
  resto da função fica igual.
- O check de `messages.origin` passa a aceitar `ia`.

Resposta da IA entregue antes da publicação continua `automacao` (cobertura
documentada).

### 5. Dados para sincronização e histórico

- `messages.inserted_at timestamptz not null default now()`, com índice
  `(user_id, inserted_at, id)`. As linhas existentes recebem o instante da migration.
- Tombstones: tabela `api_deleted_records (id, user_id, entity, entity_id, deleted_at)`
  alimentada por trigger `AFTER DELETE` em `leads` (fora os de teste) e em `messages`
  (só quando o lead ainda existe e não é de teste: a exclusão em cascata de um lead vira
  um tombstone só, o do lead, e a limpeza do "Testar fluxo" não gera nenhum).
- O trigger `record_lead_stage_event` passa a gravar em `metadata` o nome das etapas de
  origem e destino no momento da mudança (dado histórico congelado, regra do projeto).

### 6. Erros, limites e repetição

Corpo de erro: `{ "erro": { "codigo": "...", "mensagem": "..." } }`.

| status | código | quando | repetir? |
|---|---|---|---|
| 400 | `parametro_invalido` | parâmetro fora do formato ou limite; cursor inválido | não |
| 401 | `token_invalido` | token ausente, errado ou revogado | não; avisar o dono |
| 403 | `escopo_insuficiente` | token sem o escopo da rota | não |
| 404 | `nao_encontrado` | lead inexistente ou de outra conta | não |
| 405 | `metodo_nao_permitido` | método diferente de GET | não |
| 429 | `limite_excedido` | mais de `rate_limit_per_minute` chamadas em 60 s | sim, depois de `Retry-After` |
| 500 | `erro_interno` | falha nossa; detalhe só no log | sim, com espera crescente |

- Limite: 120 chamadas por minuto por token (janela deslizante de 60 s).
- Auditoria: `api_request_log (token_id, user_id, metodo, rota, status, itens,
  duracao_ms, created_at)`, sem conteúdo nem parâmetros com dado de lead. É também o
  contador do limite. Linhas com mais de 90 dias apagadas por `pg_cron` diário.
- Recomendação ao Office: timeout de 15 s; repetir 429 depois do `Retry-After` e 5xx ou
  falha de rede com espera de 1, 2, 4, 8 e 16 s; nunca repetir 4xx diferente de 429.
  Toda rota é leitura, então repetir é seguro.

### 7. Documentação

- `docs/api/office-api.openapi.json` (OpenAPI 3.1): rotas reais, autenticação,
  escopos, parâmetros, esquemas, erros e exemplos sanitizados. Servido também em
  `GET openapi.json`.
- `docs/api/office-api.md`: guia do Office (configuração, sincronização incremental,
  exclusões, repetição) e definições:
  - **estoque atual**: leads hoje em cada etapa (`etapa` do lead);
  - **entradas no período**: leads distintos com evento para a etapa na janela;
  - **transições**: os eventos em si, com `de`, `para` e `resultado`;
  - **cobertura histórica**: mensagens desde 16/06 (importadas do app antigo); mensagem
    do aparelho e mídia desde 25/09; origem IA desde a publicação desta parte;
    transições de etapa desde 21/09; nome da etapa da época desde a publicação.

## Testes

Unitários: roteamento, resolução de token e escopo, cursor (codificar, decodificar,
recusar lixo), parâmetros, mapeamento de origem, tipo e status.

E2E contra produção:

- **isolamento**: token da conta A não vê lead, mensagem, evento nem exclusão da conta
  B (listas, feed e `GET leads/{id}` com id da outra conta → 404);
- token sem `comercial:leitura` → 403; token errado → 401; limite baixo → 429 com
  `Retry-After`;
- **paginação**: 7 mensagens com o mesmo instante, lidas de 2 em 2, voltam 7 ids únicos
  em ordem; o feed também;
- **ordem cronológica** de mensagens e eventos gravados fora de ordem;
- **histórico incompleto**: lead sem transição tem `fechado_em = null`; lead perdido
  por importação tem `motivo_perda` e `fechado_em = null`;
- eventos: ganho, perda e reabertura marcados; nome da época gravado;
- exclusão de mensagem e de lead aparece em `exclusoes`; a cascata do lead não gera
  tombstone de mensagem;
- `sales-coach.spec.ts` continua verde com o token vindo da tabela.

Escrita nenhuma em dado real: os E2E usam as contas de teste.

## Fora de escopo

- Qualquer escrita (tarefas são a parte C).
- Responsável por lead, oportunidade separada e motivo de perda como campo.
- Webhooks: a primeira versão é por consulta incremental.
- Transcrição ou download de mídia.
- Tela para gerar e revogar token.

## Implantação

Com OK do dono antes:

1. Migrations (tokens, auditoria, tombstones, `inserted_at`, origem IA, nome da época,
   funções SQL).
2. Hashes atuais para `api_tokens`; tokens de E2E novos (texto só no `.env.staging`).
3. Deploy de `office-api`, `sales-coach` e `ai-agent-reply`.
4. E2E completo; conferência do `sales-coach` com o token do Office.
5. Apagar o segredo `SALES_COACH_TOKENS`.
6. Instruções ao Office: o mesmo token passa a ler a `office-api`.

## Decisões do dono (2026-09-25)

1. **Tokens:** o token atual do sales-coach ganha `comercial:leitura`; o Nexo ganha
   token próprio na parte C.
2. **Desenho aprovado** (abordagem 1: uma função `office-api`, funções SQL por recurso,
   tabela `api_tokens`, limite de 120 por minuto).
3. Registro da origem IA na entrega e nome da etapa congelado no evento: detalhes de
   implementação do desenho aprovado, levados à revisão desta spec.
