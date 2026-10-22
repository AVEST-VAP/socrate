import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalRefusal, deadlineIn, instanceName, localFetch, portNumber, runtime, tcpProbe } from './local-run.ts';
import { signAssertion } from './assertion.ts';

// Parcours de lancement au premier plan : la pile possédée est démarrée, un retour fictif est publié puis lu, la pile est arrêtée.
const rt = await runtime();
const name = instanceName(process.env.SOCRATE_INSTANCE ?? 'parcours');
const ports = { service: portNumber(process.env.SOCRATE_SERVICE_PORT ?? 8787, 'service'), demo: portNumber(process.env.SOCRATE_DEMO_PORT ?? 5173, 'démo') };
for (const p of Object.values(ports)) if ((await tcpProbe(p)) !== 'refused') throw new LocalRefusal('port_busy', `port ${p} déjà occupé : parcours refusé`);
const handle = await rt.launchInstance({ root: rt.instanceRoot(name), name, ports, reset: process.argv.includes('--reset'), deadline: deadlineIn(90_000), log: console.log });
const facts: Record<string, unknown> = { instance: name, instanceId: handle.view.instanceId, service: handle.view.serviceUrl, hote: handle.view.demoOrigin };
let failure: unknown;
try {
  const { serviceUrl, demoOrigin, root } = handle.view;
  const base = `${serviceUrl}/v1/projects/${rt.PROJECT}/reviews/rappels-automatiques`;
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => localFetch(`${base}${path}`, deadlineIn(10_000), init);
  const host = await localFetch(`${demoOrigin}/api/preview-context`, deadlineIn(10_000));
  facts.hotePret = host.status === 200 && (host.json as { instanceId?: string }).instanceId === handle.view.instanceId;
  const privateJwk = JSON.parse(await readFile(join(root, 'keys/issuer-private.jwk.json'), 'utf8')) as JsonWebKey;
  const assertion = signAssertion(privateJwk, {
    issuer: rt.ISSUER, audience: rt.SERVICE_AUDIENCE, sub: 'claire', name: 'Claire Morel', projectId: rt.PROJECT, reviewKey: 'rappels-automatiques',
    deploymentId: 'local-1', origin: demoOrigin, capabilities: ['thread.participate'],
  });
  const session = await localFetch(`${serviceUrl}/v1/auth/session`, deadlineIn(10_000), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: demoOrigin }, body: JSON.stringify({ assertion }) });
  if (session.status !== 201) throw new Error(`session refusée : ${session.status} ${session.text}`);
  const token = (session.json as { sessionToken: string }).sessionToken;
  const body = `Retour fictif du parcours local ${new Date().toISOString()}`;
  const published = await call('/threads', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: demoOrigin, Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ kind: 'global', body }),
  });
  if (published.status !== 201) throw new Error(`publication refusée : ${published.status} ${published.text}`);
  const threadId = (published.json as { threadId: string }).threadId;
  const read = await call('/threads?limit=100', { headers: { Authorization: `Bearer ${handle.credentials.agent}` } });
  const items = (read.json as { items: { threadId: string; messages: { body: string }[] }[] }).items;
  facts.publie = { status: published.status, threadId };
  facts.luParAgent = { status: read.status, retrouve: items.some((t) => t.threadId === threadId && t.messages[0]?.body === body), fils: items.length };
  if (!facts.hotePret || !(facts.luParAgent as { retrouve: boolean }).retrouve) throw new Error(`parcours incomplet : ${JSON.stringify(facts)}`);
} catch (e) {
  failure = e;
} finally {
  const stopped = await handle.stop('fin du parcours local');
  facts.arret = stopped;
  facts.portsApres = { service: await tcpProbe(ports.service), demo: await tcpProbe(ports.demo) };
  console.log(JSON.stringify(facts, null, 1));
  if (failure || !stopped.confirmed) {
    console.error(failure ?? 'arrêt non confirmé');
    process.exitCode = 1;
  }
}
