import React, { useCallback, useState, useEffect } from "react";
import { handleError } from "@/utils/error-handler";
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  Connection,
  Edge,
  Node,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  BackgroundVariant,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import { useQueryClient } from "@tanstack/react-query";
import { useFlow, useCreateBlock } from "@/hooks/use-flows";
import { useStages } from "@/hooks/use-crm";
import { useParams, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Play, Save, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { FlowNode, BLOCK_TYPES } from "@/components/flows/FlowNode";
import { SimpleConfigPanel } from "@/components/flows/ConfigPanel";

const NODE_TYPES = {
  custom: FlowNode,
};

function getBlockPreview(type: string, config: any, stages: any[]): string {
  if (!config) return "Configurar...";
  const blockType = String(type).toLowerCase();

  switch (blockType) {
    case "message":
      return config.message || "Enviar mensagem...";
    case "wait":
    case "espera":
    case "delay":
      return `Aguardar ${config.waitValue ?? 24} ${config.waitUnit || "hours"}`;
    case "trigger":
      if (config.trigger_type !== "stage_enter") return "Gatilho Manual";
      // Sem etapa escolhida o bloco não dispara nada. Dizer "Gatilho: Estágio"
      // fazia parecer configurado.
      if (!config.stage_id) return "Gatilho: escolher etapa...";
      return `Gatilho: ${stages?.find((s) => s.id === config.stage_id)?.name || "etapa removida"}`;
    case "condition":
    case "condição":
    case "condicao":
      if (config.conditionMode === "any_response") return "Qualquer resposta";
      return config.conditionText || `Se ${config.positiveKeywords ? "SIM/NÃO" : "resposta"}...`;
    case "move_pipeline":
      // Sem etapa escolhida o bloco não move ninguém: o motor passa por ele e
      // segue. Três blocos assim estavam no fluxo do agente da conta Eleve One,
      // todos mostrando "Mover para Estágio" como se estivessem prontos.
      if (!config.target_stage_id) return "Escolher etapa de destino...";
      return `Mover para ${stages?.find((s) => s.id === config.target_stage_id)?.name || "etapa removida"}`;
    case "ai_agent":
      return config.prompt
        ? `IA: ${String(config.prompt).slice(0, 60)}...`
        : "Configurar Agente IA...";
    default:
      return "Configurar bloco...";
  }
}

function FlowCanvas() {
  const { id } = useParams({ from: "/flows/$id/edit" }) as { id: string };
  const navigate = useNavigate();
  const { data: flow, isLoading } = useFlow(id);
  const { data: stages } = useStages();
  const createBlock = useCreateBlock();
  const { project, setViewport } = useReactFlow();
  const queryClient = useQueryClient();

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;

  const handleUpdateNodeConfig = useCallback(
    (nodeId: string, updates: any) => {
      setNodes((prevNodes) =>
        prevNodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: { ...node.data.config, ...updates },
                  preview: getBlockPreview(
                    node.data.type,
                    { ...node.data.config, ...updates },
                    stages || [],
                  ),
                },
              }
            : node,
        ),
      );
      setHasUnsavedChanges(true);
    },
    [setNodes, stages],
  );

  const handleDeleteNode = async (blockId: string) => {
    if (confirm("Remover este bloco?")) {
      setNodes((nds) => nds.filter((n) => n.id !== blockId));
      setEdges((eds) => eds.filter((e) => e.source !== blockId && e.target !== blockId));
      setHasUnsavedChanges(true);
      if (selectedNodeId === blockId) setSelectedNodeId(null);
    }
  };

  const handleAddBlock = async (type: string, position?: { x: number; y: number }) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const blockId = crypto.randomUUID();
    const typeInfo = BLOCK_TYPES.find((t) => t.id === type);
    const defaultConfig: any = { position_x: position?.x || 250, position_y: position?.y || 100 };
    setNodes((nds) =>
      nds.concat({
        id: blockId,
        type: "custom",
        position: { x: defaultConfig.position_x, y: defaultConfig.position_y },
        data: {
          type,
          label: typeInfo?.name,
          preview: getBlockPreview(type, defaultConfig, stages || []),
          config: defaultConfig,
          onDelete: (id: string) => handleDeleteNode(id),
        },
      }),
    );
    setHasUnsavedChanges(true);
    createBlock.mutate({ flow_id: id, user_id: user.id, type, config: defaultConfig });
  };

  const onConnect = useCallback(
    (params: Connection) => {
      const newEdge = {
        ...params,
        id: `e-${params.source}-${params.target}${params.sourceHandle ? "-" + params.sourceHandle : ""}`,
        type: "smoothstep",
        animated: !!flow?.is_active,
        style: {
          stroke:
            params.sourceHandle === "true"
              ? "#10b981"
              : params.sourceHandle === "false"
                ? "#ef4444"
                : "#7c3aed",
          strokeWidth: 2,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color:
            params.sourceHandle === "true"
              ? "#10b981"
              : params.sourceHandle === "false"
                ? "#ef4444"
                : "#7c3aed",
        },
      };
      setEdges((eds) => addEdge(newEdge, eds));
      if (params.sourceHandle === "true")
        handleUpdateNodeConfig(params.source!, { next_if_true: params.target });
      else if (params.sourceHandle === "false")
        handleUpdateNodeConfig(params.source!, { next_if_false: params.target });
      else {
        setNodes((nds) =>
          nds.map((n) =>
            n.id === params.source
              ? { ...n, data: { ...n.data, next_block_id: params.target } }
              : n,
          ),
        );
        setHasUnsavedChanges(true);
      }
    },
    [flow, handleUpdateNodeConfig, setEdges, setNodes],
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      setEdges((eds) => eds.filter((e) => !deletedEdges.find((de) => de.id === e.id)));
      deletedEdges.forEach((edge) => {
        if (edge.sourceHandle === "true")
          handleUpdateNodeConfig(edge.source, { next_if_true: null });
        else if (edge.sourceHandle === "false")
          handleUpdateNodeConfig(edge.source, { next_if_false: null });
        else {
          setNodes((nds) =>
            nds.map((n) =>
              n.id === edge.source ? { ...n, data: { ...n.data, next_block_id: null } } : n,
            ),
          );
          setHasUnsavedChanges(true);
        }
      });
    },
    [handleUpdateNodeConfig, setEdges, setNodes],
  );

  const onNodeDragStop = useCallback(
    (_: any, node: Node) => {
      setNodes((nds) => nds.map((n) => (n.id === node.id ? { ...n, position: node.position } : n)));
      setHasUnsavedChanges(true);
    },
    [setNodes],
  );

  useEffect(() => {
    if (!flow || isInitialized || !stages) return;

    if (
      flow.canvas_state &&
      typeof flow.canvas_state === "object" &&
      (flow.canvas_state as any).nodes?.length > 0
    ) {
      const state = flow.canvas_state as any;
      const savedNodes = state.nodes.map((n: any) => ({
        ...n,
        position: { x: n.position?.x ?? 400, y: n.position?.y ?? 100 },
        data: { ...n.data, onDelete: (id: string) => handleDeleteNode(id) },
      }));

      const savedEdges = state.edges.map((e: any) => ({
        ...e,
        style: e.style || { stroke: "#7c3aed", strokeWidth: 2 },
        markerEnd: e.markerEnd || { type: MarkerType.ArrowClosed, color: "#7c3aed" },
      }));

      setNodes(savedNodes);
      setEdges(savedEdges);
      if (state.viewport) {
        setViewport(state.viewport);
      }
      setIsInitialized(true);
      return;
    }

    if (flow.flow_blocks && flow.flow_blocks.length > 0) {
      setNodes(
        flow.flow_blocks.map((b: any, idx: number) => ({
          id: b.id,
          type: "custom",
          position: { x: 400, y: 100 + idx * 180 },
          data: {
            type: b.type,
            config: b.config,
            preview: getBlockPreview(b.type, b.config, stages),
            onDelete: (id: string) => handleDeleteNode(id),
          },
        })),
      );
      setIsInitialized(true);
    }
  }, [flow, stages, isInitialized, setNodes, setEdges]);

  const handleSave = async () => {
    const loadingToast = toast.loading("Salvando fluxo...");
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Usuário não autenticado");

      // Apenas nós que existem hoje no canvas
      const nodeIds = new Set(nodes.map((n) => n.id));
      // Descarta arestas órfãs (source/target apontando para nós deletados)
      const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

      const canvasState = {
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.type,
          position: node.position,
          data: { ...node.data, onDelete: undefined },
        })),
        edges: validEdges.map((edge) => ({
          ...edge,
          label: typeof edge.label === "string" ? edge.label : null,
        })),
        viewport: (window as any).reactFlowViewport || { x: 0, y: 0, zoom: 1 },
      };

      const { error: flowErr } = await supabase
        .from("flows")
        .update({ canvas_state: canvasState as any })
        .eq("id", id);
      if (flowErr) throw new Error(`Erro ao salvar canvas: ${flowErr.message}`);

      const blocksToInsert = nodes.map((node, index) => {
        const cfg: any = {
          ...node.data.config,
          canvas_x: node.position.x,
          canvas_y: node.position.y,
        };
        // Para blocos de condição: sincroniza ramos SIM/NÃO direto das arestas válidas
        if (node.data.type === "condition") {
          const trueEdge = validEdges.find(
            (e) => e.source === node.id && e.sourceHandle === "true",
          );
          const falseEdge = validEdges.find(
            (e) => e.source === node.id && e.sourceHandle === "false",
          );
          cfg.next_if_true = trueEdge?.target || null;
          cfg.next_if_false = falseEdge?.target || null;
        }
        const defaultEdge = validEdges.find((e) => e.source === node.id && !e.sourceHandle);
        return {
          id: node.id,
          flow_id: id,
          user_id: user.id,
          type: node.data.type,
          position: index,
          config: cfg,
          next_block_id: defaultEdge?.target || null,
        };
      });

      const { data: existingBlocks, error: existingErr } = await supabase
        .from("flow_blocks")
        .select("id")
        .eq("flow_id", id);
      if (existingErr) throw new Error(`Erro ao buscar blocos antigos: ${existingErr.message}`);

      const { data: referencedExecutions, error: refErr } = await supabase
        .from("flow_executions")
        .select("current_block_id")
        .eq("flow_id", id)
        .not("current_block_id", "is", null);
      if (refErr) throw new Error(`Erro ao verificar execuções ativas: ${refErr.message}`);

      const referencedBlockIds = new Set(
        (referencedExecutions || [])
          .map((execution: any) => execution.current_block_id)
          .filter(Boolean),
      );
      const obsoleteBlockIds = (existingBlocks || [])
        .map((block: any) => block.id)
        .filter((blockId: string) => !nodeIds.has(blockId) && !referencedBlockIds.has(blockId));

      if (obsoleteBlockIds.length > 0) {
        const { error: delErr } = await supabase
          .from("flow_blocks")
          .delete()
          .in("id", obsoleteBlockIds);
        if (delErr) throw new Error(`Erro ao limpar blocos antigos: ${delErr.message}`);
      }

      if (blocksToInsert.length > 0) {
        const { error: insErr } = await supabase
          .from("flow_blocks")
          .upsert(blocksToInsert, { onConflict: "id" });
        if (insErr) throw new Error(`Erro ao gravar blocos: ${insErr.message}`);
      }

      queryClient.invalidateQueries({ queryKey: ["flows", id] });
      setHasUnsavedChanges(false);
      toast.dismiss(loadingToast);
      toast.success(`Fluxo salvo! (${blocksToInsert.length} blocos)`);
    } catch (e: any) {
      toast.dismiss(loadingToast);
      handleError(e, "FlowEditor:handleSave");
    }
  };

  const handleTestFlow = async () => {
    const loadingToast = toast.loading("Iniciando teste real...");
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { data: account } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", user.id)
        .single();
      if (!account) throw new Error("Conta não encontrada");

      const settings = account.settings as any;
      const testPhone = settings?.test_phone;

      if (!testPhone) {
        toast.dismiss(loadingToast);
        toast.error("Configure o telefone de teste nas configurações.");
        navigate({ to: "/settings" as any });
        return;
      }

      if (account.whatsapp_status !== "connected") {
        toast.dismiss(loadingToast);
        toast.error("WhatsApp desconectado. Conecte antes de testar.");
        return;
      }

      const { normalizeBrazilPhone } = await import("@/lib/phone");
      const normalized = normalizeBrazilPhone(testPhone);

      // 1. Create temporary test lead
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({
          user_id: user.id,
          name: "Teste EleveFlow",
          phone: normalized,
          company: "Ambiente de Teste",
          tags: ["teste-editor"],
          marketing_consent_status: "not_required",
        })
        .select()
        .single();

      if (leadError) throw new Error(`Falha ao criar lead: ${leadError.message}`);

      // 2. Execute flow
      const { data: executionResult, error: invokeError } = await supabase.functions.invoke(
        "execute-flow",
        {
          body: {
            lead_id: lead.id,
            flow_id: id,
            user_id: user.id,
            trigger_type: "manual",
          },
        },
      );

      if (invokeError) throw new Error(invokeError.message);
      if (executionResult?.error) throw new Error(executionResult.error);

      toast.loading("Fluxo acionado. Gerando mensagem...", { id: loadingToast });

      // 3. Process queue immediately
      const { processQueueBatch } = await import("@/services/queueService");
      // Wait for Edge Function to finish DB inserts
      await new Promise((resolve) => setTimeout(resolve, 3500));
      await processQueueBatch(5);

      // 4. Poll for status
      let attempts = 0;
      let finalStatus = "pending";

      toast.loading("Aguardando confirmação de envio real...", { id: loadingToast });

      while (attempts < 8 && finalStatus !== "sent" && finalStatus !== "failed") {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const { data: queueItem } = await supabase
          .from("send_queue")
          .select("status")
          .eq("lead_id", lead.id)
          .eq("flow_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (queueItem?.status) finalStatus = queueItem.status;
      }

      toast.dismiss(loadingToast);
      if (finalStatus === "sent") {
        toast.success("Mensagem enviada com sucesso!");
      } else if (finalStatus === "failed") {
        toast.error("Falha no envio pelo WhatsApp.");
      } else {
        toast.warning("Fluxo iniciado, mas mensagem ainda na fila.");
      }

      // Cleanup lead after 30s
      setTimeout(() => supabase.from("leads").delete().eq("id", lead.id), 30000);
    } catch (err: any) {
      toast.dismiss(loadingToast);
      handleError(err, "FlowEditor:handleTestFlow");
    }
  };

  const onDrop = useCallback(
    (event: any) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow");
      if (!type) return;
      const position = project({ x: event.clientX - 240, y: event.clientY - 64 });
      handleAddBlock(type, position);
    },
    [project],
  );

  if (isLoading) return <div className="p-10 text-white">Carregando editor visual...</div>;

  return (
    <div className="h-screen w-full flex flex-col bg-[#0a0a0f] overflow-hidden relative">
      <header className="h-16 flex justify-between items-center px-6 border-b border-[#2a2a3a] bg-[#111118] z-20">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate({ to: "/flows" as any })}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-white font-bold">{flow?.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestFlow}
            className="border-[#2a2a3a] text-slate-300 hover:text-white"
          >
            <Play className="h-4 w-4 mr-2 text-green-500" /> Testar
          </Button>
          <Button
            onClick={handleSave}
            className={hasUnsavedChanges ? "bg-orange-500 animate-pulse" : "bg-[#7c3aed]"}
          >
            <Save className="h-4 w-4 mr-2" /> {hasUnsavedChanges ? "Salvar*" : "Salvar"}
          </Button>
        </div>
      </header>
      <div className="flex-1 flex overflow-hidden">
        <aside className="w-[240px] p-4 bg-[#111118] border-r border-[#2a2a3a] overflow-y-auto">
          <h2 className="text-[11px] font-bold text-[#475569] uppercase tracking-widest mb-4">
            Blocos
          </h2>
          <div className="space-y-2">
            {BLOCK_TYPES.map((type) => (
              <div
                key={type.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/reactflow", type.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => handleAddBlock(type.id)}
                className="flex items-center gap-3 p-3 rounded-lg border border-[#2a2a2a] bg-[#0d0d14] cursor-grab hover:border-[#7c3aed]"
              >
                <div
                  className="p-1.5 rounded"
                  style={{ backgroundColor: type.bgColor, color: type.color }}
                >
                  {type.icon}
                </div>
                <span className="text-xs font-semibold text-white">{type.name}</span>
              </div>
            ))}
          </div>
        </aside>
        <main
          className="flex-1 relative bg-[#0a0a0f]"
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={NODE_TYPES}
            onNodeClick={(_, n) => setSelectedNodeId(n.id)}
            onMove={(_, viewport) => {
              (window as any).reactFlowViewport = viewport;
            }}
            fitView
          >
            <Background color="#1a1a24" variant={BackgroundVariant.Dots} />
            <Controls />
            <MiniMap
              nodeColor={(n: any) =>
                BLOCK_TYPES.find((t) => t.id === n.data.type)?.color || "#7c3aed"
              }
              className="!bg-[#111118] !border-[#2a2a3a]"
            />
          </ReactFlow>
        </main>
        {selectedNode && (
          <SimpleConfigPanel
            node={selectedNode}
            stages={stages || []}
            onUpdate={handleUpdateNodeConfig}
            onClose={() => setSelectedNodeId(null)}
            onDelete={handleDeleteNode}
          />
        )}
      </div>
    </div>
  );
}

export default function FlowEditorPage() {
  return (
    <ReactFlowProvider>
      <FlowCanvas />
    </ReactFlowProvider>
  );
}
