import React from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Handle, Position } from "reactflow";
import { safeText } from "@/lib/utils/safeData";
import {
  X,
  Split,
  MessageSquare,
  Clock,
  BrainCircuit,
  LayoutGrid,
  AlertCircle,
  XCircle,
  Bot,
} from "lucide-react";

export const BLOCK_TYPES = [
  {
    id: "trigger",
    name: "Gatilho",
    icon: <Split className="h-4 w-4" />,
    color: "#7c3aed",
    bgColor: "#7c3aed20",
    symbol: "⚡",
  },
  {
    id: "message",
    name: "WhatsApp",
    icon: <MessageSquare className="h-4 w-4" />,
    color: "#10b981",
    bgColor: "#10b98120",
    symbol: "💬",
  },
  {
    id: "wait",
    name: "Espera",
    icon: <Clock className="h-4 w-4" />,
    color: "#3b82f6",
    bgColor: "#3b82f620",
    symbol: "⏱️",
  },
  {
    id: "condition",
    name: "Condição",
    icon: <Split className="h-4 w-4" />,
    color: "#f59e0b",
    bgColor: "#f59e0b20",
    symbol: "🔀",
  },
  {
    id: "ai_agent",
    name: "Agente de IA",
    icon: <Bot className="h-4 w-4" />,
    color: "#a855f7",
    bgColor: "#a855f720",
    symbol: "🧠",
  },
  {
    id: "classifier",
    name: "IA / Classificador",
    icon: <BrainCircuit className="h-4 w-4" />,
    color: "#06b6d4",
    bgColor: "#06b6d420",
    symbol: "🤖",
  },
  {
    id: "move_pipeline",
    name: "Mover Pipeline",
    icon: <LayoutGrid className="h-4 w-4" />,
    color: "#f97316",
    bgColor: "#f9731620",
    symbol: "📋",
  },
  {
    id: "objection",
    name: "Criar Objeção",
    icon: <AlertCircle className="h-4 w-4" />,
    color: "#ef4444",
    bgColor: "#ef444420",
    symbol: "⚠️",
  },
  {
    id: "end",
    name: "Fim do Fluxo",
    icon: <XCircle className="h-4 w-4" />,
    color: "#6b7280",
    bgColor: "#6b728020",
    symbol: "🛑",
  },
];

export const FlowNode = ({ data, id }: any) => {
  const typeInfo = BLOCK_TYPES.find((t) => t.id === data.type);
  const isCondition = data.type === "condition";
  const isAiAgent = data.type === "ai_agent";

  return (
    <ErrorBoundary>
      <div
        className={`node-wrapper w-[220px] bg-[#111118] border-2 rounded-xl overflow-hidden shadow-2xl transition-all ${data.selected ? "ring-2 ring-[#7c3aed] ring-offset-2 ring-offset-[#0a0a0f]" : ""}`}
        style={{ borderColor: typeInfo?.color || "#2a2a3a" }}
      >
        <div
          className="node-header flex items-center justify-between px-3 py-2"
          style={{ backgroundColor: typeInfo?.bgColor }}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm">{typeInfo?.symbol}</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-white">
              {safeText(typeInfo?.name)}
            </span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete(id);
            }}
            className="text-[#94a3b8] hover:text-white transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <div className="node-body p-3 border-t border-[#2a2a3a]">
          <p className="text-[11px] text-[#94a3b8] line-clamp-2 italic">
            {safeText(data.preview || "Configurar bloco...")}
          </p>
        </div>

        <Handle
          type="target"
          position={Position.Top}
          className="!w-3 !h-3 !bg-[#7c3aed] !border-2 !border-[#111118]"
        />

        {isCondition ? (
          <div className="flex justify-around w-full pb-1 relative">
            <div className="flex flex-col items-center gap-1">
              <Handle
                type="source"
                position={Position.Bottom}
                id="true"
                style={{ left: "30%" }}
                className="!w-3 !h-3 !bg-green-500 !border-2 !border-[#111118]"
              />
              <span className="text-[8px] text-green-500 font-bold mt-1">SIM</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Handle
                type="source"
                position={Position.Bottom}
                id="false"
                style={{ left: "70%" }}
                className="!w-3 !h-3 !bg-red-500 !border-2 !border-[#111118]"
              />
              <span className="text-[8px] text-red-500 font-bold mt-1">NÃO</span>
            </div>
          </div>
        ) : isAiAgent ? (
          <div className="flex justify-around w-full pb-1 relative">
            <div className="flex flex-col items-center gap-1">
              <Handle
                type="source"
                position={Position.Bottom}
                id="goal"
                style={{ left: "20%" }}
                className="!w-3 !h-3 !bg-green-500 !border-2 !border-[#111118]"
              />
              <span className="text-[8px] text-green-500 font-bold mt-1">OBJETIVO</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Handle
                type="source"
                position={Position.Bottom}
                id="giveup"
                style={{ left: "50%" }}
                className="!w-3 !h-3 !bg-red-500 !border-2 !border-[#111118]"
              />
              <span className="text-[8px] text-red-500 font-bold mt-1">DESISTIU</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Handle
                type="source"
                position={Position.Bottom}
                id="limit"
                style={{ left: "80%" }}
                className="!w-3 !h-3 !bg-amber-500 !border-2 !border-[#111118]"
              />
              <span className="text-[8px] text-amber-500 font-bold mt-1">LIMITE</span>
            </div>
          </div>
        ) : (
          <Handle
            type="source"
            position={Position.Bottom}
            className="!w-3 !h-3 !bg-[#7c3aed] !border-2 !border-[#111118]"
          />
        )}
      </div>
    </ErrorBoundary>
  );
};
