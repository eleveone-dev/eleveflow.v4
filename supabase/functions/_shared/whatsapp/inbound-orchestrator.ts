// Orquestração CRM de uma mensagem recebida, compartilhada pelos webhooks.
// Movido de whatsapp-webhook/index.ts sem mudança de regra: dedupe, achar lead,
// opt-out, consentimento, classificação de etapa por IA e delegação a
// agente/sequence/flow.

import { resolveExistingNextBlockId } from "../flow-routing.ts";
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../ai.ts";
import { assertLeadCanReceiveMarketing } from "../marketing-consent.ts";
import { HttpError } from "../http-error.ts";
import { isMarketingOptOutMessage } from "./crm-parse.ts";
import { resolveLead } from "./lead-resolver.ts";
import { isAlreadyRegistered } from "./message-dedupe.ts";

export interface OrchestratorDeps {
  client: { from: (table: string) => any };
  fetchFn: typeof fetch;
  baseUrl: string;
  internalHeaders: () => Record<string, string>;
  openrouterKey: string | null;
  /** Espelha o passo corrente no chamador. O webhook reporta esse valor no
   *  corpo do erro e no log webhook_error; sem isso o campo perderia precisão. */
  onStep?: (step: string) => void;
}

export interface OrchestratorInput {
  tenantId: string;
  providerMessageId: string | null;
  fromPhone: string;
  text: string;
  /** Valor de messages.media_type; null ou ausente = texto. */
  mediaType?: string | null;
}

export interface OrchestratorResult {
  status: number;
  body: Record<string, unknown>;
}

export async function safeLog(client: any, payload: any) {
  try {
    await client.from("logs").insert(payload);
  } catch (e) {
    console.error("[Webhook] Erro ao gravar log:", e);
  }
}

async function recordMarketingOptOut(
  client: any,
  userId: string,
  leads: Array<{ id: string }>,
  whatsappId: string | null | undefined,
): Promise<void> {
  const leadIds = leads.map((lead) => lead.id).filter(Boolean);
  if (leadIds.length === 0) return;

  const now = new Date().toISOString();
  const reason = "Opt-out recebido por WhatsApp";
  const [leadUpdate, queueUpdate] = await Promise.all([
    client
      .from("leads")
      .update({
        marketing_consent_status: "withdrawn",
        marketing_opted_out_at: now,
        marketing_opt_out_reason: reason,
        is_suppressed: true,
        suppressed_at: now,
        suppression_reason: reason,
        flow_waiting_reply: false,
      })
      .in("id", leadIds)
      .eq("user_id", userId),
    // A send already claimed by another worker must be cancelled too. The
    // worker rereads status immediately before dispatching to close this race.
    client
      .from("send_queue")
      .update({ status: "failed", sending_at: null, claim_token: null })
      .in("lead_id", leadIds)
      .eq("user_id", userId)
      .in("status", ["pending", "sending"]),
  ]);
  if (leadUpdate.error) throw leadUpdate.error;
  if (queueUpdate.error) throw queueUpdate.error;

  await Promise.all(
    leadIds.map((leadId) =>
      safeLog(client, {
        user_id: userId,
        lead_id: leadId,
        event: "marketing_opt_out_received",
        details: { channel: "whatsapp", whatsapp_id: whatsappId },
      }),
    ),
  );
}

