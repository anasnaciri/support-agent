import ipaddr from "ipaddr.js";

// SSRF guard for tenant-supplied URLs (knowledge documents "from URL").
// SECURITY-CRITICAL — keep the default deny: only plainly public ("unicast")
// destinations over http/https are allowed; everything else is blocked.

export const isAllowedScheme = (url: URL): boolean =>
  url.protocol === "http:" || url.protocol === "https:";

/** True when `host` is an IP literal (so it needs no DNS resolution). */
export const isIpLiteral = (host: string): boolean =>
  ipaddr.isValid(stripBrackets(host));

const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, "");

/**
 * Returns a reason string when `ip` must NOT be fetched (a private, loopback,
 * link-local, unique-local, reserved, multicast, … address — anything not a
 * publicly-routable unicast address), or null when it's safe. Unparseable
 * input is blocked (fail closed). IPv4-mapped IPv6 is evaluated as its
 * embedded IPv4 so `::ffff:127.0.0.1` is caught as loopback.
 */
export const blockedIpReason = (ip: string): string | null => {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(stripBrackets(ip));
  } catch {
    return "unparseable";
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }
  const range = addr.range();
  return range === "unicast" ? null : range;
};
