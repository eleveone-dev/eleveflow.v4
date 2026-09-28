import { describe, it, expect } from "vitest";
import {
  findNextBlockId,
  findFallbackBlockId,
  resolveExistingNextBlockId,
  findSpeakingBlockAhead,
  findAllNextBlockIds,
  type FlowBlock,
  type FlowEdge,
} from "../../supabase/functions/_shared/flow-routing";

const b = (id: string, type = "message", extra: Partial<FlowBlock> = {}): FlowBlock => ({
  id,
  type,
  ...extra,
});

describe("findNextBlockId", () => {
  it("segue edge com handle default/null", () => {
    const edges: FlowEdge[] = [{ id: "e1", source: "a", target: "b", sourceHandle: null }];
    const r = findNextBlockId(b("a"), edges);
    expect(r).toEqual({ nextId: "b", edgeId: "e1", via: "edges" });
  });

  it("condition true casa aliases de handle (sim/yes/a)", () => {
    const edges: FlowEdge[] = [
      { id: "e-no", source: "c", target: "x", sourceHandle: "nao" },
      { id: "e-yes", source: "c", target: "y", sourceHandle: "SIM" },
    ];
    const r = findNextBlockId(b("c", "condition"), edges, "true");
    expect(r.nextId).toBe("y");
    expect(r.via).toBe("edges(handle=true)");
  });

  it("condition false casa aliases (não/no/b)", () => {
    const edges: FlowEdge[] = [{ id: "e2", source: "c", target: "x", sourceHandle: "não" }];
    const r = findNextBlockId(b("c", "condition"), edges, "false");
    expect(r.nextId).toBe("x");
  });

  it("condition sem edge do handle usa config.next_if_true/false", () => {
    const block = b("c", "condition", { config: { next_if_false: "z" } });
    const r = findNextBlockId(block, [], "false");
    expect(r).toEqual({ nextId: "z", edgeId: null, via: "config.next_if_false" });
  });

  it("handle custom (fase B: goal/giveup/limit) casa por igualdade", () => {
    const edges: FlowEdge[] = [{ id: "e3", source: "ai", target: "g", sourceHandle: "goal" }];
    const r = findNextBlockId(b("ai", "ai_agent"), edges, "goal");
    expect(r.nextId).toBe("g");
  });

  it("sem edges cai no next_block_id legado", () => {
    const r = findNextBlockId(b("a", "message", { next_block_id: "n" }), []);
    expect(r).toEqual({ nextId: "n", edgeId: null, via: "next_block_id" });
  });

  it("sem nada retorna null", () => {
    expect(findNextBlockId(b("a"), []).nextId).toBeNull();
  });

  it("bloco sem id retorna no_current", () => {
    const r = findNextBlockId({ id: "", type: "message" }, []);
    expect(r).toEqual({ nextId: null, edgeId: null, via: "no_current" });
  });

  it("output sem edge nem config retorna no_match", () => {
    const r = findNextBlockId(b("c", "condition"), [], "true");
    expect(r).toEqual({ nextId: null, edgeId: null, via: "no_match" });
  });

  it("config true aceita aliases sim/yes/positive", () => {
    expect(findNextBlockId(b("c", "condition", { config: { sim: "s1" } }), [], "true").nextId).toBe(
      "s1",
    );
    expect(findNextBlockId(b("c", "condition", { config: { yes: "s2" } }), [], "true").nextId).toBe(
      "s2",
    );
    expect(
      findNextBlockId(b("c", "condition", { config: { positive: "s3" } }), [], "true").nextId,
    ).toBe("s3");
  });

  it("config false aceita aliases nao/no/negative", () => {
    expect(
      findNextBlockId(b("c", "condition", { config: { nao: "n1" } }), [], "false").nextId,
    ).toBe("n1");
    expect(
      findNextBlockId(b("c", "condition", { config: { negative: "n2" } }), [], "false").nextId,
    ).toBe("n2");
  });

  it("output custom cai em config.next_if_<output>", () => {
    const block = b("ai", "ai_agent", { config: { next_if_goal: "g9" } });
    const r = findNextBlockId(block, [], "goal");
    expect(r).toEqual({ nextId: "g9", edgeId: null, via: "config.next_if_goal" });
  });

  it("edges sem handle default pega a primeira", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "a", target: "x", sourceHandle: "esquisito" },
      { id: "e2", source: "a", target: "y", sourceHandle: "outro" },
    ];
    const r = findNextBlockId(b("a"), edges);
    expect(r.nextId).toBe("x");
    expect(r.via).toBe("edges");
  });
});

