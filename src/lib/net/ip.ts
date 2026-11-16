import net from 'node:net';

/**
 * Address classification for outbound-fetch safety.
 *
 * A fetch target is acceptable only when it is a *globally routable unicast*
 * address. Everything else — loopback, RFC 1918, link-local (which includes the
 * 169.254.169.254 cloud-metadata endpoint), CGNAT, multicast, documentation and
 * reserved ranges, and every IPv6 form that embeds one of those — is refused.
 */

function ipv4Octets(ip: string): [number, number, number, number] | null {
  if (net.isIPv4(ip)) return ip.split('.').map(Number) as [number, number, number, number];
  return null;
}

export function isPrivateIPv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b, c] = o;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol + TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay (deprecated)
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands any IPv6 text form to its eight 16-bit groups, or null if malformed. */
function ipv6Groups(ip: string): number[] | null {
  let v = ip.toLowerCase().split('%')[0]!;
  if (!net.isIPv6(v)) return null;
  // Convert a trailing dotted quad into two hex groups.
  const dotted = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = ipv4Octets(dotted[2]!);
    if (!o) return null;
    v = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = v.includes('::') ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(groups: number[], at: number): string {
  return `${groups[at]! >> 8}.${groups[at]! & 255}.${groups[at + 1]! >> 8}.${groups[at + 1]! & 255}`;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  const allZeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if (allZeroTo(5) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4(g, 6)); // ::ffff:a.b.c.d
  if (allZeroTo(6)) return true; // IPv4-compatible ::a.b.c.d (deprecated) — never a real target
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIPv4(embeddedV4(g, 6)); // NAT64 64:ff9b::/96 wrapping an IPv4
  }
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedV4(g, 1)); // 6to4 embeds an IPv4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard 100::/64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when the address must never be connected to. Non-IP strings return false. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(v)) return isPrivateIPv4(v);
  if (net.isIPv6(v.split('%')[0]!)) return isPrivateIPv6(v);
  return false;
}

export function isIpLiteral(host: string): boolean {
  return net.isIP(host.replace(/^\[|\]$/g, '').split('%')[0]!) !== 0;
}

/** Decimal / octal / hex IPv4 spellings ("2130706433", "0x7f.1") that WHATWG URL normalises, kept as a guard. */
export function looksLikeObfuscatedIPv4(host: string): boolean {
  return /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(host) && !net.isIPv4(host);
}
