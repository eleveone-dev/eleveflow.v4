import { describe, it, expect } from "vitest";
import { assertLeadCanReceiveMarketing } from "../../supabase/functions/_shared/marketing-consent";

describe("assertLeadCanReceiveMarketing", () => {
  it.each(["granted", "not_required"])("deixa passar consentimento %s", (status) => {
    expect(() => assertLeadCanReceiveMarketing({ marketing_consent_status: status })).not.toThrow();
  });

  it("bloqueia lead suprimido", () => {
    expect(() =>
      assertLeadCanReceiveMarketing({ marketing_consent_status: "granted", is_suppressed: true }),
    ).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("bloqueia lead com opt-out registrado", () => {
    expect(() =>
      assertLeadCanReceiveMarketing({
        marketing_consent_status: "granted",
        marketing_opted_out_at: "2026-07-25T00:00:00Z",
      }),
    ).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it.each(["unknown", "withdrawn", "denied"])("bloqueia consentimento %s", (status) => {
    expect(() => assertLeadCanReceiveMarketing({ marketing_consent_status: status })).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("lead sem campo de consentimento é tratado como unknown", () => {
    expect(() => assertLeadCanReceiveMarketing({})).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
  });
});
