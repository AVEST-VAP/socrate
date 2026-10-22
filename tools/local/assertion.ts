import { createPrivateKey, sign } from 'node:crypto';

export type AssertionInput = {
  issuer: string; audience: string; sub: string; name: string; jti?: string; iat?: number; ttlSeconds?: number;
  projectId: string; reviewKey: string; deploymentId: string; origin: string; capabilities: string[];
  exploring?: { account: string; organisation: string | null } | null;
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signAssertion(privateJwk: JsonWebKey, input: AssertionInput): string {
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.issuer, aud: input.audience, sub: input.sub, name: input.name, iat, exp: iat + (input.ttlSeconds ?? 60), jti: input.jti ?? crypto.randomUUID(),
    projectId: input.projectId, reviewKey: input.reviewKey, deploymentId: input.deploymentId, origin: input.origin, capabilities: input.capabilities, exploring: input.exploring ?? null,
  };
  const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const key = createPrivateKey({ key: privateJwk as Record<string, unknown>, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(signature)}`;
}
