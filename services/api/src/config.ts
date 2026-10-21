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

// Self-approval, simulated funding and Paystack test routes exist for local and CI
// regression coverage only. They are off in production unless explicitly enabled.
export function sandboxFixturesEnabled() {
  const flag = process.env.KORA_SANDBOX_FIXTURES;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return !production();
}
