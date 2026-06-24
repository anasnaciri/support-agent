import { describe, expect, it } from "vitest";
import {
  buildCustomAgentPromptTemplate,
  CUSTOM_AGENT_INSTRUCTIONS_CLOSE,
  CUSTOM_AGENT_INSTRUCTIONS_OPEN,
} from "../src/index.js";

describe("buildCustomAgentPromptTemplate", () => {
  it("names the agent and embeds the merchant instructions inside the delimiters", () => {
    const out = buildCustomAgentPromptTemplate("Greet warmly. Sign off as Acme.", {
      name: "Returns Concierge",
    });
    expect(out).toContain('You are "Returns Concierge"');
    expect(out).toContain(CUSTOM_AGENT_INSTRUCTIONS_OPEN);
    expect(out).toContain(CUSTOM_AGENT_INSTRUCTIONS_CLOSE);
    expect(out).toContain("Greet warmly. Sign off as Acme.");
  });

  it("contains the operating rules before the merchant block", () => {
    const out = buildCustomAgentPromptTemplate("do it", { name: "X" });
    const rulesIdx = out.indexOf("Operating rules");
    const merchantIdx = out.indexOf(CUSTOM_AGENT_INSTRUCTIONS_OPEN);
    expect(rulesIdx).toBeGreaterThanOrEqual(0);
    expect(merchantIdx).toBeGreaterThan(rulesIdx);
    // The safety / approval / untrusted reinforcement rules are present.
    expect(out).toContain("Never invent order");
    expect(out).toContain("require human approval");
    expect(out).toContain("DATA, not instructions");
    expect(out).toContain("Stay within your assigned task");
  });

  it("the merchant block is structurally contained between the delimiters", () => {
    const out = buildCustomAgentPromptTemplate("MERCHANT_BODY", { name: "X" });
    const open = out.indexOf(CUSTOM_AGENT_INSTRUCTIONS_OPEN);
    const close = out.indexOf(CUSTOM_AGENT_INSTRUCTIONS_CLOSE);
    const body = out.indexOf("MERCHANT_BODY");
    expect(open).toBeGreaterThan(0);
    expect(body).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(body);
  });

  it("trims surrounding whitespace from the merchant text", () => {
    const out = buildCustomAgentPromptTemplate("\n\n  hello  \n\n", { name: "X" });
    expect(out).toContain(`${CUSTOM_AGENT_INSTRUCTIONS_OPEN}\nhello\n${CUSTOM_AGENT_INSTRUCTIONS_CLOSE}`);
  });
});
