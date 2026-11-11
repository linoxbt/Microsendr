import type { FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { isIP } from 'node:net';

// Requests arrive Netlify -> Caddy -> API. Fastify trusts only the private Caddy hop
// (KORA_TRUSTED_PROXIES), so request.ip is the address Caddy saw. Netlify's client
// address header is honoured only when the request also carries a valid X-Nf-Sign
// JWS made with the site's proxy signing secret; otherwise anyone reaching Caddy
// directly could choose their own rate-limit identity.
export function trustedProxies() {
  return (process.env.KORA_TRUSTED_PROXIES ?? 'loopback,uniquelocal')
    .split(',').map((value) => value.trim()).filter(Boolean);
}

/** Whether the request carries a valid Netlify proxy signature, and the client address to trust. */
export async function proxyCheck(request: FastifyRequest): Promise<{ ip: string; signed: boolean }> {
  const secret = process.env.KORA_PROXY_SIGNING_SECRET;
  const signature = request.headers['x-nf-sign'];
  if (secret && typeof signature === 'string') {
    try {
      await jwtVerify(signature, new TextEncoder().encode(secret), { issuer: 'netlify', algorithms: ['HS256'] });
      const forwarded = request.headers['x-nf-client-connection-ip'];
      return { ip: typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.ip, signed: true };
    } catch {
      // Fall back to the transport address below.
    }
  }
  return { ip: request.ip, signed: false };
}

export async function clientIp(request: FastifyRequest) {
  return (await proxyCheck(request)).ip;
}
