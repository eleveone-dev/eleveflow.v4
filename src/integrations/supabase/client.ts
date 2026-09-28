import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// Use standard environment variables for Supabase configuration
// These are managed by the Lovable platform
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
  auth: {
    storage: typeof window !== "undefined" ? localStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const isSupabaseConfigured = !!(supabaseUrl && supabaseKey);
