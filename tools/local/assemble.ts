// Assemble un dossier `.socrate/` en un manifeste unique, celui qu'attend `PUT …/deployments/{id}`. Ne lit que le dossier donné, n'écrit que sur la sortie standard et n'ouvre aucune connexion.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleManifest } from '@socrate/contract/assemble';

// `npm run` se place à la racine du dépôt : un chemin relatif part du dossier d'où la commande a été lancée.
const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

/** Manifeste assemblé en JSON sur une ligne, ou les erreurs avec fichier et chemin de donnée. */
export async function assemble(dir: string): Promise<{ ok: true; json: string } | { ok: false; errors: string[] }> {
  const r = await assembleManifest(dir);
  if (!r.ok) return { ok: false, errors: r.issues.map((i) => `${i.file ?? '(manifeste)'} ${i.path} : ${i.message}`) };
  return { ok: true, json: `${JSON.stringify(r.manifest)}\n` };
}

async function main(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new Error('usage : npm run --silent assemble -- <dossier .socrate> > manifest.json');
  const r = await assemble(fromCaller(positionals[0]!));
  if (!r.ok) throw new Error(`manifeste refusé :\n${r.errors.map((e) => `  ${e}`).join('\n')}`);
  process.stdout.write(r.json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((e: Error) => {
    console.error(`refusé : ${e.message}`);
    process.exitCode = 1;
  });
}
