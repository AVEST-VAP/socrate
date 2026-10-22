import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { BROWSERS_DIR, LocalRefusal, deadlineIn, remaining, type Deadline } from './local-run.ts';

export type SeenRequest = { url: string; method: string; headers: Record<string, string>; postData: string | null; outcome?: { status: number; bytes: number } | { error: string } };
export type FaultDecision =
  | { kind: 'pass' }
  | { kind: 'abort' }
  | { kind: 'lose-response' }
  | { kind: 'hold'; until: Promise<unknown> }
  | { kind: 'hold-response'; until: Promise<unknown> }
  | { kind: 'respond'; status: number; body: unknown };
export type FaultPolicy = (request: SeenRequest) => FaultDecision;

export type LocalContext = {
  context: BrowserContext;
  seen: SeenRequest[];
  blocked: string[];
  failed: string[];
  setFaults(policy: FaultPolicy | null): void;
};

export type LocalBrowser = {
  browser: Browser;
  sinkAttempts: string[];
  newContext(allowedOrigins: string[], display?: { deviceScaleFactor?: number }): Promise<LocalContext>;
  /** Origines listées jamais interceptées : un `fulfill` Playwright ajoute lui-même `Access-Control-Allow-Origin` (issue Playwright 12929) et masquerait le CORS réel du service. */
  newNativeContext(allowedOrigins: string[]): Promise<{ context: BrowserContext; blocked: string[] }>;
  close(): Promise<void>;
};

export function browserExecutablePath(): string {
  return chromium.executablePath();
}

function assertLocalBrowser(): string {
  const path = browserExecutablePath();
  const real = realpathSync(path);
  if (!real.startsWith(`${BROWSERS_DIR}/`)) throw new LocalRefusal('browser_outside', `navigateur hors de ${BROWSERS_DIR} : ${real}`);
  return path;
}

async function startSink(): Promise<{ url: string; attempts: string[]; close(): Promise<void> }> {
  const attempts: string[] = [];
  const server = createServer((req, res) => {
    attempts.push(`${req.method} ${req.url}`);
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('sortie réseau refusée par le puits loopback du banc Socrate');
  });
  server.on('connect', (req, socket) => {
    attempts.push(`CONNECT ${req.url}`);
    socket.on('error', (e: NodeJS.ErrnoException) => attempts.push(`CONNECT ${req.url} : ${e.code ?? e.message}`));
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, attempts, close: () => new Promise((r) => server.close(() => r())) };
}

/** `autoAcceptTabCapture` est une permission automatique de Chromium pour les tests de logique : jamais une preuve du sélecteur natif. */
export async function openBrowser(opts: { headed?: boolean; autoAcceptTabCapture?: boolean } = {}): Promise<LocalBrowser> {
  const executablePath = assertLocalBrowser();
  const sink = await startSink();
  const browser = await chromium.launch({
    headless: !opts.headed,
    executablePath,
    proxy: { server: sink.url, bypass: '127.0.0.1' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--no-default-browser-check', '--metrics-recording-only', '--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions,Translate,SafeBrowsing,LocalNetworkAccessChecksWebSockets',
      ...(opts.autoAcceptTabCapture ? ['--auto-accept-this-tab-capture'] : [])],
  });
  return {
    browser,
    sinkAttempts: sink.attempts,
    async newContext(allowedOrigins: string[], display: { deviceScaleFactor?: number } = {}) {
      const allowed = new Set(allowedOrigins);
      const context = await browser.newContext({ serviceWorkers: 'block', ...(display.deviceScaleFactor ? { deviceScaleFactor: display.deviceScaleFactor } : {}) });
      const seen: SeenRequest[] = [];
      const blocked: string[] = [];
      const failed: string[] = [];
      let policy: FaultPolicy | null = null;
      const deadline = (): Deadline => deadlineIn(15_000);
      const handler = async (route: Route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.resourceType() === 'serviceworker' || !allowed.has(url.origin)) {
          blocked.push(`${req.method()} ${req.url()}`);
          return route.abort('blockedbyclient');
        }
        const request: SeenRequest = { url: req.url(), method: req.method(), headers: req.headers(), postData: req.postData() };
        seen.push(request);
        const decision = policy?.(request) ?? { kind: 'pass' };
        if (decision.kind === 'abort') {
          request.outcome = { error: 'abort injecté' };
          return route.abort('connectionreset');
        }
        if (decision.kind === 'respond') {
          const body = JSON.stringify(decision.body);
          await route.fulfill({ status: decision.status, contentType: 'application/json; charset=utf-8', body });
          request.outcome = { status: decision.status, bytes: Buffer.byteLength(body) };
          return;
        }
        if (decision.kind === 'hold') await decision.until;
        const d = deadline();
        let response: Awaited<ReturnType<Route['fetch']>>;
        try {
          response = await route.fetch({ maxRedirects: 0, timeout: Math.max(1, Math.ceil(remaining(d))) });
        } catch (e) {
          failed.push(`${req.method()} ${req.url()} : ${(e as Error).message.split('\n')[0]}`);
          request.outcome = { error: failed.at(-1)! };
          return route.abort(/timeout/i.test((e as Error).message) ? 'timedout' : 'connectionrefused');
        }
        // 304 Not Modified revalide une ressource déjà en cache, sans Location ni navigation : ce n'est pas une redirection.
        if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
          blocked.push(`redirection refusée ${response.status()} depuis ${req.url()} vers ${response.headers()['location'] ?? '(sans Location)'}`);
          request.outcome = { error: blocked.at(-1)! };
          return route.abort('blockedbyclient');
        }
        if (decision.kind === 'lose-response') {
          request.outcome = { error: 'réponse perdue injectée' };
          return route.abort('connectionreset');
        }
        if (decision.kind === 'hold-response') await decision.until;
        try {
          const bytes = (await response.body()).length;
          await route.fulfill({ response });
          request.outcome = { status: response.status(), bytes };
        } catch (e) {
          request.outcome = { error: `remise au navigateur impossible : ${(e as Error).message.split('\n')[0]}` };
        }
      };
      await context.route('**/*', handler);
      await context.routeWebSocket('**', (ws) => {
        const url = new URL(ws.url());
        const origin = `http://${url.host}`;
        if (url.protocol === 'ws:' && allowed.has(origin)) ws.connectToServer();
        else {
          blocked.push(`websocket ${ws.url()}`);
          ws.close();
        }
      });
      return { context, seen, blocked, failed, setFaults: (p) => { policy = p; } };
    },
    async newNativeContext(allowedOrigins: string[]) {
      const allowed = new Set(allowedOrigins);
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const blocked: string[] = [];
      await context.route((url) => !allowed.has(url.origin), (route) => {
        blocked.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort('blockedbyclient');
      });
      await context.routeWebSocket((url) => !allowed.has(`http://${url.host}`), (ws) => {
        blocked.push(`websocket ${ws.url()}`);
        ws.close();
      });
      return { context, blocked };
    },
    async close() {
      await browser.close();
      await sink.close();
    },
  };
}
