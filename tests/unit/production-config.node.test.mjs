import assert from "node:assert/strict";
import test from "node:test";

import { readProductionSupabaseConfig } from "../../scripts/lib/production-config.mjs";

test("rejects an incomplete public Supabase configuration", () => {
  assert.throws(
    () => readProductionSupabaseConfig({ VITE_SUPABASE_URL: "" }),
    /VITE_SUPABASE_URL/,
  );
});

test("rejects a legacy Lovable host", () => {
  assert.throws(
    () =>
      readProductionSupabaseConfig({
        VITE_SUPABASE_URL: "https://happy-thread-weaver.lovable.app",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      }),
    /lovable\.app/,
  );
});
