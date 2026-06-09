import { describe, expect, it } from "vitest";
import {
  blockedIpReason,
  isAllowedScheme,
  isIpLiteral,
} from "../src/url-fetch-ssrf.js";

// SECURITY-CRITICAL: this guard is the only thing standing between a tenant-
// supplied URL and a server-side request. A regression here is an SSRF hole.

describe("isAllowedScheme", () => {
  it("allows http and https only", () => {
    expect(isAllowedScheme(new URL("http://example.com"))).toBe(true);
    expect(isAllowedScheme(new URL("https://example.com"))).toBe(true);
  });
  it("rejects every other scheme", () => {
    for (const u of [
      "ftp://example.com",
      "file:///etc/passwd",
      "gopher://x",
      "data:text/html,hi",
      "javascript:alert(1)",
    ]) {
      expect(isAllowedScheme(new URL(u))).toBe(false);
    }
  });
});

describe("blockedIpReason", () => {
  it("blocks loopback, private, link-local, unique-local and metadata", () => {
    for (const ip of [
      "127.0.0.1", // loopback
      "10.0.0.5", // private
      "192.168.1.10", // private
      "172.16.5.4", // private
      "169.254.169.254", // link-local / cloud metadata
      "::1", // IPv6 loopback
      "fe80::1", // IPv6 link-local
      "fc00::1", // IPv6 unique-local
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "0.0.0.0", // unspecified
    ]) {
      expect(blockedIpReason(ip), ip).not.toBeNull();
    }
  });

  it("allows ordinary public addresses", () => {
    expect(blockedIpReason("1.1.1.1")).toBeNull();
    expect(blockedIpReason("8.8.8.8")).toBeNull();
    expect(blockedIpReason("93.184.216.34")).toBeNull(); // example.com
    expect(blockedIpReason("2606:4700:4700::1111")).toBeNull(); // public IPv6
  });

  it("blocks an unparseable address rather than allowing it", () => {
    expect(blockedIpReason("not-an-ip")).not.toBeNull();
  });
});

describe("isIpLiteral", () => {
  it("recognizes IP literals and rejects hostnames", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("2606:4700:4700::1111")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("shop.example.co.uk")).toBe(false);
  });
});
