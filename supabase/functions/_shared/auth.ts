import { createClient } from "https://esm.sh/@supabase/supabase-js@2.107.0";
import { HttpError } from "./http-error.ts";
import { constantTimeEqual } from "./hmac.ts";
import { assertSuperadmin, isSuperadmin } from "./platform-role.ts";

/**
 * Authentication helpers shared by Edge Functions.
 *
 * These functions intentionally do not infer that an invalid/missing user JWT is
 * an internal request. Internal callers must present the project's service-role
 * key in `apikey`; all other callers must have a real Auth user.
 */

export type RequestActor = { kind: "user"; userId: string } | { kind: "service_role" };

export { HttpError };

export function getSupabaseUrl(): string {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  if (!url) throw new HttpError(500, "SUPABASE_URL is not configured");
  return url;
}

function readNamedApiKey(environmentName: string): string | null {
  const raw = Deno.env.get(environmentName)?.trim();
  if (!raw) return null;

  try {
    const keys = JSON.parse(raw);
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) return null;
    const defaultKey = (keys as Record<string, unknown>).default;
    if (typeof defaultKey === "string" && defaultKey.trim()) return defaultKey.trim();

    for (const value of Object.values(keys as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // A malformed map must not be interpreted as a key. The caller returns a
    // deterministic configuration error instead of falling back to anonymous.
  }

  return null;
}

function readLegacyApiKey(...names: string[]): string | null {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function readApiKey(namedEnvironment: string, legacyNames: string[]): string | null {
  // Hosted Supabase injects named key maps. When present, prefer that source so
  // a migration to sb_publishable_/sb_secret_ cannot silently keep old keys.
  if (Deno.env.get(namedEnvironment)?.trim()) return readNamedApiKey(namedEnvironment);
  return readLegacyApiKey(...legacyNames);
}

export function getPublishableKey(): string {
  const key = readApiKey("SUPABASE_PUBLISHABLE_KEYS", [
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
  ]);
  if (!key) throw new HttpError(500, "Supabase publishable key is not configured");
  return key;
}

function readServiceRoleKey(): string | null {
  return readApiKey("SUPABASE_SECRET_KEYS", ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
}

function isLegacyJwtApiKey(value: string): boolean {
  return value.startsWith("eyJ") && value.split(".").length === 3;
}

/** Returns the key used by trusted workers and function-to-function requests. */
export function getServiceRoleKey(): string {
  const key = readServiceRoleKey();
  if (!key) throw new HttpError(500, "Supabase service role key is not configured");
  return key;
}

function getInternalFunctionSecret(): string | null {
  const secret = Deno.env.get("INTERNAL_FUNCTION_SECRET")?.trim() || "";
  return secret.length >= 32 ? secret : null;
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Resolves a caller as either a signed-in user or the service role. Never turn a
 * failed user verification into an internal call: that was the prior auth bypass.
 */
export async function getRequestActor(req: Request): Promise<RequestActor> {
  const bearerToken = getBearerToken(req);
  const apiKey = req.headers.get("apikey")?.trim() || null;
  const internalHeader = req.headers.get("x-internal-function-secret")?.trim() || null;
  const internalSecret = getInternalFunctionSecret();
  const serviceRoleKey = readServiceRoleKey();

  if (internalHeader && !internalSecret) {
    throw new HttpError(
      503,
      "INTERNAL_FUNCTION_SECRET must be configured with at least 32 characters",
    );
  }
  if (internalHeader && internalSecret && constantTimeEqual(internalHeader, internalSecret)) {
    return { kind: "service_role" };
  }

  if (
    (apiKey && serviceRoleKey && constantTimeEqual(apiKey, serviceRoleKey)) ||
    (bearerToken &&
      serviceRoleKey &&
      isLegacyJwtApiKey(serviceRoleKey) &&
      constantTimeEqual(bearerToken, serviceRoleKey))
  ) {
    return { kind: "service_role" };
  }

  if (!bearerToken) {
    throw new HttpError(401, "Authentication is required");
  }

  const client = createClient(getSupabaseUrl(), getPublishableKey());
  const {
    data: { user },
    error,
  } = await client.auth.getUser(bearerToken);
  if (error || !user) {
    throw new HttpError(401, "Invalid authentication token");
  }

  return { kind: "user", userId: user.id };
}

export { generateWebhookVerifyToken } from "./platform-role.ts";

/** Gate das operações administrativas da plataforma (config global da Meta). */
export async function requireSuperadmin(
  req: Request,
): Promise<{ userId: string; email: string | null }> {
  const bearerToken = getBearerToken(req);
  if (!bearerToken) throw new HttpError(401, "Authentication is required");

  const client = createClient(getSupabaseUrl(), getPublishableKey());
  const {
    data: { user },
    error,
  } = await client.auth.getUser(bearerToken);
  if (error || !user) throw new HttpError(401, "Invalid authentication token");

  assertSuperadmin(user);
  return { userId: user.id, email: user.email ?? null };
}

/**
 * Usuario autenticado mais o papel de plataforma, numa unica verificacao de
 * token. Existe porque o whatsapp-proxy precisa SABER se quem chama e
 * superadmin, nao exigir que seja: sem isso ele teria de consultar uma tabela de
 * papeis, e este schema nao tem nenhuma — o papel vive em app_metadata.
 */
export async function getAuthUserWithPlatformRole(
  req: Request,
): Promise<{ userId: string; isSuperadmin: boolean }> {
  const bearerToken = getBearerToken(req);
  if (!bearerToken) throw new HttpError(401, "Authentication is required");

  const client = createClient(getSupabaseUrl(), getPublishableKey());
  const {
    data: { user },
    error,
  } = await client.auth.getUser(bearerToken);
  if (error || !user) throw new HttpError(401, "Invalid authentication token");

  return { userId: user.id, isSuperadmin: isSuperadmin(user) };
}

export function requireServiceRole(actor: RequestActor): void {
  if (actor.kind !== "service_role") {
    throw new HttpError(403, "This operation is restricted to internal workers");
  }
}

/**
 * Rejects a forged body.user_id and returns the tenant to use for the request.
 * Internal callers must still provide a validated resource owner before using a
 * caller-provided user id.
 */
export function resolveActorUserId(
  actor: RequestActor,
  resourceOwnerId: string,
  requestedUserId?: string | null,
): string {
  if (!resourceOwnerId) {
    throw new HttpError(404, "Resource owner was not found");
  }
  if (requestedUserId && requestedUserId !== resourceOwnerId) {
    throw new HttpError(403, "Resource tenant does not match user_id");
  }
  if (actor.kind === "user" && actor.userId !== resourceOwnerId) {
    throw new HttpError(403, "You do not own this resource");
  }
  return resourceOwnerId;
}

/** Fetches the owning tenant for tables with the standard id/user_id shape. */
export async function getResourceOwner(
  supabaseClient: any,
  table: string,
  resourceId: string,
): Promise<string> {
  if (!resourceId || typeof resourceId !== "string") {
    throw new HttpError(400, `A valid ${table} id is required`);
  }

  const { data, error } = await supabaseClient
    .from(table)
    .select("id, user_id")
    .eq("id", resourceId)
    .maybeSingle();

  if (error || !data?.user_id) {
    throw new HttpError(404, `${table} resource was not found`);
  }

  return data.user_id;
}

/** Validates the resource owner, preserving the legacy helper's public API. */
export async function validateOwnership(
  supabaseClient: any,
  table: string,
  resourceId: string,
  authenticatedUserId: string,
) {
  const ownerId = await getResourceOwner(supabaseClient, table, resourceId);
  if (ownerId !== authenticatedUserId) {
    throw new HttpError(403, `Unauthorized access to ${table} ${resourceId}`);
  }
  return true;
}

/**
 * Compatibility helper for any future caller that only accepts an Auth user.
 * Service-role callers are deliberately not represented as null/anonymous.
 */
export async function getAuthUser(req: Request): Promise<string> {
  const actor = await getRequestActor(req);
  if (actor.kind !== "user") {
    throw new HttpError(403, "A user session is required");
  }
  return actor.userId;
}

export function getHttpErrorStatus(error: unknown, fallback = 500): number {
  return error instanceof HttpError ? error.status : fallback;
}

export { assertLeadCanReceiveMarketing } from "./marketing-consent.ts";

/** Headers for calls made by one trusted Edge Function to another. */
export function internalAuthHeaders(): Record<string, string> {
  const key = getServiceRoleKey();
  const headers: Record<string, string> = {
    apikey: key,
  };
  const internalSecret = getInternalFunctionSecret();
  if (internalSecret) headers["x-internal-function-secret"] = internalSecret;
  return headers;
}
