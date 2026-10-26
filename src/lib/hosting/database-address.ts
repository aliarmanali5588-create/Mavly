/**
 * ═══ APPLICATION-DATABASE ADDRESS POLICY ════════════════════════════════════
 *
 * A user supplies the database URL, so the hostname is attacker-controlled.
 * Mavly opens exactly one bounded connection to prove it is reachable; that
 * connection must never become a probe of a private network or the Mavly
 * runtime's own metadata services.
 *
 * The URL parser rejects obviously private hostnames (`localhost`, `.local`,
 * `.internal`) and IPv6 literals. DNS can still point a public-looking name at
 * a loopback/private address, so the resolved addresses are checked here before
 * the driver connects. The connection is then pinned to a validated address.
 *
 * Pure and dependency-free (only `node:net`), so the rules are unit-tested.
 */

import { isIP } from "node:net";

type Ipv4 = readonly number[];

function ipv4Parts(address: string): Ipv4 | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (!numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
  return numbers;
}

/**
 * Public IPv4 only. Everything reserved, private, loopback, link-local,
 * CGNAT, documentation, multicast and broadcast is refused.
 */
function isPublicIpv4(address: string): boolean {
  const parsed = ipv4Parts(address);
  if (!parsed) return false;
  const [a, b, c] = parsed;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 1 || c === 2)) return false; // 192.0.0/24, 192.0.1/24, TEST-NET-1
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase();

  // IPv4-mapped: validate the embedded address. A non-dotted mapping is
  // refused rather than decoded by hand (rare, and not returned by dns.lookup).
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    return isIP(tail) === 4 && isPublicIpv4(tail);
  }

  if (lower === "::" || lower === "::1") return false;
  if (/^f[cd]/.test(lower)) return false; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return false; // fe80::/10 link-local
  if (/^ff/.test(lower)) return false; // multicast
  if (/^2001:db8:/.test(lower)) return false; // documentation
  if (/^2001:0:/.test(lower)) return false; // Teredo
  if (/^2002:/.test(lower)) return false; // 6to4 (embeds an IPv4 address)
  if (/^64:ff9b:/.test(lower)) return false; // NAT64 well-known prefix
  if (/^3fff:/.test(lower)) return false; // documentation (RFC 9637)

  // Global unicast is 2000::/3: the first 16-bit group is 0x2000–0x3fff.
  const firstGroup = lower.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(firstGroup)) return false;
  const value = parseInt(firstGroup, 16);
  return value >= 0x2000 && value <= 0x3fff;
}

/**
 * Why this resolved address may not be connected to, or null when it is a
 * globally routable unicast address.
 */
export function ipAddressRejectionReason(address: string): string | null {
  const family = isIP(address.trim());
  if (family === 4) {
    return isPublicIpv4(address.trim())
      ? null
      : "resolves to a private, loopback or reserved address";
  }
  if (family === 6) {
    return isPublicIpv6(address.trim())
      ? null
      : "resolves to a private, loopback or reserved address";
  }
  return "is not an IP address";
}

/**
 * Reject the connection when ANY resolved address is non-public. The driver
 * would be free to choose any of them, so a mixed answer is not safe.
 */
export function resolvedAddressRejectionReason(
  addresses: readonly string[],
): string | null {
  if (addresses.length === 0) return "did not resolve to any address";
  for (const address of addresses) {
    const reason = ipAddressRejectionReason(address);
    if (reason) return reason;
  }
  return null;
}
