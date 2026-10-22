import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { assembleManifest } from '@socrate/contract/assemble';
import { REPO_ROOT, localPath } from '../local-run.ts';

const run = promisify(execFile);
const SCRIPT = localPath('tools/local/assemble.ts');
const tmp = (prefix: string) => mkdtemp(join(REPO_ROOT, '.tmp', prefix));
// Comme `npm run`, qui se place à la racine et garde le dossier d'appel dans INIT_CWD.
const assemble = (caller: string, args: string[]) => run(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, env: { ...process.env, INIT_CWD: caller } });

/** Fichiers de l'exemple minimal publié dans le guide d'intégration, extraits par leur marqueur. */
async function minimalExample(): Promise<Map<string, string>> {
  const guide = await readFile(localPath('docs/integrate.md'), 'utf8');
  return new Map([...guide.matchAll(/<!-- manifest: ([a-z/.-]+) -->\n```json\n([\s\S]*?)```/g)].map((m) => [m[1]!, m[2]!]));
}

test('assemble écrit sur la sortie standard le manifeste de la démo tel que l’assembleur le produit, chemin relatif au dossier d’appel', async () => {
  const caller = await tmp('assemble-');
  const expected = await assembleManifest(localPath('apps/demo/.socrate'));
  assert.ok(expected.ok);
  const { stdout } = await assemble(caller, [join('..', '..', 'apps/demo/.socrate')]);
  assert.deepEqual(JSON.parse(stdout), expected.manifest);
  assert.deepEqual(await readdir(caller), [], 'aucun fichier écrit');
});

test('l’exemple minimal du guide d’intégration est un manifeste valide, et chaque champ requis l’est vraiment', async () => {
  const files = await minimalExample();
  assert.deepEqual([...files.keys()], ['.socrate/index.json', '.socrate/zones/settings.json']);
  const write = async (dir: string, edit: (index: Record<string, unknown>) => void = () => {}) => {
    for (const [name, text] of files) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      const json = JSON.parse(text);
      if (name.endsWith('index.json')) edit(json);
      await writeFile(join(dir, name), JSON.stringify(json));
    }
    return join(dir, '.socrate');
  };
  const { stdout } = await assemble(REPO_ROOT, [await write(await tmp('assemble-'))]);
  assert.equal(JSON.parse(stdout).zones.length, 1);
  for (const field of ['title', 'before', 'now', 'zones']) {
    const dir = await write(await tmp('assemble-'), (index) => { delete index[field]; });
    await assert.rejects(assemble(REPO_ROOT, [dir]), (e: { code: number; stderr: string }) => e.code === 1 && e.stderr.includes(`index.json ${field}`), `${field} requis`);
  }
});

test('assemble refuse un dossier invalide avec le fichier et le chemin fautifs, sortie standard vide', async () => {
  const caller = await tmp('assemble-');
  const dir = join(caller, '.socrate');
  await mkdir(join(dir, 'zones'), { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 1, reviewKey: 'my-app-pr-42', title: 'T', before: 'B', now: 'N', zones: ['zones/a.json'] }));
  await writeFile(join(dir, 'zones/a.json'), JSON.stringify({ id: 'a', title: 'A', route: 'sans-barre' }));
  await assert.rejects(assemble(caller, ['.socrate']), (e: { code: number; stdout: string; stderr: string }) => e.code === 1 && e.stdout === '' && e.stderr.includes('zones/a.json route'));
});
