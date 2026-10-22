// Étapes de l'opérateur pour une instance Cloudflare auto-hébergée. Rien n'est envoyé à Cloudflare : chaque étape écrit ses fichiers et affiche la commande wrangler à lancer.
import { parseArgs } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedPath, localPath, REPO_ROOT, runtime } from './local-run.ts';
import { z } from 'zod';
import { issuesOf, migrationListSchema, randomToken, serviceConfigSchema, tokenHash, type MigrationRef } from '@socrate/contract';

const { bundleDigest, buildWorker, listMigrations, pendingMigrations, SCHEMA_MIGRATIONS_TABLE } = await runtime();

// Même workerd que le miniflare figé du banc local (package.json).
export const WRANGLER = 'npx wrangler@4.116.0';
export const DEFAULT_OUT = localPath('apps/service/dist');
const DEPLOY_CONFIG = 'wrangler.json';
// Un fichier et un libellé par accès technique émis par l'opérateur.
const CREDENTIALS = {
  'deployment.import': { file: 'acces-import.sql', label: 'ci-previews' },
  'review.archive': { file: 'acces-archive.sql', label: 'archivage-manuel' },
  'review.read': { file: 'acces-lecture.sql', label: 'agent-lecture' },
} as const;
type Issued = keyof typeof CREDENTIALS;
const shown = (path: string) => relative(REPO_ROOT, path);

const ownerConfigSchema = z.looseObject({
  name: z.string().regex(/^[a-z0-9-]{1,63}$/),
  d1_databases: z.tuple([z.looseObject({ binding: z.literal('DB'), database_name: z.string().min(1), database_id: z.string().min(1) })]),
  r2_buckets: z.tuple([z.looseObject({ binding: z.literal('CAPTURES'), bucket_name: z.string().min(1) })]),
  vars: z.strictObject({ SOCRATE_CONFIG: serviceConfigSchema, SOCRATE_INSTANCE: z.strictObject({ instanceId: z.string().regex(/^[a-z0-9-]{1,64}$/) }) }),
});
type DeployConfig = { d1_databases: [{ database_name: string }]; vars: Record<'SOCRATE_CONFIG' | 'SOCRATE_SCHEMA' | 'SOCRATE_INSTANCE', string>; [key: string]: unknown };

async function deployConfig(out: string): Promise<{ path: string; config: DeployConfig }> {
  const path = join(guardedPath(out), DEPLOY_CONFIG);
  const config = JSON.parse(await readFile(path, 'utf8').catch(() => { throw new Error(`${shown(path)} absent : lancer d'abord \`npm run distant -- preparer\``); })) as DeployConfig;
  return { path, config };
}

