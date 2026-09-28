// Fonte única de roteamento de blocos do motor de fluxos.
// Importado pelas edge functions (Deno) e pelos testes (Vitest/Node):
// não pode ter APIs Deno nem imports por URL.

export interface FlowBlock {
  id: string;
  type: string;
  position?: number | null;
  next_block_id?: string | null;
  config?: Record<string, unknown> | null;
}

export interface FlowEdge {
  id?: string;
  source?: string;
  target?: string;
  sourceHandle?: string | null;
}

export interface RouteResult {
  nextId: string | null;
  edgeId: string | null;
  via: string;
}

export const HANDLE_ALIASES: Record<string, string[]> = {
  true: ["true", "sim", "yes", "positive", "a"],
  false: ["false", "nao", "não", "no", "negative", "b"],
};

const isDefaultHandle = (h: unknown) =>
  h == null || h === "default" || h === "source" || h === "out";

export function findNextBlockId(
  currentBlock: FlowBlock,
  edges: FlowEdge[],
  output?: string,
): RouteResult {
  const currentId = currentBlock?.id;
  if (!currentId) return { nextId: null, edgeId: null, via: "no_current" };

  const outgoing = (edges || []).filter((e) => e?.source === currentId);

  if (output) {
    const wanted = HANDLE_ALIASES[output] ?? [output.toLowerCase()];
    const match = outgoing.find((e) =>
      wanted.includes(String(e?.sourceHandle ?? "").toLowerCase()),
    );
    if (match) {
      return {
        nextId: match.target ?? null,
        edgeId: match.id ?? null,
        via: `edges(handle=${output})`,
      };
    }
    const cfg = (currentBlock.config ?? {}) as Record<string, unknown>;
    const cfgNext =
      output === "true"
        ? cfg.next_if_true || cfg.sim || cfg.yes || cfg.positive
        : output === "false"
          ? cfg.next_if_false || cfg.nao || cfg.no || cfg.negative
          : cfg[`next_if_${output}`];
    if (cfgNext) {
      return { nextId: String(cfgNext), edgeId: null, via: `config.next_if_${output}` };
    }
    return { nextId: null, edgeId: null, via: "no_match" };
  }

  if (outgoing.length > 0) {
    const def = outgoing.find((e) => isDefaultHandle(e?.sourceHandle)) || outgoing[0];
    return { nextId: def.target ?? null, edgeId: def.id ?? null, via: "edges" };
  }

  if (currentBlock.next_block_id) {
    return { nextId: currentBlock.next_block_id, edgeId: null, via: "next_block_id" };
  }
  return { nextId: null, edgeId: null, via: "no_edges" };
}

export function findFallbackBlockId(currentBlock: FlowBlock, blocks: FlowBlock[]): string | null {
  if (!currentBlock) return null;
  if (currentBlock.next_block_id && blocks.some((b) => b.id === currentBlock.next_block_id)) {
    return currentBlock.next_block_id;
  }
  const pos = Number(currentBlock.position ?? -1);
  return (
    (blocks || [])
      .filter((b) => b.id !== currentBlock.id && Number(b.position ?? -1) > pos)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))[0]?.id || null
  );
}

export function resolveExistingNextBlockId(
  currentBlock: FlowBlock,
  blocks: FlowBlock[],
  edges: FlowEdge[],
  output?: string,
): RouteResult {
  const resolved = findNextBlockId(currentBlock, edges, output);
  if (resolved.nextId && blocks.some((b) => b.id === resolved.nextId)) return resolved;

  const currentId = currentBlock?.id;
  const outgoing = (edges || []).filter(
    (e) => e?.source === currentId && blocks.some((b) => b.id === e?.target),
  );
  if (outgoing.length > 0 && currentBlock?.type !== "condition") {
    const valid = outgoing.find((e) => isDefaultHandle(e?.sourceHandle)) || outgoing[0];
    return {
      nextId: valid.target ?? null,
      edgeId: valid.id ?? null,
      via: "edges_valid_fallback",
    };
  }
  if (currentBlock?.type !== "condition" && currentBlock?.type !== "trigger") {
    return { nextId: null, edgeId: resolved.edgeId, via: `${resolved.via}_missing_target` };
  }
  const fallback = findFallbackBlockId(currentBlock, blocks);
  if (fallback) {
    return {
      nextId: fallback,
      edgeId: resolved.edgeId,
      via: `${resolved.via}_fallback_position`,
    };
  }
  return resolved;
}

