const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"];

export function readProductionSupabaseConfig(environment) {
  for (const name of required) {
    if (!environment[name]?.trim()) {
      throw new Error(`Missing required production variable: ${name}`);
    }
  }

  const url = new URL(environment.VITE_SUPABASE_URL);
  if (url.hostname.endsWith("lovable.app")) {
    throw new Error("Production Supabase URL must not use a lovable.app host");
  }

  return {
    url: url.toString().replace(/\/$/, ""),
    publishableKey: environment.VITE_SUPABASE_PUBLISHABLE_KEY,
  };
}
