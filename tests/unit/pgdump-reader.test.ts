import { describe, it, expect } from "vitest";
// @ts-expect-error: modulo .mjs de script, sem declaracao de tipos.
import { parseRow } from "../../scripts/pgdump-reader.mjs";

// No formato texto do COPY, barra invertida literal sai como `\\`, e os
// controles saem como `\t`, `\n`, `\r`. Decodificar em passes separados troca a
// ordem: o `\n` de dentro de `\\n` vira quebra de linha real.
describe("parseRow", () => {
  it("separa por tab e trata \\N como nulo", () => {
    expect(parseRow("1\t\\N\tb", ["a", "vazio", "c"])).toEqual({ a: "1", vazio: null, c: "b" });
  });

  it("decodifica os controles do COPY", () => {
    expect(parseRow("linha1\\nlinha2\\tcoluna\\rfim", ["x"]).x).toBe(
      "linha1\nlinha2\tcoluna\rfim",
    );
  });

  it("barra escapada seguida de letra continua sendo barra e letra", () => {
    // Dado `a\tb` com barra literal; no COPY sai `a\\tb`.
    expect(parseRow("a\\\\tb", ["x"]).x).toBe("a\\tb");
  });

  it("JSON com \\n dentro de string sobrevive e continua valido", () => {
    // jsonb {"m":"oi\nbom dia"}; no COPY sai {"m":"oi\\nbom dia"}.
    const { x } = parseRow('{"m":"oi\\\\nbom dia"}', ["x"]);
    expect(x).toBe('{"m":"oi\\nbom dia"}');
    expect(JSON.parse(x).m).toBe("oi\nbom dia");
  });

  it("barra escapada no fim do campo", () => {
    expect(parseRow("C:\\\\", ["x"]).x).toBe("C:\\");
  });
});
