import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT, localPath } from '../local-run.ts';
import { parseStatus } from '../../../.agents/skills/verify-socrate/verify.ts';

const run = promisify(execFile);
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
const VERIFY = localPath('.agents/skills/verify-socrate/verify.ts');
const git = async (...args: string[]) => (await run('git', args, { cwd: REPO_ROOT, env })).stdout;

test('parseStatus : un renommage ou une copie consomme ses deux noms exacts en colonne X comme en colonne Y, sur les vrais octets NUL d’un dépôt Git jetable du banc', async () => {
  const repo = await mkdtemp(join(REPO_ROOT, '.tmp', 'status-z-'));
  const g = async (...args: string[]) => (await run('git', args, { cwd: repo, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })).stdout;
  await g('init', '-q');
  await g('config', 'user.email', 'banc@socrate.invalid');
  await g('config', 'user.name', 'banc');
  await writeFile(join(repo, 'ancien.txt'), 'contenu identique\nligne 2\n');
  await writeFile(join(repo, 'témoin "guillemets" espace.txt'), 'autre contenu\n');
  await writeFile(join(repo, 'inchangé.txt'), 'inchangé\n');
  await g('add', '.');
  await g('commit', '-qm', 'init');
  await g('mv', 'témoin "guillemets" espace.txt', 'renommé "en index" espace.txt');
  await rename(join(repo, 'ancien.txt'), join(repo, 'nouveau.txt'));
  await g('add', '-N', 'nouveau.txt');
  await writeFile(join(repo, 'nouveau.txt'), 'contenu identique\nligne 2\nligne 3\n');
  await copyFile(join(repo, 'inchangé.txt'), join(repo, 'copie.txt'));
  await writeFile(join(repo, 'inchangé.txt'), 'inchangé puis modifié\n');
  await g('add', 'copie.txt', 'inchangé.txt');
  const raw = await g('-c', 'status.renames=copies', 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const entries = parseStatus(raw).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(entries, [
    { status: 'C ', path: 'copie.txt', from: 'inchangé.txt' },
    { status: 'M ', path: 'inchangé.txt' },
    { status: ' R', path: 'nouveau.txt', from: 'ancien.txt' },
    { status: 'R ', path: 'renommé "en index" espace.txt', from: 'témoin "guillemets" espace.txt' },
  ].sort((a, b) => a.path.localeCompare(b.path)), raw.replaceAll('\0', '␀'));
  assert.ok(!entries.some((e) => e.path === 'ancien.txt' || e.path === 'témoin "guillemets" espace.txt'), 'aucune origine prise pour une entrée');
  await rm(repo, { recursive: true, force: true });
});

type Source = { sha: string; dirty: string[] };
async function source(): Promise<{ ok: true; state: Source } | { ok: false; stderr: string }> {
  try {
    const { stdout } = await run(process.execPath, [VERIFY, 'source'], { cwd: REPO_ROOT, env });
    return { ok: true, state: JSON.parse(stdout.trim()) as Source };
  } catch (e) {
    return { ok: false, stderr: (e as { stderr?: string }).stderr ?? String(e) };
  }
}
const sourceOk = async (): Promise<Source> => {
  const r = await source();
  assert.ok(r.ok, (r as { stderr: string }).stderr);
  return r.state;
};

test('digest sale par la vraie entrée CLI : octets et mode d’une source non suivie admissible changent le digest, nom particulier exact via NUL, restauration exacte', async () => {
  const dir = 'tools/local/test';
  const stamp = crypto.randomUUID().slice(0, 8);
  const plain = `${dir}/temoin-digest-${stamp}.txt`;
  const odd = `${dir}/témoin digest "guillemets" ${stamp}.txt`;
  const before = await sourceOk();
  try {
    await writeFile(join(REPO_ROOT, plain), 'octets A\n');
    const a = await sourceOk();
    assert.match(a.sha, /-dirty\+[0-9a-f]{12}$/);
    assert.notEqual(a.sha, before.sha);
    assert.ok(a.dirty.includes(plain), a.dirty.join(','));
    await writeFile(join(REPO_ROOT, plain), 'octets B\n');
    const b = await sourceOk();
    assert.notEqual(b.sha, a.sha, 'des octets différents changent le digest');
    await chmod(join(REPO_ROOT, plain), 0o755);
    const mode = await sourceOk();
    assert.notEqual(mode.sha, b.sha, 'un mode différent change le digest');
    await writeFile(join(REPO_ROOT, odd), 'nom particulier\n');
    const named = await sourceOk();
    assert.ok(named.dirty.includes(odd), `nom exact conservé : ${named.dirty.join(' | ')}`);
    await rm(join(REPO_ROOT, odd));
    assert.equal((await sourceOk()).sha, mode.sha, 'retrait du nom particulier : digest restauré');
  } finally {
    await rm(join(REPO_ROOT, plain), { force: true });
    await rm(join(REPO_ROOT, odd), { force: true });
  }
  assert.deepEqual(await sourceOk(), before, 'état exactement restauré');
});

test('digest sale : un renommage indexé est lu par ses deux noms exacts, puis l’index est rétabli', async () => {
  const from = 'tools/local/test/fixtures/listener.ts';
  const to = `tools/local/test/fixtures/listener-renomme-${crypto.randomUUID().slice(0, 8)}.ts`;
  const before = await sourceOk();
  await git('mv', from, to);
  try {
    const renamed = await sourceOk();
    assert.ok(renamed.dirty.includes(`${to} <- ${from}`), renamed.dirty.join(' | '));
    assert.notEqual(renamed.sha, before.sha);
  } finally {
    await git('mv', to, from);
  }
  assert.equal((await git('status', '--porcelain', '--', from, to)).trim(), '', 'index rétabli');
  assert.deepEqual(await sourceOk(), before);
});

test('digest sale : un lien symbolique au nom admissible et un fichier au nom interdit sont refusés avant toute lecture, destination jamais visitée', async () => {
  const dir = 'tools/local/test';
  const stamp = crypto.randomUUID().slice(0, 8);
  const dangling = `${dir}/temoin-lien-${stamp}.txt`;
  const toSource = `${dir}/temoin-lien-source-${stamp}.ts`;
  const forbidden = `${dir}/temoin-fictif-${stamp}.token`;
  const before = await sourceOk();
  try {
    await symlink(join(REPO_ROOT, '.tmp', `nulle-part-${stamp}`), join(REPO_ROOT, dangling));
    const r1 = await source();
    assert.equal(r1.ok, false, 'un lien pendant serait compté « supprimé » s’il était suivi : il est refusé avant');
    assert.match((r1 as { stderr: string }).stderr, /lien symbolique refusé sur le chemin : tools\/local\/test\/temoin-lien-/);
    await rm(join(REPO_ROOT, dangling));
    await symlink(join(REPO_ROOT, 'tools/local/test/fixtures/holder.ts'), join(REPO_ROOT, toSource));
    const r2 = await source();
    assert.equal(r2.ok, false, 'un lien vers une source admissible reste refusé : le nom du lien ne rend pas sa destination admissible');
    assert.match((r2 as { stderr: string }).stderr, /lien symbolique refusé/);
    await rm(join(REPO_ROOT, toSource));
    await writeFile(join(REPO_ROOT, forbidden), 'texte fictif sans secret\n');
    const r3 = await source();
    assert.equal(r3.ok, false);
    assert.match((r3 as { stderr: string }).stderr, /état source refusé sans lecture : tools\/local\/test\/temoin-fictif-[0-9a-f]+\.token n’est pas une source admissible/);
  } finally {
    for (const p of [dangling, toSource, forbidden]) await rm(join(REPO_ROOT, p), { force: true });
  }
  assert.ok(!existsSync(join(REPO_ROOT, '.tmp', `nulle-part-${stamp}`)), 'la destination pendante n’a jamais été créée');
  assert.deepEqual(await sourceOk(), before);
});

test('entrée CLI par un chemin alias : un lien symbolique du banc vers verify.ts exécute la commande avec la même sortie que l’invocation directe, et une commande inconnue rend l’usage avec le code 2, jamais une sortie 0 silencieuse', async () => {
  const bench = await mkdtemp(join(REPO_ROOT, '.tmp', 'cli-alias-'));
  const alias = join(bench, 'verify-alias.ts');
  await symlink(VERIFY, alias);
  try {
    const direct = await run(process.execPath, [VERIFY, 'source'], { cwd: REPO_ROOT, env, timeout: 30_000 });
    const aliased = await run(process.execPath, [alias, 'source'], { cwd: REPO_ROOT, env, timeout: 30_000 });
    assert.match(direct.stdout, /^\{"sha":"[0-9a-f]{40}/);
    assert.equal(aliased.stdout, direct.stdout, 'même état source par l’alias, aucune sortie 0 silencieuse');
    const unknown = await run(process.execPath, [alias, 'commande-inconnue'], { cwd: REPO_ROOT, env, timeout: 30_000 }).then(() => null, (e: Error & { code?: number; stderr?: string }) => e);
    assert.ok(unknown, 'une commande inconnue par l’alias échoue au lieu de sortir en 0');
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr ?? '', /usage : verify\.ts/);
  } finally {
    await rm(bench, { recursive: true, force: true });
  }
});
