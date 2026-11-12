import type { FastifyRequest } from 'fastify';
import { PaymentError } from '../../../packages/payments/src/errors.js';

const developmentOrigins =
  'http://127.0.0.1:4310,http://localhost:4310,http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:5176,http://localhost:5176';

export const production = () => process.env.NODE_ENV === 'production';

// One allowlist for every cookie-authenticated surface. Production fails closed:
// without KORA_CONSOLE_ORIGINS no browser origin may sign in or write.
export function allowedOrigins() {
  const configured = process.env.KORA_CONSOLE_ORIGINS ?? (production() ? '' : developmentOrigins);
  return configured.split(',').map((value) => value.trim()).filter(Boolean);
}

export function requireOrigin(request: FastifyRequest, code = 'origin_denied') {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins().includes(origin))
    throw new PaymentError(403, code, 'This origin is not allowed');
  return origin;
}

export function secureCookie(origin: string) {
  return production() || origin.startsWith('https:');
}

// Email codes are HMACed with this secret; a short value would make stored hashes guessable.
export function authSecret(override?: string) {
  const secret = override ?? process.env.KORA_AUTH_SECRET;
  if (!secret) return undefined;
  if (override === undefined && Buffer.byteLength(secret) < 32)
    throw new Error('KORA_AUTH_SECRET must be at least 32 bytes');
  return secret;
}

// The retired business platform (console, /v1 developer API, network, Stellar, rails)
// stays available for local and CI regression only. In production it is unreachable
// unless KORA_LEGACY_PLATFORM=true is set on purpose.
export function legacyPlatformEnabled() {
  const flag = process.env.KORA_LEGACY_PLATFORM;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return !production();
}
export const legacyPlatformPath = /^\/(?:v1|console|business|internal|openapi\.json|reference)(?:[/?#]|$)/;

// Self-approval, simulated funding and Paystack test routes exist for local and CI
// regression coverage only. They are off in production unless explicitly enabled.
export function sandboxFixturesEnabled() {
  const flag = process.env.KORA_SANDBOX_FIXTURES;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return !production();
}

/**
 * Settings the consumer app needs to work in production. Names only, never values:
 * the list is logged at startup and reported by /health so a missing secret is seen
 * at deploy time, not by the first customer who cannot sign in.
 */
export function configReport() {
  const env = process.env;
  const missing: string[] = [];
  const secret = env.KORA_AUTH_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32) missing.push('KORA_AUTH_SECRET');
  if (!allowedOrigins().length) missing.push('KORA_CONSOLE_ORIGINS');
  if (!(env.EMAIL_FROM || env.SMTP_FROM) || !(env.RESEND_API_KEY || env.SMTP_HOST)) missing.push('email (RESEND_API_KEY and EMAIL_FROM)');
  if (production() && !env.KORA_PROXY_SIGNING_SECRET) missing.push('KORA_PROXY_SIGNING_SECRET');
  if (production() && env.KORA_MANAGED_TRANSFERS === 'true' && !env.PRIVY_POLICY_ID && env.KORA_ALLOW_UNPOLICED_TRANSFERS !== 'true')
    missing.push('PRIVY_POLICY_ID (account-wallet sends stay off without it)');
  const optional: string[] = [];
  if (!env.KORA_PUBLIC_API_URL) optional.push('KORA_PUBLIC_API_URL');
  if (!env.DIDIT_API_KEY || !env.DIDIT_WEBHOOK_SECRET) optional.push('identity verification (DIDIT_API_KEY, DIDIT_WEBHOOK_SECRET)');
  if (!env.FONBNK_CLIENT_ID || !env.FONBNK_SIGNATURE_SECRET || !env.FONBNK_WEBHOOK_SECRET) optional.push('naira purchases (FONBNK_*)');
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) optional.push('account wallets (PRIVY_APP_ID, PRIVY_APP_SECRET)');
  if (!env.RELOADLY_CLIENT_ID || !env.RELOADLY_CLIENT_SECRET || !env.BILLS_TREASURY_ADDRESS)
    optional.push('airtime, data and gift cards (RELOADLY_CLIENT_ID, RELOADLY_CLIENT_SECRET, BILLS_TREASURY_ADDRESS)');
  if (!env.MICROSENDR_PAY_ADDRESS || !env.OPERATOR_PRIVATE_KEY) optional.push('MicrosendrPay escrow (MICROSENDR_PAY_ADDRESS, OPERATOR_PRIVATE_KEY)');
  return { ready: missing.length === 0, missing, optional };
}

/**
 * In production, browser routes are reachable only through the signing web proxy, so
 * nobody can call the API host directly with a forged client address or skip the
 * proxy's protections. Webhooks carry their own signatures and stay open.
 */
export function proxySignatureRequired() {
  const flag = process.env.KORA_REQUIRE_PROXY_SIGNATURE;
  if (flag === 'false') return false;
  if (flag === 'true') return true;
  return production() && !!process.env.KORA_PROXY_SIGNING_SECRET;
}
export const proxyExemptPath = /^\/personal\/api\/(?:webhooks\/|health(?:[?#]|$))/;

/** Settings without which the API must not serve at all in production. */
export function fatalConfigProblems() {
  if (!production()) return [];
  const problems: string[] = [];
  if (Buffer.byteLength(process.env.KORA_AUTH_SECRET ?? '') < 32) problems.push('KORA_AUTH_SECRET (at least 32 bytes)');
  return problems;
}
