import { describe, it, expect } from "vitest";
import openapi from "../../supabase/functions/office-api/openapi.json";
import { ROTAS } from "../../supabase/functions/_shared/office-api/rotas";

describe("openapi.json", () => {
  it("e OpenAPI 3.1 com Bearer", () => {
    expect(openapi.openapi).toMatch(/^3\.1/);
    expect(openapi.components.securitySchemes.bearer).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("documenta toda rota da tabela com os metodos dela, e nada alem", () => {
    const paths = openapi.paths as Record<string, Record<string, unknown>>;
    for (const rota of ROTAS) {
      expect(Object.keys(paths[rota.modelo] ?? {}).sort(), rota.modelo).toEqual(
        Object.keys(rota.metodos)
          .map((m) => m.toLowerCase())
          .sort(),
      );
    }
    expect(Object.keys(paths).sort()).toEqual(ROTAS.map((r) => r.modelo).sort());
  });

  it("toda operacao com escopo documenta sucesso, 401, 403, 429 e 500", () => {
    const paths = openapi.paths as Record<string, Record<string, any>>;
    for (const rota of ROTAS) {
      for (const [metodo, escopos] of Object.entries(rota.metodos)) {
        if (!escopos) continue;
        const respostas = paths[rota.modelo][metodo.toLowerCase()].responses;
        const nome = `${metodo} ${rota.modelo}`;
        expect(respostas["200"] ?? respostas["201"], nome).toBeTruthy();
        for (const status of ["401", "403", "429", "500"]) {
          expect(respostas[status], `${nome} ${status}`).toBeTruthy();
        }
      }
    }
  });

  it("escrita de tarefa documenta a chave, o If-Match e os erros de conflito", () => {
    const paths = openapi.paths as Record<string, Record<string, any>>;
    const parametros = (op: any) => JSON.stringify(op.parameters ?? []);
    expect(parametros(paths["/v1/tarefas"].post)).toContain("idempotencyKey");
    expect(paths["/v1/tarefas"].post.responses["201"]).toBeTruthy();
    for (const op of [paths["/v1/tarefas/{id}"].patch, paths["/v1/tarefas/{id}/entrega"].post]) {
      expect(parametros(op)).toContain("ifMatch");
      for (const status of ["400", "404", "409", "412", "428"]) {
        expect(op.responses[status], status).toBeTruthy();
      }
    }
  });

  it("toda operacao tem operationId unico, para gerar cliente", () => {
    const operacoes = Object.values(openapi.paths as Record<string, Record<string, any>>).flatMap(
      (path) => Object.values(path),
    );
    const ids = operacoes.map((op) => op.operationId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("todo $ref aponta para um schema que existe", () => {
    const refs = JSON.stringify(openapi).match(/#\/components\/[a-zA-Z]+\/[A-Za-z]+/g) ?? [];
    for (const ref of refs) {
      const [, , secao, nome] = ref.split("/");
      expect((openapi.components as Record<string, any>)[secao]?.[nome], ref).toBeTruthy();
    }
  });
});
