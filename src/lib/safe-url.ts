/**
 * ═══ IS THIS URL SAFE FOR THE SERVER TO FETCH? ══════════════════════════════
 *
 * ⚠️⚠️ ANY ROUTE THAT FETCHES A URL A CLIENT SUPPLIED IS AN SSRF PRIMITIVE UNTIL IT
 * ASKS THIS. Our server sits inside a network the browser cannot reach; a request it
 * makes on the caller's behalf runs with our egress, not theirs. `http://localhost:8125/`
 * and `http://169.254.169.254/` are the two that turn a file fetcher into a
 * credential-reading tool.
 *
 * ⚠️ AN ALLOW-SHAPE, NOT A BLOCK-LIST. Only `http`/`https` get through, and any host
 * that is internal — by name, or as an IP literal in ANY of its spellings — is refused.
 *
 * ⭐ Extracted because the visual editor's apply route began fetching uploaded
 * images server-side to copy them into the project, and shipped without this. The
 * upload route had carried its own private copy since F-something; one definition now
 * serves both, so a hardening applied here reaches every caller.
 *
 * ═══⚠️⚠️ IP LITERALS ARE PARSED, NOT PATTERN-MATCHED ═══════════════════════
 *
 * A regex over dotted-quad prefixes is not enough — every one of these reads as a
 * public host to a naive string check yet points somewhere internal:
 *
 *   http://[::ffff:169.254.169.254]/   ← cloud metadata, as an IPv4-mapped IPv6 literal
 *   http://[::ffff:127.0.0.1]/         ← loopback, same trick
 *   http://[fd00::1]/  http://[fe80::1]/   ← IPv6 private and link-local
 *   http://100.64.0.1/  http://0.1.2.3/    ← carrier-grade NAT and 0.0.0.0/8
 *
 * The mapped form is the dangerous one: the URL parser rewrites it to
 * `[::ffff:a9fe:a9fe]`, no regex written for dotted quads can see it, and a dual-stack
 * socket connects straight to 169.254.169.254. So IP literals are now PARSED — v4 and
 * v6, with the IPv4 embedded in mapped / compatible / NAT64 forms unwrapped and judged
 * on its own — instead of pattern-matched.
 *
 * ⚠️ AND A PUBLIC NAME CAN STILL POINT AT A PRIVATE ADDRESS (`localtest.me` →
 * 127.0.0.1, or an attacker's own DNS → 169.254.169.254). No synchronous check can see
 * that, which is why `publicUrlRejectionReason` exists: it resolves the name and judges
 * every address it gets back. SERVER ROUTES SHOULD CALL THE ASYNC ONE. What remains is
 * DNS rebinding between that lookup and the fetch's own; pair it with
 * `redirect: "error"` and a timeout, and that window is the whole residual risk.
 */

/** Hostnames that are internal by definition, whatever they resolve to. */
function isInternalName(host: string): boolean {
    return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".internal") ||
        host.endsWith(".local") ||
        host.endsWith(".home.arpa")
    );
}

/** A dotted-quad IPv4 address as a 32-bit unsigned integer, or `null`. */
function ipv4ToInt(ip: string): number | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n > 255) return null;
        value = value * 256 + n;
    }
    return value;
}

/** `[base, prefixLength]` — every range an outside caller must never reach through us. */
const PRIVATE_V4: [string, number][] = [
    ["0.0.0.0", 8],        // "this network"
    ["10.0.0.0", 8],       // private
    ["100.64.0.0", 10],    // carrier-grade NAT
    ["127.0.0.0", 8],      // loopback
    ["169.254.0.0", 16],   // link-local — cloud metadata lives here
    ["172.16.0.0", 12],    // private
    ["192.0.0.0", 24],     // IETF protocol assignments
    ["192.0.2.0", 24],     // documentation
    ["192.168.0.0", 16],   // private
    ["198.18.0.0", 15],    // benchmarking
    ["198.51.100.0", 24],  // documentation
    ["203.0.113.0", 24],   // documentation
    ["224.0.0.0", 4],      // multicast
    ["240.0.0.0", 4],      // reserved, including 255.255.255.255
];

function isPrivateIPv4(ip: string): boolean {
    const value = ipv4ToInt(ip);
    if (value === null) return false;
    return PRIVATE_V4.some(([base, bits]) => {
        const start = ipv4ToInt(base)!;
        const size = 2 ** (32 - bits);
        return value >= start && value < start + size;
    });
}

