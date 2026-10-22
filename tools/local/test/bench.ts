import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { allowPort, guardedPath } from '../local-run.ts';

export type CaseSpec = { name: string; waitMs?: number; graceMs?: number; closeMs?: number; report?: (report: CaseReport) => void };
export type WaitOptions = { ms?: number; cancel?: AbortSignal; label?: string };
export type End = { code: number | null; signal: NodeJS.Signals | null; error: string | null };
export type HeldChild = {
  readonly child: ChildProcess;
  readonly argv: readonly string[];
  readonly end: Promise<End>;
  readonly closed: Promise<void>;
  readonly events: string[];
  ended: End | null;
  readonly rawKill: (signal?: NodeJS.Signals) => boolean;
};
export type Witness = HeldChild & { out(): string; line(opts?: WaitOptions): Promise<string>; until(predicate: (out: string) => boolean, opts?: WaitOptions): Promise<void> };
export type Listener = { readonly server: HttpServer | TcpServer; readonly port: number; listen(port?: number): Promise<number> };
export type Capture = { readonly original: typeof spawn; seen(): readonly HeldChild[] };
export type Kind = 'closer' | 'child' | 'http' | 'tcp' | 'capture' | 'root';
export type State = 'open' | 'closed' | 'rescued' | 'unconfirmed' | 'retained' | 'kept';
export type AcquisitionReport = { seq: number; name: string; kind: Kind; state: State; detail: string; ms: number };
export type CaseReport = { name: string; confirmed: boolean; acquisitions: AcquisitionReport[]; problems: string[]; publication: string | null };

type Outcome = { state: 'closed' | 'rescued'; detail: string };
type Acquisition = AcquisitionReport & { close: (budget: AbortSignal, hold: string | null) => Promise<Outcome> };

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const describeEnd = (end: End): string => (end.error ? `erreur ${end.error}` : end.signal ? `signal ${end.signal}` : `code ${end.code}`);
const tag = (a: AcquisitionReport): string => `${a.name}#${a.seq}`;
const pidOf = (held: HeldChild): string => `pid ${held.child.pid ?? 'absent'}`;

function raced<T>(work: Promise<T>, cancel: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancel.reason);
    work.then((value) => { cancel.removeEventListener('abort', onAbort); resolve(value); }, (e: unknown) => { cancel.removeEventListener('abort', onAbort); reject(e); });
    if (cancel.aborted) onAbort();
    else cancel.addEventListener('abort', onAbort, { once: true });
  });
}

function bounded<T>(work: Promise<T>, ms: number, label: string, cancel?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(new Error(`${label} : annulé (${describe(cancel?.reason)})`, { cause: cancel?.reason })));
    const timer = setTimeout(() => settle(() => reject(new Error(`${label} : ${ms} ms dépassés`))), ms);
    work.then((value) => settle(() => resolve(value)), (e: unknown) => settle(() => reject(e)));
    if (cancel?.aborted) onAbort();
    else cancel?.addEventListener('abort', onAbort, { once: true });
  });
}

function holdChild(child: ChildProcess, argv: readonly string[]): HeldChild {
  const events: string[] = [];
  let finish = (_end: End): void => undefined;
  const held: HeldChild = {
    child, argv, events, ended: null, rawKill: child.kill.bind(child),
    end: new Promise<End>((resolve) => {
      finish = (end) => {
        held.ended ??= end;
        resolve(end);
      };
    }),
    closed: new Promise<void>((resolve) => child.once('close', () => {
      events.push('close');
      resolve();
    })),
  };
  child.once('exit', (code, signal) => {
    events.push(`exit ${describeEnd({ code, signal, error: null })}`);
    finish({ code, signal, error: null });
  });
  child.on('error', (e) => {
    const refused = held.ended === null && (child.exitCode !== null || child.signalCode !== null);
    events.push(`${refused ? 'création refusée' : 'erreur non terminale'} ${e.message}`);
    if (refused) finish({ code: child.exitCode, signal: child.signalCode, error: e.message });
  });
  return held;
}

type Ending = { signalled: boolean; detail: string };

