import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import { callLLM, makeApiCallRecorder, getGlobalSetting } from "../_shared/ai.ts";
import { buildAgentMessages, parseAgentResponse, AGENT_DEFAULTS } from "../_shared/agent-prompt.ts";
import { findAllNextBlockIds, findSpeakingBlockAhead } from "../_shared/flow-routing.ts";
import {
  HttpError,
  assertLeadCanReceiveMarketing,
  getHttpErrorStatus,
  getRequestActor,
  internalAuthHeaders,
  requireServiceRole,
} from "../_shared/auth.ts";
import { humanTakeoverUntil, shouldSkipAutomation } from "../_shared/whatsapp/human-takeover.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createServiceRoleClient();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let step = "init";
  let execution_id: string | null = null;
  let execution: any = null;
  let lockAcquired = false;
  let finished = false;
  try {
    requireServiceRole(await getRequestActor(req));

    step = "parse_body";
    const body: any = await req.json().catch(() => ({}));
    const { lead_id, reply_content } = body;
    execution_id = body.execution_id ?? null;
    if (!execution_id || !lead_id)
      return json({ success: false, error: "execution_id e lead_id obrigatórios" }, 400);

    step = "load_execution";
    const { data: executionRow } = await supabase
      .from("flow_executions")
      .select("*")
      .eq("id", execution_id)
      .maybeSingle();
    execution = executionRow;
    const agent = (execution?.context as any)?.agent;
    if (execution && execution.lead_id !== lead_id) {
      throw new HttpError(403, "Execution does not belong to the supplied lead");
    }
    if (!execution || !agent || agent.status !== "active") {
      return json({ success: true, ignored: true, reason: "execução sem modo agente ativo" });
    }

    // ===== Lock otimista do turno (spec §4.5): duas invocações simultâneas não geram duas respostas =====
    step = "lock";
    const lockedContext = {
      ...(execution.context as any),
      agent: { ...agent, processing_since: new Date().toISOString() },
    };
    const first = await supabase
      .from("flow_executions")
      .update({ context: lockedContext })
      .eq("id", execution_id)
      .is("context->agent->>processing_since", null)
      .select("id");
    if (!first.data || first.data.length === 0) {
      // takeover apenas se um turno anterior travou há mais de 2 minutos
      const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const retaken = await supabase
        .from("flow_executions")
        .update({ context: lockedContext })
        .eq("id", execution_id)
        .lt("context->agent->>processing_since", cutoff)
        .select("id");
      if (!retaken.data || retaken.data.length === 0) {
        return json({ success: true, ignored: true, reason: "turno já em processamento" });
      }
    }
    lockAcquired = true;

    const userId = execution.user_id;
    const flowId = execution.flow_id;
    const baseUrl = Deno.env.get("SUPABASE_URL");

    // Grava o contexto final SEM processing_since (libera o lock em toda saída).
    const finishAgent = async (
      agentPatch: Record<string, unknown>,
      executionPatch: Record<string, unknown> = {},
    ) => {
      const agentFinal: Record<string, unknown> = { ...agent, ...agentPatch };
      delete agentFinal.processing_since;
      await supabase
        .from("flow_executions")
        .update({
          context: { ...(execution.context as any), agent: agentFinal },
          ...executionPatch,
        })
        .eq("id", execution_id);
      finished = true;
    };

    step = "load_data";
    const [{ data: block }, { data: blocks }, { data: flowRow }, { data: lead }] =
      await Promise.all([
        supabase
          .from("flow_blocks")
          .select("*")
          .eq("id", agent.block_id)
          .eq("flow_id", flowId)
          .maybeSingle(),
        supabase.from("flow_blocks").select("*").eq("flow_id", flowId),
        supabase.from("flows").select("canvas_state, user_id").eq("id", flowId).maybeSingle(),
        supabase.from("leads").select("*").eq("id", lead_id).maybeSingle(),
      ]);

    if (!block) {
      await finishAgent(
        { status: "giveup", ended_at: new Date().toISOString() },
        { status: "completed" },
      );
      await supabase.from("leads").update({ flow_waiting_reply: false }).eq("id", lead_id);
      return json({ success: true, ignored: true, reason: "bloco do agente não existe mais" });
    }

    if (!lead || lead.user_id !== userId || !flowRow || flowRow.user_id !== userId) {
      throw new HttpError(403, "Execution resources do not belong to the same tenant");
    }
    if (shouldSkipAutomation(lead)) {
      // Silêncio deliberado, não erro: o dono está respondendo pelo celular.
      // Retorna 200 sem consumir turno nem token.
      console.log(`[Agent] lead ${lead_id} em atendimento humano — turno ignorado`);
      return json({
        success: true,
        paused: "human_takeover",
        until: humanTakeoverUntil(lead),
      });
    }
    assertLeadCanReceiveMarketing(lead);

    const config: any = block.config || {};
    const maxTurns = config.max_turns ?? AGENT_DEFAULTS.maxTurns;
    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) {
      await finishAgent({});
      return json({ success: false, error: "OPENROUTER_API_KEY ausente" }, 500);
    }

    step = "llm";
    let history: any[] = [];
    if (config.useHistory !== false) {
      const { data: h } = await supabase
        .from("messages")
        .select("direction, content, created_at")
        .eq("lead_id", lead_id)
        .order("created_at", { ascending: false })
        .limit(30);
      history = (h || []).reverse();
    }

    const model =
      config.model ||
      (await getGlobalSetting(supabase, "ai_model_agent_default")) ||
      "google/gemini-2.5-flash";
    const record = makeApiCallRecorder(supabase);
    const aiContext = {
      user_id: userId,
      lead_id,
      flow_id: flowId,
      execution_id,
      block_id: block.id,
    };
    const messages = buildAgentMessages(config, lead || {}, history, { opening: false });

    // JSON inválido → 1 retry; persistindo, fail-safe: silêncio, agente segue aguardando (spec §4.6).
    let parsed = null;
    for (let i = 0; i < 2 && !parsed; i++) {
      const result = await callLLM({
        apiKey,
        model,
        messages,
        feature: "agent_reply",
        jsonResponse: true,
        temperature: config.temperature ?? AGENT_DEFAULTS.temperature,
        maxTokens: 1024,
        context: aiContext,
        record,
      });
      if (!result.ok) break;
      parsed = parseAgentResponse(result.content);
    }

    if (!parsed) {
      await finishAgent({});
      await supabase.from("logs").insert({
        user_id: userId,
        lead_id,
        flow_id: flowId,
        event: "ai_agent_error",
        details: {
          execution_id,
          block_id: block.id,
          error: "resposta inválida do modelo (fail-safe silencioso)",
        },
      });
      return json({ success: true, sent: false, reason: "resposta inválida do modelo" });
    }

    // Limite duro de turnos: forçado pelo motor, nunca decidido pelo LLM (spec §4.2.3).
    let decision: "continue" | "goal" | "giveup" | "limit" = parsed.decision;
    if (decision === "continue" && agent.turns >= maxTurns) decision = "limit";

    // Decisão commitada ANTES de enfileirar: falha no meio perde uma reply
    // (fail-safe aceitável), nunca gera envio duplicado após takeover.
    step = "apply_decision";
    let nextBlockId: string | null = null;
    let ramosParalelos: string[] = [];
    let reply = parsed.reply;
    let replySuppressedBy: string | null = null;
    if (decision === "continue") {
      await finishAgent({ turns: agent.turns + 1 }, { status: "waiting_response" });
      await supabase.from("leads").update({ flow_waiting_reply: true }).eq("id", lead_id);
    } else {
      const canvasState: any = flowRow?.canvas_state || {};
      const edges: any[] = Array.isArray(canvasState.edges) ? canvasState.edges : [];
      // A saída pode estar ligada em mais de um bloco — mensagem e mover etapa, por
      // exemplo. Todos os ramos correm, e o execute-flow recebe os irmãos.
      const rotaSaida = findAllNextBlockIds(block, blocks || [], edges, decision);
      nextBlockId = rotaSaida[0] ?? null;
      ramosParalelos = rotaSaida.slice(1);
      // Algum caminho da saída já fala com o lead (mensagem ou outro agente)? Então
      // quem encerra a conversa é o fluxo, e a resposta do agente não sai. Antes
      // saíam as duas, uma atrás da outra: no teste de 2026-09-22 o agente
      // perguntou "WhatsApp ou e-mail?" e, seis segundos depois, o fluxo mandou
      // "vou criar a demonstração e te envio!".
      const blocoQueFala = rotaSaida
        .map((id) => findSpeakingBlockAhead(id, blocks || [], edges))
        .find((b) => b !== null);
      if (blocoQueFala && reply) {
        replySuppressedBy = blocoQueFala.id;
        reply = "";
      }
      await finishAgent(
        { status: decision, ended_at: new Date().toISOString() },
        nextBlockId
          ? { status: "running", current_block_id: nextBlockId }
          : { status: "completed" },
      );
      await supabase
        .from("leads")
        .update({
          flow_waiting_reply: false,
          ...(nextBlockId ? {} : { active_flow_id: null, active_flow_step: 0 }),
        })
        .eq("id", lead_id);
    }

    step = "queue_reply";
    if (replySuppressedBy) {
      await supabase.from("logs").insert({
        user_id: userId,
        lead_id,
        flow_id: flowId,
        block_id: block.id,
        event: "ai_agent_reply_suppressed",
        details: { decision, next_block_id: nextBlockId, speaking_block_id: replySuppressedBy },
      });
    }
    let queueItemId: string | null = null;
    if (reply) {
      // Na fila, sem block_id — de propósito. A abertura já ocupa (lead, bloco) no
      // índice único send_queue_unique_active_delivery_idx, que conta também item
      // enviado: com o block_id do agente, toda resposta depois da abertura batia
      // no índice e não saía. O bloco do agente continua em context.agent.block_id
      // da execução. A origem vai em `origin`: sem bloco, é ela que separa a
      // resposta da IA de automação no histórico.
      const { data: qItem, error: qErr } = await supabase
        .from("send_queue")
        .insert({
          user_id: userId,
          lead_id,
          flow_id: flowId,
          block_id: null,
          origin: "ia",
          scheduled_at: new Date().toISOString(),
          status: "pending",
          content: reply,
        })
        .select("id")
        .maybeSingle();
      queueItemId = qItem?.id ?? null;
      // O histórico (`messages`) é gravado na entrega, ligado ao item da fila.
      // Gravar aqui também duplicava toda resposta entregue na conversa — e no
      // histórico que o próprio agente relê no turno seguinte.
      if (!queueItemId) {
        await supabase.from("logs").insert({
          user_id: userId,
          lead_id,
          flow_id: flowId,
          block_id: block.id,
          event: "ai_agent_message_not_queued",
          details: { stage: "reply", error: qErr?.message ?? "insert descartado" },
        });
      }
    }

    // Envia a reply ANTES de continuar o fluxo (ordem das mensagens no WhatsApp).
    step = "send_reply";
    if (queueItemId) {
      await fetch(`${baseUrl}/functions/v1/process-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
        // Resposta a quem acabou de escrever sai na hora, como a M2. Sem `force`
        // ela obedecia ao intervalo mínimo da prospecção, ao horário comercial e
        // ao limite diário: o lead perguntava e o agente respondia minutos depois.
        body: JSON.stringify({ queueItemId, force: true }),
      }).catch((e) => console.error("[ai-agent-reply] erro process-queue:", e));
    }

    step = "continue_flow";
    if (nextBlockId) {
      await fetch(`${baseUrl}/functions/v1/execute-flow`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...internalAuthHeaders() },
        body: JSON.stringify({
          flow_id: flowId,
          lead_id,
          execution_id,
          user_id: userId,
          trigger_type: "reply_received",
          reply_content,
          block_id: nextBlockId,
          parallel_block_ids: ramosParalelos,
        }),
      }).catch((e) => console.error("[ai-agent-reply] erro execute-flow:", e));
    }

    await supabase.from("logs").insert({
      user_id: userId,
      lead_id,
      flow_id: flowId,
      event: "ai_agent_turn",
      details: {
        execution_id,
        decision,
        turns: decision === "continue" ? agent.turns + 1 : agent.turns,
        reason: parsed.reason,
        next_block_id: nextBlockId,
      },
    });

    return json({ success: true, decision, sent: !!queueItemId, next_block_id: nextBlockId });
  } catch (error: any) {
    console.error(`[ai-agent-reply] erro em step=${step}:`, error?.message || error);
    // Lock adquirido sem estado final gravado: libera processing_since.
    // finished=true significa finishAgent já commitou — não sobrescrever.
    if (lockAcquired && !finished) {
      try {
        const ctx = { ...(execution?.context as any) };
        if (ctx?.agent) {
          const agentClean = { ...ctx.agent };
          delete agentClean.processing_since;
          await supabase
            .from("flow_executions")
            .update({ context: { ...ctx, agent: agentClean } })
            .eq("id", execution_id);
        }
      } catch (e2) {
        console.error("[ai-agent-reply] falha ao liberar lock no catch:", e2);
      }
    }
    return json(
      { success: false, step, error: error?.message || String(error) },
      getHttpErrorStatus(error, 500),
    );
  }
});
