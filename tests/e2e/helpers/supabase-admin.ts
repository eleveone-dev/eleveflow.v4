import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required E2E environment variable: ${names.join(" or ")}`);
}

/**
 * Modern Supabase secret keys (`sb_secret_...`) are API keys, not JWTs. The
 * JavaScript client adds `Authorization: Bearer <key>` by default, which the
 * platform correctly rejects for those keys. Preserve real user JWTs but drop
 * only that synthetic bearer header.
 */
export function apiKeyFetch(apiKey: string): typeof fetch {
  return async (input, init) => {
    const inputHeaders = input instanceof Request ? input.headers : undefined;
    const headers = new Headers(inputHeaders);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("apikey", apiKey);
    if (headers.get("Authorization") === `Bearer ${apiKey}`) {
      headers.delete("Authorization");
    }
    return fetch(input, { ...init, headers });
  };
}

export function stagingUrl(): string {
  return requiredEnv("VITE_SUPABASE_URL");
}

export function stagingServiceKey(): string {
  return requiredEnv("STAGING_SUPABASE_SECRET_KEY", "STAGING_SERVICE_ROLE_KEY");
}

export function stagingPublishableKey(): string {
  return requiredEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_ANON_KEY");
}

export function createStagingAdminClient(): SupabaseClient {
  const apiKey = stagingServiceKey();
  return createClient(stagingUrl(), apiKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: apiKeyFetch(apiKey) },
  });
}
