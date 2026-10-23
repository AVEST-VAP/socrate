// Construit `packages/socrate/pack/`, le dossier publié : JavaScript et déclarations sous `dist/`, `@socrate/contract` et `@socrate/react` embarqués,
// aucune source TypeScript, et un `package.json` sans `private`, scripts ni dépendances de développement du workspace.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { guardedPath, localPath } from './local-run.ts';

export const PACKAGE_DIR = localPath('packages/socrate');

type Manifest = { dependencies: Record<string, string>; peerDependencies: Record<string, string>; [key: string]: unknown };

/** Le manifeste du workspace, privé pour qu'aucun `npm publish` ne parte de ses sources, sans ce qui ne sert qu'ici. */
export function publishedManifest(source: Manifest): Record<string, unknown> {
  const { private: _private, scripts: _scripts, devDependencies: _dev, ...published } = source;
  return published;
}

export async function buildPackage(pack = join(PACKAGE_DIR, 'pack')): Promise<string> {
  const root = guardedPath(pack);
  const outdir = join(root, 'dist');
  const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as Manifest;
  // Dépendances et pairs restent des imports nus, résolus chez l'hôte : mediabunny reste chargé à la demande par son bundler.
  const external = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)].flatMap((name) => [name, `${name}/*`]);
  const common = { absWorkingDir: PACKAGE_DIR, bundle: true, format: 'esm', splitting: true, external, outdir, sourcemap: false, logLevel: 'warning', legalComments: 'inline', chunkNames: 'chunks/[name]-[hash]' } as const;
  const { build } = await import('esbuild');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(publishedManifest(pkg), null, 2)}\n`);
  for (const file of ['README.md', 'LICENSE']) copyFileSync(join(PACKAGE_DIR, file), join(root, file));
  await build({ ...common, entryPoints: { react: 'src/react.tsx' }, platform: 'browser', target: 'es2022', jsx: 'automatic' });
  await build({ ...common, entryPoints: { vite: 'src/vite.ts', cli: 'src/cli.ts' }, platform: 'node', target: 'node20' });
  for (const file of ['react.d.ts', 'vite.d.ts', 'vite-client.d.ts']) copyFileSync(join(PACKAGE_DIR, 'types', file), join(outdir, file));
  const cli = join(outdir, 'cli.js');
  writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, 'utf8')}`);
  chmodSync(cli, 0o755);
  return root;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`package built: ${await buildPackage()}`);
}
