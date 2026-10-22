import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

export class LocalRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

export function localPath(...segments: string[]): string {
  const target = resolve(REPO_ROOT, ...segments);
  const rel = relative(REPO_ROOT, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new LocalRefusal('path_outside', `chemin hors du dépôt refusé : ${segments.join('/')}`);
  }
  let current = REPO_ROOT;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      break;
    }
    if (stat.isSymbolicLink()) throw new LocalRefusal('symlink', `lien symbolique refusé sur le chemin : ${relative(REPO_ROOT, current)}`);
  }
  return target;
}

export const guardedPath = (absolute: string): string => localPath(relative(REPO_ROOT, resolve(absolute)));

export function guardedTree(absolute: string): { path: string; files: number } {
  const path = guardedPath(absolute);
  let files = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new LocalRefusal('symlink', `lien symbolique refusé sur le chemin : ${relative(REPO_ROOT, child)}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files += 1;
    }
  };
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { path, files };
  }
  if (stat.isDirectory()) walk(path);
  return { path, files };
}

export const LOCAL_ROOT = localPath('.local');
export const TMP_ROOT = localPath('.tmp');
export const TMPDIR = localPath('.tmp', 'tmp');
export const BROWSERS_DIR = localPath('.local', 'pw-browsers');
export const NPM_CACHE = localPath('.local', 'npm-cache');

mkdirSync(TMPDIR, { recursive: true });
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = TMPDIR;
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR;
process.env.npm_config_cache = NPM_CACHE;
delete process.env.NODE_OPTIONS;

export function instanceName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) {
    throw new LocalRefusal('instance_invalid', `nom d'instance refusé : ${JSON.stringify(value)} (minuscules, chiffres et tirets, 48 caractères au plus)`);
  }
  return value;
}

export function portNumber(value: unknown, label: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 65_535) throw new LocalRefusal('port_invalid', `port ${label} refusé : ${JSON.stringify(value)}`);
  return n as number;
}

export type Deadline = { readonly at: number };
export const deadlineIn = (ms: number): Deadline => ({ at: performance.now() + ms });
export const remaining = (d: Deadline): number => d.at - performance.now();

const allowedPorts = new Map<number, number>();
export function allowPort(port: number): () => void {
  allowedPorts.set(port, (allowedPorts.get(port) ?? 0) + 1);
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    const n = (allowedPorts.get(port) ?? 1) - 1;
    if (n <= 0) allowedPorts.delete(port);
    else allowedPorts.set(port, n);
  };
}

const nativeFetch = globalThis.fetch;
let transportCalls = 0;
export const transportCallCount = () => transportCalls;

function admit(input: RequestInfo | URL): URL {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new LocalRefusal('network_refused', `destination refusée avant émission : ${url.origin}`);
  }
  const port = Number(url.port || 80);
  if (!allowedPorts.has(port)) throw new LocalRefusal('network_refused', `port loopback non possédé par le banc : ${port}`);
  return url;
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  admit(input);
  transportCalls += 1;
  return nativeFetch(input, { ...init, redirect: 'error' });
};

export type LocalResponse = { status: number; headers: Headers; text: string; json: unknown };

export async function localFetch(url: string, deadline: Deadline, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, cancel?: AbortSignal): Promise<LocalResponse> {
  const ms = remaining(deadline);
  if (ms <= 0) throw new LocalRefusal('deadline', `délai écoulé avant la requête ${url}`);
  cancel?.throwIfAborted();
  const timeout = AbortSignal.timeout(Math.ceil(ms));
  const res = await fetch(url, { ...init, signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export type PortState = 'refused' | 'listening' | 'unknown';

export function tcpProbe(port: number, timeoutMs = 1000): Promise<PortState> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (state: PortState) => {
      socket.destroy();
      done(state);
    };
    socket.setTimeout(timeoutMs, () => finish('unknown'));
    socket.once('connect', () => finish('listening'));
    socket.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED' ? 'refused' : 'unknown'));
  });
}

export const sleep = (ms: number, cancel?: AbortSignal) => new Promise<void>((r) => {
  if (cancel?.aborted) return r();
  const done = () => {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', done);
    r();
  };
  const timer = setTimeout(done, ms);
  cancel?.addEventListener('abort', done, { once: true });
});

export type Ports = { service: number; demo: number };

export type LocalCommand =
  | { action: 'launch'; instance: string; ports: Ports; reset?: boolean; detached?: boolean; deadlineMs?: number; log?: (line: string) => void; cancel?: AbortSignal }
  | { action: 'doctor'; instance: string; deadlineMs?: number }
  | { action: 'cleanup'; instance: string; deadlineMs?: number };

export type InstanceView = { name: string; instanceId: string; build: string; schema: string[]; serviceUrl: string; demoOrigin: string; root: string };
export type Check = { ok: boolean; detail: string };

export type LocalReport =
  | { kind: 'ready'; instance: InstanceView; stop?: () => Promise<StopReport> }
  | { kind: 'healthy'; checks: Record<string, Check> }
  | { kind: 'cleaned'; detail: string }
  | { kind: 'refused'; reason: string; detail: string; checks?: Record<string, Check> };

export type StopReport = { confirmed: boolean; detail: string };

export const runtime = () => import('./runtime.ts');
export const browser = () => import('./browser.ts');

export async function localCommand(command: LocalCommand): Promise<LocalReport> {
  const name = instanceName(command.instance);
  const rt = await runtime();
  const deadline = deadlineIn(command.deadlineMs ?? 60_000);
  try {
    if (command.action === 'launch') {
      const ports = { service: portNumber(command.ports.service, 'service'), demo: portNumber(command.ports.demo, 'démo') };
      if (command.detached) return await rt.launchDetached({ name, ports, reset: command.reset ?? false, deadline, log: command.log });
      const handle = await rt.launchInstance({ root: rt.instanceRoot(name), name, ports, reset: command.reset ?? false, deadline, log: command.log, cancel: command.cancel });
      return { kind: 'ready', instance: handle.view, stop: handle.stop };
    }
    if (command.action === 'doctor') return await rt.doctorInstance(name, deadline);
    return await rt.cleanupInstance(name, deadline);
  } catch (e) {
    if (e instanceof LocalRefusal) return { kind: 'refused', reason: e.reason, detail: e.message };
    throw e;
  }
}
