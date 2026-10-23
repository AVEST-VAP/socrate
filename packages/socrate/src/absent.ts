// `socrate check-absent` : un build de production ne contient ni le client Socrate ni l'adresse du service.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { CLIENT_MARK, RENDER_MARK } from './mark.ts';
import { CliError, type Io } from './io.ts';

export type Leak = { file: string; marker: string };

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() && !entry.name.endsWith('.map') ? [path] : [];
  });
}

/** Le mot « socrate » seul n'est pas cherché : il peut figurer dans un nom de branche ou de route de l'hôte. */
export function findLeaks(dist: string, markers: string[]): { leaks: Leak[]; checked: number } {
  const all = files(dist);
  const needles = markers.map((m) => [m, Buffer.from(m)] as const);
  const leaks = all.flatMap((path) => {
    const bytes = readFileSync(path);
    return needles.filter(([, needle]) => bytes.includes(needle)).map(([marker]) => ({ file: relative(dist, path), marker }));
  });
  return { leaks, checked: all.length };
}

export function checkAbsent(io: Io, args: { dist?: string; config?: string }): void {
  if (!args.dist) throw new CliError('usage: socrate check-absent <build output directory> [--config socrate.yml]', 2);
  const config = loadConfig(io.cwd, args.config);
  const dist = resolve(io.cwd, args.dist);
  let isDir = false;
  try {
    isDir = statSync(dist).isDirectory();
  } catch {}
  if (!isDir) throw new CliError(`${dist} is not a directory`);
  const { leaks, checked } = findLeaks(dist, [CLIENT_MARK, RENDER_MARK, new URL(config.service).host]);
  if (checked === 0) throw new CliError(`${dist} contains no file to check`);
  if (leaks.length) throw new CliError(`Socrate found in ${dist}:\n${leaks.map((l) => `  ${l.file}: contains ${JSON.stringify(l.marker)}`).join('\n')}`);
  io.log(`no Socrate client nor service address in ${dist} (${checked} files checked)`);
}