/** Valide la configuration de l'opérateur, construit Worker et client, puis écrit la configuration de déploiement avec les variables calculées. */
export async function prepare(ownerConfig: string, out = DEFAULT_OUT): Promise<string> {
  // JSONC limité aux commentaires sur ligne seule, comme l'exemple.
  const text = (await readFile(guardedPath(ownerConfig), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  const placeholders = text.match(/"<[^"]*>"/g);
  if (placeholders) throw new Error(`valeurs à remplacer dans ${shown(guardedPath(ownerConfig))} : ${placeholders.join(', ')}`);
  const parsed = ownerConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`configuration refusée : ${issuesOf(parsed.error).map((i) => `${i.path} ${i.message}`).join(' ; ')}`);
  const { vars, ...owner } = parsed.data;
  const open = Object.entries(vars.SOCRATE_CONFIG.projects).filter(([, p]) => p.allowedOrigin === undefined).map(([id]) => id);
  if (open.length) throw new Error(`allowedOrigin requis pour chaque projet de l'instance distante : ${open.join(', ')}`);
  const bundle = await buildWorker(join(guardedPath(out), 'worker.mjs'));
  const schema: MigrationRef[] = (await listMigrations()).map(({ id, checksum }) => ({ id, checksum }));
  const deploy: DeployConfig = {
    ...owner, main: 'worker.mjs', no_bundle: true, assets: { directory: 'assets', binding: 'ASSETS', run_worker_first: true },
    vars: { SOCRATE_CONFIG: JSON.stringify(vars.SOCRATE_CONFIG), SOCRATE_SCHEMA: JSON.stringify(schema), SOCRATE_INSTANCE: JSON.stringify({ instanceId: vars.SOCRATE_INSTANCE.instanceId, build: bundleDigest(bundle) }) },
  };
  const path = join(guardedPath(out), DEPLOY_CONFIG);
  await writeFile(path, `${JSON.stringify(deploy, null, 2)}\n`);
  return path;
}

const appliedSchema = z.union([migrationListSchema, z.tuple([z.looseObject({ results: migrationListSchema })]).transform(([r]) => r.results)]);

/** Lit la sortie `--json` de wrangler (ou une liste simple) ; une base vierge n'a pas encore de table `schema_migrations`. */
export function parseApplied(json: string): MigrationRef[] {
  const r = appliedSchema.safeParse(JSON.parse(json));
  if (!r.success) throw new Error(`liste des migrations appliquées illisible : ${issuesOf(r.error).map((i) => `${i.path} ${i.message}`).join(' ; ')}`);
  return r.data;
}

/** Un fichier par migration restante, chacun suivi de son empreinte dans `schema_migrations`, à exécuter dans l'ordre. */
export async function remoteMigrations(applied: MigrationRef[], out = DEFAULT_OUT): Promise<string[]> {
  const pending = pendingMigrations(applied, await listMigrations());
  const dir = join(guardedPath(out), 'migrations-distantes');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const m of pending) {
    const file = join(dir, m.id);
    const sql = m.sql.trimEnd().replace(/;?$/, ';');
    await writeFile(file, `${SCHEMA_MIGRATIONS_TABLE};\n${sql}\nINSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('${m.id}', '${m.checksum}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));\n`);
    files.push(file);
  }
  return files;
}

