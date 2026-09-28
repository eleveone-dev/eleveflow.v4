# Spec — Tarefas pela API do Eleve Office (parte C)

Data: 2026-09-25
Status: desenho aprovado pelo dono em 2026-09-25 (decisões no fim). Não implementado.
Escopo: repositório `eleve.flow2`, projeto Supabase `xlycuunqpgpyfmafgajr` (produção).

## Contexto

Parte C de quatro da integração com o Eleve Office (A captura e B leitura comercial no
ar; D lembretes depois). O consumidor é o **Nexo**, o orquestrador do Office: recebe
ordens, organiza tarefas, distribui trabalho entre agentes e acompanha a entrega. O
EleveFlow é o registro principal da tarefa: o id é o do EleveFlow, e a tela Minhas
Tarefas continua sendo onde o dono vê e decide.

## Estado atual (verificado em 2026-09-25)

- `personal_tasks`: `id`, `user_id`, `title`, `description`, `priority`
  (`low`/`medium`/`high`), `status` (`pending`/`in_progress`/`done`,
  `personal_tasks_status_check`), `due_date` (timestamptz), `completed_at`,
  `position`, `created_at`, `updated_at` (trigger `update_personal_tasks_updated_at`).
  RLS "Users manage own personal tasks" (`auth.uid() = user_id`). 5 tarefas no banco.
- Sem vínculo com lead, criador, responsável, origem, id externo nem resultado.
- A tela (`src/pages/Tasks.tsx`) cria, edita, apaga e conclui com um clique: `done` com
  `completed_at`, e o clique de volta reabre como `pending`.
- A `office-api` (parte B) já tem token com escopo, auditoria por chamada, limite por
  token, cursor e feed de exclusões. Só aceita GET.

## Desenho

### 1. Dados (aditivo em `personal_tasks`)

| coluna | tipo | nota |
|---|---|---|
| `origin` | text, padrão `eleveflow` | `eleveflow` ou `eleve_office` |
| `lead_id` | uuid | fk `leads`, lead da mesma conta (trigger de validação) |
| `project_ref` | text | referência externa; o EleveFlow não tem projetos |
| `creator_type`, `creator_ref` | text | `dono` ou `agente`; `ref` é o id do agente no Office |
| `assignee_type`, `assignee_ref` | text | idem; padrão `dono` |
| `external_order_id` | text | ordem de trabalho do Office |
| `result`, `result_ref` | text | resultado da entrega e link |
| `version` | integer, padrão 1 | +1 em toda alteração, pela tela ou pela API (trigger) |
| `idempotency_key` | text | única por conta; só em tarefa criada pela API |

- Agente nunca vira usuário: é tipo `agente` com a `ref` do Office.
- Status ganha `aguardando_revisao`: `pending`, `in_progress`, `aguardando_revisao`,
  `done`.

### 2. Rotas novas na `office-api`

| rota | escopo | o que faz |
|---|---|---|
| `GET tarefas` | `tarefas:leitura` | lista por (`atualizada_em`, `tarefa_id`), cursor; filtros `status`, `responsavel_tipo`, `responsavel_ref`, `atualizado_desde`; serve de feed |
| `GET tarefas/{id}` | `tarefas:leitura` | uma tarefa |
| `POST tarefas` | `tarefas:escrita` | cria; `Idempotency-Key` obrigatório |
| `PATCH tarefas/{id}` | `tarefas:escrita` | altera campos permitidos; `If-Match` obrigatório |
| `POST tarefas/{id}/entrega` | `tarefas:escrita` | entrega com resultado; `If-Match` obrigatório |

Tarefa de outra conta responde 404, igual a inexistente.

**Tarefa na API:**

