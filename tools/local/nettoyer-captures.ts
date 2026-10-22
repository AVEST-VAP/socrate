import { existsSync } from 'node:fs';
import { LocalRefusal, instanceName, runtime } from './local-run.ts';

// Invocation explicite et unique du nettoyage des captures et des pièces jointes non rattachées, dans la phase de maintenance exclusive de l'instance arrêtée : aucune tâche planifiée.
const rt = await runtime();
const { Maintenance } = await import('./maintenance.ts');
const name = instanceName(process.env.SOCRATE_INSTANCE ?? 'demo');
const root = rt.instanceRoot(name);
if (!existsSync(root)) throw new LocalRefusal('unknown_instance', `instance ${name} absente`);
const r = await Maintenance.run(root, async (m) => {
  const count = async () => (await m.db.prepare("SELECT (SELECT COUNT(*) FROM captures WHERE state <> 'committed') + (SELECT COUNT(*) FROM attachments WHERE state <> 'attached') AS n").first<{ n: number }>())!.n;
  const pending = await count();
  const { outcome } = await m.scheduled('nettoyage-manuel');
  return { pending, outcome, after: await count() };
});
console.log(`nettoyage ${r.outcome} : ${r.pending} capture(s) ou pièce(s) non validée(s) avant, ${r.after} après (les réservations encore valides ou sous bail restent en place, les pièces rattachées ne sont jamais candidates)`);
if (r.outcome !== 'ok') process.exitCode = 1;
