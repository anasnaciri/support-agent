import { describe, expect, it } from "vitest";

import {
  actorVariant,
  approvalStatusVariant,
  caseStatusVariant,
  integrationStatusVariant,
  permissionVariant,
  riskVariant,
} from "../lib/status-variants.js";

// Cases, audit, and approvals use brighter, more saturated (Bright) tags so the
// status colors pop — same soft pill style, vivid hue ramp. The settings pages
// (permissions, integrations) keep the calmer base tints — those must not
// regress.
describe("status badge variants", () => {
  describe("cases / audit / approvals use the bright saturated variants", () => {
    it("case status maps colored states to bright variants", () => {
      expect(caseStatusVariant("resolved")).toBe("successBright");
      expect(caseStatusVariant("human_takeover")).toBe("destructiveBright");
      // "Needs approval" uses the calmer amber, not the bright yellow: the
      // vivid hue had too little contrast on the off-white background.
      expect(caseStatusVariant("waiting_for_approval")).toBe("warning");
      expect(caseStatusVariant("in_progress")).toBe("infoBright");
    });

    it("keeps waiting states quiet", () => {
      expect(caseStatusVariant("waiting_for_customer")).toBe("muted");
      expect(caseStatusVariant("waiting_for_supplier")).toBe("muted");
    });

    it("approval status maps to bright variants, except pending's amber", () => {
      // pending uses the calmer amber, not the bright yellow — too little
      // contrast on the off-white background (matches waiting_for_approval).
      expect(approvalStatusVariant("pending")).toBe("warning");
      expect(approvalStatusVariant("approved")).toBe("successBright");
      expect(approvalStatusVariant("rejected")).toBe("destructiveBright");
    });

    it("risk maps to bright variants, except medium's amber", () => {
      expect(riskVariant("low")).toBe("successBright");
      // same contrast fix as above — bright yellow → amber.
      expect(riskVariant("medium")).toBe("warning");
      expect(riskVariant("high")).toBe("destructiveBright");
      expect(riskVariant("critical")).toBe("destructiveBright");
    });

    it("audit actor maps colored actors to bright variants", () => {
      expect(actorVariant("agent")).toBe("infoBright");
      expect(actorVariant("user")).toBe("successBright");
      expect(actorVariant("system")).toBe("muted");
    });
  });

  describe("settings tags stay on the calmer base variants", () => {
    it("permission variant is unchanged", () => {
      expect(permissionVariant("allow")).toBe("success");
      expect(permissionVariant("ask")).toBe("warning");
      expect(permissionVariant("deny")).toBe("destructive");
    });

    it("integration status variant is unchanged", () => {
      expect(integrationStatusVariant("active")).toBe("success");
      expect(integrationStatusVariant("revoked")).toBe("destructive");
    });
  });
});
