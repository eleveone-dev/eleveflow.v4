import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import {
  assertLeadCanReceiveMarketing,
  HttpError,
  getHttpErrorStatus,
  getRequestActor,
  getResourceOwner,
  internalAuthHeaders,
  resolveActorUserId,
} from "../_shared/auth.ts";
import {
  resolveExistingNextBlockId,
  findAllNextBlockIds,
  findFallbackBlockId,
} from "../_shared/flow-routing.ts";
import { canReceiveWhatsApp } from "../_shared/whatsapp/phone-target.ts";
import { renderizarMensagem } from "../_shared/message-humanize.ts";
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../_shared/ai.ts";
import { buildAgentMessages, parseAgentResponse, AGENT_DEFAULTS } from "../_shared/agent-prompt.ts";
import {
  humanTakeoverUntil,
  rescheduleForTakeover,
  shouldSkipAutomation,
} from "../_shared/whatsapp/human-takeover.ts";

function getNextValidQueueTime(settings: any, baseDate = new Date()) {
  const schedule = settings || {};
  if (schedule.respect_business_hours === false) return baseDate.toISOString();
  const startHour = parseInt(schedule.start_hour ?? 8);
  const endHour = parseInt(schedule.end_hour ?? 18);
  const activeDays: number[] =
    Array.isArray(schedule.days) && schedule.days.length > 0 ? schedule.days : [1, 2, 3, 4, 5];
  const br = new Date(baseDate.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  if (br.getHours() < startHour) br.setHours(startHour, 0, 0, 0);
  if (br.getHours() >= endHour) {
    br.setDate(br.getDate() + 1);
    br.setHours(startHour, 0, 0, 0);
  }
  let safety = 0;
  while (!activeDays.includes(br.getDay()) && safety < 14) {
    br.setDate(br.getDate() + 1);
    br.setHours(startHour, 0, 0, 0);
    safety++;
  }
  return new Date(br.getTime() + 3 * 60 * 60 * 1000).toISOString();
}

/**
 * Encerra a execução quando o lead não pode receber a mensagem, e diz por quê.
 *
 * Existe porque deixar a execução `running` com `scheduled_at` nulo tirava o lead
 * do fluxo para sempre: o `process-flows` só retoma `scheduled_at <= agora` e o
 * `trigger-flow-by-stage` pula lead com execução ativa. `blocked` é final e não
 * está na lista de status ativos, então um novo gatilho volta a funcionar.
 */
async function encerrarPorBloqueio(
  client: any,
  evento: "lead_phone_not_whatsapp" | "marketing_automation_blocked",
  ctx: {
    execution?: { id?: string } | null;
    user_id: string;
    lead_id: string;
    flow_id: string;
    block_id: string;
  },
  detalhes: Record<string, unknown>,
): Promise<void> {
  if (ctx.execution?.id) {
    await client
      .from("flow_executions")
      .update({ status: "blocked", scheduled_at: null })
      .eq("id", ctx.execution.id);
  }
  await client.from("logs").insert({
    user_id: ctx.user_id,
    lead_id: ctx.lead_id,
    flow_id: ctx.flow_id,
    block_id: ctx.block_id,
    event: evento,
    details: detalhes,
  });
}

async function moveLeadToOwnedStage(
  client: any,
  userId: string,
  leadId: string,
  targetStageId: unknown,
): Promise<void> {
  if (!targetStageId || typeof targetStageId !== "string") {
    throw new HttpError(400, "A valid target stage is required");
  }
  const stageOwnerId = await getResourceOwner(client, "pipeline_stages", targetStageId);
  if (stageOwnerId !== userId) {
    throw new HttpError(403, "Target stage belongs to another tenant");
  }
  const { error } = await client
    .from("leads")
    .update({ stage_id: targetStageId })
    .eq("id", leadId)
    .eq("user_id", userId);
  if (error) throw error;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: any = {};
  try {
    const supabaseClient = createServiceRoleClient();

    body = await req.json().catch(() => ({}));
    console.log("Diagnóstico - Body recebido:", JSON.stringify(body));

    const {
      flow_id,
      lead_id,
      execution_id,
      phone,
      user_id: requestedUserId,
      trigger_type,
      reply_content,
      block_id,
      // Ramos irmãos que quem chamou já resolveu (saída do agente de IA ligada em
      // mais de um bloco). Percorridos depois do ramo principal, nesta invocação.
      parallel_block_ids,
      is_test,
    } = body;

    // Resposta de cliente e teste manual não entram no espaçamento da
    // prospecção. O `next_send_slot` existe para não queimar o número
    // disparando em série para quem nunca falou com a gente; quem acabou
    // de escrever está em conversa, e esperar o próximo slot (podia ser 40
    // minutos depois) fazia o fluxo parecer morto — foi o "só manda a
    // primeira mensagem". O mesmo valia para o teste de fluxo, que
    // enfileirava e não achava o item, porque o `process-queue` só pega
    // `scheduled_at <= agora`. Vale para o bloco de mensagem e para a
    // abertura do agente.
    const envioImediato =
      trigger_type === "reply_received" || trigger_type === "manual" || is_test === true;

    // Validação de Payload: início de fluxo não tem execution_id; respostas/agendamentos têm.
    if (!flow_id || !lead_id) {
      const errorResponse = {
        success: false,
        step: "validate_payload",
        error: "Payload inválido",
        missing: {
          flow_id: !flow_id,
          lead_id: !lead_id,
        },
      };
      console.error("Payload inválido detectado:", JSON.stringify(errorResponse));
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve ownership from actual database resources, not body.user_id.
    const actor = await getRequestActor(req);
    const [leadOwnerId, flowOwnerId] = await Promise.all([
      getResourceOwner(supabaseClient, "leads", lead_id),
      getResourceOwner(supabaseClient, "flows", flow_id),
    ]);
    if (leadOwnerId !== flowOwnerId) {
      throw new HttpError(403, "Lead and flow belong to different tenants");
    }
    const user_id = resolveActorUserId(actor, leadOwnerId, requestedUserId);

    if (execution_id) {
      const { data: requestedExecution, error: requestedExecutionError } = await supabaseClient
        .from("flow_executions")
        .select("id, user_id, lead_id, flow_id")
        .eq("id", execution_id)
        .maybeSingle();
      if (requestedExecutionError) throw requestedExecutionError;
      if (
        requestedExecution &&
        (requestedExecution.user_id !== user_id ||
          requestedExecution.lead_id !== lead_id ||
          requestedExecution.flow_id !== flow_id)
      ) {
        throw new HttpError(403, "Execution does not belong to the requested tenant/resources");
      }
    }

    // Note: If authUserId is null, it's a service-role call (e.g., from resume-flow),
    // which is trusted as it's internal.

    console.log(`Executing flow ${flow_id} for lead ${lead_id}. Trigger: ${trigger_type}`);

    // 1. Get flow and all blocks
    const { data: flow, error: flowError } = await supabaseClient
      .from("flows")
      .select("*")
      .eq("id", flow_id)
      .single();

    if (flowError || !flow) throw new Error("Flow not found");
    const canvasState: any = flow.canvas_state || {};
    const edges: any[] = Array.isArray(canvasState.edges) ? canvasState.edges : [];

    const { data: blocks, error: blocksError } = await supabaseClient
      .from("flow_blocks")
      .select("*")
      .eq("flow_id", flow_id)
      .order("position", { ascending: true });

    if (blocksError) throw blocksError;

    const { data: accountRow } = await supabaseClient
      .from("accounts")
      .select("settings")
      .eq("user_id", user_id)
      .maybeSingle();
    const userSettings = accountRow?.settings || {};

    // 2. Get or create flow_execution
    let execution: any = null;
    let execError: any = null;

    if (execution_id) {
      const execRes = await supabaseClient
        .from("flow_executions")
        .select("*")
        .eq("id", execution_id)
        .maybeSingle();
      execution = execRes.data;
      execError = execRes.error;
    }

    if (!execution && !execError) {
      const execRes = await supabaseClient
        .from("flow_executions")
        .select("*")
        .eq("lead_id", lead_id)
        .eq("flow_id", flow_id)
        .in("status", ["running", "waiting_response", "active"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      execution = execRes.data;
      execError = execRes.error;
    }

    if (!execution) {
      // Se execution_id foi passado pelo chamador (webhook/process-flows) mas não achamos,
      // NÃO criamos nova execução — provavelmente é uma corrida com outra invocação
      // que acabou de avançar/concluir a execução. Criar uma nova causaria fluxo paralelo
      // começando no bloco errado (ex: wait), pulando mensagens.
      if (execution_id) {
        console.log(
          `[execute-flow] execution_id ${execution_id} não encontrado — abortando para evitar execução paralela.`,
        );
        return new Response(
          JSON.stringify({
            success: true,
            ignored: true,
            reason: "execution_not_found",
            execution_id,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Confere se já existe execução em andamento para este lead+flow, para
      // evitar duplicatas paralelas no mesmo fluxo do mesmo lead.
      //
      // `completed` e `blocked` são finais e não podem ser reutilizadas:
      // reutilizar uma execução bloqueada por consentimento a fazia avançar
      // mantendo o status `blocked`, e aí o inbound não a retomava mais — ele só
      // procura waiting_response, running e active.
      const { data: anyActive } = await supabaseClient
        .from("flow_executions")
        .select("*")
        .eq("lead_id", lead_id)
        .eq("flow_id", flow_id)
        .not("status", "in", "(completed,blocked)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (anyActive) {
        console.log(
          `[execute-flow] Já existe execução ativa ${anyActive.id} para este lead+flow — reutilizando.`,
        );
        execution = anyActive;
      } else {
        // Find starting block: either the provided block_id, or the first 'trigger' block, or the first block in the list
        const startBlock = block_id
          ? blocks.find((b) => b.id === block_id)
          : blocks.find((b) => b.type === "trigger") || blocks[0];

        if (!startBlock) {
          throw new Error("No starting block found for this flow");
        }

        console.log(
          `Creating new execution starting at block: ${startBlock.type} (${startBlock.id})`,
        );

        const { data: newExec, error: newExecError } = await supabaseClient
          .from("flow_executions")
          .insert({
            user_id,
            lead_id,
            flow_id,
            status: "running",
            current_block_id: startBlock.id,
          })
          .select()
          .single();

        if (newExecError) throw newExecError;
        execution = newExec;

        // Log flow started
        await supabaseClient.from("logs").insert({
          user_id,
          lead_id,
          flow_id,
          event: "flow_started",
          details: { trigger_type, starting_block_id: startBlock.id },
        });
      }
    }

    // 3. Main execution loop
    let currentBlockId = block_id || execution.current_block_id;
    // Se a execução foi pré-criada sem current_block_id (ex.: teste manual via modal),
    // descobrimos o bloco inicial agora (trigger ou primeiro bloco) para não retornar 0 steps.
    if (!currentBlockId) {
      const startBlock = (blocks || []).find((b: any) => b.type === "trigger") || (blocks || [])[0];
      if (startBlock) {
        currentBlockId = startBlock.id;
        await supabaseClient
          .from("flow_executions")
          .update({ current_block_id: startBlock.id, status: "running" })
          .eq("id", execution.id);
        console.log(
          `[execute-flow] current_block_id estava vazio — iniciando em ${startBlock.type} (${startBlock.id})`,
        );
      } else {
        console.log(`[execute-flow] Nenhum bloco encontrado para o fluxo ${flow_id}`);
      }
    }
    const maxSteps = 20; // Prevent infinite loops
    let steps = 0;
    // Ramos paralelos ainda por percorrer. A mesma saída ligada em mais de um
    // bloco executa todos: antes o motor seguia só a primeira ligação e o "mover
    // etapa" pendurado na saída Objetivo do agente nunca acontecia.
    const ramosPendentes: string[] = Array.isArray(parallel_block_ids)
      ? parallel_block_ids.filter(
          (id: unknown) => typeof id === "string" && blocks.some((b: any) => b.id === id),
        )
      : [];
    const jaExecutados = new Set<string>();
    // Ponteiro da execução: o primeiro ramo que parou é por onde o fluxo retoma,
    // então percorrer os irmãos depois dele não pode mexer no ponteiro.
    let ponteiroCongelado = false;

    while (currentBlockId && steps < maxSteps) {
      steps++;
      const block = blocks.find((b) => b.id === currentBlockId);
      if (!block) break;

      console.log(`Processing block: ${block.type} (${block.id})`);
      jaExecutados.add(block.id);
      const config = (block.config as any) || {};
      const rota = findAllNextBlockIds(block, blocks, edges);
      let nextBlockId: string | null = rota[0] ?? null;
      let ramosIrmaos = rota.slice(1);
      let shouldPause = false;

      switch (block.type) {
        case "trigger":
          if (trigger_type && config.trigger_type !== trigger_type) {
            console.log(`Trigger type mismatch: ${config.trigger_type} vs ${trigger_type}`);
            // If manual trigger, we ONLY continue if it's the very first step of the execution
            if (trigger_type !== "manual" || steps > 1) {
              shouldPause = true;
            } else {
              console.log(`Manual trigger: bypassing type check for first block`);
            }
          }
          break;

        case "message": {
          const isResuming = trigger_type === "reply_received" || trigger_type === "time_elapsed";
          const alreadyQueuedThisBlock =
            body.already_queued === true && block.id === execution.current_block_id && steps === 1;

          if (!alreadyQueuedThisBlock) {
            const { data: lead } = await supabaseClient
              .from("leads")
              .select("*")
              .eq("id", lead_id)
              .single();
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
            // Telefone que o WhatsApp nao recebe nao vai para a fila. Antes, o
            // item era enfileirado e o provedor recusava com `Bad Request` na hora
            // do envio: virava falha de envio, quando o problema e o cadastro.
            const alvo = canReceiveWhatsApp(lead);
            if (!alvo.ok) {
              // A flag e dado derivado do telefone, e nos leads migrados ela veio
              // errada: fixo marcado como WhatsApp. Corrigir aqui e o que faz a
              // tela avisar que o numero pode estar errado. Quem discordar edita o
              // cadastro — o campo `whatsapp` vence o `phone`.
              await supabaseClient
                .from("leads")
                .update({
                  has_whatsapp: false,
                  ...(alvo.reason === "unusable_phone" ? { phone_valid: false } : {}),
                })
                .eq("id", lead_id);
              await encerrarPorBloqueio(
                supabaseClient,
                "lead_phone_not_whatsapp",
                { execution, user_id, lead_id, flow_id, block_id: block.id },
                { reason: alvo.reason, phone: lead?.phone ?? null },
              );
              return new Response(
                JSON.stringify({
                  success: true,
                  paused: "phone_not_whatsapp",
                  reason: alvo.reason,
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            try {
              assertLeadCanReceiveMarketing(lead);
            } catch (consentError) {
              await encerrarPorBloqueio(
                supabaseClient,
                "marketing_automation_blocked",
                { execution, user_id, lead_id, flow_id, block_id: block.id },
                {
                  reason:
                    consentError instanceof Error ? consentError.message : String(consentError),
                  consent_status: lead?.marketing_consent_status ?? null,
                  is_suppressed: lead?.is_suppressed ?? false,
                },
              );
              return new Response(
                JSON.stringify({
                  success: true,
                  paused: "marketing_consent",
                  execution_blocked: Boolean(execution?.id),
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            // Variáveis + spintax + saudação pelo relógio de Brasília. O texto é
            // sorteado aqui, no enfileiramento, para o histórico guardar
            // exatamente o que foi enviado.
            const message = renderizarMensagem(config.message || config.text || "", lead || {});

            const delay = config.delay_seconds || 0;
            const minAt = new Date(Date.now() + delay * 1000).toISOString();

            let scheduledAt = minAt;
            if (!envioImediato) {
              const { data: slotRpc, error: slotError } = await supabaseClient.rpc(
                "next_send_slot",
                { p_user_id: user_id, p_min_at: minAt },
              );
              // O fallback abaixo não sorteia intervalo nem respeita o limite
              // diário. Cair nele em silêncio escondeu por meses que a RPC
              // quebrava para conta com hora gravada como "08:00".
              if (slotError) {
                console.error("[execute-flow] next_send_slot falhou, usando fallback:", slotError);
              }
              scheduledAt =
                slotRpc || getNextValidQueueTime(userSettings, new Date(Date.now() + delay * 1000));
            }

            // Insert into send_queue
            const { data: queuedMessage, error: queueInsertError } = await supabaseClient
              .from("send_queue")
              .insert({
                user_id,
                lead_id,
                flow_id,
                block_id: block.id,
                scheduled_at: scheduledAt,
                status: "pending",
                content: message,
              })
              .select("id")
              .maybeSingle();

            if (queueInsertError) throw queueInsertError;

            // A trigger prevent_duplicate_send_queue descarta em silêncio (RETURN
            // NULL) o item de um bloco que este lead já recebeu — pending, sending ou
            // sent. Com `.single()`, a linha ausente virava exceção e o motor
            // devolvia 500: a execução ficava presa na mensagem. Acontecia com lead
            // real que volta a entrar no fluxo e com o lead de teste reaproveitado.
            if (!queuedMessage) {
              await supabaseClient.from("logs").insert({
                user_id,
                lead_id,
                flow_id,
                block_id: block.id,
                event: "send_queue_duplicate_blocked",
                details: { is_test: Boolean(is_test) },
              });
              if (is_test) {
                // No teste, seguir em silêncio daria "sucesso" sem mensagem nenhuma
                // chegando. Melhor dizer por quê.
                return new Response(
                  JSON.stringify({
                    success: true,
                    paused: "duplicate_blocked",
                    message:
                      "Este lead de teste já recebeu esta mensagem. Use 'Limpar teste' e rode de novo.",
                  }),
                  { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
                );
              }
              // Lead real: a mensagem já foi entregue antes. Não repete, e o fluxo
              // segue como se tivesse acabado de enviar.
            }
            // Nada vai para `messages` aqui. A conversa registra o que o lead
            // recebeu, e quem grava é a entrega (complete_marketing_queue_delivery),
            // com o item da fila ligado. Gravar também ao enfileirar fazia toda
            // mensagem entregue aparecer duas vezes, e a que nunca saía ficava
            // "pendente" para sempre.

            if (queuedMessage?.id && (isResuming || envioImediato)) {
              // `force` só vale para chamador service_role, que é o caso aqui. Sem
              // ele o `process-queue` reaplica o filtro de horário e devolve
              // `queue_item_not_found` para o item que acabou de ser criado.
              const baseUrl = Deno.env.get("SUPABASE_URL");
              await fetch(`${baseUrl}/functions/v1/process-queue`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
                body: JSON.stringify({ queueItemId: queuedMessage.id, force: envioImediato }),
              }).catch((e) => console.error("[Flow] Erro ao processar mensagem retomada:", e));
            }
          }

          if (config.wait_for_reply && !alreadyQueuedThisBlock) {
            console.log(
              `[Flow] Bloco de mensagem configurado para aguardar resposta. Pausando lead ${lead_id}`,
            );
            await supabaseClient
              .from("leads")
              .update({ flow_waiting_reply: true })
              .eq("id", lead_id);
            shouldPause = true;
          } else if (!config.auto_continue && !alreadyQueuedThisBlock) {
            console.log(`[Flow] Bloco de mensagem sem auto_continue. Pausando lead ${lead_id}`);
            shouldPause = true;
          } else {
            console.log(`[Flow] Mensagem enviada e auto_continue ativo ou retomando. Seguindo...`);
          }
          break;
        }

        case "wait": {
          const waitType =
            config.wait_type ||
            (config.waitValue || config.wait_seconds || config.waitSeconds ? "time" : "reply");
          if (waitType === "time") {
            let waitSeconds = config.wait_seconds ?? config.waitValue ?? config.waitSeconds ?? 60;
            const unit = config.wait_unit || config.waitUnit || "seconds";

            if (unit === "minutes") waitSeconds *= 60;
            else if (unit === "hours") waitSeconds *= 3600;
            else if (unit === "days") waitSeconds *= 86400;

            const nextRun = new Date(Date.now() + waitSeconds * 1000).toISOString();
            await supabaseClient
              .from("flow_executions")
              .update({
                scheduled_at: nextRun,
                status: "running",
                current_block_id: nextBlockId,
              })
              .eq("id", execution.id);
            shouldPause = true;
          } else if (waitType === "reply") {
            await supabaseClient
              .from("leads")
              .update({ flow_waiting_reply: true })
              .eq("id", lead_id);
            await supabaseClient
              .from("flow_executions")
              .update({
                current_block_id: nextBlockId,
              })
              .eq("id", execution.id);
            shouldPause = true;
          }
          break;
        }

        case "condition": {
          const { data: lead } = await supabaseClient
            .from("leads")
            .select("*")
            .eq("id", lead_id)
            .single();
          let conditionMet = false;
          let isWaiting = false;

          console.log(
            `[Flow] Avaliando condição para lead ${lead_id}. Modo: ${config.conditionMode || config.condition_type}. Resposta: "${reply_content || ""}"`,
          );

          if (config.conditionMode === "any_response") {
            const hasAnyResponse = String(reply_content || "").trim().length > 0;
            if (hasAnyResponse) {
              console.log(`[Flow] Condição "Qualquer Resposta" validada com sucesso. Saída: SIM`);
              conditionMet = true;
            } else {
              isWaiting = true;
            }
          } else if (config.condition_type === "reply_contains" || !config.condition_type) {
            const lastReply = String(reply_content || "").toLowerCase();
            const pos =
              config.positiveKeywords || config.value || "sim,claro,pode,quero,adorei,vamos,ok";
            const neg = config.negativeKeywords || "não,agora não,depois,sem interesse,não quero";

            const matches = (keywords: string) =>
              keywords.split(",").some((k) => lastReply.includes(k.trim().toLowerCase()));

            if (matches(pos)) {
              console.log(`[Flow] Condição "Keywords" validada como POSITIVA. Saída: SIM`);
              conditionMet = true;
            } else if (matches(neg)) {
              console.log(`[Flow] Condição "Keywords" validada como NEGATIVA. Saída: NÃO`);
              conditionMet = false;
            } else if (lastReply && trigger_type === "reply_received") {
              console.log(
                `[Flow] Resposta não classificada: "${lastReply}". Seguindo pela saída SIM como fallback de qualquer resposta.`,
              );
              conditionMet = true;
            } else {
              if (lastReply) {
                console.log(
                  `[Flow] Resposta não classificada: "${lastReply}". Aguardando nova resposta ou mantendo estado.`,
                );
              }
              isWaiting = true;
            }
          } else if (config.condition_type === "tag_is") {
            conditionMet = lead?.tags?.includes(config.value);
          } else if (config.condition_type === "stage_is") {
            conditionMet = lead?.stage_id === config.value;
          }

          if (isWaiting) {
            console.log(`[Flow] Fluxo pausado aguardando resposta do lead ${lead_id}`);
            await supabaseClient
              .from("leads")
              .update({ flow_waiting_reply: true })
              .eq("id", lead_id);
            shouldPause = true;
            break;
          } else {
            await supabaseClient
              .from("leads")
              .update({ flow_waiting_reply: false })
              .eq("id", lead_id);
          }

          // Normalize handle mapping for SIM/NÃO
          const handle = conditionMet ? "true" : "false";
          const rotaCondicao = findAllNextBlockIds(block, blocks, edges, handle);
          nextBlockId =
            rotaCondicao[0] || (conditionMet ? config.next_if_true : config.next_if_false);
          ramosIrmaos = rotaCondicao.slice(1);
          if (nextBlockId && !blocks.some((b: any) => b.id === nextBlockId)) {
            console.log(
              `[execute-flow] Saída da condição aponta para bloco removido ${nextBlockId} — usando fallback por ordem.`,
            );
            nextBlockId = findFallbackBlockId(block, blocks);
          }

          // Fallback check for handle names in config
          if (!nextBlockId) {
            nextBlockId = conditionMet
              ? config.sim || config.yes || config.positive
              : config.nao || config.no || config.negative;
          }
          break;
        }

        case "ai_agent": {
          const apiKey = Deno.env.get("OPENROUTER_API_KEY");
          if (!apiKey) {
            console.error("[ai_agent] OPENROUTER_API_KEY ausente — pausando sem abrir conversa");
            await supabaseClient.from("logs").insert({
              user_id,
              lead_id,
              flow_id,
              event: "ai_agent_error",
              details: { block_id: block.id, error: "OPENROUTER_API_KEY ausente" },
            });
            await supabaseClient
              .from("flow_executions")
              .update({
                status: "waiting_response",
                context: {
                  ...(execution.context || {}),
                  agent: {
                    block_id: block.id,
                    turns: 0,
                    status: "active",
                    started_at: new Date().toISOString(),
                  },
                },
              })
              .eq("id", execution.id);
            await supabaseClient
              .from("leads")
              .update({ flow_waiting_reply: true })
              .eq("id", lead_id);
            shouldPause = true;
            break;
          }

          const { data: lead } = await supabaseClient
            .from("leads")
            .select("*")
            .eq("id", lead_id)
            .single();
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
          // Os mesmos dois portões do bloco de mensagem. Sem eles, o agente
          // gastava uma chamada de LLM para abrir conversa com quem não pode
          // receber — e o assert solto deixava a execução presa em `running` com
          // `scheduled_at` nulo, fora do alcance do cron e do gatilho.
          const alvoAgente = canReceiveWhatsApp(lead);
          if (!alvoAgente.ok) {
            await supabaseClient
              .from("leads")
              .update({
                has_whatsapp: false,
                ...(alvoAgente.reason === "unusable_phone" ? { phone_valid: false } : {}),
              })
              .eq("id", lead_id);
            await encerrarPorBloqueio(
              supabaseClient,
              "lead_phone_not_whatsapp",
              { execution, user_id, lead_id, flow_id, block_id: block.id },
              { reason: alvoAgente.reason, phone: lead?.phone ?? null, stage: "ai_agent" },
            );
            return new Response(
              JSON.stringify({
                success: true,
                paused: "phone_not_whatsapp",
                reason: alvoAgente.reason,
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          try {
            assertLeadCanReceiveMarketing(lead);
          } catch (consentError) {
            await encerrarPorBloqueio(
              supabaseClient,
              "marketing_automation_blocked",
              { execution, user_id, lead_id, flow_id, block_id: block.id },
              {
                reason: consentError instanceof Error ? consentError.message : String(consentError),
                consent_status: lead?.marketing_consent_status ?? null,
                is_suppressed: lead?.is_suppressed ?? false,
                stage: "ai_agent",
              },
            );
            return new Response(
              JSON.stringify({
                success: true,
                paused: "marketing_consent",
                execution_blocked: Boolean(execution?.id),
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          let history: any[] = [];
          if (config.useHistory !== false) {
            const { data: h } = await supabaseClient
              .from("messages")
              .select("direction, content, created_at")
              .eq("lead_id", lead_id)
              .order("created_at", { ascending: false })
              .limit(30);
            history = (h || []).reverse();
          }

          const model =
            config.model ||
            (await getGlobalSetting(supabaseClient, "ai_model_agent_default")) ||
            "google/gemini-2.5-flash";
          const record = makeApiCallRecorder(supabaseClient);
          const aiContext = {
            user_id,
            lead_id,
            flow_id,
            execution_id: execution.id,
            block_id: block.id,
          };
          const messages = buildAgentMessages(config, lead || {}, history, { opening: true });

          // Resposta fora do JSON esperado → 1 retry; persistindo, fail-safe silencioso (spec §4.6).
          let parsed = null;
          for (let i = 0; i < 2 && !parsed; i++) {
            const result = await callLLM({
              apiKey,
              model,
              messages,
              feature: "agent_opening",
              jsonResponse: true,
              temperature: config.temperature ?? AGENT_DEFAULTS.temperature,
              maxTokens: 1024,
              context: aiContext,
              record,
            });
            if (!result.ok) break;
            parsed = parseAgentResponse(result.content);
          }

          let aberturaId: string | null = null;
          if (parsed?.reply) {
            // Mesma regra do bloco de mensagem: teste e disparo manual saem na hora.
            // Antes a abertura ia sempre para o próximo slot sorteado, e o Testar
            // fluxo pedia ao `process-queue` um item agendado no futuro — recebia
            // `queue_item_not_found` e acusava falha no envio.
            let scheduledAt = new Date().toISOString();
            if (!envioImediato) {
              const { data: slotRpc, error: slotError } = await supabaseClient.rpc(
                "next_send_slot",
                { p_user_id: user_id, p_min_at: scheduledAt },
              );
              if (slotError) {
                console.error("[ai_agent] next_send_slot falhou, usando fallback:", slotError);
              }
              scheduledAt = slotRpc || getNextValidQueueTime(userSettings);
            }
            const { data: aberturaNaFila, error: aberturaErro } = await supabaseClient
              .from("send_queue")
              .insert({
                user_id,
                lead_id,
                flow_id,
                block_id: block.id,
                scheduled_at: scheduledAt,
                status: "pending",
                content: parsed.reply,
              })
              .select("id")
              .maybeSingle();
            // O histórico (`messages`) é gravado na entrega, como no bloco de
            // mensagem. Aqui só se registra quando a abertura nem entrou na fila.
            aberturaId = aberturaNaFila?.id ?? null;
            if (!aberturaId) {
              await supabaseClient.from("logs").insert({
                user_id,
                lead_id,
                flow_id,
                block_id: block.id,
                event: "ai_agent_message_not_queued",
                details: { stage: "opening", error: aberturaErro?.message ?? "insert descartado" },
              });
            }
          } else {
            console.error(
              "[ai_agent] abertura sem resposta válida — pausando em silêncio (fail-safe)",
            );
          }

          await supabaseClient
            .from("flow_executions")
            .update({
              status: "waiting_response",
              context: {
                ...(execution.context || {}),
                agent: {
                  block_id: block.id,
                  turns: parsed?.reply ? 1 : 0,
                  status: "active",
                  started_at: new Date().toISOString(),
                },
              },
            })
            .eq("id", execution.id);
          await supabaseClient.from("leads").update({ flow_waiting_reply: true }).eq("id", lead_id);
          // Só depois de gravar a conversa ativa: a resposta do lead não pode chegar
          // antes de existir agente esperando por ela. `force` só vale para chamador
          // service_role, que é o caso aqui.
          if (aberturaId && envioImediato) {
            await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-queue`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
              body: JSON.stringify({ queueItemId: aberturaId, force: true }),
            }).catch((e) => console.error("[ai_agent] erro ao despachar a abertura:", e));
          }
          await supabaseClient.from("logs").insert({
            user_id,
            lead_id,
            flow_id,
            event: parsed?.reply ? "ai_agent_opened" : "ai_agent_error",
            details: { block_id: block.id, execution_id: execution.id, opened: !!parsed?.reply },
          });
          shouldPause = true;
          break;
        }

        case "classifier": {
          // IA Classifier logic (Keyword based as fallback/default)
          const lastReply = reply_content || "";
          let result = "later"; // default

          const pos = config.keywords_positive || "sim,tenho interesse,quero,pode ser";
          const neg = config.keywords_negative || "não,agora não,depois,parar";
          const prop = config.keywords_proposal || "proposta,valor,quanto custa,preço";
          const later = config.keywords_later || "amanhã,depois,semana que vem";

          const matches = (keywords: string) =>
            keywords
              .split(",")
              .some((k) => lastReply.toLowerCase().includes(k.trim().toLowerCase()));

          if (matches(pos)) result = "positive";
          else if (matches(neg)) result = "negative";
          else if (matches(prop)) result = "proposal";
          else if (matches(later)) result = "later";

          const stageKey = `on_${result}_stage_id`;
          const targetStageId = config[stageKey];

          if (targetStageId) {
            await moveLeadToOwnedStage(supabaseClient, user_id, lead_id, targetStageId);
            await supabaseClient.from("logs").insert({
              user_id,
              lead_id,
              flow_id,
              event: "stage_changed",
              details: { stage_id: targetStageId, reason: "classifier", result },
            });
          }
          break;
        }

        case "move_pipeline": {
          if (config.target_stage_id) {
            await moveLeadToOwnedStage(supabaseClient, user_id, lead_id, config.target_stage_id);
            await supabaseClient.from("logs").insert({
              user_id,
              lead_id,
              flow_id,
              event: "stage_changed",
              details: { stage_id: config.target_stage_id, reason: "flow_block" },
            });
          } else {
            // Bloco sem etapa escolhida não move ninguém. Ficava invisível: o
            // fluxo parecia mover o lead e não movia.
            await supabaseClient.from("logs").insert({
              user_id,
              lead_id,
              flow_id,
              block_id: block.id,
              event: "flow_block_sem_configuracao",
              details: { type: block.type, falta: "target_stage_id" },
            });
          }
          break;
        }

        case "objection": {
          await supabaseClient.from("objections").insert({
            user_id,
            lead_id,
            content: config.objection_text || "Objeção identificada pelo fluxo",
          });
          await supabaseClient.from("logs").insert({
            user_id,
            lead_id,
            flow_id,
            event: "objection_created",
            details: { content: config.objection_text },
          });
          break;
        }

        case "end": {
          await supabaseClient
            .from("flow_executions")
            .update({ status: "completed" })
            .eq("id", execution.id);
          await supabaseClient
            .from("leads")
            .update({
              active_flow_id: null,
              active_flow_step: 0,
              flow_waiting_reply: false,
            })
            .eq("id", lead_id);

          await supabaseClient.from("logs").insert({
            user_id,
            lead_id,
            flow_id,
            event: "flow_completed",
          });
          shouldPause = true;
          break;
        }
      }

      // Irmãos da saída DESTE bloco só entram na fila se ele não pausou. Quem
      // pausa não decidiu a saída ainda: o bloco de agente pausa para esperar a
      // conversa, e quem resolve as saídas dele depois é o `ai-agent-reply`. Sem
      // isso, a abertura do agente já disparava tudo que estava pendurado no
      // Objetivo — objeção e mover etapa aconteciam antes do lead responder.
      if (!shouldPause) {
        for (const ramo of ramosIrmaos) {
          if (!jaExecutados.has(ramo) && !ramosPendentes.includes(ramo)) ramosPendentes.push(ramo);
        }
      }

      // Ramo terminou (pausou ou não tem próximo): segue para o irmão na fila,
      // vindo de fan-out mais acima ou de quem chamou (parallel_block_ids).
      const proximoDoRamo = shouldPause ? null : nextBlockId;
      if (shouldPause) ponteiroCongelado = true;
      currentBlockId = proximoDoRamo || ramosPendentes.shift() || null;
      if (currentBlockId && !ponteiroCongelado) {
        await supabaseClient
          .from("flow_executions")
          .update({ current_block_id: currentBlockId })
          .eq("id", execution.id);
      }
    }

    return new Response(JSON.stringify({ success: true, steps_executed: steps }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error: any) {
    console.error(`CRITICAL Error executing flow: ${error?.message || String(error)}`);
    return new Response(
      JSON.stringify({
        success: false,
        step: "catch_execute_flow",
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: getHttpErrorStatus(error, 500),
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
