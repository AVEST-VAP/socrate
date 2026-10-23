// `socrate.yml` de l'application hôte : la seule configuration que l'hôte écrit. Lue par le plugin Vite et par la CLI.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { originAllowed, projectPolicySchema, stableId, zoneSchema } from '@socrate/contract';
import { english } from './messages.ts';

export const CONFIG_FILE = 'socrate.yml';
export const DEFAULT_ZONES = [{ id: 'home', title: 'Home', route: '/', questions: [] as string[] }];

/** Origine https du service ; http seulement en boucle locale, pour un service lancé par `npm run serve` ou un banc de test. */
export function isServiceOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}

export function renderReviewKey(template: string, pr: number): string {
  return template.replaceAll('{pr}', String(pr));
}

const required = (what: string) => ({ error: (issue: { input: unknown }) => (issue.input === undefined ? `required: ${what}` : `must be a string: ${what}`) });
const relativePath = (what: string) => z.string(required(what)).min(1, `required: ${what}`)
  .refine((p) => !isAbsolute(p) && !p.split(/[\\/]/).includes('..'), `must be a relative path without "..": ${what}`);
const allowedOrigin = projectPolicySchema.shape.allowedOrigin.unwrap();
const manifestText = (what: string) => z.string(required(what)).trim().min(1, 'must not be empty').max(400, 'at most 400 characters')
  .refine((t) => !/[{}]/.test(t.replaceAll('{pr}', '').replaceAll('{title}', '')), 'only the {pr} and {title} placeholders are supported');

export const configSchema = z.strictObject({
  service: z.string(required('the https origin of your Socrate service, e.g. https://my-socrate.example.workers.dev'))
    .refine(isServiceOrigin, 'must be an https origin without path or trailing slash, e.g. https://my-socrate.example.workers.dev'),
  project: z.string(required('the project id configured in the service')).regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase letters, digits and dashes, at most 64 characters'),
  previews: z.string(required('the origin pattern of your previews, e.g. https://*.my-app.pages.dev'))
    .refine((p) => allowedOrigin.safeParse(p).success, 'an exact origin (https://preview.example.com) or a single-label wildcard (https://*.my-app.pages.dev)'),
  label: z.string(required('the pull request label')).trim().min(1, 'must not be empty').max(50, 'at most 50 characters').default('socrate'),
  review: z.string(required('the review key template')).default('pr-{pr}').superRefine((template, ctx) => {
    if (!template.includes('{pr}')) ctx.addIssue({ code: 'custom', message: 'must contain {pr}, the pull request number' });
    else if (/[{}]/.test(template.replaceAll('{pr}', ''))) ctx.addIssue({ code: 'custom', message: 'only the {pr} placeholder is supported' });
    else if (![1, 99_999_999].every((pr) => stableId.safeParse(renderReviewKey(template, pr)).success)) {
      ctx.addIssue({ code: 'custom', message: 'must render a review key of lowercase letters, digits and dashes, at most 64 characters, e.g. pr-{pr}' });
    }
  }),
  before: manifestText('what reviewers saw before the pull request').default('The app before pull request #{pr}.'),
  now: manifestText('what the pull request changes').default('Pull request #{pr}: {title}'),
  csp: relativePath('the headers file of the build output, e.g. _headers').optional(),
  zones: z.array(zoneSchema, { error: 'must be a list of zones { id, title, route }' }).min(1, 'at least one zone').max(30, 'at most 30 zones').optional(),
  manifest: relativePath('the .socrate folder of the pull request').optional(),
}, { error: (issue) => (issue.code === 'invalid_type' ? 'socrate.yml must be a mapping of keys to values' : undefined) });

export type SocrateConfig = z.infer<typeof configSchema>;
export type LoadedConfig = SocrateConfig & { file: string; dir: string; zones: NonNullable<SocrateConfig['zones']> };

export class ConfigError extends Error {}

const describeIssues = (file: string, error: z.ZodError) => error.issues.flatMap((i) => {
  const at = i.path.map(String).join('.');
  if (i.code === 'unrecognized_keys') return i.keys.map((k) => `  ${[at, k].filter(Boolean).join('.')}: unknown key`);
  return [`  ${at || '(file)'}: ${english(i.message)}`];
}).join('\n');

export function parseConfig(text: string, file: string): LoadedConfig {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length) throw new ConfigError(`${file} is not valid YAML:\n${doc.errors.map((e) => `  ${e.message}`).join('\n')}`);
  const r = configSchema.safeParse(doc.toJS() ?? {});
  if (!r.success) throw new ConfigError(`${file} is invalid:\n${describeIssues(file, r.error)}`);
  return { ...r.data, zones: r.data.zones ?? DEFAULT_ZONES, file, dir: dirname(file) };
}

/** Chemin explicite, sinon premier `socrate.yml` en remontant depuis `from`, sans dépasser la racine Git. */
export function findConfig(from: string, explicit?: string): string {
  if (explicit) {
    const file = resolve(from, explicit);
    if (!existsSync(file) || !statSync(file).isFile()) throw new ConfigError(`config file not found: ${file}`);
    return file;
  }
  let dir = resolve(from);
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) return file;
    const parent = dirname(dir);
    if (existsSync(join(dir, '.git')) || parent === dir) throw new ConfigError(`${CONFIG_FILE} not found in ${resolve(from)} or its parents up to ${dir}`);
    dir = parent;
  }
}

export function loadConfig(from: string, explicit?: string): LoadedConfig {
  const file = findConfig(from, explicit);
  return parseConfig(readFileSync(file, 'utf8'), file);
}

export { originAllowed };
