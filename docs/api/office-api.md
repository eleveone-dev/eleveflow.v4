# API do Eleve Office — guia de integração

Leitura comercial (Agente SDR) e tarefas (Nexo) do EleveFlow para o Eleve Office.
Contrato completo: `supabase/functions/office-api/openapi.json`, também servido em
`GET /v1/openapi.json`.

## Configuração no Office

| item | valor |
|---|---|
| URL base | `https://xlycuunqpgpyfmafgajr.supabase.co/functions/v1/office-api` |
| autenticação | `Authorization: Bearer <token>` |
| token do Agente SDR | o mesmo já instalado para o sales-coach (`ELEVE_FLOW_SALES_COACH_TOKEN`), com o escopo `comercial:leitura` |
| token do Nexo | próprio, com `tarefas:leitura` e `tarefas:escrita` (variável sugerida `ELEVE_FLOW_NEXO_TOKEN`) |
| escopo exigido | o da rota e do método (tabelas abaixo) |
| limite | 120 chamadas por minuto por token |
| timeout recomendado | 15 s |

O token fica só no servidor do Office: nunca no navegador, no repositório, em log ou em
mensagem de erro. Não há `apikey` nem CORS.

A conta é sempre a do token. Nenhum parâmetro ou campo do corpo escolhe conta, usuário ou
responsável humano.

## Rotas de leitura comercial

| rota | para quê |
|---|---|
| `GET /v1/leads` | leads da conta; filtros `atualizado_desde`, `criado_de`, `criado_ate`, `etapa_id`, `situacao` |
| `GET /v1/leads/{id}` | um lead |
| `GET /v1/leads/{id}/mensagens` | a conversa do lead, em ordem cronológica, texto integral |
| `GET /v1/leads/{id}/etapas` | o histórico de etapas do lead |
| `GET /v1/mensagens` | feed de mensagens gravadas, para sincronizar |
| `GET /v1/etapas` | feed de eventos de etapa gravados, para sincronizar |
| `GET /v1/exclusoes` | feed do que foi apagado (lead, mensagem, tarefa) |

Todas exigem `comercial:leitura`, salvo `exclusoes`, que aceita `comercial:leitura` ou
`tarefas:leitura`: cada escopo vê as entidades dele (lead e mensagem; tarefa).

Listas respondem `{ "dados": [...], "proximo_cursor": "...", "tem_mais": true }`. Use
`limite` de 1 a 500 (padrão 100) e passe o `proximo_cursor` recebido em `cursor`.

## Tarefas (Nexo)

O EleveFlow é o registro da tarefa: o `tarefa_id` é o do EleveFlow e vale na integração.
O Nexo cria, altera e entrega; **só o dono conclui**, na tela Minhas Tarefas.

| rota | escopo | para quê |
|---|---|---|
| `GET /v1/tarefas` | `tarefas:leitura` | tarefas da conta por `atualizada_em`; filtros `status`, `responsavel_tipo`, `responsavel_ref`, `atualizado_desde` |
| `GET /v1/tarefas/{id}` | `tarefas:leitura` | uma tarefa |
| `POST /v1/tarefas` | `tarefas:escrita` | cria; `Idempotency-Key` obrigatório |
| `PATCH /v1/tarefas/{id}` | `tarefas:escrita` | altera; `If-Match` obrigatório |
| `POST /v1/tarefas/{id}/entrega` | `tarefas:escrita` | entrega com resultado; `If-Match` obrigatório |

**Criar.** Mande `Idempotency-Key` com um valor único por tarefa no Office (o id da
ordem ou da tarefa lá), de 1 a 200 caracteres visíveis, sem espaço. Primeira vez: 201.
Repetição com a mesma chave (falha de rede, timeout): 200 com a mesma tarefa, sem criar
outra e sem aplicar o corpo novo, que ainda precisa ser válido. Corpo: `titulo`
(obrigatório, até 300 caracteres), `descricao`, `prioridade` (`baixa`, `media`, `alta`;
padrão `media`), `prazo` (ISO 8601 **com fuso**, como `2026-09-26T10:00:00-03:00`),
`lead_id` (lead da conta), `projeto_ref`, `responsavel` (`{"tipo": "agente", "ref":
"sdr-1"}` ou `{"tipo": "dono"}`; padrão dono), `criador_ref`, `ordem_externa_id`. Campo
fora da lista: 400. A tarefa nasce `pendente`, com `origem = eleve_office` e criador
agente.

