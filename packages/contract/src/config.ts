import { z } from 'zod';
import { capabilitySchema } from './api.ts';

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'coordonnée P-256 en base64url de 43 caractères');

export const publicJwkP256Schema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: coordinate,
  y: coordinate,
  ext: z.boolean().optional(),
  key_ops: z.array(z.literal('verify')).optional(),
  alg: z.literal('ES256').optional(),
  kid: z.string().max(128).optional(),
  use: z.literal('sig').optional(),
});

export const projectPolicySchema = z.strictObject({
  issuer: z.string().min(1).max(200),
  publicJwk: publicJwkP256Schema,
  attestableCapabilities: z.array(capabilitySchema).max(10),
  /** Origines importables : exacte, ou `*.` en tête d'hôte pour un seul label DNS. Absent, toute origine est importable. */
  allowedOrigin: z.string().regex(/^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/, 'motif d’origine : https://hote, ou https://*.domaine pour un seul label').optional(),
});

export function originAllowed(pattern: string, origin: string): boolean {
  const wildcard = pattern.indexOf('://*.');
  if (wildcard < 0) return origin === pattern;
  const scheme = pattern.slice(0, wildcard + 3);
  const suffix = pattern.slice(wildcard + 4);
  if (!origin.startsWith(scheme) || !origin.endsWith(suffix)) return false;
  return /^[a-z0-9-]{1,63}$/.test(origin.slice(scheme.length, origin.length - suffix.length));
}

export const serviceConfigSchema = z.strictObject({
  audience: z.string().min(1).max(200),
  assertionMaxAgeSeconds: z.number().int().min(1).max(60),
  clockSkewSeconds: z.number().int().min(0).max(60),
  sessionTtlSeconds: z.number().int().min(1).max(300),
  /** Délai entre l'archivage d'une revue et sa sélection par la purge manuelle. */
  archiveRetentionDays: z.number().int().min(1).max(3650).default(30),
  projects: z.record(z.string().min(1), projectPolicySchema),
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;

export type MigrationRef = { id: string; checksum: string };
export const migrationListSchema = z.array(z.strictObject({ id: z.string().regex(/^\d{4}_.+\.sql$/), checksum: z.string().regex(/^[0-9a-f]{64}$/) }));

export type InstanceIdentity = { instanceId: string; build: string };
