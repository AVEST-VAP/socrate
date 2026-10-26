import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { attachmentMetaSchema, SIGNATURE_BYTES, signatureMatches, issuesOf } from '@socrate/contract';
import { ADDED_SINCE_V1, ADDED_SINCE_V2, BACKUP_FORMAT, BACKUP_FORMAT_V1, BACKUP_TABLES, BACKUP_TABLES_V1, OBJECT_EXTENSION, backupManifestSchema, backupRowSchema, type BackupManifest } from '@socrate/contract/backup';
import { guardedPath, guardedTree, LocalRefusal, runtime } from './local-run.ts';
const { listMigrations } = await runtime();
import { Maintenance } from './maintenance.ts';

export { BACKUP_FORMAT, type BackupManifest };
export const BACKUP_RETENTION = 'Conservée jusqu’à suppression manuelle explicite de ce dossier, sans expiration automatique. Une purge de l’instance active ne modifie ni ne supprime une sauvegarde déjà faite.';

/** Seules les captures validées, les pièces rattachées et leurs objets sont exportés. */
const EXPORTED = BACKUP_TABLES;
const EXPORTED_WHERE: Partial<Record<(typeof EXPORTED)[number], string>> = { captures: " WHERE state = 'committed'", attachments: " WHERE state = 'attached'" };
const NOT_EXPORTED: Record<string, string> = {
  sessions: 'révoquées par construction : aucune session ne survit à la restauration',
  technical_credentials: 'révoqués par construction : la restauration émet de nouveaux accès locaux',
  agent_tokens: 'jetons délégués révoqués par construction : chaque agent refait socrate login',
  device_authorizations: 'codes de connexion d’agent, éphémères',
  device_attempts: 'essais de codes, éphémères',
  listings: 'listes figées temporaires, invalidées par la nouvelle epoch',
  listing_items: 'listes figées temporaires',
  sync_epoch: 'renouvelée à la restauration : curseurs et marqueurs antérieurs en 410',
  purge_objects: 'vide : aucune sauvegarde pendant une purge inachevée',
  maintenance: 'état du gel propre à l’instance',
  restorations: 'propre à chaque instance',
};

type Db = Maintenance['db'];
type TableEntry = BackupManifest['tables'][number];
type ObjectEntry = BackupManifest['objects'][number];
type Row = Record<string, string | number | null>;

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

async function writeNew(path: string, content: Uint8Array | string): Promise<void> {
  await writeFile(guardedPath(path), content, { flag: 'wx', mode: 0o600 });
}

/** Gel D1 : les déclencheurs de 0006 avortent toute écriture D1, même en vol. Il ne bloque aucun PUT R2 : l'exclusion vient de la maintenance. */
export async function freeze(db: Db, reason: string): Promise<string> {
  const since = new Date().toISOString();
  const row = await db.prepare('UPDATE maintenance SET frozen = 1, reason = ?, since = ? WHERE singleton = 1 AND frozen = 0 RETURNING since').bind(reason, since).first<{ since: string }>();
  if (!row) throw new LocalRefusal('already_frozen', 'instance déjà gelée : une sauvegarde est en cours ou s’est interrompue (npm run sauvegarde -- degeler après vérification)');
  return row.since;
}

export async function thaw(db: Db): Promise<void> {
  await db.prepare('UPDATE maintenance SET frozen = 0, reason = NULL, since = NULL WHERE singleton = 1').run();
}

/**
 * Export logique par les API D1 et R2 de Miniflare, jamais par copie de leurs fichiers internes. Il n'accepte que la phase de
 * maintenance exclusive : aucun écrivain ne peut modifier D1 ou R2 entre la lecture des lignes et l'inventaire des objets.
 */
