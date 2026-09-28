// Schema do "Sequência Simples de WhatsApp" — independente de nodes/edges.
// Salvo em flows.canvas_state = { mode:"sequence", sequence: FlowSequence }

export type WaitUnit = "minutes" | "hours" | "days";

export interface FlowSequence {
  version: 1;
  trigger: { type: "stage_enter"; stage_id: string } | { type: "manual" };
  m1: { message: string };
  on_reply: { messages: string[] };
  on_no_reply?: {
    wait_value: number;
    wait_unit: WaitUnit;
    messages: string[];
  };
}

export function emptySequence(): FlowSequence {
  return {
    version: 1,
    trigger: { type: "manual" },
    m1: { message: "" },
    on_reply: { messages: [""] },
  };
}

export function isSequenceCanvas(canvas: any): boolean {
  return canvas && canvas.mode === "sequence" && canvas.sequence;
}

export function readSequence(canvas: any): FlowSequence | null {
  if (!isSequenceCanvas(canvas)) return null;
  return canvas.sequence as FlowSequence;
}

export function waitToMs(value: number, unit: WaitUnit): number {
  const v = Math.max(0, Number(value) || 0);
  if (unit === "minutes") return v * 60_000;
  if (unit === "hours") return v * 60 * 60_000;
  return v * 24 * 60 * 60_000;
}
