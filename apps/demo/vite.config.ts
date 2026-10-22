import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { signAssertion } from '../../tools/local/assertion.ts';
import { guardedPath } from '../../tools/local/local-run.ts';

const PERSONAS: Record<string, { sub: string; name: string; capabilities: string[]; exploring: { account: string; organisation: string | null } | null; role: 'relectrice' | 'developpeur' | 'invite' }> = {
  claire: { sub: 'claire', name: 'Claire Morel', capabilities: ['thread.participate'], exploring: null, role: 'relectrice' },
  karim: { sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate', 'thread.moderate'], exploring: null, role: 'developpeur' },
  'claire-impersonation': { sub: 'claire', name: 'Claire Morel', capabilities: ['thread.participate'], exploring: { account: 'cabinet-dupont', organisation: 'Cabinet Dupont' }, role: 'relectrice' },
  invite: { sub: 'invite', name: 'Invité Sans Droit', capabilities: [], exploring: null, role: 'invite' },
};

function socratePreviewBuild(value = process.env.SOCRATE_PREVIEW_BUILD): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`SOCRATE_PREVIEW_BUILD refusé : ${JSON.stringify(value)} (true, false ou absent)`);
}

const SCENE = process.env.SOCRATE_DEMO_SCENE ?? 'a';
if (SCENE !== 'a' && SCENE !== 'b') throw new Error(`SOCRATE_DEMO_SCENE refusé : ${JSON.stringify(SCENE)} (a, b ou absent)`);

function middleware() {
  const runtimeDir = process.env.SOCRATE_RUNTIME_DIR;
  if (!runtimeDir) throw new Error('SOCRATE_RUNTIME_DIR requis : lancer la démo avec `npm run demo`');
  const privateJwk = JSON.parse(readFileSync(guardedPath(resolve(runtimeDir, 'keys/issuer-private.jwk.json')), 'utf8'));
  const preview = JSON.parse(readFileSync(guardedPath(resolve(runtimeDir, process.env.SOCRATE_PREVIEW_CONTEXT ?? 'preview-context.json')), 'utf8')) as { serviceUrl: string; projectId: string; reviewKey: string; deploymentId: string; origin: string; issuer: string; audience: string; instanceId: string };
  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<string>((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d)); });
  const sessionOf = (req: IncomingMessage) => {
    const m = /(?:^|;\s*)demo_session=([a-z-]+)/.exec(req.headers.cookie ?? '');
    return m && PERSONAS[m[1]!] ? { id: m[1]!, ...PERSONAS[m[1]!]! } : null;
  };
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/')) return next();
    const session = sessionOf(req);
    if (url === '/api/login' && req.method === 'POST') {
      const { persona } = JSON.parse((await readBody(req)) || '{}');
      const p = PERSONAS[persona];
      if (!p) return json(res, 400, { error: 'persona inconnue' });
      return json(res, 200, { persona, displayName: p.name, role: p.role, exploring: p.exploring }, { 'Set-Cookie': `demo_session=${persona}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (url === '/api/logout' && req.method === 'POST') return json(res, 204, null, { 'Set-Cookie': 'demo_session=; Path=/; Max-Age=0' });
    if (url === '/api/me') return session ? json(res, 200, { persona: session.id, displayName: session.name, role: session.role, exploring: session.exploring }) : json(res, 401, { error: 'non connecté' });
    if (url === '/api/preview-context') return json(res, 200, { serviceUrl: preview.serviceUrl, projectId: preview.projectId, reviewKey: preview.reviewKey, deploymentId: preview.deploymentId, instanceId: preview.instanceId });
    if (url === '/api/socrate/assertion' && req.method === 'POST') {
      if (!session) return json(res, 401, { error: 'session hôte requise' });
      const assertion = signAssertion(privateJwk, {
        issuer: preview.issuer, audience: preview.audience, sub: session.sub, name: session.name, projectId: preview.projectId, reviewKey: preview.reviewKey,
        deploymentId: preview.deploymentId, origin: preview.origin, capabilities: session.capabilities, exploring: session.exploring, ttlSeconds: 60,
      });
      return json(res, 200, { assertion });
    }
    return json(res, 404, { error: 'route inconnue' });
  };
}

function hostBackend(): Plugin {
  return {
    name: 'socrate-demo-host-backend',
    configureServer: (server) => void server.middlewares.use(middleware()),
    configurePreviewServer: (server) => void server.middlewares.use(middleware()),
  };
}

export default defineConfig({
  plugins: [react(), hostBackend()],
  // Deux hôtes de scènes différentes tournent ensemble : chacun garde ses dépendances optimisées.
  cacheDir: resolve(import.meta.dirname, SCENE === 'b' ? '../../.local/vite-cache-b' : '../../.local/vite-cache'),
  define: { __SOCRATE_PREVIEW__: JSON.stringify(socratePreviewBuild()), __DEMO_SCENE_B__: JSON.stringify(SCENE === 'b') },
  server: { host: '127.0.0.1', port: Number(process.env.SOCRATE_DEMO_PORT ?? 5173), strictPort: true },
  preview: { host: '127.0.0.1', port: Number(process.env.SOCRATE_DEMO_PORT ?? 4173), strictPort: true },
  appType: 'spa',
});
