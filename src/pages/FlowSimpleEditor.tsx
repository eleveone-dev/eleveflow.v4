import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Play,
  Save,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  MessageSquare,
  Clock,
  Split,
  LayoutGrid,
  XCircle,
  Sliders,
} from "lucide-react";
import { useFlow } from "@/hooks/use-flows";
import { useStages } from "@/hooks/use-crm";
import { handleError } from "@/utils/error-handler";
import { runFlowTest } from "@/lib/flow-test";
import { SimpleStep, stepsToCanvas, canvasToSteps } from "@/lib/flow-simple-converter";

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const STEP_META: Record<
  SimpleStep["type"],
  { label: string; icon: React.ReactNode; color: string }
> = {
  message: {
    label: "Mensagem WhatsApp",
    icon: <MessageSquare className="h-4 w-4" />,
    color: "#10b981",
  },
  condition: {
    label: "Condição de resposta",
    icon: <Split className="h-4 w-4" />,
    color: "#f59e0b",
  },
  wait: { label: "Espera", icon: <Clock className="h-4 w-4" />, color: "#3b82f6" },
  move_pipeline: {
    label: "Mover Pipeline",
    icon: <LayoutGrid className="h-4 w-4" />,
    color: "#f97316",
  },
  end: { label: "Fim", icon: <XCircle className="h-4 w-4" />, color: "#6b7280" },
};

function makeStep(type: SimpleStep["type"]): SimpleStep {
  const id = newId();
  switch (type) {
    case "message":
      return { id, type: "message", message: "" };
    case "condition":
      return { id, type: "condition", mode: "any_response" };
    case "wait":
      return { id, type: "wait", value: 1, unit: "hours" };
    case "move_pipeline":
      return { id, type: "move_pipeline", stage_id: "" };
    case "end":
      return { id, type: "end" };
  }
}

export default function FlowSimpleEditor() {
  const { id } = useParams({ from: "/flows/$id/edit" }) as { id: string };
  const search = useSearch({ from: "/flows/$id/edit" }) as { mode?: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: flow, isLoading } = useFlow(id);
  const { data: stages } = useStages();

  const [steps, setSteps] = useState<SimpleStep[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!flow || initialized) return;
    const canvas = (flow as any).canvas_state;
    const reconstructed = canvasToSteps(canvas);
    if (reconstructed === null) {
      setUnsupported(true);
      setInitialized(true);
      return;
    }
    if (reconstructed.length === 0) {
      setSteps([makeStep("message")]);
    } else {
      setSteps(reconstructed);
    }
    setInitialized(true);
  }, [flow, initialized]);

  const update = (idx: number, patch: Partial<any>) => {
    setSteps((arr) => arr.map((s, i) => (i === idx ? ({ ...s, ...patch } as SimpleStep) : s)));
    setDirty(true);
  };
  const remove = (idx: number) => {
    setSteps((arr) => arr.filter((_, i) => i !== idx));
    setDirty(true);
  };
  const move = (idx: number, dir: -1 | 1) => {
    setSteps((arr) => {
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return arr;
      const copy = [...arr];
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });
    setDirty(true);
  };
  const add = (type: SimpleStep["type"]) => {
    setSteps((arr) => [...arr, makeStep(type)]);
    setDirty(true);
  };

  const handleSave = async () => {
    const t = toast.loading("Salvando fluxo...");
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Não autenticado");

      const { nodes, edges } = stepsToCanvas(steps);
      const canvasState = {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges,
        viewport: { x: 0, y: 0, zoom: 1 },
      };

      await supabase
        .from("flows")
        .update({ canvas_state: canvasState as any })
        .eq("id", id);
      await supabase.from("flow_blocks").delete().eq("flow_id", id);

      const blocksToInsert = nodes.map((node, index) => ({
        id: node.id,
        flow_id: id,
        user_id: user.id,
        type: node.data.type,
        position: index,
        config: node.data.config,
        next_block_id: edges.find((e) => e.source === node.id && !e.sourceHandle)?.target || null,
      }));
      if (blocksToInsert.length > 0) await supabase.from("flow_blocks").insert(blocksToInsert);

      queryClient.invalidateQueries({ queryKey: ["flows", id] });
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      setDirty(false);
      toast.dismiss(t);
      toast.success("Fluxo salvo!");
    } catch (e: any) {
      toast.dismiss(t);
      handleError(e, "FlowSimpleEditor:handleSave");
    }
  };

  const goAdvanced = () =>
    navigate({ to: "/flows/$id/edit", params: { id }, search: { mode: "advanced" } } as any);

  if (isLoading) return <div className="p-10 text-white">Carregando...</div>;

  if (unsupported) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] text-white p-8">
        <Button variant="ghost" onClick={() => navigate({ to: "/flows" as any })}>
          <ArrowLeft className="h-5 w-5 mr-2" /> Voltar
        </Button>
        <div className="max-w-xl mx-auto mt-16 p-8 rounded-xl border border-[#2a2a3a] bg-[#111118] text-center">
          <h2 className="text-xl font-bold mb-3">Este fluxo usa estrutura avançada</h2>
          <p className="text-slate-400 mb-6">
            Ele tem ramificações que o Modo Simples não consegue editar sem perder informação. Abra
            no Modo Avançado para editar.
          </p>
          <Button onClick={goAdvanced} className="bg-[#7c3aed]">
            <Sliders className="h-4 w-4 mr-2" /> Abrir Modo Avançado
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <header className="h-16 flex justify-between items-center px-6 border-b border-[#2a2a3a] bg-[#111118] sticky top-0 z-20">
        <div className="flex items-center gap-4 min-w-0">
          <Button variant="ghost" onClick={() => navigate({ to: "/flows" as any })}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-bold truncate">{flow?.name}</h1>
          <span className="text-[10px] uppercase tracking-widest text-slate-500 border border-[#2a2a3a] rounded px-2 py-0.5">
            Modo Simples
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={goAdvanced}
            className="text-slate-400 hover:text-white"
          >
            <Sliders className="h-4 w-4 mr-2" /> Modo Avançado
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runFlowTest(id, () => navigate({ to: "/settings" as any }))}
            className="border-[#2a2a3a] text-slate-300 hover:text-white"
          >
            <Play className="h-4 w-4 mr-2 text-green-500" /> Testar
          </Button>
          <Button
            onClick={handleSave}
            className={dirty ? "bg-orange-500 animate-pulse" : "bg-[#7c3aed]"}
          >
            <Save className="h-4 w-4 mr-2" /> {dirty ? "Salvar*" : "Salvar"}
          </Button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto py-10 px-4 pb-32">
        <div className="space-y-4">
          {steps.map((step, idx) => (
            <StepCardView
              key={step.id}
              step={step}
              index={idx}
              total={steps.length}
              stages={stages || []}
              onUpdate={(patch) => update(idx, patch)}
              onRemove={() => remove(idx)}
              onMoveUp={() => move(idx, -1)}
              onMoveDown={() => move(idx, 1)}
            />
          ))}
        </div>

        <AddStepBar onAdd={add} />
      </main>
    </div>
  );
}

