// Contexte d'une preview, écrit par `socrate preview prepare` dans `SOCRATE_PREVIEW` et relu par le plugin Vite et par `register`.
import { z } from 'zod';
import { originAllowed, renderReviewKey, type LoadedConfig } from './config.ts';

export const PREVIEW_ENV = 'SOCRATE_PREVIEW';
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase letters, digits and dashes, at most 64 characters');

export const previewEnvSchema = z.strictObject({
  serviceUrl: z.string(),
  projectId: id,
  reviewKey: id,
  deploymentId: id,
  origin: z.string(),
  pullRequest: z.number().int().positive(),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/, 'hexadecimal commit, 7 to 64 characters'),
  buildId: z.string().min(1).max(64),
  repository: z.string().min(1).max(120).optional(),
  title: z.string().min(1),
});
export type PreviewEnv = z.infer<typeof previewEnvSchema>;

/** Ce que le client reçoit au build : `import.meta.env.SOCRATE`. */
export type SocratePreview = Pick<PreviewEnv, 'serviceUrl' | 'projectId' | 'reviewKey' | 'deploymentId' | 'origin'>;

export class PreviewError extends Error {}

export function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** Refuse toute incohérence entre le contexte et `socrate.yml` : un build de preview ne vise jamais un autre service, projet ou domaine. */
export function checkPreview(preview: PreviewEnv, config: LoadedConfig): PreviewEnv {
  const problems: string[] = [];
  if (preview.serviceUrl !== config.service) problems.push(`serviceUrl ${JSON.stringify(preview.serviceUrl)} is not the service of ${config.file} (${config.service})`);
  if (preview.projectId !== config.project) problems.push(`projectId ${JSON.stringify(preview.projectId)} is not the project of ${config.file} (${config.project})`);
  if (!isOrigin(preview.origin)) problems.push(`origin ${JSON.stringify(preview.origin)} is not an origin (scheme, host and port, no path)`);
  else if (!originAllowed(config.previews, preview.origin)) problems.push(`origin ${preview.origin} does not match previews (${config.previews})`);
  const expected = renderReviewKey(config.review, preview.pullRequest);
  if (preview.reviewKey !== expected) problems.push(`reviewKey ${JSON.stringify(preview.reviewKey)} does not follow the review template (${expected} expected)`);
  if (problems.length) throw new PreviewError(`${PREVIEW_ENV} does not match ${config.file}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return preview;
}

export function parsePreview(raw: string, config: LoadedConfig): PreviewEnv {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new PreviewError(`${PREVIEW_ENV} is not JSON (${(e as Error).message}); it is written by \`socrate preview prepare\``);
  }
  const r = previewEnvSchema.safeParse(json);
  if (!r.success) {
    const lines = r.error.issues.flatMap((i) => i.code === 'unrecognized_keys' ? i.keys.map((k) => `  ${k}: unknown key`) : [`  ${i.path.join('.') || '(value)'}: ${i.message}`]);
    throw new PreviewError(`${PREVIEW_ENV} is invalid:\n${lines.join('\n')}`);
  }
  return checkPreview(r.data, config);
}

export const clientPreview = ({ serviceUrl, projectId, reviewKey, deploymentId, origin }: PreviewEnv): SocratePreview => ({ serviceUrl, projectId, reviewKey, deploymentId, origin });