**Alterar.** Leia a tarefa, guarde `versao` e mande `If-Match: "<versao>"`. Se alguém
alterou antes (a tela ou outro agente): 412 com a tarefa atual em `tarefa`; refaça a
alteração sobre ela. Campos: `titulo`, `descricao`, `prioridade`, `prazo`, `lead_id`,
`projeto_ref`, `responsavel`, `status`; `null` limpa o campo opcional. `status` só vai e
volta entre `pendente` e `em_andamento`. Vale também para as tarefas que o dono criou na
tela.

**Entregar.** `POST /v1/tarefas/{id}/entrega` com `If-Match` e
`{"resultado": "...", "resultado_ref": "https://..."}` (resultado obrigatório, até 5.000
caracteres; link opcional, http ou https). A tarefa vai para `aguardando_revisao` e
aparece para o dono com **Concluir** e **Devolver**. Reentregar troca o resultado.
Devolvida, ela volta para `em_andamento`, com a última entrega ainda em `resultado`.

**O que a API não faz:** concluir, apagar ou reabrir tarefa. Tarefa `concluida` ou
`aguardando_revisao` não muda de status pela API (409 `transicao_invalida`), e tarefa
concluída não recebe entrega. Um agente ter respondido não conclui nada.

**Agentes** não são usuários do EleveFlow: vão em `responsavel` com `tipo = agente` e a
`ref` do Office. Não há cadastro de agente nem de projeto no EleveFlow.

Cada criação e alteração fica no histórico da tarefa, com o autor (`api:<nome do token>`,
`tela` ou `sistema`) e os nomes dos campos alterados, sem o texto.

## Como sincronizar sem baixar tudo de novo

Guarde um cursor por feed (`leads`, `mensagens`, `etapas`, `exclusoes` e, no Nexo,
`tarefas`).

1. **Primeira carga:** percorra cada feed sem `cursor` até `tem_mais = false`.
2. **Depois:** chame cada feed com o último `proximo_cursor` guardado. Página vazia
   devolve o mesmo cursor: guarde e tente de novo mais tarde.
3. **Alterações:** `GET /v1/leads` ordena por `atualizado_em` e `GET /v1/tarefas` por
   `atualizada_em`; um registro alterado volta a aparecer depois do cursor. Substitua o
   registro local pelo novo (na tarefa, com a `versao` nova).
4. **Exclusões:** para cada item de `/v1/exclusoes`, apague o registro local. Lead
   apagado vem como um item só (`entidade = lead`): apague junto as mensagens e os
   eventos dele. Tarefa apagada na tela vem com `entidade = tarefa`.
5. **Registro indisponível:** `GET /v1/leads/{id}` ou `GET /v1/tarefas/{id}` com 404
   significa apagado, de teste ou de outra conta. Trate como apagado.

Os feeds deixam de fora os últimos 5 segundos, para que uma gravação em andamento não
escape do cursor. Um item gravado agora aparece na próxima leitura. A leitura de um
registro só (`/v1/leads/{id}`, `/v1/tarefas/{id}`) não tem essa espera.

A conversa de um lead (`/v1/leads/{id}/mensagens`) ordena pela data da mensagem
(`enviada_em`). O feed `/v1/mensagens` ordena pela data de gravação (`gravada_em`) e
traz também mensagem antiga recuperada depois.

## Erros e repetição

Corpo de erro: `{ "erro": { "codigo": "...", "mensagem": "..." } }`. Em 409 e 412 vem
também `tarefa`, com a tarefa atual.

