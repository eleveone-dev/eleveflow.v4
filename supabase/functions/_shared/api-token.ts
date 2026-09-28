// Token de API de terceiros (Eleve Office). O token e nosso, nao JWT do Supabase:
// api_tokens guarda so o SHA-256, com a conta, os escopos e o limite. A conta sai
// daqui, nunca da requisicao. Deno-free: o Vitest importa este arquivo em Node.

import { sha256Hex } from "./hmac.ts";

export interface TokenResolvido {
  tokenId: string;
  userId: string;
  label: string;
  scopes: string[];
  rateLimitPerMinute: number;
}

export function tokenDoHeader(authorization: string | null): string | null {
  return /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "")?.[1] ?? null;
}

export async function resolveApiToken(
  client: { from: (table: string) => any },
  authorization: string | null,
): Promise<TokenResolvido | null> {
  const token = tokenDoHeader(authorization);
  if (!token) return null;

  const { data, error } = await client
    .from("api_tokens")
    .select("id, user_id, label, scopes, rate_limit_per_minute, revoked_at")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at) return null;

  return {
    tokenId: data.id,
    userId: data.user_id,
    label: data.label,
    scopes: data.scopes ?? [],
    rateLimitPerMinute: data.rate_limit_per_minute,
  };
}

/** Marca o uso, no maximo uma vez por minuto por token. */
export async function marcarUso(
  client: { from: (table: string) => any },
  tokenId: string,
  agora = new Date(),
): Promise<void> {
  const umMinutoAntes = new Date(agora.getTime() - 60_000).toISOString();
  const { error } = await client
    .from("api_tokens")
    .update({ last_used_at: agora.toISOString() })
    .eq("id", tokenId)
    .or(`last_used_at.is.null,last_used_at.lt.${umMinutoAntes}`);
  if (error) console.error(JSON.stringify({ event: "api_token_uso_falhou", error: error.message }));
}