export async function exportBackup(m: Maintenance, dir: string): Promise<{ dir: string; manifestSha256: string; manifest: BackupManifest }> {
  Maintenance.assert(m);
  const root = guardedPath(dir);
  if (existsSync(root)) throw new LocalRefusal('backup_exists', `dossier de sauvegarde ${root} déjà présent : jamais réécrit`);
  await mkdir(join(root, 'tables'), { recursive: true });
  await mkdir(join(root, 'objects'), { recursive: true });
  const db = m.db;
  const frozenSince = await freeze(db, 'sauvegarde logique');
  try {
    const purging = await db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE state = 'purging'").first<{ n: number }>();
    if (purging!.n > 0) throw new LocalRefusal('purge_pending', `${purging!.n} revue(s) en cours de purge : terminer la purge avant de sauvegarder`);
    const epoch = (await db.prepare('SELECT epoch FROM sync_epoch WHERE singleton = 1').first<{ epoch: string }>())!.epoch;
    const tables: TableEntry[] = [];
    let captures: { capture_id: string; object_key: string; sha256: string; size: number }[] = [];
    let attachments: { attachment_id: string; object_key: string; sha256: string; size: number; content_type: keyof typeof OBJECT_EXTENSION }[] = [];
    for (const name of EXPORTED) {
      const rows = (await db.prepare(`SELECT * FROM ${name}${EXPORTED_WHERE[name] ?? ''} ORDER BY rowid`).all<Record<string, unknown>>()).results;
      if (name === 'captures') captures = rows as typeof captures;
      if (name === 'attachments') attachments = rows as typeof attachments;
      const body = JSON.stringify(rows);
      const file = `tables/${name}.json`;
      await writeNew(join(root, file), body);
      tables.push({ name, file, rows: rows.length, sha256: sha(body) });
    }
    const bucket = m.bucket;
    const objects: ObjectEntry[] = [];
    // Un objet à la fois : une vidéo de 50 Mio n'est jamais tenue avec une autre.
    const copy = async (key: string, expected: { sha256: string; size: number }, extension: string, what: string) => {
      const obj = await bucket.get(key);
      if (!obj) throw new LocalRefusal('object_missing', `objet ${key} d’une ${what} absent du stockage : sauvegarde refusée`);
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const digest = sha(bytes);
      if (digest !== expected.sha256 || bytes.byteLength !== expected.size) throw new LocalRefusal('object_altered', `objet ${key} différent de sa ligne : sauvegarde refusée`);
      const file = `objects/${digest}.${extension}`;
      if (!existsSync(join(root, file))) await writeNew(join(root, file), bytes);
      return { key, file, size: bytes.byteLength, sha256: digest };
    };
    for (const c of captures) objects.push({ ...(await copy(c.object_key, c, 'png', 'capture validée')), captureId: c.capture_id });
    for (const a of attachments) objects.push({ ...(await copy(a.object_key, a, OBJECT_EXTENSION[a.content_type], 'pièce rattachée')), attachmentId: a.attachment_id, contentType: a.content_type });
    const exportedKeys = new Set(objects.map((o) => o.key));
    const objectsNotExported: string[] = [];
    for (const prefix of ['captures/', 'attachments/']) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const o of page.objects) if (!exportedKeys.has(o.key)) objectsNotExported.push(o.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, createdAt: new Date().toISOString(), sourceInstanceId: m.instanceId, build: m.build, retention: BACKUP_RETENTION,
      schema: (await listMigrations()).map(({ id, checksum }) => ({ id, checksum })), epochAtBackup: epoch, frozenSince,
      tables, objects, notExported: NOT_EXPORTED, objectsNotExported,
    };
    const text = JSON.stringify(manifest, null, 1);
    await writeNew(join(root, 'manifest.json'), text);
    return { dir: root, manifestSha256: sha(text), manifest };
  } finally {
    await thaw(db);
  }
}

const FILE_NAME = /^(?:manifest\.json|tables\/[a-z_]+\.json|objects\/[0-9a-f]{64}\.(?:png|jpg|webp|mp4|webm))$/;
const SHA256 = /^[0-9a-f]{64}$/;

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(relative(root, p));
      else throw new LocalRefusal('backup_unexpected', `${relative(root, p)} n’est ni un fichier ni un dossier : refusé`);
    }
  };
  await walk(root);
  return out.sort();
}

export type VerifiedBackup = { manifest: BackupManifest; manifestSha256: string; tables: { name: TableEntry['name']; rows: Row[] }[]; objects: { entry: ObjectEntry; bytes: Uint8Array }[] };