```json
{
  "tarefa_id": "uuid",
  "conta_id": "uuid",
  "titulo": "Ligar para a Barbearia Exemplo",
  "descricao": "Confirmar a demonstração de quinta",
  "prioridade": "alta",
  "status": "em_andamento",
  "criador": { "tipo": "agente", "ref": "nexo" },
  "responsavel": { "tipo": "agente", "ref": "sdr-1" },
  "prazo": "2026-09-26T13:00:00Z",
  "lead_id": "uuid",
  "projeto_ref": null,
  "origem": "eleve_office",
  "ordem_externa_id": "ordem-123",
  "resultado": null,
  "resultado_ref": null,
  "versao": 3,
  "criada_em": "...",
  "atualizada_em": "...",
  "concluida_em": null
}
```

- `prioridade`: `baixa`, `media`, `alta`. `status`: `pendente`, `em_andamento`,
  `aguardando_revisao`, `concluida`.
- `prazo`: ISO 8601 **com fuso** obrigatório (`Z` ou `-03:00`); sem fuso, 400. A
  resposta vem em UTC.

### 3. Regras de escrita

**Criação (`POST tarefas`):**

- `Idempotency-Key` (1 a 200 caracteres) obrigatório. Repetição com a mesma chave
  devolve a tarefa já criada (200, em vez de 201) e não cria outra. O corpo da repetição
  é ignorado.
- Corpo: `titulo` (obrigatório), `descricao`, `prioridade` (padrão `media`), `prazo`,
  `lead_id`, `projeto_ref`, `responsavel` (`{tipo, ref}`; padrão `dono`; `ref`
  obrigatória para `agente`), `criador_ref`, `ordem_externa_id`.
- Nasce `pendente`, com `origem = eleve_office` e `criador.tipo = agente`.
- `lead_id` de outra conta ou inexistente: 400. A conta é a do token; nada no corpo muda
  a conta.

**Alteração (`PATCH tarefas/{id}`):**

- `If-Match: "<versao>"` obrigatório (sem ele, 428). Versão diferente da atual: 412, com
  a tarefa atual no corpo, para o Office refazer a alteração sobre ela.
- Campos permitidos: `titulo`, `descricao`, `prioridade`, `prazo`, `lead_id`,
  `projeto_ref`, `responsavel`, `status`. Qualquer outro campo: 400.
- `status` só entre `pendente` e `em_andamento`, e só a partir desses dois. Tarefa
  `aguardando_revisao` ou `concluida` não muda de status pela API: 409
  `transicao_invalida`.
- Vale para qualquer tarefa da conta, inclusive as criadas pelo dono na tela (decisão
  do dono).

**Entrega (`POST tarefas/{id}/entrega`):**

- `If-Match` obrigatório. Corpo: `resultado` (obrigatório, até 5.000 caracteres) e
  `resultado_ref` (opcional, URL).
- De `pendente`, `em_andamento` ou `aguardando_revisao` (reentrega atualiza o
  resultado) para `aguardando_revisao`. Tarefa `concluida`: 409.
- Nenhuma rota conclui, apaga ou reabre. **Quem conclui é o dono, na tela.**

### 4. Tela Minhas Tarefas

- Status "Aguardando revisão" em destaque, com filtro próprio.
- No cartão: resultado e link, origem (Eleve Office), responsável (agente, pela `ref`) e
  lead vinculado.
- Tarefa aguardando revisão: botões **Concluir** (vai a `done`) e **Devolver** (volta a
  `in_progress`). O clique de concluir continua valendo para as demais.
- Implementação com a skill `frontend-design`.

### 5. Auditoria e sincronização

- `personal_task_history (id, task_id, user_id, actor, action, fields, status_from,
  status_to, created_at)` por trigger em INSERT e UPDATE. `actor` = `tela` ou
  `api:<rótulo do token>` (a função da API marca a sessão com `set_config`). Guarda nomes
  de campos e status, não o texto. Sobrevive à exclusão da tarefa.
- Tarefa apagada na tela vira tombstone `tarefa` no feed `exclusoes`.
- `GET tarefas` deixa de fora os últimos 5 segundos, como os outros feeds.

### 6. Tokens

