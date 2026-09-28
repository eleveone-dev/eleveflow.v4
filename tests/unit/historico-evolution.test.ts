import { describe, it, expect } from "vitest";
import {
  chaveTelefone,
  planejarImportacao,
  telefoneDoRegistro,
  type RegistroEvolution,
} from "../../scripts/lib/historico-evolution";

const CONTA = "conta-1";
const leadPorChave = new Map([[chaveTelefone("5527999998888"), "lead-1"]]);

const registro = (over: Partial<RegistroEvolution> = {}): RegistroEvolution => ({
  key: { id: "A1", fromMe: false, remoteJid: "5527999998888@s.whatsapp.net" },
  message: { conversation: "oi" },
  messageTimestamp: 1789000000,
  source: "android",
  ...over,
});

describe("chaveTelefone", () => {
  it("celular BR com e sem o nono digito da a mesma chave", () => {
    expect(chaveTelefone("5527999998888")).toBe(chaveTelefone("552799998888"));
  });

  it("numero que nao e celular BR fica como esta", () => {
    expect(chaveTelefone("14155550123")).toBe("14155550123");
  });
});

describe("telefoneDoRegistro", () => {
  it("jid de telefone vira digitos", () => {
    expect(telefoneDoRegistro({ remoteJid: "5527999998888@s.whatsapp.net" })).toBe("5527999998888");
  });

  it("@lid usa o remoteJidAlt; sem ele, vazio", () => {
    expect(
      telefoneDoRegistro({ remoteJid: "1@lid", remoteJidAlt: "5527999998888@s.whatsapp.net" }),
    ).toBe("5527999998888");
    expect(telefoneDoRegistro({ remoteJid: "1@lid" })).toBe("");
  });

  it("grupo e vazio", () => {
    expect(telefoneDoRegistro({ remoteJid: "120363000000000000@g.us" })).toBe("");
  });
});

describe("planejarImportacao", () => {
  const planejar = (registros: RegistroEvolution[], wamids: string[] = []) =>
    planejarImportacao(registros, leadPorChave, new Set(wamids), CONTA);

  it("recebida que falta entra com a data original", () => {
    const { inserir } = planejar([registro()]);
    expect(inserir).toEqual([
      {
        user_id: CONTA,
        lead_id: "lead-1",
        direction: "inbound",
        content: "oi",
        media_type: null,
        origin: null,
        status: "received",
        whatsapp_id: "A1",
        created_at: new Date(1789000000 * 1000).toISOString(),
      },
    ]);
  });

  it("audio recebido entra com o tipo e texto vazio", () => {
    const { inserir } = planejar([registro({ message: { audioMessage: { ptt: true } } })]);
    expect(inserir[0]).toMatchObject({ media_type: "audio", content: "" });
  });

  it("enviada pelo celular entra como business_app", () => {
    const { inserir } = planejar([
      registro({ key: { id: "B1", fromMe: true, remoteJid: "5527999998888@s.whatsapp.net" } }),
    ]);
    expect(inserir[0]).toMatchObject({
      direction: "outbound",
      origin: "business_app",
      status: null,
    });
  });

  it("enviada pela web que nao esta no CRM fica de fora como origem ambigua", () => {
    const { inserir, contagem } = planejar([
      registro({
        key: { id: "C1", fromMe: true, remoteJid: "5527999998888@s.whatsapp.net" },
        source: "web",
      }),
    ]);
    expect(inserir).toHaveLength(0);
    expect(contagem.origem_ambigua).toBe(1);
  });

  it("mensagem que o CRM ja tem e duplicada", () => {
    const { inserir, contagem } = planejar([registro()], ["A1"]);
    expect(inserir).toHaveLength(0);
    expect(contagem.duplicada).toBe(1);
  });

  it("o mesmo id duas vezes entra uma vez", () => {
    const { inserir, contagem } = planejar([registro(), registro()]);
    expect(inserir).toHaveLength(1);
    expect(contagem.duplicada).toBe(1);
  });

  it("conversa sem lead e protocolo ficam de fora", () => {
    const { inserir, contagem } = planejar([
      registro({ key: { id: "D1", fromMe: false, remoteJid: "5511000000000@s.whatsapp.net" } }),
      registro({
        key: { id: "E1", fromMe: false, remoteJid: "5527999998888@s.whatsapp.net" },
        message: { protocolMessage: {} },
      }),
    ]);
    expect(inserir).toHaveLength(0);
    expect(contagem).toMatchObject({ sem_lead: 1, tipo_ignorado: 1 });
  });

  it("registro sem id fica de fora", () => {
    const { inserir, contagem } = planejar([
      registro({ key: { fromMe: false, remoteJid: "5527999998888@s.whatsapp.net" } }),
    ]);
    expect(inserir).toHaveLength(0);
    expect(contagem.sem_id).toBe(1);
  });
});
