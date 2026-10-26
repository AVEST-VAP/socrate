// Jetons délégués des agents, rangés par service, projet et agent dans un fichier privé de l'utilisateur, jamais dans le dépôt.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CliError, secrets, type Io } from './io.ts';

const entrySchema = z.object({
  service: z.string(), projectId: z.string(), agent: z.string(), tokenId: z.string(), token: z.string(), machine: z.string(),
  actor: z.object({ key: z.string(), displayName: z.string() }), capabilities: z.array(z.string()), expiresAt: z.string(),
});
const fileSchema = z.object({ version: z.literal(1), tokens: z.array(entrySchema) });
export type StoredToken = z.infer<typeof entrySchema>;

/** `$XDG_CONFIG_HOME/socrate/credentials.json`, par défaut `~/.config/socrate/credentials.json`. */
export function credentialsPath(env: Io['env']): string {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : null);
  if (!base) throw new CliError('neither XDG_CONFIG_HOME nor HOME is set: no place to store the agent credentials');
  return join(resolve(base), 'socrate', 'credentials.json');
}

export function readTokens(env: Io['env']): StoredToken[] {
  const file = credentialsPath(env);
  if (!existsSync(file)) return [];
  let parsed: z.infer<typeof fileSchema>;
  try {
    parsed = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new CliError(`${file} is not a Socrate credentials file: remove it, then run npx @meyer0x/socrate login again`);
  }
  for (const t of parsed.tokens) secrets.add(t.token);
  return parsed.tokens;
}

/** Dossier en 0700, fichier en 0600, écrit à côté puis renommé : jamais un fichier à moitié écrit ni lisible par un autre compte. */
export function writeTokens(env: Io['env'], tokens: StoredToken[]): string {
  const file = credentialsPath(env);
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new CliError(`cannot write ${file}: ${(e as Error).message}`);
  }
  return file;
}

export const sameSlot = (a: Pick<StoredToken, 'service' | 'projectId' | 'agent'>, b: Pick<StoredToken, 'service' | 'projectId' | 'agent'>) =>
  a.service === b.service && a.projectId === b.projectId && a.agent.toLowerCase() === b.agent.toLowerCase();
