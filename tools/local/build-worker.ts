import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedPath, localPath, REPO_ROOT } from './local-run.ts';

export const WORKER_ENTRY = localPath('apps/service/src/index.ts');
export const WORKER_BUNDLE = localPath('apps/service/dist/worker.mjs');
export const CLIENT_ENTRY = localPath('packages/react/src/mount.tsx');

/** Les assets du Worker sont voisins de son bundle : `<dossier>/assets/client/<empreinte>.js`. */
export const assetsDirOf = (bundle: string) => join(dirname(bundle), 'assets');

/** Les anciennes empreintes restent dans le dossier : une preview figée sur une version antérieure la charge encore après un nouveau déploiement. */
export async function buildClient(assetsDir: string): Promise<string> {
  const outdir = guardedPath(join(assetsDir, 'client'));
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [CLIENT_ENTRY], absWorkingDir: REPO_ROOT, bundle: true, format: 'esm', splitting: true, platform: 'browser', target: 'es2022', outdir,
    entryNames: '[hash]', chunkNames: 'chunk-[hash]', jsx: 'automatic', minify: true, metafile: true, sourcemap: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  // Chaque import dynamique est aussi une entrée du métafichier : seule celle de `mount` est l'URL publiée.
  const entry = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint === relative(REPO_ROOT, CLIENT_ENTRY))![0];
  return `/${relative(guardedPath(assetsDir), resolve(REPO_ROOT, entry))}`;
}

export async function buildWorker(outfile = WORKER_BUNDLE): Promise<string> {
  const target = guardedPath(outfile);
  const client = await buildClient(assetsDirOf(target));
  const { build } = await import('esbuild');
  await build({ entryPoints: [WORKER_ENTRY], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: target, sourcemap: false, logLevel: 'silent', define: { __SOCRATE_CLIENT__: JSON.stringify(client) } });
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundled = await buildWorker();
  console.log(`worker bundle: ${bundled} (TMPDIR ${process.env.TMPDIR})`);
}