// Blocos que mandam mensagem ao lead assim que o motor chega neles.
const SPEAKING_TYPES = new Set(["message", "ai_agent"]);
// Blocos que não falam nem esperam: o motor passa por eles e segue pela saída
// padrão no mesmo instante.
const SILENT_TYPES = new Set(["move_pipeline", "objection"]);

/**
 * O primeiro bloco que vai falar com o lead a partir de `startId`, sem espera no
 * meio. Atravessa blocos silenciosos pela saída padrão; para em espera, condição,
 * fim ou qualquer outro tipo, e aí devolve null.
 *
 * Serve à saída do agente de IA: se o caminho da saída já fala, quem encerra a
 * conversa é o fluxo, e a resposta improvisada do agente não é enviada.
 */
export function findSpeakingBlockAhead(
  startId: string,
  blocks: FlowBlock[],
  edges: FlowEdge[],
): FlowBlock | null {
  const visited = new Set<string>();
  let current = (blocks || []).find((b) => b.id === startId) ?? null;
  while (current && !visited.has(current.id)) {
    if (SPEAKING_TYPES.has(current.type)) return current;
    if (!SILENT_TYPES.has(current.type)) return null;
    visited.add(current.id);
    const nextId = resolveExistingNextBlockId(current, blocks, edges).nextId;
    current = nextId ? ((blocks || []).find((b) => b.id === nextId) ?? null) : null;
  }
  return null;
}

/**
 * Todos os blocos ligados na mesma saída, o principal na frente.
 *
 * O editor deixa pendurar mais de um bloco na mesma saída, e o motor seguia só a
 * primeira ligação. No fluxo "Agente de IA — Abordagem" a saída Objetivo estava
 * ligada em mensagem E em mover etapa: a mensagem saía e o lead nunca era movido.
 *
 * Só irmãos da MESMA saída entram: `true` e `false` da condição continuam sendo
 * caminhos excludentes. Caminho que não veio de edge (config.next_if_* ou
 * next_block_id legado) não tem irmão.
 */
export function findAllNextBlockIds(
  currentBlock: FlowBlock,
  blocks: FlowBlock[],
  edges: FlowEdge[],
  output?: string,
): string[] {
  const principal = resolveExistingNextBlockId(currentBlock, blocks, edges, output);
  if (!principal.nextId) return [];
  const ids = [principal.nextId];

  const currentId = currentBlock?.id;
  const outgoing = (edges || []).filter(
    (e) => e?.source === currentId && blocks.some((b) => b.id === e?.target),
  );
  const principalEdge =
    outgoing.find((e) => e?.id && e.id === principal.edgeId) ??
    outgoing.find((e) => e?.target === principal.nextId);
  if (!principalEdge) return ids;

  const wanted = output ? (HANDLE_ALIASES[output] ?? [output.toLowerCase()]) : null;
  const mesmaSaida = (handle: unknown) => {
    if (wanted) return wanted.includes(String(handle ?? "").toLowerCase());
    if (isDefaultHandle(principalEdge.sourceHandle)) return isDefaultHandle(handle);
    return (
      String(handle ?? "").toLowerCase() ===
      String(principalEdge.sourceHandle ?? "").toLowerCase()
    );
  };

  for (const edge of outgoing) {
    if (edge === principalEdge || !edge?.target) continue;
    if (ids.includes(edge.target) || !mesmaSaida(edge.sourceHandle)) continue;
    ids.push(edge.target);
  }
  return ids;
}
