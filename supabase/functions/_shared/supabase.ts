import { createClient } from "https://esm.sh/@supabase/supabase-js@2.107.0";
import { getPublishableKey, getServiceRoleKey, getSupabaseUrl } from "./auth.ts";

const serviceRoleFetch: typeof fetch = async (input, init) => {
  const serviceKey = getServiceRoleKey();
  const headers = new Headers(init?.headers);
  headers.set("apikey", serviceKey);

  // supabase-js adds `Authorization: Bearer <api key>` by default. That is
  // accepted by legacy JWT keys but rejected for modern `sb_secret_*` keys;
  // retain real user JWTs and remove only the synthetic service-key bearer.
  if (headers.get("Authorization") === `Bearer ${serviceKey}`) {
    headers.delete("Authorization");
  }

  return fetch(input, { ...init, headers });
};

export const createSupabaseClient = (req: Request) => {
  return createClient(getSupabaseUrl(), getPublishableKey(), {
    global: {
      headers: { Authorization: req.headers.get("Authorization") ?? "" },
    },
  });
};

export const createServiceRoleClient = () => {
  const serviceKey = getServiceRoleKey();
  return createClient(getSupabaseUrl(), serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { fetch: serviceRoleFetch },
  });
};
