import { describe, it, expect } from "vitest";
import { NotSupportedError } from "../../supabase/functions/_shared/whatsapp/types";

describe("NotSupportedError", () => {
  it("nomeia provider e operação sem vazar detalhes", () => {
    const error = new NotSupportedError("meta_cloud", "sendTemplate");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotSupportedError");
    expect(error.message).toBe("Provider meta_cloud does not support sendTemplate");
  });
});
