import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalRefusal, guardedPath, instanceName, localPath, runtime } from './local-run.ts';

// Commandes explicites d'une phase de maintenance exclusive : instance arrêtée, ressources antérieures prouvées fermées, aucune tâche planifiée.
const rt = await runtime();
const { exportBackup, restoreBackup, thaw, verifyBackup } = await import('./backup.ts');
const { Maintenance, purgeProject } = await import('./maintenance.ts');
const [action, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = instanceName(flag('instance') ?? process.env.SOCRATE_INSTANCE ?? 'demo');
const root = rt.instanceRoot(name);

/** Accès lu depuis un fichier, jamais depuis la ligne de commande ni affiché. */
async function tokenFrom(path: string): Promise<string> {
  const token = (await readFile(guardedPath(path), 'utf8')).trim();
  if (!token) throw new LocalRefusal('missing_token', `fichier d’accès ${path} vide`);
  return token;
}

if (action === 'sauvegarder') {
  if (!existsSync(root)) throw new LocalRefusal('unknown_instance', `instance ${name} absente`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = flag('dossier') ?? localPath('.local/sauvegardes', `${name}-${stamp}`);
  const r = await Maintenance.run(root, (m) => exportBackup(m, dir));
  console.log(`sauvegarde ${r.dir}\nmanifeste sha256 ${r.manifestSha256} (à noter pour la restauration)\n${r.manifest.tables.map((t) => `${t.name} ${t.rows}`).join(', ')} ; ${r.manifest.objects.filter((o) => !('attachmentId' in o)).length} capture(s), ${r.manifest.objects.filter((o) => 'attachmentId' in o).length} pièce(s) jointe(s), format ${r.manifest.format}\n${r.manifest.retention}`);
} else if (action === 'restaurer') {
  const from = flag('depuis');
  const expected = flag('empreinte');
  if (!from || !expected) throw new LocalRefusal('missing_source', 'paramètres --depuis <dossier de sauvegarde> et --empreinte <sha256 du manifeste> requis');
  if (existsSync(root) && readdirSync(root).length) throw new LocalRefusal('target_not_empty', `instance ${name} déjà présente : la restauration ne vise qu’une instance neuve, jamais l’instance active`);
  // Une entrée hostile ou altérée est refusée avant que la racine cible ne soit créée.
  await verifyBackup(from, expected);
  const r = await Maintenance.run(root, async (m) => {
    const restored = await restoreBackup(m, from, expected);
    const creds = await rt.reconcileCredentials(m.db, `${root}/credentials`, {
      import: { projectId: rt.PROJECT, label: 'ci-demo', capabilities: ['deployment.import'] },
      agent: { projectId: rt.PROJECT, label: 'agent-demo', capabilities: ['review.read'] },
      archive: { projectId: rt.PROJECT, label: 'archivage-demo', capabilities: ['review.archive'] },
    });
    return { restored, files: Object.keys(creds).map((k) => `${root}/credentials/${k}.token`) };
  });
  console.log(`instance ${name} restaurée le ${r.restored.restoredAt} depuis la sauvegarde du ${r.restored.backupCreatedAt} (manifeste ${r.restored.manifestSha256})\n${Object.entries(r.restored.rows).map(([t, n]) => `${t} ${n}`).join(', ')} ; ${r.restored.objects} objet(s) (captures et pièces jointes) ; nouvelle epoch ${r.restored.epoch}\nsessions et accès antérieurs non repris ; nouveaux accès techniques : ${r.files.join(', ')}`);
} else if (action === 'purger') {
  const projectId = flag('projet') ?? rt.PROJECT;
  const token = await tokenFrom(flag('acces') ?? join(root, 'credentials/archive.token'));
  const report = await Maintenance.run(root, (m) => purgeProject(m, { projectId, token }));
  for (const e of report.entries) console.log(`${e.reviewKey} ${e.action} ${e.resource} ${e.detail}`);
  console.log(`purge ${report.mode} du projet ${projectId} au ${report.at} : ${report.complete ? 'complète' : 'incomplète, relancer la commande'} ; planification ${report.planification}`);
  if (!report.complete) process.exitCode = 1;
} else if (action === 'degeler') {
  await Maintenance.run(root, (m) => thaw(m.db));
  console.log(`instance ${name} dégelée`);
} else {
  console.error('usage : npm run sauvegarde -- sauvegarder|restaurer|purger|degeler [--instance <nom>] [--dossier <chemin>] [--depuis <dossier> --empreinte <sha256>] [--projet <id> --acces <fichier>]');
  process.exit(2);
}