async function endChild(held: HeldChild, graceMs: number, budget: AbortSignal): Promise<Ending> {
  const sent: string[] = [];
  const send = (signal: NodeJS.Signals) => {
    budget.throwIfAborted();
    sent.push(held.rawKill(signal) ? signal : `${signal} refusé`);
  };
  const signals = () => (sent.length ? `${sent.join(' puis ')} envoyé(s) par le handle` : 'aucun signal envoyé');
  const awaitEnd = (label: string) => bounded(held.end, graceMs, label, budget).then((end) => end, (e: unknown) => {
    if (budget.aborted) throw e;
    return null;
  });
  let end = held.ended;
  try {
    if (!end) {
      send('SIGTERM');
      end = await awaitEnd('SIGTERM');
    }
    if (!end) {
      send('SIGKILL');
      end = await awaitEnd('SIGKILL');
    }
    if (!end) throw new Error(`témoin ${pidOf(held)} : ${signals()}, fin non observée`);
  } catch (e) {
    if (!budget.aborted) throw e;
    throw new Error(`témoin ${pidOf(held)} : ${signals()}, fin non observée avant la borne (${describe(budget.reason)}) ; aucun autre signal`, { cause: budget.reason });
  }
  await raced(held.closed, budget).catch((e: unknown) => {
    throw new Error(`témoin ${pidOf(held)} : ${signals()}, ${describeEnd(end)} observé, close non observé avant la borne (${describe(e)}) ; aucun autre signal`, { cause: e });
  });
  return { signalled: sent.length > 0, detail: `${sent.length ? `terminé par ${sent.join(' puis ')} du handle` : 'déjà terminé'} (${describeEnd(end)}), flux fermés` };
}

const cjs = createRequire(import.meta.url)('node:child_process') as { spawn: typeof spawn };
const rawSpawn = cjs.spawn;
let activeCapture: string | null = null;
let retainedCapture: string | null = null;

function installCapture(owner: string, graceMs: number): { capture: Capture; close: Acquisition['close'] } {
  if (retainedCapture) throw new Error(`banc : capture retenue, campagne arrêtée (${retainedCapture})`);
  if (activeCapture !== null) throw new Error(`banc : capture de spawn déjà détenue par le cas ${activeCapture}, seconde portée refusée avant effet`);
  const original = cjs.spawn;
  const records: HeldChild[] = [];
  let refusal: string | null = null;
  const wrapped = function benchSpawn(this: unknown, ...args: unknown[]): ChildProcess {
    if (refusal) throw new Error(`banc : création de processus refusée ${refusal}`);
    const child = (original as unknown as (...a: unknown[]) => ChildProcess).apply(this, args);
    records.push(holdChild(child, [String(args[0]), ...(Array.isArray(args[1]) ? args[1].map(String) : [])]));
    return child;
  };
  activeCapture = owner;
  cjs.spawn = wrapped as unknown as typeof spawn;
  syncBuiltinESMExports();
  const close = async (budget: AbortSignal, hold: string | null): Promise<Outcome> => {
    refusal = 'pendant la fermeture de la capture';
    const results = await Promise.allSettled(records.map((r) => endChild(r, graceMs, budget)));
    const notes = results.map((result, i) => (result.status === 'fulfilled' ? `${result.value.signalled ? 'secours ' : ''}${pidOf(records[i]!)} : ${result.value.detail}` : `${pidOf(records[i]!)} : ${describe(result.reason)}`));
    try {
      if (hold) throw new Error(hold);
      const unconfirmed = results.filter((result) => result.status === 'rejected').length;
      if (unconfirmed) throw new Error(`${unconfirmed} processus sans fermeture confirmée`);
      budget.throwIfAborted();
      cjs.spawn = original;
      syncBuiltinESMExports();
      activeCapture = null;
      return results.some((result) => result.status === 'fulfilled' && result.value.signalled)
        ? { state: 'rescued', detail: `originaux restaurés après secours : ${notes.join(' ; ')}` }
        : { state: 'closed', detail: `${records.length} processus observé(s), fins et close observés, originaux restaurés` };
    } catch (e) {
      const cause = [describe(e), ...notes].join(' ; ');
      retainedCapture = `cas ${owner} : ${cause}`;
      refusal = `: capture retenue (${retainedCapture})`;
      throw new Error(`capture retenue, originaux non restaurés : ${cause}`, { cause: e });
    }
  };
  return { capture: { original, seen: () => records }, close };
}

