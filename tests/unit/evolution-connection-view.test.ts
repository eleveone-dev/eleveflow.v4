import { describe, it, expect } from "vitest";
import {
  evolutionHeadline,
  evolutionLinks,
  type EvolutionState,
} from "../../src/lib/evolution-connection-view";

const base: EvolutionState = {
  configured: false,
  instance: null,
  exists: false,
  connected: false,
  providerState: null,
  webhookAt: null,
  checkedAt: "2026-09-18T12:00:00.000Z",
  error: null,
};

const estado = (patch: Partial<EvolutionState> = {}): EvolutionState => ({ ...base, ...patch });

const porId = (state: EvolutionState) =>
  Object.fromEntries(evolutionLinks(state).map((link) => [link.id, link]));

describe("evolutionLinks", () => {
  it("descreve a cadeia na ordem do pareamento", () => {
    expect(evolutionLinks(estado()).map((l) => l.id)).toEqual(["instance", "paired", "webhook"]);
  });

  it("sem instancia no servidor, o elo e ausencia de evidencia, nao falha", () => {
    // `missing` desenha contorno vazio; `failed` desenha marca cheia. Antes do
    // primeiro pareamento nada falhou — so nao existe ainda.
    expect(porId(estado()).instance.state).toBe("missing");
  });

  it("quando o servidor nao responde, nenhum elo afirma estado", () => {
    const links = porId(estado({ error: { message: "timeout" } }));
    expect(links.instance.state).toBe("unknown");
    expect(links.instance.provenance).toContain("timeout");
    expect(links.paired.state).toBe("unknown");
  });

  it("instancia criada e nao pareada mantem o elo seguinte sem evidencia", () => {
    const links = porId(estado({ exists: true, instance: "conta-a", providerState: "close" }));
    expect(links.instance.state).toBe("ok");
    expect(links.instance.provenance).toContain("conta-a");
    expect(links.paired.state).toBe("missing");
    expect(links.paired.provenance).toContain("close");
  });

  it("pareada cita o estado devolvido pela Evolution", () => {
    const links = porId(
      estado({ exists: true, connected: true, providerState: "open", instance: "conta-a" }),
    );
    expect(links.paired.state).toBe("ok");
    expect(links.paired.provenance).toContain("open");
  });

  it("webhook sem registro avisa que nada chega ao CRM", () => {
    const links = porId(estado({ exists: true, connected: true }));
    expect(links.webhook.state).toBe("missing");
    expect(links.webhook.provenance).toContain("CRM");
  });

  it("webhook registrado cita a data do registro", () => {
    const links = porId(
      estado({ exists: true, connected: true, webhookAt: "2026-09-18T10:30:00.000Z" }),
    );
    expect(links.webhook.state).toBe("ok");
    expect(links.webhook.provenance).toContain("2026");
  });
});

describe("evolutionHeadline", () => {
  it("erro do servidor vence qualquer outra leitura", () => {
    // O banco pode ter linha de conexao antiga; se a Evolution nao respondeu
    // agora, a tela nao tem o direito de dizer que esta conectada.
    const state = estado({ configured: true, connected: true, error: { message: "ECONNRESET" } });
    expect(evolutionHeadline(state).line).toContain("não respondeu");
  });

  it("sem instancia, diz que nenhum numero esta conectado", () => {
    expect(evolutionHeadline(estado()).line).toContain("Nenhum número");
  });

  it("instancia sem pareamento", () => {
    expect(evolutionHeadline(estado({ exists: true })).line).toContain("não pareado");
  });

  it("pareado sem webhook", () => {
    expect(evolutionHeadline(estado({ exists: true, connected: true })).line).toContain(
      "sem webhook",
    );
  });

  it("pareado com webhook", () => {
    const state = estado({
      exists: true,
      connected: true,
      webhookAt: "2026-09-18T10:30:00.000Z",
    });
    expect(evolutionHeadline(state).line).toContain("em uso");
  });
});
