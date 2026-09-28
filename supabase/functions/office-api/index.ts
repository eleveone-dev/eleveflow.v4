// API do Eleve Office: leitura comercial (parte B) e tarefas (parte C). Token
// proprio: a conta sai do token (api_tokens), nunca da requisicao. Specs:
// docs/specs/2026-09-25-api-leitura-comercial-office-design.md e
// docs/specs/2026-09-25-tarefas-office-design.md.
//
// Sem CORS de proposito: quem chama e o servidor do Eleve Office.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { HttpError } from "../_shared/http-error.ts";
import { marcarUso, resolveApiToken, type TokenResolvido } from "../_shared/api-token.ts";
import { atender } from "../_shared/office-api/atender.ts";
import { registrarChamada } from "../_shared/office-api/auditoria.ts";
import { corpoDeErro, ErroApi } from "../_shared/office-api/erros.ts";
import { verificarLimite } from "../_shared/office-api/limite.ts";
import { encontrarRota, metodoDaRota } from "../_shared/office-api/rotas.ts";
import { lerJson } from "../_shared/office-api/tarefas-corpo.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";
import openapi from "./openapi.json" with { type: "json" };

const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const erro = (status: number, mensagem: string, headers: Record<string, string> = {}) =>
  json(corpoDeErro(status, mensagem), status, headers);

serve(async (req) => {
  const inicio = Date.now();
  const client = createServiceRoleClient();
  const url = new URL(req.url);
  const rota = encontrarRota(url.pathname);
  let token: TokenResolvido | null = null;
  let status = 500;
  let itens: number | null = null;

  const responder = (resposta: Response, quantos: number | null = null) => {
    status = resposta.status;
    itens = quantos;
    return resposta;
  };

  try {
    if (!rota) return responder(erro(404, "rota inexistente"));
    const metodo = metodoDaRota(rota, req.method);
    if (!metodo) {
      const aceitos = Object.keys(rota.metodos).join(", ");
      return responder(erro(405, `a rota aceita ${aceitos}`, { Allow: aceitos }));
    }
    const escopos = rota.metodos[metodo];
    if (!escopos) return responder(json(openapi));

    token = await resolveApiToken(client, req.headers.get("authorization"));
    // Mesmo corpo para token ausente, errado e revogado.
    if (!token) return responder(erro(401, "token ausente, errado ou revogado"));
    const { scopes } = token;
    if (!escopos.some((escopo) => scopes.includes(escopo))) {
      return responder(erro(403, `a rota exige o escopo ${escopos.join(" ou ")}`));
    }

    const limite = await verificarLimite(client, token.tokenId, token.rateLimitPerMinute);
    if (!limite.ok) {
      return responder(
        erro(429, "limite de chamadas por minuto excedido", {
          "Retry-After": String(limite.retryAfter),
        }),
      );
    }

    const resposta = await atender(client, rota, {
      metodo,
      userId: token.userId,
      escopos: token.scopes,
      ator: `api:${token.label}`,
      query: url.searchParams,
      ifMatch: req.headers.get("if-match"),
      chave: req.headers.get("idempotency-key"),
      corpo: metodo === "GET" ? null : lerJson(await req.text()),
    });
    return responder(json(resposta.corpo, resposta.status), resposta.itens);
  } catch (error) {
    if (error instanceof HttpError) {
      const extra = error instanceof ErroApi ? error.extra : {};
      return responder(json(corpoDeErro(error.status, error.message, extra), error.status));
    }
    console.error(
      JSON.stringify({
        event: "office_api_erro",
        rota: rota?.modelo,
        metodo: req.method,
        user_id: token?.userId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return responder(erro(500, "falha interna"));
  } finally {
    if (rota && rota.nome !== "openapi") {
      await registrarChamada(client, {
        tokenId: token?.tokenId ?? null,
        userId: token?.userId ?? null,
        metodo: req.method,
        rota: rota.modelo,
        status,
        itens,
        duracaoMs: Date.now() - inicio,
      });
      if (token) await marcarUso(client, token.tokenId);
    }
  }
});
