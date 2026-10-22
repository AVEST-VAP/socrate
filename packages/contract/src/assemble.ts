import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { indexSchema, manifestSchema, wordingSchema, zoneSchema, issuesOf, type Manifest, type ValidationIssue } from './manifest.ts';

export type AssembleResult = { ok: true; manifest: Manifest } | { ok: false; issues: ValidationIssue[] };

const EXECUTABLE = /\.(c|m)?(j|t)sx?$/i;

const posix = (p: string) => p.split(sep).join('/');

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(posix(relative(base, full)));
  }
  return out;
}

type Bounds = { root: string; rootReal: string };

function normalizeRef(bounds: Bounds, ref: string): string {
  return posix(relative(bounds.root, resolve(bounds.root, ref)));
}

async function readBoundedJson(bounds: Bounds, ref: string, issues: ValidationIssue[], referencedBy: { file: string; path: string }): Promise<unknown | undefined> {
  if (/^[a-z]+:/i.test(ref) || ref.startsWith('/') || ref.startsWith('\\')) {
    issues.push({ ...referencedBy, message: `référence non relative refusée : ${ref}` });
    return undefined;
  }
  const target = resolve(bounds.root, ref);
  if (!target.startsWith(bounds.rootReal + sep) && !target.startsWith(bounds.root + sep)) {
    issues.push({ ...referencedBy, message: `traversée hors du dossier refusée : ${ref}` });
    return undefined;
  }
  if (EXECUTABLE.test(ref) || !ref.endsWith('.json')) {
    issues.push({ file: ref, path: '(fichier)', message: 'seul un fragment JSON est accepté' });
    return undefined;
  }
  let link: boolean;
  try {
    link = (await lstat(target)).isSymbolicLink();
  } catch {
    issues.push({ file: ref, path: '(fichier)', message: 'fichier référencé absent' });
    return undefined;
  }
  const real = await realpath(target);
  if (!real.startsWith(bounds.rootReal + sep)) {
    issues.push({ file: ref, path: '(fichier)', message: 'lien symbolique sortant refusé' });
    return undefined;
  }
  if (link) {
    issues.push({ file: ref, path: '(fichier)', message: 'lien symbolique refusé' });
    return undefined;
  }
  try {
    return JSON.parse(await readFile(real, 'utf8'));
  } catch (e) {
    issues.push({ file: ref, path: '(fichier)', message: `JSON invalide : ${(e as Error).message}` });
    return undefined;
  }
}

export async function assembleManifest(dir: string): Promise<AssembleResult> {
  const issues: ValidationIssue[] = [];
  const root = resolve(dir);
  const bounds: Bounds = { root, rootReal: await realpath(root) };
  const files = await listFiles(root);
  for (const f of files) {
    if (EXECUTABLE.test(f)) issues.push({ file: f, path: '(fichier)', message: 'code exécutable refusé dans le dossier de revue' });
  }
  const indexRaw = await readBoundedJson(bounds, 'index.json', issues, { file: 'index.json', path: '(fichier)' });
  if (indexRaw === undefined) return { ok: false, issues };
  const index = indexSchema.safeParse(indexRaw);
  if (!index.success) return { ok: false, issues: [...issues, ...issuesOf(index.error, 'index.json')] };

  const referenced = new Set<string>(['index.json']);
  const zones: unknown[] = [];
  for (const ref of index.data.zones) {
    referenced.add(normalizeRef(bounds, ref));
    const fragment = await readBoundedJson(bounds, ref, issues, { file: 'index.json', path: 'zones' });
    if (fragment === undefined) continue;
    const zone = zoneSchema.safeParse(fragment);
    if (!zone.success) issues.push(...issuesOf(zone.error, ref));
    else zones.push(zone.data);
  }
  let wordings: unknown[] | undefined;
  if (index.data.wordings !== undefined) {
    const ref = index.data.wordings;
    referenced.add(normalizeRef(bounds, ref));
    const fragment = await readBoundedJson(bounds, ref, issues, { file: 'index.json', path: 'wordings' });
    if (fragment !== undefined) {
      const list = z.array(wordingSchema).safeParse(fragment);
      if (!list.success) issues.push(...issuesOf(list.error, ref));
      else wordings = list.data;
    }
  }
  for (const f of files) {
    if (f.endsWith('.json') && !referenced.has(f)) issues.push({ file: f, path: '(fichier)', message: 'fichier de données non référencé par index.json' });
  }
  if (issues.length) return { ok: false, issues };
  const { zones: _refs, wordings: _wordingsRef, ...rest } = index.data;
  const manifest = manifestSchema.safeParse({ ...rest, zones, ...(wordings && { wordings }) });
  if (!manifest.success) return { ok: false, issues: issuesOf(manifest.error, 'index.json') };
  return { ok: true, manifest: manifest.data };
}