- Escopos já previstos: `tarefas:leitura`, `tarefas:escrita`.
- O Nexo ganha token próprio com os dois, mostrado uma vez ao dono. O token atual do
  Office (`comercial:leitura`) não escreve tarefa: 403.

### 7. Erros novos

| status | código | quando |
|---|---|---|
| 409 | `transicao_invalida` | mudança de status fora da regra; entrega de tarefa concluída |
| 412 | `versao_desatualizada` | `If-Match` diferente da versão atual |
| 428 | `versao_obrigatoria` | PATCH ou entrega sem `If-Match` |
| 400 | `parametro_invalido` | corpo inválido, campo não permitido, prazo sem fuso, lead de outra conta, POST sem `Idempotency-Key` |

Repetição: 412 e 409 não se repetem às cegas (reler e decidir). POST com a mesma
`Idempotency-Key` é seguro de repetir. 429 e 5xx seguem a política da parte B.

## Testes

Unitários: regras de transição, validação do corpo (campos, fuso, tamanhos, tipo de
responsável), leitura de `If-Match` e `Idempotency-Key`, mapeamento de status e
prioridade.

E2E contra produção (contas de teste):

- criação idempotente: dois POST com a mesma chave → uma tarefa, mesmo `tarefa_id`;
- atualização conflitante: dois PATCH com a mesma `versao` → o segundo 412 com a atual;
- PATCH sem `If-Match` → 428; campo não permitido → 400; prazo sem fuso → 400;
- entrega sem resultado → 400; entrega → `aguardando_revisao` com o resultado;
  PATCH com `status = concluida` → 409 `transicao_invalida`;
- token só de leitura comercial tentando escrever → 403; token de tarefas lendo leads →
  403;
- isolamento: tarefa da conta B → 404 para o token da conta A;
- histórico: criação e alterações gravadas com o ator da API; tarefa apagada aparece em
  `exclusoes`.

## Fora de escopo

- Concluir, apagar ou reabrir pela API.
- Cadastro de agentes ou projetos no EleveFlow.
- Notificação ao dono (é assunto da parte D).
- Lembretes pessoais (parte D).

## Implantação

Com OK do dono: migration; deploy da `office-api`; frontend; token do Nexo (mostrado uma
vez); E2E; instruções ao Office.

## Decisões do dono (2026-09-25)

1. **Conclusão:** o agente entrega (`aguardando_revisao` com resultado obrigatório); só o
   dono conclui, na tela.
2. **Desenho aprovado** (abordagem 1: estender `personal_tasks` e pôr as rotas na
   `office-api`), inclusive: o Office edita os campos permitidos também das tarefas
   criadas pelo dono, mas nunca conclui, apaga ou reabre.

## Esclarecimentos da implementação (2026-09-25)

Detalhes que o desenho deixou em aberto, fechados no plano
(`docs/plans/2026-09-25-tarefas-office.md`) sem mudar as decisões acima:

1. **Exclusões por escopo.** O token do Nexo não tem `comercial:leitura`; para ver a
   tarefa apagada, `GET exclusoes` aceita `comercial:leitura` **ou** `tarefas:leitura`,
   e cada escopo vê as entidades dele (lead e mensagem; tarefa). O token comercial
   continua vendo o mesmo de antes.
2. **Ator `sistema`.** Escrita sem usuário logado e fora da API (script, chave de
   serviço) fica no histórico como `sistema`, não como `tela`.
3. **Repetição com a mesma chave:** devolve a tarefa já criada sem aplicar o corpo, mas o
   corpo ainda passa pela validação (400 se inválido).
4. **Tamanhos:** título até 300 caracteres, descrição até 10.000, referências e ids
   externos até 200, resultado até 5.000, link do resultado até 2.000 (http ou https),
   `Idempotency-Key` de 1 a 200 caracteres visíveis sem espaço.
5. **409 e 412 levam a tarefa atual** em `tarefa`, para o Office decidir sem reler.
6. **405** traz o header `Allow` com os métodos da rota.
