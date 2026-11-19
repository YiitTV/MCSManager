import { promises as dns } from "dns";
import * as net from "net";

const { isIP } = net;
// @types/node 14 has no typings for net.BlockList (available at runtime on Node 22).
interface IBlockList {
  addSubnet(network: string, prefix: number, type: "ipv4" | "ipv6"): void;
  check(address: string, type: "ipv4" | "ipv6"): boolean;
}
const BlockList: new () => IBlockList = (net as any).BlockList;

// SSRF-safe helper for admin-configured outbound URLs (notifications).
// Syntax checks (`validateOutboundUrl`) are separate from the network step
// (`resolveOutboundTarget`), which returns the exact address that was validated so the HTTP
// client can pin it with `makePinnedLookup` and a second DNS answer cannot change the target.

export const OUTBOUND_URL_MAX_LENGTH = 512;

export type OutboundSinkType = "bot_http" | "discord_webhook";

export const DISCORD_WEBHOOK_HOSTS = [
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com"
];
const DISCORD_WEBHOOK_PATH = /^\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;

export type OutboundUrlErrorCode =
  | "invalid_url"
  | "too_long"
  | "credentials"
  | "scheme"
  | "host_not_allowed"
  | "path"
  | "port"
  | "blocked_address"
  | "dns";

// The message is a stable code only: it never contains the URL, so it is safe to log.
export class OutboundUrlError extends Error {
  constructor(public readonly code: OutboundUrlErrorCode) {
    super(code);
    this.name = "OutboundUrlError";
  }
}

export interface OutboundUrlOptions {
  allowPrivate: boolean;
  sinkType: OutboundSinkType;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type OutboundResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface OutboundTarget {
  url: URL;
  hostname: string;
  port: number;
  address: string;
  family: 4 | 6;
  // True when every resolved address is in a blocked (private) range.
  allPrivate: boolean;
}

const blockList = new BlockList();
function addV4(net: string, prefix: number) {
  blockList.addSubnet(net, prefix, "ipv4");
}
function addV6(net: string, prefix: number) {
  blockList.addSubnet(net, prefix, "ipv6");
}
addV4("0.0.0.0", 8);
addV4("10.0.0.0", 8);
addV4("100.64.0.0", 10);
addV4("127.0.0.0", 8);
addV4("169.254.0.0", 16);
addV4("172.16.0.0", 12);
addV4("192.0.0.0", 24);
addV4("192.168.0.0", 16);
addV4("198.18.0.0", 15);
addV4("224.0.0.0", 4);
addV4("240.0.0.0", 4);
addV6("::", 128);
addV6("::1", 128);
addV6("fc00::", 7);
addV6("fe80::", 10);
addV6("ff00::", 8);
addV6("2001::", 32); // Teredo
addV6("2001:db8::", 32); // documentation
addV6("100::", 64); // discard-only

function ipv4ToString(b: number[]) {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

// Parse an IPv6 text address into 16 bytes (handles "::" and a trailing dotted IPv4 part).
function parseIPv6(input: string): number[] | null {
  let text = input;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = text.slice(lastColon + 1);
    if (isIP(v4) !== 4) return null;
    tail = v4.split(".").map(Number);
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...rest] : head;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  if (tail.length === 4) {
    bytes[12] = tail[0];
    bytes[13] = tail[1];
    bytes[14] = tail[2];
    bytes[15] = tail[3];
  }
  return bytes;
}

/**
 * True when the address must not be contacted unless the admin allowed private targets.
 * Unparseable input counts as blocked (fail closed).
 */
export function isBlockedAddress(address: string): boolean {
  let host = address.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  const family = isIP(host);
  if (family === 4) return blockList.check(host, "ipv4");
  if (family !== 6) return true;

  const bytes = parseIPv6(host);
  if (!bytes) return true;
  const firstTenZero = bytes.slice(0, 10).every((v) => v === 0);
  // IPv4-mapped (::ffff:a.b.c.d): classify the embedded IPv4.
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return blockList.check(ipv4ToString(bytes.slice(12)), "ipv4");
  }
  // ::/96 (deprecated IPv4-compatible, includes :: and ::1) is never a legitimate target.
  if (bytes.slice(0, 12).every((v) => v === 0)) return true;
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 in the last 32 bits.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((v) => v === 0)
  ) {
    return blockList.check(ipv4ToString(bytes.slice(12)), "ipv4");
  }
  // 6to4 (2002::/16) embeds an IPv4 in bytes 2..5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return blockList.check(ipv4ToString(bytes.slice(2, 6)), "ipv4");
  }
  return blockList.check(host, "ipv6");
}

