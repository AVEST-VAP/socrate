import type { LocalContext } from './browser.ts';

export type Traced = Readonly<{ phase: string; method: string; path: string; origin: string; status: number | null; bytes: number | null; error: string | null }>;

// La phase d'une requête est celle ouverte quand le routage du navigateur l'a enregistrée dans ctx.seen, jamais celle de sa fin.
export function phaseTrace(ctx: Pick<LocalContext, 'seen'>, first: string) {
  const marks = [{ phase: first, from: ctx.seen.length }];
  const own = () => ctx.seen.slice(marks[0]!.from);
  return {
    begin(phase: string) {
      marks.push({ phase, from: ctx.seen.length });
    },
    async settle({ quietMs = 500, timeoutMs = 10_000 } = {}): Promise<string[]> {
      const end = Date.now() + timeoutMs;
      let count = ctx.seen.length;
      let since = Date.now();
      for (;;) {
        const pending = own().filter((r) => !r.outcome);
        if (ctx.seen.length !== count) {
          count = ctx.seen.length;
          since = Date.now();
        } else if (pending.length === 0 && Date.now() - since >= quietMs) return [];
        if (Date.now() >= end) return pending.length ? pending.map((r) => `sans issue après ${timeoutMs} ms : ${r.method} ${r.url}`) : [`activité réseau continue après ${timeoutMs} ms`];
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    records(): Traced[] {
      return own().map((r, i) => {
        const u = new URL(r.url);
        const o = r.outcome;
        return Object.freeze({
          phase: marks.findLast((m) => m.from <= marks[0]!.from + i)!.phase,
          method: r.method,
          path: u.pathname,
          origin: u.origin,
          status: o && 'status' in o ? o.status : null,
          bytes: o && 'status' in o ? o.bytes : null,
          error: !o ? 'sans issue' : 'error' in o ? o.error : null,
        });
      });
    },
  };
}

export function traceProblems(trace: Traced[], ctx: Pick<LocalContext, 'blocked' | 'failed'>, incomplete: string[], expected: (r: Traced) => boolean): string[] {
  return [
    ...incomplete.map((s) => `collecte incomplète : ${s}`),
    ...ctx.blocked.map((s) => `bloquée : ${s}`),
    ...ctx.failed.map((s) => `échec du transport : ${s}`),
    ...trace.filter((r) => !expected(r) && (r.error !== null || r.status === null || r.status < 200 || r.status >= 300)).map((r) => `inattendue en ${r.phase} : ${r.method} ${r.origin}${r.path} ${r.error ?? r.status}`),
  ];
}