describe("findFallbackBlockId", () => {
  it("usa next_block_id quando o alvo existe", () => {
    const blocks = [
      b("a", "trigger", { next_block_id: "b", position: 0 }),
      b("b", "message", { position: 1 }),
    ];
    expect(findFallbackBlockId(blocks[0], blocks)).toBe("b");
  });

  it("cai para o próximo por position quando next_block_id não existe", () => {
    const blocks = [
      b("a", "trigger", { next_block_id: "morto", position: 0 }),
      b("c", "message", { position: 5 }),
      b("b", "message", { position: 2 }),
    ];
    expect(findFallbackBlockId(blocks[0], blocks)).toBe("b");
  });

  it("retorna null sem candidatos", () => {
    expect(
      findFallbackBlockId(b("a", "end", { position: 9 }), [b("a", "end", { position: 9 })]),
    ).toBeNull();
  });
});

describe("resolveExistingNextBlockId", () => {
  const blocks = [
    b("t", "trigger", { position: 0 }),
    b("m1", "message", { position: 1 }),
    b("m2", "message", { position: 2 }),
    b("c", "condition", { position: 3 }),
  ];

  it("retorna alvo quando existe na lista de blocks", () => {
    const edges: FlowEdge[] = [{ id: "e1", source: "m1", target: "m2" }];
    expect(resolveExistingNextBlockId(blocks[1], blocks, edges).nextId).toBe("m2");
  });

  it("edge para bloco removido: usa outra edge válida (não-condition)", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "m1", target: "fantasma" },
      { id: "e2", source: "m1", target: "m2", sourceHandle: "out" },
    ];
    const r = resolveExistingNextBlockId(blocks[1], blocks, edges);
    expect(r.nextId).toBe("m2");
    expect(r.via).toBe("edges_valid_fallback");
  });

  it("condition com alvo removido cai no fallback por posição", () => {
    const cond = b("c", "condition", { position: 1 });
    const all = [cond, b("m2", "message", { position: 2 })];
    const edges: FlowEdge[] = [{ id: "e1", source: "c", target: "fantasma", sourceHandle: "sim" }];
    const r = resolveExistingNextBlockId(cond, all, edges, "true");
    expect(r.nextId).toBe("m2");
    expect(r.via).toContain("fallback_position");
  });

  it("message sem alvo válido retorna null (não inventa caminho)", () => {
    const edges: FlowEdge[] = [{ id: "e1", source: "m2", target: "fantasma" }];
    const r = resolveExistingNextBlockId(blocks[2], blocks, edges);
    expect(r.nextId).toBeNull();
    expect(r.via).toContain("missing_target");
  });

  it("trigger sem edges cai no fallback por posição", () => {
    const trig = b("t", "trigger", { position: 0 });
    const all = [trig, b("m1", "message", { position: 1 })];
    const r = resolveExistingNextBlockId(trig, all, []);
    expect(r.nextId).toBe("m1");
    expect(r.via).toContain("fallback_position");
  });

  it("condition sem nada devolve o resolved original (sem fallback)", () => {
    const cond = b("c", "condition", { position: 9 });
    const r = resolveExistingNextBlockId(cond, [cond], [], "true");
    expect(r.nextId).toBeNull();
    expect(r.via).toBe("no_match");
  });

  it("condition prefere edge válida do handle sobre fallback", () => {
    const cond = b("c", "condition", { position: 0 });
    const all = [cond, b("y", "message", { position: 1 }), b("n", "message", { position: 2 })];
    const edges: FlowEdge[] = [
      { id: "ey", source: "c", target: "y", sourceHandle: "sim" },
      { id: "en", source: "c", target: "n", sourceHandle: "nao" },
    ];
    expect(resolveExistingNextBlockId(cond, all, edges, "true").nextId).toBe("y");
    expect(resolveExistingNextBlockId(cond, all, edges, "false").nextId).toBe("n");
  });
});

