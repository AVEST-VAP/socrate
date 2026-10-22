import { issuesOf, migrationListSchema, serviceConfigSchema, type InstanceIdentity, type MigrationRef, type ServiceConfig } from '@socrate/contract';
import { HttpError } from './http.ts';

export type { ServiceConfig };

export type Env = { DB: D1Database; CAPTURES: R2Bucket; ASSETS: Fetcher; SOCRATE_CONFIG: string; SOCRATE_SCHEMA: string; SOCRATE_INSTANCE: string; SOCRATE_MAINTENANCE?: 'exclusive' };

const misconfigured = (what: string) => new HttpError(500, 'misconfigured', `configuration du service invalide : ${what}`);

const configCache = new Map<string, ServiceConfig>();

export function readConfig(env: Env): ServiceConfig {
  const cached = configCache.get(env.SOCRATE_CONFIG);
  if (cached) return cached;
  let raw: unknown;
  try {
    raw = JSON.parse(env.SOCRATE_CONFIG);
  } catch {
    throw misconfigured('SOCRATE_CONFIG illisible');
  }
  const parsed = serviceConfigSchema.safeParse(raw);
  if (!parsed.success) throw misconfigured(issuesOf(parsed.error).map((i) => `${i.path} ${i.message}`).join(' ; '));
  configCache.set(env.SOCRATE_CONFIG, parsed.data);
  return parsed.data;
}

export function readInstance(env: Env): InstanceIdentity {
  try {
    const i = JSON.parse(env.SOCRATE_INSTANCE) as InstanceIdentity;
    if (typeof i.instanceId !== 'string' || typeof i.build !== 'string') throw new Error();
    return i;
  } catch {
    throw misconfigured('SOCRATE_INSTANCE doit porter instanceId et build');
  }
}

export function expectedSchema(env: Env): MigrationRef[] {
  let raw: unknown;
  try {
    raw = JSON.parse(env.SOCRATE_SCHEMA);
  } catch {
    throw misconfigured('SOCRATE_SCHEMA illisible');
  }
  const parsed = migrationListSchema.safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) throw misconfigured('SOCRATE_SCHEMA doit lister les migrations attendues');
  return parsed.data;
}

const notReady = () => new HttpError(503, 'not_ready', 'schéma non migré, instance pas encore prête', true);

let schemaReady: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = checkSchema(env).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

async function checkSchema(env: Env): Promise<void> {
  const expected = expectedSchema(env);
  let rows: { id: string; checksum: string }[];
  try {
    rows = (await env.DB.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all<{ id: string; checksum: string }>()).results;
  } catch {
    throw notReady();
  }
  const prefix = rows.every((r, i) => expected[i] !== undefined && expected[i]!.id === r.id && expected[i]!.checksum === r.checksum);
  if (!prefix) throw new HttpError(500, 'schema_incompatible', 'schéma de la base incompatible avec ce build (migration inconnue, trou ou checksum divergent) : aucune réinitialisation automatique', false);
  if (rows.length < expected.length) throw notReady();
}