| status | código | o que fazer |
|---|---|---|
| 400 | `parametro_invalido` | corrigir o parâmetro ou o corpo; não repetir |
| 401 | `token_invalido` | não repetir; avisar o dono (token ausente, errado ou revogado) |
| 403 | `escopo_insuficiente` | não repetir; o token não tem o escopo da rota |
| 404 | `nao_encontrado` | não repetir; lead ou tarefa inexistente, de teste ou de outra conta |
| 405 | `metodo_nao_permitido` | usar o método da rota (header `Allow`) |
| 409 | `transicao_invalida` | não repetir; releia a tarefa (vem em `tarefa`) e decida |
| 412 | `versao_desatualizada` | não repetir às cegas; refaça a alteração sobre `tarefa` |
| 428 | `versao_obrigatoria` | mandar `If-Match` com a `versao` lida |
| 429 | `limite_excedido` | repetir depois dos segundos do header `Retry-After` |
| 500 | `erro_interno` | repetir com espera de 1, 2, 4, 8 e 16 s; persistindo, avisar o dono |

Falha de rede e 502, 503 ou 504: mesma política do 500. Leitura é segura de repetir.
Criação com a mesma `Idempotency-Key` também. Alteração e entrega repetidas com o mesmo
`If-Match`: se a primeira gravou, a repetição volta 412 com a tarefa já alterada; compare
e siga.

## O que cada campo significa

- **Lead é a oportunidade.** Uma negociação por lead; reabrir é voltar de etapa. Não há
  `oportunidade_id` separado.
- **Responsável do lead:** sempre `null`. A conta tem um vendedor; o CRM não registra dono
  por lead.
- **Situação:** `ganha` (etapa `won`), `perdida` (etapa `lost`) ou `em_andamento`.
- **Motivo de perda:** o nome da etapa de perda. Não há campo de motivo livre, e a API
  não infere motivo.
- **Fechado em:** a última mudança registrada para a etapa de ganho ou perda atual. Lead
  que já chegou fechado (importado) fica `null`.
- **Origem da mensagem:** `lead`; `humano_aparelho` (vendedor pelo celular ou WhatsApp
  Web); `humano_crm` (vendedor pela tela do CRM); `automacao` (fluxo); `ia`.
- **Tipo:** `texto`, `audio`, `imagem`, `video`, `documento`, `figurinha`,
  `localizacao`, `contato`, `outro`. Mídia não é baixada nem transcrita: `transcricao` é
  sempre `null` e `tem_texto` diz se há legenda. Não trate mídia como analisada.
- **Autor de evento:** `usuario` (com `id`) ou `automacao_ou_importacao`.
- **Nome da época:** `nome_da_epoca = true` quando nome e tipo da etapa foram gravados
  na hora da mudança; `false` em evento antigo, que mostra o nome e o tipo de hoje.
- **Tarefa:** `status` em `pendente`, `em_andamento`, `aguardando_revisao` (entregue,
  esperando o dono) ou `concluida`; `origem` é `eleveflow` (criada na tela) ou
  `eleve_office`; `versao` sobe a cada alteração, pela tela ou pela API; `prazo`,
  `criada_em`, `atualizada_em` e `concluida_em` vêm em UTC; `concluida_em` só é
  preenchido quando o dono conclui.

## Indicadores: definições

- **Estoque atual:** quantos leads estão hoje em cada etapa (campo `etapa` do lead).
- **Entradas no período:** leads distintos com evento para a etapa dentro da janela
  (`/v1/etapas`, por `ocorreu_em`). Um lead que entra duas vezes conta uma.
- **Transições:** os eventos em si (`de`, `para`, `resultado`). Servem para tempo por
  etapa e para o caminho real até o resultado.

Não misture os três: estoque é fotografia de agora; entradas e transições são
movimento dentro de uma janela.

## Cobertura histórica

| dado | desde |
|---|---|
| mensagens recebidas e enviadas por fluxo | 2026-06-16 (importadas do app antigo) |
| mensagem do vendedor pelo aparelho e mídia com tipo | 2026-09-25 |
| origem `ia` registrada | publicação da parte B; antes, a resposta da IA aparece como `automacao` |
| transições de etapa | 2026-09-21; antes, só o evento de criação, com a etapa do momento da importação |
| nome e tipo da etapa congelados no evento | publicação da parte B |
| status de entrega | só `enviada`, `pendente`, `falhou` e `recebida`; entregue e lida não são registrados |
| histórico e exclusão de tarefa | publicação da parte C; antes, nada foi registrado |

O que não foi registrado não é reconstruído: a API não inventa evento nem motivo.
