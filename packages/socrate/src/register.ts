// `socrate preview register` : enregistre la preview déployée auprès du service, avec son manifeste.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MANIFEST_SCHEMA_VERSION, issuesOf, manifestSchema, type Manifest } from '@socrate/contract';
import { assembleManifest } from '@socrate/contract/assemble';
import { loadConfig, type LoadedConfig } from './config.ts';
import { PREVIEW_ENV, parsePreview, type PreviewEnv } from './preview.ts';
import { CliError, type Io } from './io.ts';
import { describeIssue } from './messages.ts';

export const TOKEN_ENV = 'SOCRATE_IMPORT_TOKEN';

/** Coupe au caractère près, sans casser une paire de substitution, avec une ellipse quand le texte dépasse. */
export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  let out = '';
  for (const char of trimmed) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

function validated(manifest: unknown, what: string): Manifest {
  const r = manifestSchema.safeParse(manifest);
  if (!r.success) throw new CliError(`${what} refused:\n${issuesOf(r.error).map(describeIssue).join('\n')}`);
  return r.data;
}

export function genericManifest(config: LoadedConfig, preview: PreviewEnv): Manifest {
  const n = preview.pullRequest;
  // Un seul passage : un titre qui contient `{pr}` reste tel quel.
  const text = (template: string) => truncate(template.replace(/\{(pr|title)\}/g, (_, key) => (key === 'pr' ? String(n) : preview.title.trim())), 400);
  return validated({
    schemaVersion: MANIFEST_SCHEMA_VERSION, reviewKey: preview.reviewKey, ...(preview.repository && { repository: preview.repository }), pullRequest: n,
    title: truncate(preview.title, 80), before: text(config.before), now: text(config.now), zones: config.zones,
  }, 'generic manifest');
}

// Le dossier `.socrate/` est écrit avant que la pull request n'ait un numéro : la clé de revue de la preview fait foi.
export async function buildManifest(config: LoadedConfig, preview: PreviewEnv, io: Io): Promise<Manifest> {
  if (!config.manifest) return genericManifest(config, preview);
  const dir = resolve(config.dir, config.manifest);
  if (!existsSync(dir)) {
    io.log(`no ${config.manifest} folder in this checkout: generic manifest`);
    return genericManifest(config, preview);
  }
  const r = await assembleManifest(dir);
  if (!r.ok) throw new CliError(`${dir} refused:\n${r.issues.map((i) => describeIssue({ ...i, file: i.file ?? '(manifest)' })).join('\n')}`);
  const m = r.manifest;
  return validated({
    ...m, reviewKey: preview.reviewKey, pullRequest: m.pullRequest ?? preview.pullRequest, ...(!m.repository && preview.repository && { repository: preview.repository }),
  }, dir);
}

export async function register(io: Io, args: { url?: string; config?: string }): Promise<void> {
  if (!args.url) throw new CliError('usage: socrate preview register --url <deployed preview URL> [--config socrate.yml]', 2);
  const config = loadConfig(io.cwd, args.config);
  const raw = io.env[PREVIEW_ENV];
  if (!raw) throw new CliError(`${PREVIEW_ENV} is not set: run \`socrate preview prepare\` in an earlier step of the same job, and register only when its output enabled is true`);
  const preview = parsePreview(raw, config);
  const token = io.env[TOKEN_ENV];
  if (!token) throw new CliError(`${TOKEN_ENV} is not set: give the deployment.import token of the project as a CI secret`);
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    throw new CliError(`--url ${JSON.stringify(args.url)} is not a URL`);
  }
  // Le client ne se rend que sur l'origine du build : une autre origine enregistrerait une preview inutilisable.
  if (url.origin !== preview.origin) throw new CliError(`--url ${args.url} is not on the origin of the build (${preview.origin}); register the URL the reviewers open`);
  const manifest = await buildManifest(config, preview, io);

  const endpoint = `${config.service}/v1/projects/${preview.projectId}/reviews/${preview.reviewKey}/deployments/${preview.deploymentId}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ commit: preview.commit, buildId: preview.buildId, url: url.href, manifest }),
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
  } catch (e) {
    throw new CliError(`Socrate service unreachable (PUT ${endpoint}): ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let body: { code?: string; message?: string; issues?: { file?: string; path: string; message: string }[] } | null = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const issues = body?.issues?.map((i) => `\n${describeIssue(i)}`).join('') ?? '';
    throw new CliError(`the Socrate service refused the deployment: ${res.status} ${body?.code ?? ''}${body?.message ? `: ${body.message}` : text ? `: ${text.slice(0, 300)}` : ''}${issues}`);
  }
  io.log(`registered deployment ${preview.deploymentId} of review ${preview.reviewKey} (${res.status}) for ${url.href}`);
}