const refuse = (what: string) => new LocalRefusal('backup_invalid', `sauvegarde invalide : ${what}`);

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw refuse(`${what} n’est pas du JSON`);
  }
}

/**
 * Intégrité, forme et périmètre avant tout effet. L'empreinte attendue du manifeste, notée à la sauvegarde, est obligatoire :
 * elle ancre tous les autres fichiers. Aucun lien, fichier manquant, en trop ou altéré ; compteurs, tailles et relations entre
 * captures et objets vérifiés ; schéma identique au build. Les octets lus ici sont ceux que la restauration écrira.
 */
export async function verifyBackup(dir: string, expectedManifestSha256: string): Promise<VerifiedBackup> {
  if (typeof expectedManifestSha256 !== 'string' || !SHA256.test(expectedManifestSha256)) throw new LocalRefusal('missing_fingerprint', 'empreinte SHA-256 attendue du manifeste requise (--empreinte, notée à la sauvegarde)');
  const root = guardedTree(dir).path;
  const files = await filesUnder(root);
  const bad = files.filter((f) => !FILE_NAME.test(f));
  if (bad.length) throw new LocalRefusal('backup_unexpected', `fichiers hors du format de sauvegarde : ${bad.join(', ')}`);
  if (!files.includes('manifest.json')) throw new LocalRefusal('backup_missing', 'manifest.json absent');
  const text = await readFile(join(root, 'manifest.json'), 'utf8');
  const manifestSha256 = sha(text);
  if (manifestSha256 !== expectedManifestSha256) throw new LocalRefusal('backup_altered', `empreinte du manifeste ${manifestSha256} différente de celle attendue`);
  const parsed = backupManifestSchema.safeParse(parseJson(text, 'manifest.json'));
  if (!parsed.success) throw refuse(`manifeste hors forme (${issuesOf(parsed.error).map((i) => `${i.path} ${i.message}`).join(' ; ')})`);
  const manifest = parsed.data;
  const v1 = manifest.format === BACKUP_FORMAT_V1;
  const scope: readonly string[] = v1 ? BACKUP_TABLES_V1 : EXPORTED;
  if (manifest.tables.map((t) => t.name).join() !== scope.join()) throw new LocalRefusal('backup_scope', `liste des tables différente du périmètre exporté au format ${manifest.format}`);
  for (const t of manifest.tables) if (t.file !== `tables/${t.name}.json`) throw refuse(`fichier ${t.file} pour la table ${t.name}`);
  for (const o of manifest.objects) {
    const extension = 'attachmentId' in o ? OBJECT_EXTENSION[o.contentType] : 'png';
    if (o.file !== `objects/${o.sha256}.${extension}`) throw refuse(`fichier ${o.file} pour l’objet ${o.key}`);
  }
  const listed = new Map<string, string>([...manifest.tables.map((t) => [t.file, t.sha256] as const), ...manifest.objects.map((o) => [o.file, o.sha256] as const)]);
  const missing = [...listed.keys()].filter((f) => !files.includes(f));
  const extra = files.filter((f) => f !== 'manifest.json' && !listed.has(f));
  if (missing.length || extra.length) throw new LocalRefusal('backup_incomplete', `manquants : ${missing.join(', ') || 'aucun'} ; en trop : ${extra.join(', ') || 'aucun'}`);
  const read = new Map<string, Buffer>();
  for (const [f, digest] of listed) {
    const bytes = await readFile(join(root, f));
    if (sha(bytes) !== digest) throw new LocalRefusal('backup_altered', `${f} altéré : empreinte différente du manifeste`);
    read.set(f, bytes);
  }
  // Schéma du build, ou ce schéma sans les migrations additives ajoutées depuis le format, qui restent alors vides ; jamais un autre écart.
  const build = await listMigrations();
  const added: readonly string[] = v1 ? ADDED_SINCE_V1 : ADDED_SINCE_V2;
  const older = build.filter((m) => !added.includes(m.id));
  if (older.length + added.length !== build.length) throw new LocalRefusal('backup_schema', `migrations additives du format ${manifest.format} absentes du build : restauration refusée`);
  const schemaText = (list: { id: string; checksum: string }[]) => list.map(({ id, checksum }) => `${id}:${checksum}`).join();
  const accepted = v1 ? [schemaText(older)] : [schemaText(build), schemaText(older)];
  if (!accepted.includes(schemaText(manifest.schema))) throw new LocalRefusal('backup_schema', `schéma de la sauvegarde (${manifest.format}) différent de celui du build : restauration refusée`);
  const tables = manifest.tables.map((t) => {
    const data = parseJson(read.get(t.file)!.toString('utf8'), t.file);
    if (!Array.isArray(data)) throw refuse(`${t.file} n’est pas une liste de lignes`);
    const rows = data.map((r, i) => {
      const row = backupRowSchema.safeParse(r);
      if (!row.success) throw refuse(`${t.file} ligne ${i} hors forme (${issuesOf(row.error).map((x) => `${x.path} ${x.message}`).join(' ; ')})`);
      return row.data;
    });
    if (rows.length !== t.rows) throw refuse(`${t.file} contient ${rows.length} ligne(s), le manifeste en annonce ${t.rows}`);
    return { name: t.name, rows };
  });
  const rowsOf = (name: string) => tables.find((t) => t.name === name)?.rows ?? [];
  const captures = rowsOf('captures');
  const attachments = rowsOf('attachments');
  const byKey = new Map<string, BackupManifest['objects'][number]>(manifest.objects.map((o) => [o.key, o]));
  if (byKey.size !== manifest.objects.length || captures.length + attachments.length !== manifest.objects.length) throw refuse('objets, captures validées et pièces rattachées ne se correspondent pas un à un');
  for (const c of captures) {
    const o = byKey.get(String(c.object_key));
    if (c.state !== 'committed' || !o || !('captureId' in o) || o.sha256 !== c.sha256 || o.size !== c.size || o.captureId !== c.capture_id || o.key !== `captures/${c.project_id}/${c.review_key}/${c.capture_id}.png`) {
      throw refuse(`capture ${String(c.capture_id)} sans objet identique dans le manifeste`);
    }
  }
  const messageKey = (m: Row) => `${m.project_id}\u0000${m.review_key}\u0000${m.thread_id}\u0000${m.message_id}`;
  const messages = new Map(rowsOf('messages').map((m) => [messageKey(m), m]));
  const positions = new Set<string>();
  for (const a of attachments) {
    const o = byKey.get(String(a.object_key));
    if (a.state !== 'attached' || a.uploaded !== 1 || !o || !('attachmentId' in o) || o.sha256 !== a.sha256 || o.size !== a.size || o.attachmentId !== a.attachment_id || o.contentType !== a.content_type
      || o.key !== `attachments/${a.project_id}/${a.review_key}/${a.attachment_id}`) {
      throw refuse(`pièce ${String(a.attachment_id)} sans objet identique dans le manifeste`);
    }
    const message = messages.get(messageKey(a));
    if (!message) throw refuse(`pièce ${String(a.attachment_id)} rattachée à un message absent de la sauvegarde`);
    const metadata = attachmentMetaSchema.safeParse({ name: a.name, contentType: a.content_type, size: a.size, sha256: a.sha256 });
    if (!metadata.success || !signatureMatches(metadata.data.contentType, read.get(o.file)!.subarray(0, SIGNATURE_BYTES))) throw refuse(`pièce ${String(a.attachment_id)} : métadonnées ou signature invalides`);
    const position = `${messageKey(a)}\u0000${a.position}`;
    if (a.actor_key !== message.author_key || typeof a.position !== 'number' || !Number.isInteger(a.position) || a.position < 0 || a.position > 3 || positions.has(position)) throw refuse(`pièce ${String(a.attachment_id)} : auteur ou position invalide`);
    positions.add(position);
  }
  const objects = manifest.objects.map((entry) => {
    const bytes = new Uint8Array(read.get(entry.file)!);
    if (bytes.byteLength !== entry.size) throw refuse(`${entry.file} : ${bytes.byteLength} octets, ${entry.size} annoncés`);
    return { entry, bytes };
  });
  return { manifest, manifestSha256, tables, objects };
}