describe("findSpeakingBlockAhead", () => {
  // A saída do agente leva a um bloco que manda mensagem ao lead? Se sim, é o
  // fluxo que encerra a conversa, e a resposta improvisada do agente não sai —
  // senão o lead recebe duas mensagens seguidas.
  const e = (source: string, target: string): FlowEdge => ({ id: `${source}-${target}`, source, target });

  it("saída direto numa mensagem: a mensagem fala", () => {
    const blocks = [b("m", "message"), b("fim", "end")];
    expect(findSpeakingBlockAhead("m", blocks, [e("m", "fim")])?.id).toBe("m");
  });

  it("atravessa bloco silencioso (mover etapa, objeção) até a mensagem", () => {
    const blocks = [b("mv", "move_pipeline"), b("ob", "objection"), b("m", "message")];
    const edges = [e("mv", "ob"), e("ob", "m")];
    expect(findSpeakingBlockAhead("mv", blocks, edges)?.id).toBe("m");
  });

  it("outro agente também fala: ele abre a conversa", () => {
    const blocks = [b("mv", "move_pipeline"), b("ag", "ai_agent")];
    expect(findSpeakingBlockAhead("mv", blocks, [e("mv", "ag")])?.id).toBe("ag");
  });

  it("caminho que termina sem mensagem: ninguém fala", () => {
    const blocks = [b("mv", "move_pipeline"), b("fim", "end")];
    expect(findSpeakingBlockAhead("mv", blocks, [e("mv", "fim")])).toBeNull();
  });

  it("espera antes da mensagem: a mensagem não sai junto com a do agente", () => {
    const blocks = [b("w", "wait"), b("m", "message")];
    expect(findSpeakingBlockAhead("w", blocks, [e("w", "m")])).toBeNull();
  });

  it("condição não é seguida: o ramo depende do lead", () => {
    const blocks = [b("c", "condition"), b("m", "message")];
    expect(findSpeakingBlockAhead("c", blocks, [e("c", "m")])).toBeNull();
  });

  it("bloco silencioso sem saída: ninguém fala", () => {
    expect(findSpeakingBlockAhead("mv", [b("mv", "move_pipeline")], [])).toBeNull();
  });

  it("ciclo de blocos silenciosos não trava", () => {
    const blocks = [b("a", "move_pipeline"), b("z", "move_pipeline")];
    expect(findSpeakingBlockAhead("a", blocks, [e("a", "z"), e("z", "a")])).toBeNull();
  });

  it("bloco inexistente: ninguém fala", () => {
    expect(findSpeakingBlockAhead("fantasma", [b("m", "message")], [])).toBeNull();
  });
});

describe("findAllNextBlockIds", () => {
  // A mesma saída ligada em mais de um bloco: o motor tem que rodar todos os
  // ramos. Antes pegava só a primeira ligação, e o "mover etapa" pendurado na
  // saída Objetivo do agente nunca acontecia.
  const blocks = [
    b("ag", "ai_agent"),
    b("msg", "message"),
    b("mv", "move_pipeline"),
    b("fim", "end"),
  ];

  it("uma ligação: só ela", () => {
    const edges: FlowEdge[] = [{ id: "e1", source: "msg", target: "fim" }];
    expect(findAllNextBlockIds(blocks[1], blocks, edges)).toEqual(["fim"]);
  });

  it("duas ligações na mesma saída nomeada: as duas, a primeira na frente", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "ag", target: "msg", sourceHandle: "goal" },
      { id: "e2", source: "ag", target: "mv", sourceHandle: "goal" },
      { id: "e3", source: "ag", target: "fim", sourceHandle: "giveup" },
    ];
    expect(findAllNextBlockIds(blocks[0], blocks, edges, "goal")).toEqual(["msg", "mv"]);
  });

  it("saída sem nome ligada em dois blocos: as duas", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "msg", target: "mv" },
      { id: "e2", source: "msg", target: "fim" },
    ];
    expect(findAllNextBlockIds(blocks[1], blocks, edges)).toEqual(["mv", "fim"]);
  });

  it("não mistura saídas diferentes", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "ag", target: "msg", sourceHandle: "goal" },
      { id: "e2", source: "ag", target: "mv", sourceHandle: "giveup" },
    ];
    expect(findAllNextBlockIds(blocks[0], blocks, edges, "giveup")).toEqual(["mv"]);
  });

  it("condição: aliases do mesmo lado contam como a mesma saída", () => {
    const cond = b("c", "condition");
    const all = [cond, ...blocks];
    const edges: FlowEdge[] = [
      { id: "e1", source: "c", target: "msg", sourceHandle: "sim" },
      { id: "e2", source: "c", target: "mv", sourceHandle: "true" },
      { id: "e3", source: "c", target: "fim", sourceHandle: "nao" },
    ];
    expect(findAllNextBlockIds(cond, all, edges, "true")).toEqual(["msg", "mv"]);
  });

  it("ligação para bloco removido não entra", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "msg", target: "mv" },
      { id: "e2", source: "msg", target: "fantasma" },
    ];
    expect(findAllNextBlockIds(blocks[1], blocks, edges)).toEqual(["mv"]);
  });

  it("duas ligações para o mesmo bloco: uma vez só", () => {
    const edges: FlowEdge[] = [
      { id: "e1", source: "msg", target: "fim" },
      { id: "e2", source: "msg", target: "fim" },
    ];
    expect(findAllNextBlockIds(blocks[1], blocks, edges)).toEqual(["fim"]);
  });

  it("sem edges, next_block_id legado não tem irmão", () => {
    const msg = b("msg", "message", { next_block_id: "fim" });
    expect(findAllNextBlockIds(msg, [msg, b("fim", "end")], [])).toEqual(["fim"]);
  });

  it("sem caminho nenhum: vazio", () => {
    expect(findAllNextBlockIds(blocks[3], blocks, [])).toEqual([]);
  });
});
