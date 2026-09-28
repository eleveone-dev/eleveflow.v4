// Conversor entre a sequência linear do Modo Simples e o canvas_state usado pelo motor atual.
// Não altera o formato existente: cada step vira um node "custom" e edges sequenciais com
// sourceHandle apropriado para condições.

import { MarkerType } from "reactflow";

export type SimpleStep =
  | { id: string; type: "message"; message: string }
  | {
      id: string;
      type: "condition";
      mode: "any_response" | "no_reply_timeout";
      timeoutValue?: number;
      timeoutUnit?: "minutes" | "hours" | "days";
    }
  | { id: string; type: "wait"; value: number; unit: "minutes" | "hours" | "days" }
  | { id: string; type: "move_pipeline"; stage_id: string }
  | { id: string; type: "end" };

export interface CanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { type: string; config: any; preview?: string };
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  type?: string;
  animated?: boolean;
  style?: any;
  markerEnd?: any;
}

const X_BASE = 400;
const Y_GAP = 180;

const previewFor = (step: SimpleStep): string => {
  switch (step.type) {
    case "message":
      return step.message?.slice(0, 80) || "Mensagem...";
    case "condition":
      return step.mode === "no_reply_timeout"
        ? `Se não responder em ${step.timeoutValue ?? 24} ${step.timeoutUnit ?? "hours"}`
        : "Qualquer resposta";
    case "wait":
      return `Aguardar ${step.value} ${step.unit}`;
    case "move_pipeline":
      return `Mover para estágio`;
    case "end":
      return "Fim do fluxo";
  }
};

const configFor = (step: SimpleStep, x: number, y: number): any => {
  const base = { canvas_x: x, canvas_y: y, position_x: x, position_y: y };
  switch (step.type) {
    case "message":
      return { ...base, message: step.message };
    case "condition":
      return {
        ...base,
        conditionMode: step.mode === "any_response" ? "any_response" : "no_reply",
        condition_type: step.mode === "any_response" ? "reply_any" : "no_reply_timeout",
        waitValue: step.timeoutValue,
        waitUnit: step.timeoutUnit,
      };
    case "wait":
      return { ...base, waitValue: step.value, waitUnit: step.unit };
    case "move_pipeline":
      return { ...base, target_stage_id: step.stage_id };
    case "end":
      return base;
  }
};

const edgeStyle = (handle?: string | null) => ({
  type: "smoothstep",
  animated: false,
  style: {
    stroke: handle === "true" ? "#10b981" : handle === "false" ? "#ef4444" : "#7c3aed",
    strokeWidth: 2,
  },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: handle === "true" ? "#10b981" : handle === "false" ? "#ef4444" : "#7c3aed",
  },
});

export function stepsToCanvas(steps: SimpleStep[]): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  const nodes: CanvasNode[] = steps.map((step, i) => {
    const x = X_BASE;
    const y = 100 + i * Y_GAP;
    return {
      id: step.id,
      type: "custom",
      position: { x, y },
      data: {
        type: step.type,
        config: configFor(step, x, y),
        preview: previewFor(step),
      },
    };
  });

  const edges: CanvasEdge[] = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const cur = steps[i];
    const next = steps[i + 1];
    if (cur.type === "condition") {
      // Saída SIM → próximo step
      edges.push({
        id: `e-${cur.id}-${next.id}-true`,
        source: cur.id,
        target: next.id,
        sourceHandle: "true",
        ...edgeStyle("true"),
      });
      // Atualiza config para conter next_if_true (compatibilidade com motor)
      const node = nodes.find((n) => n.id === cur.id)!;
      node.data.config.next_if_true = next.id;
    } else {
      edges.push({
        id: `e-${cur.id}-${next.id}`,
        source: cur.id,
        target: next.id,
        sourceHandle: null,
        ...edgeStyle(null),
      });
    }
  }
  return { nodes, edges };
}

// Reconstrói a sequência linear a partir do canvas_state.
// Retorna null se o fluxo não for representável como sequência simples
// (ramificações, ciclos, múltiplas raízes não suportadas).
export function canvasToSteps(canvas: any): SimpleStep[] | null {
  if (!canvas || !Array.isArray(canvas.nodes) || canvas.nodes.length === 0) return [];
  const nodes: any[] = canvas.nodes;
  const edges: any[] = Array.isArray(canvas.edges) ? canvas.edges : [];

  // raiz = node sem incoming edge
  const targets = new Set(edges.map((e) => e.target));
  const roots = nodes.filter((n) => !targets.has(n.id));
  if (roots.length !== 1) return null;

  const out: SimpleStep[] = [];
  const visited = new Set<string>();
  let cur: any | null = roots[0];

  while (cur) {
    if (visited.has(cur.id)) return null;
    visited.add(cur.id);

    const type = cur.data?.type;
    const config = cur.data?.config || {};
    let step: SimpleStep;
    switch (type) {
      case "message":
        step = { id: cur.id, type: "message", message: config.message || "" };
        break;
      case "condition":
        step = {
          id: cur.id,
          type: "condition",
          mode: config.conditionMode === "no_reply" ? "no_reply_timeout" : "any_response",
          timeoutValue: config.waitValue,
          timeoutUnit: config.waitUnit,
        };
        break;
      case "wait":
        step = {
          id: cur.id,
          type: "wait",
          value: config.waitValue ?? 1,
          unit: config.waitUnit || "hours",
        };
        break;
      case "move_pipeline":
        step = { id: cur.id, type: "move_pipeline", stage_id: config.target_stage_id || "" };
        break;
      case "end":
        step = { id: cur.id, type: "end" };
        break;
      default:
        return null; // trigger, classifier, objection etc. → não suportado no Simples
    }
    out.push(step);

    const outgoing = edges.filter((e) => e.source === cur.id);
    if (outgoing.length === 0) {
      cur = null;
    } else if (type === "condition") {
      // aceita apenas saída SIM linear; outros ramos → não-linear
      const trueEdge = outgoing.find((e) => e.sourceHandle === "true");
      const falseEdge = outgoing.find((e) => e.sourceHandle === "false");
      if (!trueEdge) return null;
      // ramo "false" só é aceito se for direto para um 'end'
      if (falseEdge) {
        const falseTarget = nodes.find((n) => n.id === falseEdge.target);
        if (!falseTarget || falseTarget.data?.type !== "end") return null;
      }
      cur = nodes.find((n) => n.id === trueEdge.target) || null;
    } else {
      if (outgoing.length > 1) return null;
      cur = nodes.find((n) => n.id === outgoing[0].target) || null;
    }
  }

  return out;
}