class Case {
  readonly name: string;
  readonly cancel: AbortSignal;
  readonly #spec: CaseSpec;
  readonly #controller = new AbortController();
  readonly #acquisitions: Acquisition[] = [];
  #phase: 'open' | 'closing' | 'done' = 'open';
  #closing: Promise<{ report: CaseReport; publication: { error: unknown } | null }> | undefined;

  constructor(spec: CaseSpec) {
    for (const [key, value] of [['waitMs', spec.waitMs], ['graceMs', spec.graceMs], ['closeMs', spec.closeMs]] as const) {
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) throw new Error(`banc : ${key} du cas ${spec.name} doit être un nombre de millisecondes positif`);
    }
    this.#spec = spec;
    this.name = spec.name;
    this.cancel = this.#controller.signal;
  }

  #open(name: string): void {
    if (this.#phase !== 'open') throw new Error(`banc : acquisition ${name} refusée, le cas ${this.name} n’accepte plus d’acquisition (${this.#phase})`);
  }

  #acquire(kind: Kind, name: string, close: Acquisition['close']): Acquisition {
    this.#open(name);
    let done: Promise<Outcome> | undefined;
    const acquisition: Acquisition = { seq: this.#acquisitions.length + 1, name, kind, state: 'open', detail: '', ms: 0, close: (budget, hold) => (done ??= close(budget, hold)) };
    this.#acquisitions.push(acquisition);
    return acquisition;
  }

  closer(name: string, close: () => Promise<string | void>): () => Promise<string | void> {
    let started: Promise<string | void> | undefined;
    const run = () => (started ??= (async () => close())());
    this.#acquire('closer', name, async (budget) => ({ state: 'closed', detail: (await raced(run(), budget)) ?? 'fermée' }));
    return run;
  }

  wait<T>(work: Promise<T>, opts: WaitOptions = {}): Promise<T> {
    const cancel = opts.cancel ? AbortSignal.any([this.cancel, opts.cancel]) : this.cancel;
    return bounded(work, opts.ms ?? this.#spec.waitMs ?? 10_000, opts.label ?? 'attente', cancel);
  }

  child(input: { name: string; argv: string[]; stdin?: 'pipe' | 'ignore' }): Witness {
    this.#open(input.name);
    const argv = [process.execPath, ...input.argv];
    const child = rawSpawn(argv[0]!, argv.slice(1), { stdio: [input.stdin ?? 'ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    const held = holdChild(child, argv);
    this.#acquire('child', input.name, async (budget) => ({ state: 'closed', detail: (await endChild(held, this.#spec.graceMs ?? 5_000, budget)).detail }));
    let out = '';
    let eof = false;
    const watchers = new Set<() => void>();
    const notify = () => {
      for (const watcher of [...watchers]) watcher();
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      out += String(chunk);
      notify();
    });
    child.stdout!.once('end', () => {
      eof = true;
      notify();
    });
    void held.end.then(notify);
    const until = (predicate: (out: string) => boolean, opts: WaitOptions = {}): Promise<void> => {
      const label = opts.label ?? `témoin ${input.name}`;
      let check = (): void => undefined;
      const inner = new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void) => {
          watchers.delete(check);
          fn();
        };
        check = () => {
          try {
            if (predicate(out)) settle(resolve);
            else if (eof || held.ended?.error) settle(() => reject(new Error(`${label} : ${held.ended ? `terminé (${describeEnd(held.ended)})` : 'sortie fermée (EOF)'} avant la condition attendue ; sortie ${JSON.stringify(out)}`)));
          } catch (e) {
            settle(() => reject(e));
          }
        };
        watchers.add(check);
        check();
      });
      return this.wait(inner, { ...opts, label }).finally(() => watchers.delete(check));
    };
    const line = (opts: WaitOptions = {}) => until((o) => o.includes('\n'), { ...opts, label: opts.label ?? `première ligne du témoin ${input.name}` }).then(() => out.split('\n')[0]!);
    return Object.assign(held, { out: () => out, line, until });
  }

  http(input: { name: string; handle: (req: IncomingMessage, res: ServerResponse) => void }): Listener {
    this.#open(input.name);
    return this.#hold('http', input.name, createHttpServer(input.handle));
  }

  tcp(input: { name: string; connection?: (socket: Socket) => void }): Listener {
    this.#open(input.name);
    return this.#hold('tcp', input.name, createTcpServer(input.connection));
  }

  #hold(kind: 'http' | 'tcp', name: string, server: HttpServer | TcpServer): Listener {
    const sockets = new Set<Socket>();
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    let port = 0;
    let state: 'idle' | 'pending' | 'listening' | 'failed' | 'closed' = 'idle';
    let revoke = (): void => undefined;
    let invalidate = (_e: Error): void => undefined;
    this.#acquire(kind, name, async (budget) => {
      const was = state;
      state = 'closed';
      const destroyed = sockets.size;
      for (const socket of sockets) socket.destroy();
      revoke();
      invalidate(new Error(`écoute de ${name} invalidée par la fermeture du cas`));
      const closing = new Promise<void>((resolve, reject) => server.close((e?: NodeJS.ErrnoException) => (e && e.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(e) : resolve())));
      await raced(closing, budget);
      return { state: 'closed', detail: `${was === 'listening' ? `port ${port} fermé` : was === 'pending' ? 'demande d’écoute pending invalidée avant liaison' : 'jamais en écoute'}, ${destroyed} socket(s) détruite(s)` };
    });
    const listen = (wanted = 0) => new Promise<number>((resolve, reject) => {
      if (state !== 'idle') return reject(new Error(`écoute de ${name} refusée : ${state === 'closed' ? 'hors de la durée de vie du cas' : `une demande a déjà eu lieu (${state})`}`));
      state = 'pending';
      const done = (fn: () => void) => {
        server.off('listening', onListening);
        server.off('error', onError);
        invalidate = () => undefined;
        fn();
      };
      const onListening = () => done(() => {
        state = 'listening';
        port = (server.address() as { port: number }).port;
        revoke = allowPort(port);
        resolve(port);
      });
      const onError = (e: Error) => done(() => {
        state = 'failed';
        reject(e);
      });
      invalidate = (e) => done(() => reject(e));
      server.once('listening', onListening);
      server.once('error', onError);
      try {
        server.listen(wanted, '127.0.0.1');
      } catch (e) {
        onError(e as Error);
      }
    });
    return { server, get port() { return port; }, listen };
  }

  captureSpawns(): Capture {
    this.#open('capture');
    const { capture, close } = installCapture(this.name, this.#spec.graceMs ?? 5_000);
    this.#acquire('capture', 'capture', close);
    return capture;
  }

  root(...paths: string[]): void {
    const targets = paths.map((p) => guardedPath(p));
    this.#acquire('root', 'root', async (budget) => {
      const removed: string[] = [];
      const progress = () => `supprimée(s) : ${removed.join(' ; ') || 'aucune'} ; non commencée(s) : ${targets.slice(removed.length + 1).join(' ; ') || 'aucune'}`;
      for (const target of targets) {
        if (budget.aborted) throw new Error(`racine ${target} : suppression non commencée (${describe(budget.reason)}) ; ${progress()}`, { cause: budget.reason });
        await raced(rm(guardedPath(target), { recursive: true, force: true }), budget).catch((e: unknown) => {
          if (e !== budget.reason) throw e;
          throw new Error(`racine ${target} : rm commencé, issue inconnue (${describe(e)}) ; ${progress()}`, { cause: e });
        });
        removed.push(target);
      }
      return { state: 'closed', detail: `supprimée : ${targets.join(' ; ')}` };
    });
  }

  async #closeOne(acquisition: Acquisition, hold: string | null): Promise<void> {
    const started = performance.now();
    const ms = this.#spec.closeMs ?? 20_000;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error(`fermeture de ${tag(acquisition)} : ${ms} ms dépassés`)), ms);
    try {
      const outcome = await bounded(acquisition.close(budget.signal, hold), ms + 1_000, `règlement de la fermeture de ${tag(acquisition)}`);
      acquisition.state = outcome.state;
      acquisition.detail = outcome.detail;
    } catch (e) {
      acquisition.state = acquisition.kind === 'capture' ? 'retained' : 'unconfirmed';
      acquisition.detail = describe(e);
    } finally {
      clearTimeout(timer);
      acquisition.ms = Math.round(performance.now() - started);
    }
  }

  close(): Promise<{ report: CaseReport; publication: { error: unknown } | null }> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<{ report: CaseReport; publication: { error: unknown } | null }> {
    this.#phase = 'closing';
    this.#controller.abort(new Error(`cas ${this.name} : fermeture du banc, attentes annulées`));
    const tier = (pick: (a: Acquisition) => boolean) => this.#acquisitions.filter(pick).reverse();
    const ordinary = tier((a) => a.kind !== 'capture' && a.kind !== 'root');
    for (const acquisition of ordinary) await this.#closeOne(acquisition, null);
    const unknownProducers = ordinary.filter((a) => a.state !== 'closed');
    const hold = unknownProducers.length ? `producteur(s) à fin inconnue : ${unknownProducers.map(tag).join(', ')}` : null;
    for (const acquisition of tier((a) => a.kind === 'capture')) await this.#closeOne(acquisition, hold);
    const others = this.#acquisitions.filter((a) => a.kind !== 'root');
    const unknown = others.filter((a) => a.state !== 'closed' && a.state !== 'rescued');
    const rescued = others.filter((a) => a.state === 'rescued');
    for (const root of tier((a) => a.kind === 'root')) {
      if (unknown.length) {
        root.state = 'kept';
        root.detail = `racine conservée : ${unknown.map((a) => `${tag(a)} ${a.state}`).join(', ')}`;
      } else if (rescued.length) {
        root.state = 'kept';
        root.detail = `racine conservée après secours de ${rescued.map(tag).join(', ')}`;
      } else await this.#closeOne(root, null);
    }
    this.#phase = 'done';
    const problems = this.#acquisitions.filter((a) => a.state !== 'closed').map((a) => `${tag(a)} (${a.kind}) : ${a.detail}`);
    const report: CaseReport = { name: this.name, confirmed: problems.length === 0, acquisitions: this.#acquisitions.map(({ close: _close, ...rest }) => rest), problems, publication: null };
    let publication: { error: unknown } | null = null;
    try {
      this.#spec.report?.(report);
    } catch (e) {
      publication = { error: e };
      report.publication = describe(e);
    }
    return { report, publication };
  }
}

