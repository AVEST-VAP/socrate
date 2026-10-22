import { z } from 'zod';

export const MANIFEST_SCHEMA_VERSION = 1;

const shortText = (max: number) => z.string().trim().min(1, 'texte requis').max(max, `au plus ${max} caractères`);
export const stableId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'identifiant en minuscules, chiffres et tirets');
const relativeRoute = z.string().regex(/^\/(?![/\\])[^\s?#]*(\?[^\s#]*)?$/, 'route relative commençant par /');

/** Élément éditorialisé : `data-socrate-id`, et `data-socrate-instance` quand l'identifiant se répète dans une liste. */
export const editorialRefSchema = z.strictObject({
  id: stableId,
  instance: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'contexte d’instance en lettres, chiffres, tirets ou soulignés').optional(),
});
export type EditorialRef = z.infer<typeof editorialRefSchema>;

export const MARKER_KINDS = ['new', 'changed', 'review'] as const;
export const markerSchema = z.strictObject({
  kind: z.enum(MARKER_KINDS),
  target: editorialRefSchema,
  explanation: shortText(280),
});
export type Marker = z.infer<typeof markerSchema>;

// Les champs éditoriaux restent sans défaut : un manifeste déjà importé garde sa forme canonique et son digest.
export const zoneSchema = z.strictObject({
  id: stableId,
  title: shortText(80),
  route: relativeRoute,
  instructions: shortText(280).optional(),
  questions: z.array(shortText(280)).max(10).default([]),
  target: editorialRefSchema.optional(),
  source: shortText(200).optional(),
  markers: z.array(markerSchema).max(20).optional(),
});

/**
 * Texte à relire préparé par l'agent : `source` est le template à modifier, `examples` ses rendus.
 * Aucune clé n'est déduite d'un texte affiché ; seul un élément marqué `data-socrate-wording` s'y rattache.
 */
export const wordingSchema = z.strictObject({
  id: stableId,
  key: shortText(200).optional(),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'langue BCP 47 simple, par exemple fr ou fr-FR'),
  variant: shortText(120).optional(),
  source: shortText(1000),
  examples: z.array(shortText(1000)).max(5).optional(),
  question: shortText(280),
  zone: stableId.optional(),
  context: shortText(280).optional(),
});

// Extension facultative : absente, elle n'entre pas dans la forme canonique et l'identité d'une révision antérieure ne change pas.
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  reviewKey: stableId,
  repository: shortText(120).optional(),
  pullRequest: z.number().int().positive().optional(),
  title: shortText(80),
  before: shortText(400),
  now: shortText(400),
  zones: z.array(zoneSchema).min(1, 'au moins une zone').max(30),
  wordings: z.array(wordingSchema).max(100).optional(),
}).superRefine((m, ctx) => {
  const seen = new Set<string>();
  m.zones.forEach((zone, i) => {
    if (seen.has(zone.id)) ctx.addIssue({ code: 'custom', path: ['zones', i, 'id'], message: `zone en double : ${zone.id}` });
    seen.add(zone.id);
    const marked = new Set<string>();
    zone.markers?.forEach((marker, j) => {
      const ref = editorialKey(marker.target);
      if (marked.has(ref)) ctx.addIssue({ code: 'custom', path: ['zones', i, 'markers', j, 'target'], message: `repère en double : ${ref}` });
      marked.add(ref);
    });
  });
  const wordings = new Set<string>();
  m.wordings?.forEach((w, i) => {
    if (wordings.has(w.id)) ctx.addIssue({ code: 'custom', path: ['wordings', i, 'id'], message: `texte à relire en double : ${w.id}` });
    wordings.add(w.id);
    if (w.zone && !seen.has(w.zone)) ctx.addIssue({ code: 'custom', path: ['wordings', i, 'zone'], message: `zone inconnue : ${w.zone}` });
  });
});

export const editorialKey = (ref: EditorialRef) => (ref.instance ? `${ref.id}#${ref.instance}` : ref.id);

export type Manifest = z.infer<typeof manifestSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type Wording = z.infer<typeof wordingSchema>;

export const indexSchema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  reviewKey: stableId,
  repository: shortText(120).optional(),
  pullRequest: z.number().int().positive().optional(),
  title: shortText(80),
  before: shortText(400),
  now: shortText(400),
  zones: z.array(z.string().min(1)).min(1, 'au moins un fragment de zone'),
  wordings: z.string().min(1).optional(),
});
export type ManifestIndex = z.infer<typeof indexSchema>;

export type ValidationIssue = { file?: string; path: string; message: string };

export function issuesOf(error: z.ZodError, file?: string): ValidationIssue[] {
  return error.issues.flatMap((i) => {
    const base = i.path.map(String);
    if (i.code === 'unrecognized_keys') return i.keys.map((k) => ({ file, path: [...base, k].join('.'), message: 'donnée inconnue refusée' }));
    return [{ file, path: base.join('.') || '(racine)', message: i.message }];
  });
}

export function validateManifest(input: unknown): { ok: true; manifest: Manifest } | { ok: false; issues: ValidationIssue[] } {
  const r = manifestSchema.safeParse(input);
  return r.success ? { ok: true, manifest: r.data } : { ok: false, issues: issuesOf(r.error) };
}
