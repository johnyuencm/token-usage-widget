/**
 * Guard for the opt-in LAN bind (config `server.host` not loopback).
 *
 * Default host is 127.0.0.1 (loopback), where the OS already restricts who can
 * reach the socket. When a user opts into a non-loopback host, /api/usage
 * (quota percentages, balances) would be readable by anyone on the LAN, so we
 * generate a token, store it in the 0600 config, and require it on requests.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** 32 random bytes -> 64 hex chars; 256 bits of entropy. */
export const LAN_TOKEN_BYTES = 32;

export function generateLanToken(): string {
  return randomBytes(LAN_TOKEN_BYTES).toString("hex");
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  // 127.0.0.0/8
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m && m.slice(1).every((p) => Number(p) <= 255)) return true;
  return false;
}

/** Pull the token from `Authorization: Bearer <t>` or `X-TUW-Token: <t>`. */
export function extractRequestToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  const header = req.headers["x-tuw-token"];
  const v = Array.isArray(header) ? header[0] : header;
  return v && v.trim() ? v.trim() : null;
}

export function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1" || a.startsWith("::ffff:127.")) return true;
  return isLoopbackHost(a);
}

/**
 * Loopback-only bind (token null) is open. On a LAN bind, requests that arrive
 * over loopback (the local widget/dashboard) stay open so the product keeps
 * working; every other source must present the token.
 */
export function authorizeApiRequest(
  req: IncomingMessage,
  lanToken: string | null | undefined,
): boolean {
  if (!lanToken) return true;
  if (isLoopbackAddress(req.socket?.remoteAddress)) return true;
  return tokenMatches(lanToken, extractRequestToken(req));
}
