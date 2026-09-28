// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    define: {
      // The managed Lovable build injects these automatically. In a standalone
      // Node container we must define them explicitly so both SSR and browser
      // bundles receive the configured Supabase project at build time.
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(process.env.VITE_SUPABASE_URL),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      ),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(
        process.env.VITE_SUPABASE_ANON_KEY,
      ),
      "import.meta.env.VITE_CUSTOM_SUPABASE_URL": JSON.stringify(process.env.CUSTOM_SUPABASE_URL),
      "import.meta.env.VITE_CUSTOM_SUPABASE_ANON_KEY": JSON.stringify(
        process.env.CUSTOM_SUPABASE_ANON_KEY,
      ),
    },
  },
  tanstackStart: {
    server: { entry: "server" },
  },
  // A produção é executada em um contêiner Node atrás do Nginx da VPS.
  nitro: { preset: "node-server" },
});