/** Le jeton n'est jamais écrit : seul son hash part dans le fichier SQL, créé une seule fois. */
export async function issueCredential(projectId: string, days: number, out = DEFAULT_OUT, capability: Issued = 'deployment.import'): Promise<{ token: string; file: string; expiresAt: string }> {
  const { config } = await deployConfig(out);
  if (!/^[a-z0-9-]{1,64}$/.test(projectId) || !(projectId in JSON.parse(config.vars.SOCRATE_CONFIG).projects)) throw new Error(`projet ${projectId} absent de SOCRATE_CONFIG`);
  if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error('durée de validité entre 1 et 730 jours');
  const token = randomToken();
  const now = Date.now();
  const expires = Math.floor(now / 1000) + days * 86_400;
  const { file: name, label } = CREDENTIALS[capability];
  const file = join(guardedPath(out), name);
  const sql = `INSERT INTO technical_credentials (credential_id, token_hash, project_id, label, capabilities, expires_at, created_at) VALUES ('${crypto.randomUUID()}', '${await tokenHash(token)}', '${projectId}', '${label}', '["${capability}"]', ${expires}, '${new Date(now).toISOString()}');\n`;
  await writeFile(file, sql, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EEXIST') throw new Error(`${shown(file)} existe déjà : l'exécuter puis le supprimer, ou le supprimer pour émettre un nouvel accès`);
    throw e;
  });
  return { token, file, expiresAt: new Date(expires * 1000).toISOString() };
}

/** Projet visé : `--projet`, sinon le seul projet de SOCRATE_CONFIG. */
function projectOf(config: DeployConfig, projet: string | undefined): string {
  if (projet) return projet;
  const ids = Object.keys(JSON.parse(config.vars.SOCRATE_CONFIG).projects);
  if (ids.length !== 1) throw new Error(`--projet requis parmi : ${ids.join(', ')}`);
  return ids[0]!;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { config: { type: 'string' }, sortie: { type: 'string' }, appliquees: { type: 'string' }, 'base-vierge': { type: 'boolean' }, projet: { type: 'string' }, jours: { type: 'string' } } });
  const out = values.sortie ? resolve(values.sortie) : DEFAULT_OUT;
  if (command === 'preparer') {
    const path = await prepare(values.config ?? localPath('apps/service/wrangler.jsonc'), out);
    console.log(`configuration de déploiement : ${shown(path)}\n\n  ${WRANGLER} deploy --config ${shown(path)}`);
    return;
  }
  const { path, config } = await deployConfig(out);
  const execute = `${WRANGLER} d1 execute ${config.d1_databases[0].database_name} --remote --config ${shown(path)}`;
  if (command === 'migrations') {
    if (!values.appliquees && !values['base-vierge']) {
      console.log(`Lire d'abord les migrations appliquées, puis relancer avec --appliquees (ou --base-vierge si la commande signale l'absence de schema_migrations) :\n\n  ${execute} --json --command "SELECT id, checksum FROM schema_migrations ORDER BY id" > ${shown(join(out, 'appliquees.json'))}`);
      return;
    }
    const applied = values['base-vierge'] ? [] : parseApplied(await readFile(guardedPath(resolve(values.appliquees!)), 'utf8'));
    const files = await remoteMigrations(applied, out);
    console.log(files.length ? `migrations à appliquer dans l'ordre, une commande à la fois :\n\n${files.map((f) => `  ${execute} --file ${shown(f)}`).join('\n')}` : 'base à jour : aucune migration à appliquer');
    return;
  }
  if (command === 'acces-import') {
    const r = await issueCredential(projectOf(config, values.projet), Number(values.jours ?? '365'), out);
    console.log(`accès deployment.import, affiché une seule fois et jamais écrit (expire le ${r.expiresAt}) :\n\n  ${r.token}\n\n1. ${execute} --file ${shown(r.file)}\n2. Déposer le jeton comme secret de la CI de l'application (par exemple SOCRATE_IMPORT_TOKEN).\n3. Supprimer ${shown(r.file)}.`);
    return;
  }
  if (command === 'acces-archive') {
    const projectId = projectOf(config, values.projet);
    const r = await issueCredential(projectId, Number(values.jours ?? '365'), out, 'review.archive');
    console.log(`accès review.archive, affiché une seule fois et jamais écrit (expire le ${r.expiresAt}) :\n\n  ${r.token}\n\n1. ${execute} --file ${shown(r.file)}\n2. Conserver le jeton hors de tout dépôt et de la CI : il sert seulement à l'archivage manuel.\n3. Supprimer ${shown(r.file)}.\n\nArchivage d'une revue à la fermeture de sa PR : docs/self-host-cloudflare.md, « Archive a review » (POST /v1/projects/${projectId}/reviews/<reviewKey>/archive).`);
    return;
  }
  if (command === 'acces-lecture') {
    const projectId = projectOf(config, values.projet);
    const r = await issueCredential(projectId, Number(values.jours ?? '365'), out, 'review.read');
    console.log(`accès review.read, affiché une seule fois et jamais écrit (expire le ${r.expiresAt}) :\n\n  ${r.token}\n\n1. ${execute} --file ${shown(r.file)}\n2. Déposer le jeton dans un fichier lisible par l'agent seul (mode 0600), hors de tout dépôt : il lit les revues de ${projectId} et n'écrit rien.\n3. Supprimer ${shown(r.file)}.\n\nLecture des retours : docs/agent-api.md (SOCRATE_TOKEN_FILE).`);
    return;
  }
  throw new Error('commande attendue : preparer, migrations, acces-import, acces-archive ou acces-lecture');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((e: Error) => {
    console.error(`refusé : ${e.message}`);
    process.exitCode = 1;
  });
}