export type Restored = { restoredAt: string; backupCreatedAt: string; manifestSha256: string; rows: Record<string, number>; objects: number; epoch: string };

/** Colonnes de la cible lues par PRAGMA : un nom de colonne n'est jamais repris d'un fichier sans figurer dans cette liste. */
async function columnsOf(db: Db, table: string): Promise<Set<string>> {
  return new Set((await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name));
}

/**
 * Restaure dans une instance vierge et isolée, sous maintenance exclusive ; l'epoch est renouvelée, aucune session ni aucun accès
 * n'est repris. Une ligne `restorations` datée `in_progress` précède la première écriture et ne passe `complete` qu'après lignes,
 * images et epoch vérifiées : une restauration interrompue reste marquée, refusée au démarrage, jamais présentée comme réussie.
 */
export async function restoreBackup(m: Maintenance, dir: string, expectedManifestSha256: string): Promise<Restored> {
  Maintenance.assert(m);
  const { manifest, manifestSha256, tables, objects } = await verifyBackup(dir, expectedManifestSha256);
  const db = m.db;
  const bucket = m.bucket;
  for (const name of [...EXPORTED, 'restorations', 'technical_credentials', 'sessions', 'agent_tokens']) {
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first<{ n: number }>())!.n;
    if (n > 0) throw new LocalRefusal('target_not_empty', `instance cible non vierge (${name} : ${n} ligne(s)) : restauration refusée, jamais substituée à une instance active`);
  }
  if ((await bucket.list({ limit: 1 })).objects.length) throw new LocalRefusal('target_not_empty', 'stockage R2 de la cible non vide : restauration refusée');
  const statements = [];
  for (const t of tables) {
    const known = await columnsOf(db, t.name);
    for (const r of t.rows) {
      const cols = Object.keys(r);
      const unknown = cols.filter((c) => !known.has(c));
      if (unknown.length) throw refuse(`colonnes inconnues de ${t.name} : ${unknown.join(', ')}`);
      statements.push({ table: t.name, cols, values: cols.map((c) => r[c]!) });
    }
  }
  const startedAt = new Date().toISOString();
  await db.prepare("INSERT INTO restorations (manifest_sha256, state, started_at, backup_created_at, source_instance_id) VALUES (?, 'in_progress', ?, ?, ?)")
    .bind(manifestSha256, startedAt, manifest.createdAt, manifest.sourceInstanceId).run();
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50).map((x) => db.prepare(`INSERT INTO ${x.table} (${x.cols.join(', ')}) VALUES (${x.cols.map(() => '?').join(', ')})`).bind(...x.values)));
  }
  const rows = Object.fromEntries(tables.map((t) => [t.name, t.rows.length]));
  for (const { entry: o, bytes } of objects) {
    await bucket.put(o.key, bytes, 'attachmentId' in o
      ? { httpMetadata: { contentType: o.contentType }, customMetadata: { sha256: o.sha256, attachmentId: o.attachmentId } }
      : { httpMetadata: { contentType: 'image/png' }, customMetadata: { sha256: o.sha256, captureId: o.captureId } });
    const back = await bucket.get(o.key);
    if (!back || sha(new Uint8Array(await back.arrayBuffer())) !== o.sha256) throw new LocalRefusal('restore_object', `objet ${o.key} non confirmé après écriture : restauration incomplète`);
  }
  const epoch = (await db.prepare('UPDATE sync_epoch SET epoch = lower(hex(randomblob(16))) WHERE singleton = 1 RETURNING epoch').first<{ epoch: string }>())!.epoch;
  if (epoch === manifest.epochAtBackup) throw new LocalRefusal('restore_epoch', 'epoch identique à la sauvegarde : restauration incomplète');
  for (const t of tables) {
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).first<{ n: number }>())!.n;
    if (n !== t.rows.length) throw new LocalRefusal('restore_rows', `${t.name} : ${n} ligne(s) après écriture, ${t.rows.length} attendues : restauration incomplète`);
  }
  const restoredAt = new Date().toISOString();
  await db.prepare("UPDATE restorations SET state = 'complete', restored_at = ? WHERE manifest_sha256 = ? AND state = 'in_progress'").bind(restoredAt, manifestSha256).run();
  return { restoredAt, backupCreatedAt: manifest.createdAt, manifestSha256, rows, objects: objects.length, epoch };
}