export async function handleInboundMessage(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
): Promise<OrchestratorResult> {
  const setStep = (step: string) => deps.onStep?.(step);

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

  // Save inbound message
  setStep("save_inbound");
  const { error: inboundInsertError } = await deps.client.from("messages").insert({
    user_id: input.tenantId,
    lead_id: lead.id,
    content: input.text,
    direction: "inbound",
    media_type: input.mediaType ?? null,
    whatsapp_id: input.providerMessageId,
    status: "received",
  });
  // Sem esta checagem, uma violação de unicidade sumia com a mensagem enquanto
  // classificação de etapa e disparo de fluxo seguiam como se ela existisse.
  if (inboundInsertError) throw inboundInsertError;
  await safeLog(deps.client, {
    user_id: input.tenantId,
    lead_id: lead.id,
    event: "message_received",
    details: { content: input.text, phone: normalized, whatsapp_id: input.providerMessageId },
  });

  // Mídia sem legenda não tem o que IA, fluxo ou opt-out leiam. Fica gravada para
  // o histórico e as APIs, e a automação segue sem reagir, como antes.
  if (!input.text.trim()) {
    return {
      status: 200,
      body: { success: true, recorded_only: true, reason: "media_without_text" },
    };
  }

  if (isMarketingOptOutMessage(input.text)) {
    setStep("record_opt_out");
    await recordMarketingOptOut(deps.client, input.tenantId, [lead], input.providerMessageId);
    return { status: 200, body: { success: true, opted_out: true } };
  }

  // ===== IA move o lead no pipeline analisando a conversa =====
  try {
    assertLeadCanReceiveMarketing(lead);
  } catch (error: any) {
    await safeLog(deps.client, {
      user_id: input.tenantId,
      lead_id: lead.id,
      event: "marketing_automation_blocked",
      details: { reason: error?.message || "lead_suppressed_or_opted_out" },
    });
    return {
      status: 200,
      body: {
        success: true,
        ignored: true,
        reason: "lead_suppressed_or_opted_out",
      },
    };
  }

  setStep("ai_classify_stage");
  try {
    const { data: stages } = await deps.client
      .from("pipeline_stages")
      .select("id, name, position")
      .eq("user_id", input.tenantId)
      .order("position", { ascending: true });

    if (stages && stages.length > 0) {
      const { data: history } = await deps.client
        .from("messages")
        .select("direction, content, created_at")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(20);

      const convo = (history || [])
        .reverse()
        .map((m: any) => `${m.direction === "inbound" ? "CLIENTE" : "EMPRESA"}: ${m.content || ""}`)
        .join("\n");

      const currentStage = stages.find((s: any) => s.id === lead.stage_id);
      const stagesList = stages.map((s: any, i: number) => `${i + 1}. ${s.name}`).join("\n");

      const openrouterKey = deps.openrouterKey;
      let chosenStageName: string | null = null;
      let aiReason: string | null = null;

      if (openrouterKey) {
        const prompt = `Você é um classificador de pipeline de vendas. Analise a conversa entre EMPRESA e CLIENTE e identifique em qual etapa do pipeline este lead se encontra AGORA.

ETAPAS DISPONÍVEIS (escolha exatamente UMA pelo nome):
${stagesList}

Etapa atual do lead: ${currentStage?.name || "nenhuma"}

CONVERSA:
${convo}

Responda APENAS com JSON: {"stage":"<nome exato da etapa>","reason":"<motivo curto>"}`;

        const model =
          (await getGlobalSetting(deps.client, "ai_model_economy")) ||
          "google/gemini-2.5-flash-lite";
        const result = await callLLM({
          apiKey: openrouterKey,
          model,
          feature: "stage_classifier",
          jsonResponse: true,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }],
          context: { user_id: input.tenantId, lead_id: lead.id },
          record: makeApiCallRecorder(deps.client),
        });
        if (result.ok) {
          try {
            const parsed = JSON.parse(result.content);
            chosenStageName = parsed?.stage || null;
            aiReason = parsed?.reason || null;
            console.log("[IA Pipeline] sugerida:", parsed);
          } catch (e) {
            console.error("[IA Pipeline] erro parse:", e, result.content);
          }
        }
      } else {
        console.log("[IA Pipeline] OPENROUTER_API_KEY ausente — pulando classificação");
      }

      const norm = (s: string) =>
        String(s || "")
          .trim()
          .toLowerCase();
      const target = chosenStageName
        ? stages.find((s: any) => norm(s.name) === norm(chosenStageName!))
        : null;

      if (target && target.id !== lead.stage_id) {
        await deps.client.from("leads").update({ stage_id: target.id }).eq("id", lead.id);
        console.log(
          `[IA Pipeline] Lead movido: ${currentStage?.name || "sem etapa"} → ${target.name}`,
        );
        await safeLog(deps.client, {
          user_id: input.tenantId,
          lead_id: lead.id,
          event: "lead_stage_advanced_ai",
          details: {
            from: currentStage?.name || null,
            to: target.name,
            reason: aiReason || "ai_classification",
          },
        });
      } else if (!target) {
        const respondedStage =
          stages.find((s: any) => norm(s.name).includes("respond")) ||
          stages.find((s: any) => s.position === 1);
        const currentPos = currentStage?.position ?? -1;
        if (respondedStage && currentPos < respondedStage.position) {
          await deps.client.from("leads").update({ stage_id: respondedStage.id }).eq("id", lead.id);
          await safeLog(deps.client, {
            user_id: input.tenantId,
            lead_id: lead.id,
            event: "lead_stage_advanced",
            details: {
              from: currentStage?.name || null,
              to: respondedStage.name,
              reason: "fallback_inbound_reply",
            },
          });
        }
      }
    }
  } catch (e) {
    console.error("Erro IA ao mover lead no pipeline:", e);
  }

  setStep("find_execution");
  const { data: executions, error: execErr } = await deps.client
    .from("flow_executions")
    .select("*")
    .eq("lead_id", lead.id)
    .eq("user_id", input.tenantId)
    .in("status", ["waiting_response", "running", "active"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (execErr) console.error("Erro ao buscar execução:", execErr);

  const execution = executions && executions[0];
  if (!execution) {
    const reason = "Nenhuma execução aguardando resposta para este lead";
    console.log(reason);
    await safeLog(deps.client, {
      user_id: input.tenantId,
      lead_id: lead.id,
      event: "webhook_no_execution",
      details: { reason },
    });
    return { status: 200, body: { success: true, ignored: true, reason } };
  }

  console.log("Execução ativa encontrada:", execution.id);
  console.log("Status da execução:", execution.status);
  console.log("current_node_id:", execution.current_block_id);

  // ===== Modo "Sequência Simples": delega ao execute-sequence =====
  const execCtx: any = (execution as any).context || {};
  // ===== Modo agente de IA: delega o turno a ai-agent-reply =====
  if (execCtx?.agent?.status === "active") {
    console.log("[Webhook] execução em modo agente — delegando a ai-agent-reply");
    const baseUrl = deps.baseUrl;
    const res = await deps.fetchFn(`${baseUrl}/functions/v1/ai-agent-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deps.internalHeaders() },
      body: JSON.stringify({
        execution_id: execution.id,
        lead_id: lead.id,
        reply_content: input.text,
      }),
    });
    const result = await res.json().catch(() => ({}));
    await safeLog(deps.client, {
      user_id: input.tenantId,
      lead_id: lead.id,
      flow_id: execution.flow_id,
      event: "webhook_ai_agent_turn",
      details: { execution_id: execution.id, result },
    });
    return { status: 200, body: { success: true, mode: "ai_agent", result } };
  }
  if (execCtx?.mode === "sequence") {
    console.log("[Webhook] execução em modo sequence — delegando a execute-sequence");
    const baseUrl = deps.baseUrl;
    const res = await deps.fetchFn(`${baseUrl}/functions/v1/execute-sequence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deps.internalHeaders() },
      body: JSON.stringify({ action: "on_reply", execution_id: execution.id }),
    });
    const result = await res.json().catch(() => ({}));
    await safeLog(deps.client, {
      user_id: input.tenantId,
      lead_id: lead.id,
      flow_id: execution.flow_id,
      event: "webhook_sequence_on_reply",
      details: { execution_id: execution.id, result },
    });
    return { status: 200, body: { success: true, mode: "sequence", result } };
  }

  setStep("load_blocks");
  const [blocksRes, flowRes] = await Promise.all([
    deps.client.from("flow_blocks").select("*").eq("flow_id", execution.flow_id),
    deps.client
      .from("flows")
      .select("canvas_state, user_id")
      .eq("id", execution.flow_id)
      .eq("user_id", input.tenantId)
      .maybeSingle(),
  ]);
  if (!flowRes.data) {
    throw new HttpError(403, "Execution flow does not belong to the instance tenant");
  }
  const blocksArr = blocksRes.data || [];
  const canvasState: any = flowRes.data?.canvas_state || {};
  const edges: any[] = Array.isArray(canvasState.edges) ? canvasState.edges : [];
  console.log(`Edges carregadas do canvas_state: ${edges.length}`);

  const currentBlock = blocksArr.find((b: any) => b.id === execution.current_block_id);
  if (!currentBlock) {
    const reason = "Bloco atual não encontrado";
    console.log(reason, execution.current_block_id);
    await safeLog(deps.client, {
      user_id: input.tenantId,
      lead_id: lead.id,
      event: "webhook_block_not_found",
      details: { current_block_id: execution.current_block_id },
    });
    return { status: 200, body: { success: true, ignored: true, reason } };
  }

  console.log("Node atual:", currentBlock.id, "tipo:", currentBlock.type);

  setStep("evaluate_next");
  const config: any = currentBlock.config || {};
  let nextBlockId: string | null = null;
  let outputChosen = "default";
  let conditionOutput: "true" | "false" | undefined;

  if (currentBlock.type === "condition") {
    const reply = input.text || "";
    let conditionMet = false;

    if (config.conditionMode === "any_response" || config.condition_type === "any_response") {
      conditionMet = reply.trim().length > 0;
      outputChosen = conditionMet ? "SIM (qualquer resposta)" : "AGUARDA";
      console.log("Condição: qualquer resposta. Saída:", outputChosen);
    } else if (config.condition_type === "reply_contains" || !config.condition_type) {
      const lastReply = reply.toLowerCase();
      const pos = config.positiveKeywords || "sim,claro,pode,quero,adorei,vamos,ok";
      const neg = config.negativeKeywords || "não,agora não,depois,sem interesse,não quero";
      const matches = (kw: string) =>
        kw.split(",").some((k: string) => lastReply.includes(k.trim().toLowerCase()));
      if (matches(pos)) {
        conditionMet = true;
        outputChosen = "SIM (keywords)";
      } else if (matches(neg)) {
        conditionMet = false;
        outputChosen = "NAO (keywords)";
      } else {
        conditionMet = true;
        outputChosen = "SIM (fallback qualquer resposta)";
      }
      console.log("Condição keywords. Saída:", outputChosen);
    } else {
      conditionMet = true;
      outputChosen = "SIM (default)";
    }

    conditionOutput = conditionMet ? "true" : "false";
    const resolved = resolveExistingNextBlockId(currentBlock, blocksArr, edges, conditionOutput);
    nextBlockId = resolved.nextId;
    console.log(`Próximo node via=${resolved.via} edge=${resolved.edgeId}`);
  } else {
    const resolved = resolveExistingNextBlockId(currentBlock, blocksArr, edges);
    nextBlockId = resolved.nextId;
    outputChosen = `edges(${resolved.via})`;
    console.log(`Próximo node via=${resolved.via} edge=${resolved.edgeId}`);
  }

  console.log("Saída escolhida:", outputChosen);
  console.log("Próximo node:", nextBlockId);

  if (!nextBlockId) {
    const reason = "Nenhum próximo node configurado";
    console.log(reason);
    await safeLog(deps.client, {
      user_id: input.tenantId,
      lead_id: lead.id,
      flow_id: execution.flow_id,
      event: "webhook_no_next_block",
      details: { current_block_id: currentBlock.id, output: outputChosen },
    });
    return { status: 200, body: { success: true, ignored: true, reason } };
  }

  const nextBlock = blocksArr.find((b: any) => b.id === nextBlockId);
  if (!nextBlock) {
    const reason = "Próximo bloco não existe na tabela";
    console.log(reason, nextBlockId);
    await safeLog(deps.client, {
      user_id: input.tenantId,
      lead_id: lead.id,
      flow_id: execution.flow_id,
      event: "webhook_next_block_missing",
      details: { nextBlockId },
    });
    return { status: 200, body: { success: true, ignored: true, reason } };
  }

  console.log("Próximo bloco tipo:", nextBlock.type);

  // Avança o ponteiro da execução
  await deps.client
    .from("flow_executions")
    .update({
      current_block_id: nextBlock.id,
      status: "running",
    })
    .eq("id", execution.id);

  if (nextBlock.type !== "message") {
    const reason = `Próximo bloco não é mensagem (${nextBlock.type}) — delegando ao execute-flow`;
    console.log(reason);
    const baseUrl = deps.baseUrl;
    const res = await deps.fetchFn(`${baseUrl}/functions/v1/execute-flow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deps.internalHeaders() },
      body: JSON.stringify({
        flow_id: execution.flow_id,
        lead_id: lead.id,
        execution_id: execution.id,
        phone: normalized,
        user_id: input.tenantId,
        trigger_type: "reply_received",
        reply_content: input.text,
        block_id: nextBlock.id,
      }),
    });
    const result = await res.json().catch(() => ({}));
    console.log("Resultado execute-flow:", JSON.stringify(result));
    return { status: 200, body: { success: true, delegated: true, result } };
  }

  // Loop de continuação: envia mensagens consecutivas sem aguardar resposta
  const baseUrl = deps.baseUrl;
  const sentMessages: any[] = [];
  let cursor: any = nextBlock;
  let label = 2; // M2 em diante
  const maxSteps = 10;
  let it = 0;

  while (cursor && it < maxSteps) {
    it++;

    if (cursor.type === "message") {
      setStep(`build_M${label}`);
      const cfg: any = cursor.config || {};
      let content: string = cfg.message || cfg.text || "";
      content = content
        .replace(/{{nome}}/g, lead.name || "")
        .replace(/{{empresa}}/g, lead.company || "")
        .replace(/{{telefone}}/g, lead.phone || "");

      console.log(`Conteúdo M${label}:`, content);

      if (!content) {
        const reason = `Bloco de mensagem M${label} sem conteúdo`;
        console.log(reason);
        await safeLog(deps.client, {
          user_id: input.tenantId,
          lead_id: lead.id,
          flow_id: execution.flow_id,
          event: "webhook_message_empty",
          details: { block_id: cursor.id, label },
        });
        break;
      }

      setStep(`insert_M${label}`);
      const { data: qItem, error: qErr } = await deps.client
        .from("send_queue")
        .insert({
          user_id: input.tenantId,
          lead_id: lead.id,
          flow_id: execution.flow_id,
          block_id: cursor.id,
          scheduled_at: new Date().toISOString(),
          status: "pending",
          attempts: 0,
          content,
        })
        .select()
        .single();

      if (qErr || !qItem) {
        console.error(`Erro ao criar M${label} na fila:`, qErr);
        await safeLog(deps.client, {
          user_id: input.tenantId,
          lead_id: lead.id,
          flow_id: execution.flow_id,
          event: "webhook_message_insert_error",
          details: { error: qErr?.message, block_id: cursor.id, label },
        });
        break;
      }

      console.log(`M${label} criada na send_queue (queueItemId=${qItem.id})`);
      await safeLog(deps.client, {
        user_id: input.tenantId,
        lead_id: lead.id,
        flow_id: execution.flow_id,
        event: "webhook_message_queued",
        details: { queueItemId: qItem.id, content, block_id: cursor.id, label },
      });

      // Avança ponteiro da execução para este bloco
      await deps.client
        .from("flow_executions")
        .update({
          current_block_id: cursor.id,
          status: "running",
        })
        .eq("id", execution.id);

      setStep(`call_process_queue_M${label}`);
      console.log(`process-queue chamada para M${label}: ${qItem.id}`);
      const pqRes = await deps.fetchFn(`${baseUrl}/functions/v1/process-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deps.internalHeaders() },
        body: JSON.stringify({ queueItemId: qItem.id }),
      });
      const pqData = await pqRes.json().catch(() => ({}));
      const itemResult = Array.isArray(pqData?.results) ? pqData.results[0] : null;
      const sentOk = itemResult?.status === "sent";
      console.log(`Resultado process-queue M${label}:`, JSON.stringify(pqData));
      if (sentOk) {
        console.log(`M${label} enviada com sucesso`);
      } else {
        console.log(`M${label} NÃO enviada com sucesso — abortando loop`);
      }

      await safeLog(deps.client, {
        user_id: input.tenantId,
        lead_id: lead.id,
        flow_id: execution.flow_id,
        event: "webhook_message_sent",
        details: {
          queueItemId: qItem.id,
          label,
          block_id: cursor.id,
          result: pqData,
          status: pqRes.status,
        },
      });

      sentMessages.push({
        label,
        block_id: cursor.id,
        queueItemId: qItem.id,
        status: itemResult?.status || "unknown",
      });

      if (!sentOk) break;

      // Se mensagem espera resposta, parar
      if (cfg.wait_for_reply === true) {
        console.log(
          `Node ${cursor.id} configurado com wait_for_reply — pausando aguardando resposta`,
        );
        await safeLog(deps.client, {
          user_id: input.tenantId,
          lead_id: lead.id,
          flow_id: execution.flow_id,
          event: "webhook_action_taken",
          details: { action: "wait_response", block_id: cursor.id },
        });
        break;
      }

      // Buscar próximo node nas edges reais
      console.log(`Buscando próximo node nas edges a partir de ${cursor.id}`);
      await safeLog(deps.client, {
        user_id: input.tenantId,
        lead_id: lead.id,
        flow_id: execution.flow_id,
        event: "webhook_next_node_lookup",
        details: { from_block_id: cursor.id },
      });
      const resolvedNext = resolveExistingNextBlockId(cursor, blocksArr, edges);
      const nextId = resolvedNext.nextId;
      if (!nextId) {
        console.log(
          `Sem próximo node conectado a partir de ${cursor.id} (via=${resolvedNext.via}) — fim do encadeamento`,
        );
        break;
      }
      const next = blocksArr.find((b: any) => b.id === nextId);
      if (!next) {
        console.log(`Próximo node ${nextId} não existe na tabela — encerrando loop`);
        break;
      }
      console.log(
        `Próximo node encontrado: tipo=${next.type} (block_id=${next.id}) via=${resolvedNext.via} edge=${resolvedNext.edgeId}`,
      );
      await safeLog(deps.client, {
        user_id: input.tenantId,
        lead_id: lead.id,
        flow_id: execution.flow_id,
        event: "webhook_next_node_found",
        details: {
          from_block_id: cursor.id,
          next_block_id: next.id,
          next_type: next.type,
          via: resolvedNext.via,
          edge_id: resolvedNext.edgeId,
        },
      });
      label++;
      cursor = next;
      continue;
    }

    if (cursor.type === "wait") {
      console.log(`Próximo bloco é 'wait' — delegando a execute-flow para agendar`);
      await deps.client
        .from("flow_executions")
        .update({
          current_block_id: cursor.id,
          status: "running",
        })
        .eq("id", execution.id);
      await deps
        .fetchFn(`${baseUrl}/functions/v1/execute-flow`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...deps.internalHeaders() },
          body: JSON.stringify({
            flow_id: execution.flow_id,
            lead_id: lead.id,
            execution_id: execution.id,
            phone: normalized,
            user_id: input.tenantId,
            trigger_type: "reply_received",
            reply_content: input.text,
            block_id: cursor.id,
          }),
        })
        .catch((e) => console.error("Erro delegando wait:", e));
      break;
    }

    if (cursor.type === "condition") {
      console.log(`Próximo bloco é 'condition' — pausando aguardando próxima resposta`);
      await deps.client
        .from("flow_executions")
        .update({
          current_block_id: cursor.id,
          status: "waiting_response",
        })
        .eq("id", execution.id);
      await deps.client.from("leads").update({ flow_waiting_reply: true }).eq("id", lead.id);
      break;
    }

    if (cursor.type === "end") {
      console.log(`Próximo bloco é 'end' — finalizando execução`);
      await deps.client
        .from("flow_executions")
        .update({
          current_block_id: cursor.id,
          status: "completed",
        })
        .eq("id", execution.id);
      await deps.client
        .from("leads")
        .update({
          active_flow_id: null,
          active_flow_step: 0,
          flow_waiting_reply: false,
        })
        .eq("id", lead.id);
      break;
    }

    // qualquer outro tipo: delega ao execute-flow
    console.log(`Próximo bloco tipo '${cursor.type}' — delegando a execute-flow`);
    await deps
      .fetchFn(`${baseUrl}/functions/v1/execute-flow`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deps.internalHeaders() },
        body: JSON.stringify({
          flow_id: execution.flow_id,
          lead_id: lead.id,
          execution_id: execution.id,
          phone: normalized,
          user_id: input.tenantId,
          trigger_type: "reply_received",
          reply_content: input.text,
          block_id: cursor.id,
        }),
      })
      .catch((e) => console.error("Erro delegando:", e));
    break;
  }

  return {
    status: 200,
    body: {
      success: true,
      lead_id: lead.id,
      execution_id: execution.id,
      sent_messages: sentMessages,
    },
  };
}
