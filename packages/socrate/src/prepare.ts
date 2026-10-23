// `socrate preview prepare` : décide, dans GitHub Actions, si la pull request reçoit une preview Socrate, et écrit son contexte pour le build.
import { appendFileSync, readFileSync } from 'node:fs';
import { loadConfig, originAllowed, renderReviewKey } from './config.ts';
import { PREVIEW_ENV, checkPreview, isOrigin, previewEnvSchema, type PreviewEnv } from './preview.ts';
import { CliError, type Io } from './io.ts';

type PullRequest = { title: string; labels: { name: string }[] };

const need = (env: Io['env'], name: string) => {
  const value = env[name];
  if (!value) throw new CliError(`${name} is not set: \`socrate preview prepare\` runs in GitHub Actions`);
  return value;
};

// Le label est lu en direct : l'événement garde les labels du moment où il a été émis, un relancement les verrait périmés.
async function readPullRequest(env: Io['env'], repository: string, number: number): Promise<PullRequest> {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new CliError('GITHUB_TOKEN or GH_TOKEN is not set: the pull request labels are read from the GitHub API');
  const url = `${(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')}/repos/${repository}/pulls/${number}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'socrate-cli' },
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
  } catch (e) {
    throw new CliError(`GitHub API unreachable (GET ${url}): ${(e as Error).message}`);
  }
  const body = await res.json().catch(() => null) as (PullRequest & { message?: string }) | null;
  if (!res.ok) throw new CliError(`GitHub API answered ${res.status} to GET ${url}${body?.message ? `: ${body.message}` : ''}`);
  if (!body || typeof body.title !== 'string' || !Array.isArray(body.labels)) throw new CliError(`unexpected GitHub API answer to GET ${url}`);
  return body;
}

// GITHUB_ENV est lu ligne à ligne : U+2028 et U+2029, laissés tels quels par JSON.stringify, sont échappés ; tout autre saut de ligne est refusé.
export function envLine(preview: PreviewEnv): string {
  const line = `${PREVIEW_ENV}=${JSON.stringify(preview).replace(/[\u2028\u2029\u0085]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;
  if (/[\r\n]/.test(line)) throw new CliError(`${PREVIEW_ENV} would span several lines: refused`);
  return line;
}

export async function prepare(io: Io, args: { origin?: string; config?: string }): Promise<void> {
  if (!args.origin) throw new CliError('usage: socrate preview prepare --origin <origin of the preview> [--config socrate.yml]', 2);
  const output = need(io.env, 'GITHUB_OUTPUT');
  const disabled = (why: string) => {
    appendFileSync(output, 'enabled=false\n');
    io.log(`Socrate disabled: ${why}`);
  };
  // Hors pull request, `socrate.yml` n'est pas lu : une branche sans ce fichier, ou qui le casse, garde son build normal.
  if (io.env.GITHUB_EVENT_NAME !== 'pull_request') return disabled(`event ${io.env.GITHUB_EVENT_NAME ?? '(unknown)'} is not pull_request`);
  const config = loadConfig(io.cwd, args.config);

  const event = JSON.parse(readFileSync(need(io.env, 'GITHUB_EVENT_PATH'), 'utf8')) as { pull_request?: { number?: unknown; head?: { sha?: unknown } } };
  const number = event.pull_request?.number;
  const sha = event.pull_request?.head?.sha;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) throw new CliError('the pull_request event has no pull request number');
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) throw new CliError('the pull_request event has no head commit');
  const env = need(io.env, 'GITHUB_ENV');
  const repository = need(io.env, 'GITHUB_REPOSITORY');
  const pr = await readPullRequest(io.env, repository, number);
  if (!pr.labels.some((l) => l.name === config.label)) return disabled(`pull request #${number} has no "${config.label}" label`);

  if (!isOrigin(args.origin)) throw new CliError(`--origin ${JSON.stringify(args.origin)} is not an origin (scheme, host and port, no path or trailing slash)`);
  if (!originAllowed(config.previews, args.origin)) throw new CliError(`--origin ${args.origin} does not match previews (${config.previews}) of ${config.file}`);
  const run = need(io.env, 'GITHUB_RUN_ID');
  const attempt = io.env.GITHUB_RUN_ATTEMPT || '1';
  if (!/^\d{1,20}$/.test(run) || !/^\d{1,5}$/.test(attempt)) throw new CliError('GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be numbers');

  const reviewKey = renderReviewKey(config.review, number);
  const parsed = previewEnvSchema.safeParse({
    serviceUrl: config.service, projectId: config.project, reviewKey, deploymentId: `pr-${number}-${sha.slice(0, 12)}-${run}-${attempt}`, origin: args.origin,
    pullRequest: number, commit: sha, buildId: `${run}-${attempt}`, title: pr.title.trim() || `Pull request #${number}`, ...(repository.length <= 120 && { repository }),
  } satisfies PreviewEnv);
  if (!parsed.success) throw new CliError(`preview context refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const preview = checkPreview(parsed.data, config);
  const line = envLine(preview);
  appendFileSync(env, `${line}\n`);
  appendFileSync(output, `enabled=true\nreview=${preview.reviewKey}\ndeployment=${preview.deploymentId}\n`);
  io.log(`Socrate enabled for pull request #${number}: review ${preview.reviewKey}, deployment ${preview.deploymentId}, origin ${preview.origin}`);
}
