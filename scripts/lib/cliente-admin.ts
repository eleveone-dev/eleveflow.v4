// Cliente Supabase com a chave de servico, para scripts que rodam com o
// .env.staging carregado (que aponta para producao).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function clienteAdmin(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL;
  const chave = process.env.STAGING_SUPABASE_SECRET_KEY;
  if (!url || !chave) {
    throw new Error("VITE_SUPABASE_URL e STAGING_SUPABASE_SECRET_KEY obrigatorios");
  }

  // Chave sb_secret nao e JWT: vai so no apikey, sem o Bearer sintetico.
  return createClient(url, chave, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("apikey", chave);
        if (headers.get("Authorization") === `Bearer ${chave}`) headers.delete("Authorization");
        return fetch(input, { ...init, headers });
      },
    },
  });
}