/** An IPv6 address expanded to its eight 16-bit groups, or `null` when it is not one. */
function expandIPv6(input: string): number[] | null {
    let ip = input.toLowerCase();
    const zone = ip.indexOf("%");
    if (zone !== -1) ip = ip.slice(0, zone);

    // A trailing dotted quad (`::ffff:1.2.3.4`) becomes two hex groups.
    const lastColon = ip.lastIndexOf(":");
    const tail = ip.slice(lastColon + 1);
    if (tail.includes(".")) {
        const v4 = ipv4ToInt(tail);
        if (v4 === null) return null;
        ip = `${ip.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }

    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;

    const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
    if (groups.length !== 8) return null;
    const out: number[] = [];
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        out.push(parseInt(group, 16));
    }
    return out;
}

function isPrivateIPv6(ip: string): boolean {
    const g = expandIPv6(ip);
    if (!g) return false;

    const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
    const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;

    if (g.every((x) => x === 0)) return true;                        // ::
    if (allZeroUpTo(7) && g[7] === 1) return true;                   // ::1
    // ⚠️ THE BYPASS THAT MATTERED: an IPv4 address wearing IPv6 clothing is judged as IPv4.
    if (allZeroUpTo(5) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4()); // ::ffff:a.b.c.d
    if (allZeroUpTo(6)) return isPrivateIPv4(embeddedV4());          // ::a.b.c.d (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
        return isPrivateIPv4(embeddedV4());                          // 64:ff9b::/96 NAT64
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true;                     // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true;                     // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true;                     // ff00::/8 multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;             // documentation
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
    return false;
}

/** True for any address — v4 or v6, any spelling — an outside caller must not reach. */
export function isPrivateAddress(address: string): boolean {
    const bare = address.replace(/^\[|\]$/g, "");
    if (bare.includes(":")) return isPrivateIPv6(bare);
    return isPrivateIPv4(bare);
}

function isIpLiteral(host: string): boolean {
    const bare = host.replace(/^\[|\]$/g, "");
    return bare.includes(":") ? expandIPv6(bare) !== null : ipv4ToInt(bare) !== null;
}

/**
 * Why this URL may not be fetched, or `null` when it may — judged from the URL alone.
 *
 * ⚠️ SYNCHRONOUS, SO IT CANNOT SEE WHERE A NAME RESOLVES. It is complete for IP literals
 * and internal names; for everything else prefer `publicUrlRejectionReason`.
 */
export function urlRejectionReason(value: string): string | null {
    if (!value) return "No URL was provided";

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return "That is not a valid URL";
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Only http and https URLs can be attached";
    }

    // Credentials in a URL are never needed for a public file and are a classic way to
    // make a URL read as one host while fetching another.
    if (parsed.username || parsed.password) return "That URL cannot be used";

    // The URL parser has already normalised decimal, hex and octal IPv4 spellings
    // (`http://2130706433/` → `127.0.0.1`), so the literal checks below see the real address.
    const host = parsed.hostname.toLowerCase();
    if (isInternalName(host)) return "That host cannot be reached from here";
    if (isIpLiteral(host) && isPrivateAddress(host)) return "That host cannot be reached from here";

    return null;
}

/**
 * The server-side check: everything `urlRejectionReason` does, then — where the runtime
 * can — the name is RESOLVED and every address it answers with is judged too. Use this
 * wherever the server itself is about to fetch a URL a client supplied.
 *
 * ⚠️ `node:dns` IS IMPORTED LAZILY, AND ITS ABSENCE IS NOT A FAILURE. On a Node server
 * the lookup runs and catches DNS-rebinding (a public name pointing at a private IP). On
 * an edge runtime (Cloudflare Workers) there is no `node:dns` at all, so the import
 * throws — and that must mean "skip the resolve step", NOT "block every URL". If it were
 * treated as a failure, every diff fetch and every visual-edit image copy would be
 * refused on edge. The synchronous checks above still run everywhere (protocol,
 * credentials, and every private IP literal in any spelling), and callers add their own
 * host allow-list plus `redirect: "error"`, so the only thing edge gives up is catching a
 * rebinding PUBLIC hostname — a narrow, well-contained residual.
 *
 * ⚠️ A GENUINE LOOKUP FAILURE (the module IS present but the name will not resolve, or
 * resolves to a private address) still BLOCKS. Only the module being unavailable is
 * treated as "cannot check here".
 */
export async function publicUrlRejectionReason(value: string): Promise<string | null> {
    const literal = urlRejectionReason(value);
    if (literal) return literal;

    const host = new URL(value).hostname.toLowerCase();
    if (isIpLiteral(host)) return null; // already judged in full above

    let lookup: ((h: string, o: { all: true; verbatim: true }) => Promise<{ address: string }[]>) | undefined;
    try {
        ({ lookup } = (await import("node:dns/promises")) as unknown as { lookup: typeof lookup });
    } catch {
        return null; // no DNS on this runtime (edge) — rely on the sync + allow-list checks
    }
    if (typeof lookup !== "function") return null;

    try {
        const addresses = await lookup(host, { all: true, verbatim: true });
        if (addresses.length === 0) return "That host could not be resolved";
        if (addresses.some((entry) => isPrivateAddress(entry.address))) {
            return "That host cannot be reached from here";
        }
    } catch {
        return "That host could not be resolved";
    }
    return null;
}
