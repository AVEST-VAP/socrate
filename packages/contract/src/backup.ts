import { z } from 'zod';
import { ATTACHMENT_TYPE_LIST, type AttachmentType } from './attachments.ts';

/** Format 2 : format 1 plus les pièces jointes rattachées et leurs objets. Le format 1 reste lu et restauré. */
export const BACKUP_FORMAT = 'socrate-sauvegarde/2';
export const BACKUP_FORMAT_V1 = 'socrate-sauvegarde/1';

/** Tables exportées, dans un ordre d'insertion compatible avec les clés étrangères : une pièce suit son message. */
export const BACKUP_TABLES = ['reviews', 'revisions', 'deployments', 'threads', 'messages', 'attachments', 'captures', 'targets', 'proposals', 'operations', 'changes', 'consumed_assertions', 'purge_log'] as const;
/** Tables du format 1, sans pièces jointes. */
export const BACKUP_TABLES_V1 = ['reviews', 'revisions', 'deployments', 'threads', 'messages', 'captures', 'targets', 'proposals', 'operations', 'changes', 'consumed_assertions', 'purge_log'] as const;
/** Migrations postérieures au format 1, toutes additives : une sauvegarde au format 1 se restaure sur ce schéma avec leurs tables vides. */
export const ADDED_SINCE_V1 = ['0007_attachments.sql', '0008_agent_tokens.sql'] as const;
/** Migrations additives postérieures aux premières sauvegardes au format 2 : tables non exportées et colonnes nulles, une sauvegarde sans elles se restaure. */
export const ADDED_SINCE_V2 = ['0008_agent_tokens.sql'] as const;

/** Extension du fichier d'objet de chaque type de pièce ; une capture garde `.png`. */
export const OBJECT_EXTENSION: Record<AttachmentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime();
const segment = '[a-z0-9][a-z0-9-]{0,63}';
const uuid = z.string().regex(/^[0-9a-f-]{36}$/);

const captureObject = z.strictObject({
  key: z.string().regex(new RegExp(`^captures/${segment}/${segment}/[0-9a-f-]{36}\\.png$`)),
  file: z.string().regex(/^objects\/[0-9a-f]{64}\.png$/),
  size: z.number().int().min(1),
  sha256,
  captureId: uuid,
});
const attachmentObject = z.strictObject({
  key: z.string().regex(new RegExp(`^attachments/${segment}/${segment}/[0-9a-f-]{36}$`)),
  file: z.string().regex(/^objects\/[0-9a-f]{64}\.(?:png|jpg|webp|mp4|webm)$/),
  size: z.number().int().min(1),
  sha256,
  attachmentId: uuid,
  contentType: z.enum(ATTACHMENT_TYPE_LIST as [AttachmentType, ...AttachmentType[]]),
});

const common = {
  createdAt: instant,
  sourceInstanceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  build: sha256,
  retention: z.string().max(1000),
  schema: z.array(z.strictObject({ id: z.string().regex(/^[0-9]{4}_[a-z0-9_]{1,64}\.sql$/), checksum: sha256 })).max(100),
  epochAtBackup: z.string().regex(/^[0-9a-f]{32}$/),
  frozenSince: instant,
  notExported: z.record(z.string().max(64), z.string().max(1000)),
  objectsNotExported: z.array(z.string().max(512)),
};

/** Hors de l'index du contrat : ni le Worker ni le panneau n'embarquent ce schéma local. Manifeste d'une sauvegarde, validé avant tout effet : chemins, empreintes, tailles et compteurs n'ont qu'une forme admise. */
export const backupManifestSchema = z.discriminatedUnion('format', [
  z.strictObject({
    format: z.literal(BACKUP_FORMAT_V1),
    ...common,
    tables: z.array(z.strictObject({ name: z.enum(BACKUP_TABLES_V1), file: z.string().regex(/^tables\/[a-z_]{1,64}\.json$/), rows: z.number().int().min(0), sha256 })),
    objects: z.array(captureObject),
  }),
  z.strictObject({
    format: z.literal(BACKUP_FORMAT),
    ...common,
    tables: z.array(z.strictObject({ name: z.enum(BACKUP_TABLES), file: z.string().regex(/^tables\/[a-z_]{1,64}\.json$/), rows: z.number().int().min(0), sha256 })),
    objects: z.array(z.union([captureObject, attachmentObject])),
  }),
]);
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** Valeurs admises dans une ligne de table : celles que D1 rend pour ces schémas, jamais un objet ou un tableau. */
export const backupRowSchema = z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/), z.union([z.string(), z.number(), z.null()]));
