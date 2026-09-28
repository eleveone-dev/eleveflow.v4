import React from "react";
import { safeText } from "@/lib/utils/safeData";

interface ConfigPanelProps {
  node: any;
  stages: any[];
  onUpdate: (id: string, config: any) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
}

const getNodeType = (node: any) => {
  return String(
    node?.type === "custom"
      ? node?.data?.type
      : node?.type || node?.data?.type || node?.data?.blockType || "",
  ).toLowerCase();
};

export const SimpleConfigPanel = ({
  node,
  stages,
  onUpdate,
  onClose,
  onDelete,
}: ConfigPanelProps) => {
  const type = getNodeType(node);
  const config = node.data?.config || {};

  const update = (key: string, value: any) => {
    onUpdate(node.id, { ...config, [key]: value });
  };

  return (
    <aside className="w-[320px] bg-[#111118] border-l border-[#2a2a3a] overflow-y-auto p-6 animate-in slide-in-from-right duration-300 z-30">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Configurar Bloco</h3>
        <button onClick={onClose} className="text-[#94a3b8] hover:text-white p-1 transition-colors">
          ✕
        </button>
      </div>

      <div className="space-y-6">
        {type === "trigger" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Tipo de Gatilho
              </label>
              <select
                value={config.trigger_type || "manual"}
                onChange={(e) => update("trigger_type", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
              >
                <option value="manual">Manual</option>
                <option value="stage_enter">Entrada em Estágio</option>
              </select>
            </div>
            {config.trigger_type === "stage_enter" && (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                  Estágio Gatilho
                </label>
                <select
                  value={config.stage_id || ""}
                  onChange={(e) => update("stage_id", e.target.value)}
                  className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
                >
                  <option value="">Selecione um estágio</option>
                  {(Array.isArray(stages) ? stages : []).map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {safeText(s.name)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {type === "message" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Mensagem WhatsApp
              </label>
              <textarea
                value={config.message || ""}
                onChange={(e) => update("message", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white min-h-[120px] focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
                placeholder="Digite sua mensagem..."
              />
              <p className="text-[10px] text-[#475569]">
                Dica: Use {"{{nome}}"} para personalizar.
              </p>
            </div>
          </div>
        )}

        {(type === "wait" || type === "espera" || type === "delay") && (
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-[#7c3aed] uppercase tracking-widest">
              Configurar Espera
            </h4>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">Tempo</label>
              <input
                type="number"
                value={config.waitValue ?? 24}
                onChange={(e) => update("waitValue", parseInt(e.target.value))}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
                min="1"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">Unidade</label>
              <select
                value={config.waitUnit || "hours"}
                onChange={(e) => update("waitUnit", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
              >
                <option value="seconds">Segundos</option>
                <option value="minutes">Minutos</option>
                <option value="hours">Horas</option>
                <option value="days">Dias</option>
              </select>
            </div>
          </div>
        )}

        {(type === "condition" || type === "condição" || type === "condicao") && (
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-[#f59e0b] uppercase tracking-widest">
              Configurar Condição
            </h4>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Tipo de Condição
              </label>
              <select
                value={config.conditionMode || "keywords"}
                onChange={(e) => update("conditionMode", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
              >
                <option value="keywords">Palavra-chave positiva/negativa</option>
                <option value="any_response">Qualquer resposta</option>
              </select>
            </div>

            {config.conditionMode === "any_response" ? (
              <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                <p className="text-[11px] text-blue-400 leading-relaxed">
                  <strong>Qualquer resposta:</strong> Qualquer mensagem recebida do lead seguirá
                  pela saída <span className="text-green-500 font-bold">SIM</span>.
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                    Intenção Positiva (SIM)
                  </label>
                  <textarea
                    value={config.positiveKeywords ?? "sim, claro, pode, quero, adorei, vamos, ok"}
                    onChange={(e) => update("positiveKeywords", e.target.value)}
                    className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white min-h-[60px] focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
                    placeholder="sim, claro, pode, quero..."
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                    Intenção Negativa (NÃO)
                  </label>
                  <textarea
                    value={
                      config.negativeKeywords ?? "não, agora não, depois, sem interesse, não quero"
                    }
                    onChange={(e) => update("negativeKeywords", e.target.value)}
                    className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white min-h-[60px] focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
                    placeholder="não, agora não, depois..."
                  />
                </div>
              </>
            )}

            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Descrição (Opcional)
              </label>
              <textarea
                value={config.conditionText || ""}
                onChange={(e) => update("conditionText", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
                placeholder="Ex: Se o cliente quiser agendar..."
              />
            </div>
          </div>
        )}

        {type === "move_pipeline" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Mover para Estágio
              </label>
              <select
                value={config.target_stage_id || ""}
                onChange={(e) => update("target_stage_id", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7c3aed]"
              >
                <option value="">Selecione um estágio</option>
                {(Array.isArray(stages) ? stages : []).map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {safeText(s.name)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {type === "ai_agent" && (
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-[#a855f7] uppercase tracking-widest">
              Agente de IA
            </h4>
            <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-lg">
              <p className="text-[11px] text-purple-300 leading-relaxed">
                A IA gera a resposta dinamicamente para o lead seguindo o prompt e as regras abaixo.
                Use variáveis como {"{{nome}}"}, {"{{empresa}}"}, {"{{ultima_mensagem}}"}.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">Modelo</label>
              <select
                value={config.model || "google/gemini-2.5-flash"}
                onChange={(e) => update("model", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
              >
                <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (recomendado)</option>
                <option value="google/gemini-2.5-flash-lite">
                  Gemini 2.5 Flash Lite (econômico)
                </option>
                <option value="google/gemini-3-flash-preview">Gemini 3 Flash Preview</option>
                <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="openai/gpt-5-mini">GPT-5 Mini</option>
                <option value="openai/gpt-5">GPT-5</option>
                <option value="anthropic/claude-haiku-4.5">Claude Haiku 4.5</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Prompt (objetivo)
              </label>
              <textarea
                value={config.prompt || ""}
                onChange={(e) => update("prompt", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white min-h-[120px] focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
                placeholder="Ex: Você é um SDR. Responda o lead de forma cordial, qualifique o interesse e proponha agendamento."
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Regras (uma por linha)
              </label>
              <textarea
                value={config.rules || ""}
                onChange={(e) => update("rules", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white min-h-[140px] focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
                placeholder={
                  "- Nunca prometa preços\n- Responda em no máximo 2 parágrafos\n- Sempre termine com uma pergunta\n- Não use emojis"
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                  Temperatura
                </label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={config.temperature ?? 0.7}
                  onChange={(e) => update("temperature", parseFloat(e.target.value))}
                  className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                  Máx. caracteres
                </label>
                <input
                  type="number"
                  min="50"
                  value={config.maxChars ?? 500}
                  onChange={(e) => update("maxChars", parseInt(e.target.value))}
                  className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Objetivo atingido quando…
              </label>
              <textarea
                value={config.goal_description || ""}
                onChange={(e) => update("goal_description", e.target.value)}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white min-h-[80px] focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
                placeholder="Ex: o lead aceitou agendar uma conversa ou pediu proposta"
              />
              <p className="text-[10px] text-[#475569]">
                Define quando a conversa sai pela saída OBJETIVO.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-[#94a3b8] uppercase">
                Máx. de turnos
              </label>
              <input
                type="number"
                min="1"
                max="30"
                value={config.max_turns ?? 8}
                onChange={(e) => update("max_turns", parseInt(e.target.value))}
                className="w-full bg-[#0d0d14] border border-[#2a2a3a] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#a855f7]"
              />
              <p className="text-[10px] text-[#475569]">
                Atingido o limite, a conversa sai pela saída LIMITE.
              </p>
            </div>

            <div className="flex items-center gap-2 p-3 bg-[#0d0d14] border border-[#2a2a3a] rounded-lg">
              <input
                type="checkbox"
                id="useHistory"
                checked={config.useHistory ?? true}
                onChange={(e) => update("useHistory", e.target.checked)}
                className="accent-[#a855f7]"
              />
              <label htmlFor="useHistory" className="text-xs text-[#cbd5e1]">
                Usar histórico da conversa como contexto
              </label>
            </div>
          </div>
        )}

        {![
          "trigger",
          "message",
          "wait",
          "espera",
          "delay",
          "condition",
          "condição",
          "condicao",
          "move_pipeline",
          "ai_agent",
        ].includes(type) && (
          <div className="p-4 bg-[#0d0d14] border border-dashed border-[#2a2a3a] rounded-lg">
            <p className="text-xs text-[#64748b] text-center italic">
              Configurações para este tipo de bloco serão disponibilizadas em breve.
            </p>
          </div>
        )}

        <button
          onClick={() => onDelete(node.id)}
          className="w-full mt-8 py-2 px-4 bg-red-500/10 border border-red-500/50 text-red-500 rounded-lg text-sm font-semibold hover:bg-red-500/20 transition-all"
        >
          Remover Bloco
        </button>
      </div>
    </aside>
  );
};