export type OwnedCase = Pick<Case, 'name' | 'cancel' | 'closer' | 'wait' | 'child' | 'http' | 'tcp' | 'captureSpawns' | 'root'>;

export class CaseFailure extends AggregateError {
  readonly report: CaseReport;
  constructor(report: CaseReport, primary: { error: unknown } | null, publication: { error: unknown } | null = null) {
    const parts = [
      ...(primary ? [`erreur initiale : ${describe(primary.error)}`] : []),
      ...report.problems.map((p) => `fermeture : ${p}`),
      ...(publication ? [`publication : ${describe(publication.error)}`] : []),
    ];
    super([...(primary ? [primary.error] : []), ...report.problems.map((p) => new Error(p)), ...(publication ? [publication.error] : [])], `cas ${report.name} : ${parts.join(' ; ')}`);
    this.name = 'CaseFailure';
    this.report = report;
  }
}

export async function withOwnedCase<T>(spec: CaseSpec, run: (b: OwnedCase) => Promise<T>): Promise<T> {
  const b = new Case(spec);
  let primary: { error: unknown } | null = null;
  try {
    return await run(b);
  } catch (e) {
    primary = { error: e };
    throw e;
  } finally {
    const { report, publication } = await b.close();
    if (primary || !report.confirmed || publication) throw new CaseFailure(report, primary, publication);
  }
}
