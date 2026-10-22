import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleManifest } from '@socrate/contract/assemble';
import { runtime, REPO_ROOT } from '../../../tools/local/local-run.ts';
import { signAssertion, type AssertionInput } from '../../../tools/local/assertion.ts';

export const rt = await runtime();
export const workerBuilt = rt.buildWorker();

export const PROJECT = 'demo';
export const ISSUER = 'demo-host';
export const REVIEW = 'rappels-automatiques';
export const ORIGIN = 'http://127.0.0.1:5173';

export type Bench = {
  service: import('../../../tools/local/runtime.ts').ServiceInstance;
  claim: import('../../../tools/local/runtime.ts').RootClaim;
  keys: Awaited<ReturnType<typeof rt.generateIssuerKeys>>;
  otherKeys: Awaited<ReturnType<typeof rt.generateIssuerKeys>>;
  importToken: string;
  agentToken: string;
  otherProjectImportToken: string;
  root: string;
  restart(): Promise<void>;
  stopService(): Promise<void>;
  startService(): Promise<void>;
  stop(): Promise<void>;
};

export async function newRoot(prefix = 'bench-'): Promise<string> {
  return mkdtemp(join(REPO_ROOT, '.tmp', prefix));
}

type Held = { root: string; ms: number; close: () => Promise<void> };
const held: Held[] = [];
const claims: Array<{ root: string; release(): void }> = [];

async function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} : fermeture non confirmée après ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function claimOrThrow(root: string) {
  const claim = rt.claimRoot(root);
  if (claim === 'busy') throw new Error(`racine ${root} déjà possédée`);
  let released = false;
  const once = { ...claim, release() { if (released) return; released = true; claim.release(); } };
  claims.push(once);
  return once;
}

export function hold(root: string, close: () => Promise<void>, ms = 20_000): () => Promise<void> {
  let done: Promise<void> | undefined;
  const entry: Held = { root, ms, close: () => (done ??= close()) };
  held.push(entry);
  return () => bounded(entry.close(), ms, root);
}

export async function startHeld(opts: Parameters<typeof rt.startService>[0]) {
  let stop: (() => Promise<void>) | undefined;
  try {
    const service = await rt.startService({ ...opts, own: (close) => { stop = hold(opts.root, close); } });
    return { ...service, stop: stop! };
  } catch (e) {
    if (stop) await stop().catch((c: unknown) => { throw new AggregateError([e, c], `${opts.root} : démarrage en échec puis fermeture non confirmée, racine conservée`); });
    throw e;
  }
}

export async function closeHeld() {
  const entries = held.splice(0);
  const unconfirmed = new Set<Held>();
  const failures: string[] = [];
  for (const h of [...entries].reverse()) {
    await bounded(h.close(), h.ms, h.root).catch((e: Error) => { unconfirmed.add(h); failures.push(`${h.root} : ${e.message}`); });
  }
  held.unshift(...entries.filter((h) => unconfirmed.has(h)));
  const keptRoots = new Set([...unconfirmed].map((h) => h.root));
  const all = claims.splice(0);
  claims.push(...all.filter((c) => keptRoots.has(c.root)));
  for (const c of all.reverse()) if (!keptRoots.has(c.root)) c.release();
  if (failures.length) throw new Error(`fermeture non confirmée, entrées et verrous de ces racines conservés :\n${failures.join('\n')}`);
}

export async function startBench(root?: string, keys?: Bench['keys']): Promise<Bench> {
  await workerBuilt;
  const benchRoot = root ?? (await newRoot());
  const claim = claimOrThrow(benchRoot);
  const issuerKeys = keys ?? (await rt.generateIssuerKeys());
  const otherKeys = await rt.generateIssuerKeys();
  const projects = [
    { projectId: PROJECT, issuer: ISSUER, publicJwk: issuerKeys.publicJwk, attestableCapabilities: ['thread.participate', 'thread.moderate'] as const },
    { projectId: 'autre', issuer: 'autre-host', publicJwk: otherKeys.publicJwk, attestableCapabilities: ['thread.participate'] as const },
  ].map((p) => ({ ...p, attestableCapabilities: [...p.attestableCapabilities] }));
  let service = await rt.startService({ root: benchRoot, projects });
  let lastPort = service.port;
  const importToken = await rt.provisionCredential(service.db, { projectId: PROJECT, label: 'ci-demo', capabilities: ['deployment.import'] });
  const agentToken = await rt.provisionCredential(service.db, { projectId: PROJECT, label: 'agent-demo', capabilities: ['review.read'] });
  const otherProjectImportToken = await rt.provisionCredential(service.db, { projectId: 'autre', label: 'ci-autre', capabilities: ['deployment.import'] });
  const bench: Bench = {
    get service() { return service; },
    claim,
    keys: issuerKeys,
    otherKeys,
    importToken,
    agentToken,
    otherProjectImportToken,
    root: benchRoot,
    async restart() {
      await bench.stopService();
      await bench.startService();
    },
    async stopService() {
      lastPort = service.port;
      await service.stop();
    },
    async startService() {
      service = await rt.startService({ root: benchRoot, port: lastPort, projects });
    },
    async stop() {
      await service.stop();
      claim.release();
    },
  };
  return bench;
}

export async function demoManifest() {
  const r = await assembleManifest(join(REPO_ROOT, 'apps/demo/.socrate'));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.manifest;
}

export function assertionFor(bench: Bench, over: Partial<AssertionInput> & { deploymentId: string }, privateJwk = bench.keys.privateJwk): string {
  return signAssertion(privateJwk, {
    issuer: ISSUER, audience: rt.SERVICE_AUDIENCE, sub: 'claire', name: 'Claire Morel', projectId: PROJECT, reviewKey: REVIEW, origin: ORIGIN,
    capabilities: ['thread.participate'], ...over,
  });
}

export type Client = { url: string; token?: string; origin?: string };

export async function call(c: Client, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (c.token) h['Authorization'] = `Bearer ${c.token}`;
  if (c.origin) h['Origin'] = c.origin;
  const res = await fetch(`${c.url}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

export async function importDemo(bench: Bench, deploymentId: string, over: Partial<{ commit: string; buildId: string; url: string }> = {}, manifest?: unknown) {
  const m = manifest ?? (await demoManifest());
  return call({ url: bench.service.url, token: bench.importToken }, 'PUT', `/v1/projects/${PROJECT}/reviews/${REVIEW}/deployments/${deploymentId}`, {
    commit: 'a1b2c3d4e5f6', buildId: '0042', url: `${ORIGIN}/`, ...over, manifest: m,
  });
}

export async function openSession(bench: Bench, over: Partial<AssertionInput> & { deploymentId: string }, privateJwk?: JsonWebKey) {
  const assertion = assertionFor(bench, over, privateJwk);
  return call({ url: bench.service.url, origin: over.origin ?? ORIGIN }, 'POST', '/v1/auth/session', { assertion });
}

export async function sessionClient(bench: Bench, over: Partial<AssertionInput> & { deploymentId: string }): Promise<Client & { session: any }> {
  const r = await openSession(bench, over);
  if (r.status !== 201) throw new Error(`session refusée: ${r.status} ${JSON.stringify(r.json)}`);
  return { url: bench.service.url, token: r.json.sessionToken, origin: over.origin ?? ORIGIN, session: r.json };
}

export const key = () => crypto.randomUUID();
export const threadsPath = `/v1/projects/${PROJECT}/reviews/${REVIEW}/threads`;
