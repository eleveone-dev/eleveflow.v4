import { describe, it, expect } from "vitest";
import {
  buildAgentMessages,
  parseAgentResponse,
  AGENT_DEFAULTS,
} from "../../supabase/functions/_shared/agent-prompt.ts";

const lead = { name: "Ana", company: "Padaria Sol", phone: "5511999990001" };

describe("buildAgentMessages", () => {
  it("system contém guardrails fixos, regras, objetivo e formato JSON", () => {
    const msgs = buildAgentMessages(
      {
        prompt: "Qualifique {{nome}} da {{empresa}}",
        rules: "Não usar emojis\nMáximo 2 parágrafos",
        goal_description: "lead aceitou agendar uma conversa",
        maxChars: 300,
      },
      lead,
      [],
      { opening: true },
    );
    expect(msgs[0].role).toBe("system");
    const sys = String(msgs[0].content);
    expect(sys).toContain("Nunca invente preços");
    expect(sys).toContain("máximo 300 caracteres");
    expect(sys).toContain("Não usar emojis");
    expect(sys).toContain("lead aceitou agendar uma conversa");
    expect(sys).toContain('"decision"');
    expect(sys).toContain("Qualifique Ana da Padaria Sol");
    expect(sys).toContain("PRIMEIRA mensagem");
  });

  it("turno com histórico vira transcript LEAD/VOCÊ no user message", () => {
    const msgs = buildAgentMessages(
      {},
      lead,
      [
        { direction: "outbound", content: "Olá Ana!" },
        { direction: "inbound", content: "quem é?" },
      ],
      { opening: false },
    );
    const user = String(msgs[1].content);
    expect(user).toContain("VOCÊ: Olá Ana!");
    expect(user).toContain("LEAD: quem é?");
  });

  it("{{ultima_mensagem}} substitui pela última inbound", () => {
    const msgs = buildAgentMessages(
      { prompt: "Responda a: {{ultima_mensagem}}" },
      lead,
      [
        { direction: "inbound", content: "primeira" },
        { direction: "outbound", content: "oi" },
        { direction: "inbound", content: "qual o preço?" },
      ],
      { opening: false },
    );
    expect(String(msgs[0].content)).toContain("Responda a: qual o preço?");
  });

  it("defaults aplicados quando config vazia", () => {
    const msgs = buildAgentMessages({}, {}, [], { opening: true });
    expect(String(msgs[0].content)).toContain(`máximo ${AGENT_DEFAULTS.maxChars} caracteres`);
  });
});

describe("parseAgentResponse", () => {
  it("JSON puro válido", () => {
    expect(parseAgentResponse('{"reply":"Oi!","decision":"continue","reason":"abrir"}')).toEqual({
      reply: "Oi!",
      decision: "continue",
      reason: "abrir",
    });
  });

  it("JSON cercado de texto/markdown", () => {
    const raw = 'Claro! ```json\n{"reply":"Fechado","decision":"goal","reason":"aceitou"}\n```';
    expect(parseAgentResponse(raw)?.decision).toBe("goal");
  });

  it("decision inválida → null; continue sem reply → null; lixo → null", () => {
    expect(parseAgentResponse('{"reply":"x","decision":"limit","reason":""}')).toBeNull();
    expect(parseAgentResponse('{"reply":"","decision":"continue","reason":""}')).toBeNull();
    expect(parseAgentResponse("não sei")).toBeNull();
  });

  it("goal sem reply é aceito (despedida opcional)", () => {
    const r = parseAgentResponse('{"reply":"","decision":"goal","reason":"objetivo atingido"}');
    expect(r).toEqual({ reply: "", decision: "goal", reason: "objetivo atingido" });
  });
});
