// API de leitura do Eleve Sales Coach: GET com token proprio, que devolve o
// retrato comercial da conta dona do token. Spec:
// docs/specs/2026-09-23-sales-coach-api-design.md.
//
// Sem CORS de proposito: quem chama e o servidor do Eleve Office, nunca um
// navegador. O token nao e JWT do Supabase (verify_jwt = false no config.toml):
// vem de api_tokens, com o escopo comercial:leitura.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { HttpError } from "../_shared/http-error.ts";
import { marcarUso, resolveApiToken, type TokenResolvido } from "../_shared/api-token.ts";
import { registrarChamada } from "../_shared/office-api/auditoria.ts";
import { parseCoachParams } from "../_shared/sales-coach.ts";
import { createServiceRoleClient } from "../_shared/supabase.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const inicio = Date.now();
  const client = createServiceRoleClient();
  let token: TokenResolvido | null = null;
  let status = 500;

  try {
    token = await resolveApiToken(client, req.headers.get("authorization"));
    // Mesmo corpo para token ausente, errado ou sem o escopo: o contrato do
    // sales-coach so conhece 401.
    if (!token || !token.scopes.includes("comercial:leitura")) {
      token = null;
      return json({ error: "Unauthorized" }, 401);
    }

    const params = parseCoachParams(new URL(req.url).searchParams);
    const { data, error } = await client.rpc("sales_coach_snapshot", {
      p_user_id: token.userId,
      p_periodo_dias: params.periodo_dias,
      p_parado_dias: params.parado_dias,
      p_followup_horas: params.followup_horas,
      p_limite: params.limite,
    });
    if (error) throw new Error(error.message);

    console.log(
      JSON.stringify({
        event: "sales_coach_snapshot",
        user_id: token.userId,
        totais: data.totais,
        limite: params.limite,
        ms: Date.now() - inicio,
      }),
    );
    status = 200;
    return json(data);
  } catch (error) {
    if (error instanceof HttpError) {
      status = error.status;
      return json({ error: error.message }, error.status);
    }
    console.error(
      JSON.stringify({
        event: "sales_coach_error",
        user_id: token?.userId ?? null,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - inicio,
      }),
    );
    return json({ error: "Internal error" }, 500);
  } finally {
    if (token) {
      await registrarChamada(client, {
        tokenId: token.tokenId,
        userId: token.userId,
        metodo: "GET",
        rota: "/sales-coach",
        status,
        itens: null,
        duracaoMs: Date.now() - inicio,
      });
      await marcarUso(client, token.tokenId);
    }
  }
});