function stripBrackets(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Syntax and policy checks that need no network. Returns the parsed URL or throws
 * `OutboundUrlError` (code only, never the URL).
 */
export function validateOutboundUrl(rawUrl: unknown, options: OutboundUrlOptions): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) throw new OutboundUrlError("invalid_url");
  if (rawUrl.length > OUTBOUND_URL_MAX_LENGTH) throw new OutboundUrlError("too_long");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundUrlError("invalid_url");
  }
  if (url.username || url.password) throw new OutboundUrlError("credentials");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new OutboundUrlError("scheme");
  if (url.hash) throw new OutboundUrlError("invalid_url");
  if (!url.hostname) throw new OutboundUrlError("invalid_url");
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OutboundUrlError("port");
  }

  if (options.sinkType === "discord_webhook") {
    if (url.protocol !== "https:") throw new OutboundUrlError("scheme");
    if (!DISCORD_WEBHOOK_HOSTS.includes(url.hostname.toLowerCase()))
      throw new OutboundUrlError("host_not_allowed");
    if (url.port !== "") throw new OutboundUrlError("port");
    if (url.search || !DISCORD_WEBHOOK_PATH.test(url.pathname)) throw new OutboundUrlError("path");
    return url;
  }

  // bot_http: plain http only with the explicit private-address opt-in
  // (the "target is private" half is checked after resolution).
  if (url.protocol === "http:" && !options.allowPrivate) throw new OutboundUrlError("scheme");
  return url;
}

const defaultResolver: OutboundResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family }));
};

/**
 * Validate and resolve the target. The returned `address` is the one to pin.
 * IP literals are classified directly without DNS.
 */
export async function resolveOutboundTarget(
  rawUrl: unknown,
  options: OutboundUrlOptions,
  resolver: OutboundResolver = defaultResolver
): Promise<OutboundTarget> {
  // The private-address option never applies to the Discord webhook sink.
  const allowPrivate = options.sinkType === "discord_webhook" ? false : options.allowPrivate;
  const url = validateOutboundUrl(rawUrl, { ...options, allowPrivate });
  const hostname = stripBrackets(url.hostname.toLowerCase());
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  let answers: ResolvedAddress[];
  if (isIP(hostname) !== 0) {
    answers = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      answers = await resolver(hostname);
    } catch {
      throw new OutboundUrlError("dns");
    }
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new OutboundUrlError("dns");

  const blocked = answers.map((a) => isBlockedAddress(a.address));
  const allPrivate = blocked.every(Boolean);
  if (!allowPrivate && blocked.some(Boolean)) throw new OutboundUrlError("blocked_address");
  // Plain http is only acceptable when the target is entirely private.
  if (url.protocol === "http:" && !allPrivate) throw new OutboundUrlError("scheme");

  const first = answers[0];
  return {
    url,
    hostname,
    port,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
    allPrivate
  };
}

/**
 * A `lookup` function for http(s).request that always answers with the validated address.
 * Handles both the single-result and the `all: true` call styles used by Node.
 */
export function makePinnedLookup(address: string, family: 4 | 6) {
  return (
    _hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (...args: any[]) => void
  ) => {
    if (typeof options === "object" && options?.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}
