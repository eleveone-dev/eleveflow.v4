import { describe, expect, it } from "vitest";
import {
  calculateResponseRate,
  countDistinctLeadsForStages,
} from "../../src/lib/marketing-metrics";

describe("marketing metrics", () => {
  it("calcula a taxa com base nos leads efetivamente contatados no período", () => {
    expect(
      calculateResponseRate(
        ["lead-a", "lead-a", "lead-b", "lead-c"],
        ["lead-a", "lead-b", "lead-x"],
      ),
    ).toBe(67);
  });

  it("retorna zero quando não houve contato no período", () => {
    expect(calculateResponseRate([], ["lead-a"])).toBe(0);
  });

  it("conta leads únicos que entraram nas etapas selecionadas", () => {
    expect(
      countDistinctLeadsForStages(
        [
          { leadId: "lead-a", stageId: "interested" },
          { leadId: "lead-a", stageId: "interested" },
          { leadId: "lead-b", stageId: "demo" },
          { leadId: "lead-c", stageId: "won" },
        ],
        ["interested", "demo"],
      ),
    ).toBe(2);
  });
});