function StepCardView({
  step,
  index,
  total,
  stages,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: SimpleStep;
  index: number;
  total: number;
  stages: any[];
  onUpdate: (patch: any) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const meta = STEP_META[step.type];
  return (
    <div
      className="rounded-xl border bg-[#111118] overflow-hidden"
      style={{ borderColor: `${meta.color}40` }}
    >
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ backgroundColor: `${meta.color}15` }}
      >
        <div className="flex items-center gap-3">
          <span
            className="flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold"
            style={{ backgroundColor: meta.color, color: "#0a0a0f" }}
          >
            {index + 1}
          </span>
          <span style={{ color: meta.color }}>{meta.icon}</span>
          <span className="text-xs font-bold uppercase tracking-widest">{meta.label}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onMoveUp}
            disabled={index === 0}
            className="h-7 w-7 p-0"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onMoveDown}
            disabled={index === total - 1}
            className="h-7 w-7 p-0"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {step.type === "message" && (
          <Textarea
            placeholder="Digite a mensagem... use {{nome}}, {{empresa}} etc."
            value={(step as any).message}
            onChange={(e) => onUpdate({ message: e.target.value })}
            className="min-h-[100px] bg-[#0d0d14] border-[#2a2a3a] text-white"
          />
        )}

        {step.type === "condition" && (
          <div className="space-y-3">
            <Select value={(step as any).mode} onValueChange={(v) => onUpdate({ mode: v })}>
              <SelectTrigger className="bg-[#0d0d14] border-[#2a2a3a]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any_response">Quando responder qualquer coisa</SelectItem>
                <SelectItem value="no_reply_timeout">Se não responder em…</SelectItem>
              </SelectContent>
            </Select>
            {(step as any).mode === "no_reply_timeout" && (
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  value={(step as any).timeoutValue ?? 24}
                  onChange={(e) => onUpdate({ timeoutValue: Number(e.target.value) })}
                  className="bg-[#0d0d14] border-[#2a2a3a]"
                />
                <Select
                  value={(step as any).timeoutUnit ?? "hours"}
                  onValueChange={(v) => onUpdate({ timeoutUnit: v })}
                >
                  <SelectTrigger className="bg-[#0d0d14] border-[#2a2a3a] w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">Minutos</SelectItem>
                    <SelectItem value="hours">Horas</SelectItem>
                    <SelectItem value="days">Dias</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {step.type === "wait" && (
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              value={(step as any).value}
              onChange={(e) => onUpdate({ value: Number(e.target.value) })}
              className="bg-[#0d0d14] border-[#2a2a3a]"
            />
            <Select value={(step as any).unit} onValueChange={(v) => onUpdate({ unit: v })}>
              <SelectTrigger className="bg-[#0d0d14] border-[#2a2a3a] w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">Minutos</SelectItem>
                <SelectItem value="hours">Horas</SelectItem>
                <SelectItem value="days">Dias</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {step.type === "move_pipeline" && (
          <Select value={(step as any).stage_id} onValueChange={(v) => onUpdate({ stage_id: v })}>
            <SelectTrigger className="bg-[#0d0d14] border-[#2a2a3a]">
              <SelectValue placeholder="Selecione um estágio" />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s: any) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {step.type === "end" && (
          <p className="text-xs text-slate-500 italic">Encerra a execução do fluxo neste ponto.</p>
        )}
      </div>
    </div>
  );
}

function AddStepBar({ onAdd }: { onAdd: (t: SimpleStep["type"]) => void }) {
  const types: SimpleStep["type"][] = ["message", "condition", "wait", "move_pipeline", "end"];
  return (
    <div className="mt-6 rounded-xl border border-dashed border-[#2a2a3a] bg-[#0d0d14] p-4">
      <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2">
        <Plus className="h-3 w-3" /> Adicionar etapa
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {types.map((t) => {
          const m = STEP_META[t];
          return (
            <button
              key={t}
              onClick={() => onAdd(t)}
              className="flex flex-col items-center gap-1 p-3 rounded-lg border border-[#2a2a3a] hover:border-[#7c3aed] transition-colors text-xs"
              style={{ color: m.color }}
            >
              {m.icon}
              <span className="text-slate-300 text-[11px]">{m.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
