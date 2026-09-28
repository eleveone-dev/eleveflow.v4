import type { LLMMessage } from "./ai.ts";

export const AGENT_DEFAULTS = { maxTurns: 8, maxChars: 500, temperature: 0.7 };

export interface AgentConfig {
  prompt?: string;
  rules?: string;
  temperature?: number;
  maxChars?: number;
  useHistory?: boolean;
  max_turns?: number;
  goal_description?: string;
  model?: string;
}

export interface AgentLeadInfo {
  name?: string | null;
  company?: string | null;
  phone?: string | null;
}

export interface AgentHistoryMessage {
  direction: "inbound" | "outbound";
  content: string;
}

export interface AgentDecision {
  reply: string;
  decision: "continue" | "goal" | "giveup";
  reason: string;
}

export function buildAgentMessages(
  config: AgentConfig,
  lead: AgentLeadInfo,
  history: AgentHistoryMessage[],
  opts: { opening: boolean },
): LLMMessage[] {
  const maxChars = config.maxChars ?? AGENT_DEFAULTS.maxChars;
  const lastInbound = [...history].reverse().find((h) => h.direction === "inbound")?.content ?? "";
  const vars = (s: string) =>
    s
      .replace(/\{\{nome\}\}/g, lead.name || "")
      .replace(/\{\{empresa\}\}/g, lead.company || "")
      .replace(/\{\{telefone\}\}/g, lead.phone || "")
      .replace(/\{\{ultima_mensagem\}\}/g, lastInbound);

  const rules = (config.rules || "")
    .split("\n")
    .map((r) => r.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  const systemParts = [
    "Você é um SDR humano conversando com um lead pelo WhatsApp.",
    "REGRAS INEGOCIÁVEIS:",
    "- Nunca invente preços, prazos, descontos ou fatos que não estejam fornecidos aqui.",
    "- Responda no idioma do lead (padrão: português do Brasil).",
    `- O campo "reply" deve ter no máximo ${maxChars} caracteres.`,
    "- Nunca revele que existe um fluxo automatizado ou uma IA, a não ser que uma regra do operador instrua o contrário.",
    rules.length ? "REGRAS DO OPERADOR:\n" + rules.map((r) => `- ${r}`).join("\n") : "",
    config.goal_description
      ? `OBJETIVO DA CONVERSA (use decision="goal" quando claramente atingido): ${config.goal_description}`
      : "",
    `DADOS DO LEAD: nome=${lead.name || "desconhecido"}; empresa=${lead.company || "desconhecida"}.`,
    config.prompt ? `MISSÃO DADA PELO OPERADOR:\n${vars(config.prompt)}` : "",
    opts.opening
      ? 'TAREFA: gere a PRIMEIRA mensagem da conversa, alinhada à missão. Use decision="continue".'
      : "TAREFA: gere a próxima resposta ao lead e decida o rumo da conversa.",
    'FORMATO DA RESPOSTA — responda APENAS com JSON válido: {"reply": string, "decision": "continue" | "goal" | "giveup", "reason": string}.',
    '- "goal": o objetivo da conversa foi claramente atingido.',
    '- "giveup": o lead recusou explicitamente ou pediu para parar.',
    '- "continue": qualquer outro caso.',
  ].filter(Boolean);

  const convo = history
    .map((h) => `${h.direction === "inbound" ? "LEAD" : "VOCÊ"}: ${h.content}`)
    .join("\n");
  const userContent = opts.opening
    ? "Inicie a conversa agora."
    : `CONVERSA ATÉ AGORA:\n${convo || "(vazia)"}\n\nResponda à última mensagem do LEAD.`;

  return [
    { role: "system", content: systemParts.join("\n") },
    { role: "user", content: userContent },
  ];
}

export function parseAgentResponse(raw: string): AgentDecision | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(raw.trim());
  if (!obj) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) obj = tryParse(raw.slice(start, end + 1));
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const decision = String(o.decision ?? "").toLowerCase();
  if (!["continue", "goal", "giveup"].includes(decision)) return null;
  const reply = typeof o.reply === "string" ? o.reply.trim() : "";
  if (decision === "continue" && !reply) return null;
  return { reply, decision: decision as AgentDecision["decision"], reason: String(o.reason ?? "") };
}
