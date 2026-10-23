// Service Socrate local et persistant pour essayer Socrate contre sa propre application : un émetteur, un projet et un déploiement pour l'origine donnée.
// Contrat d'un lanceur d'hôte : attendre sur la sortie standard la ligne JSON `{"event":"ready","hostConfig":…}`, lire ce fichier, puis arrêter par SIGTERM et attendre la sortie (code 0 si la fermeture est confirmée).
import { deadlineIn, guardedPath, localFetch, localPath, portNumber, tcpProbe, LocalRefusal, runtime } from './local-run.ts';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assembleManifest } from '@socrate/contract/assemble';
import { issuesOf, manifestSchema, type Manifest } from '@socrate/contract';
import type { OwnerRecord } from './runtime.ts';

const USAGE = 'usage : npm run serve -- --origin <origine de l’application> --manifest <dossier .socrate ou fichier JSON> [--port 8787] [--project local] [--issuer local-backend] [--state .local/runtime/serve] [--deployment <id>] [--commit <sha>]';
const log = (line: string) => console.error(`[serve] ${line}`);
// Terminal fermé (SIGHUP) : l'écriture échoue, la fermeture du service doit continuer.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);

// `npm run` se place à la racine du dépôt : un chemin relatif part du dossier d'où la commande a été lancée.
const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

async function readManifest(path: string): Promise<Manifest> {
  if (!existsSync(path)) throw new LocalRefusal('manifest_missing', `manifeste introuvable : ${path}`);
  if (statSync(path).isDirectory()) {
    const r = await assembleManifest(path);
    if (!r.ok) throw new LocalRefusal('manifest_invalid', `manifeste refusé :\n${r.issues.map((i) => `  ${i.file ?? '(manifeste)'} ${i.path} : ${i.message}`).join('\n')}`);
    return r.manifest;
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new LocalRefusal('manifest_invalid', `manifeste illisible : ${(e as Error).message}`);
  }
  const r = manifestSchema.safeParse(json);
  if (!r.success) throw new LocalRefusal('manifest_invalid', `manifeste refusé :\n${issuesOf(r.error).map((i) => `  ${i.path} : ${i.message}`).join('\n')}`);
  return r.data;
}

function originOf(value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {}
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new LocalRefusal('origin_invalid', `origine refusée : ${JSON.stringify(value)} (par exemple http://127.0.0.1:5173, sans chemin ni barre finale)`);
  }
  return url.origin;
}

const { values: args } = parseArgs({
  options: {
    origin: { type: 'string' }, manifest: { type: 'string' }, port: { type: 'string', default: process.env.SOCRATE_SERVICE_PORT ?? '8787' },
    project: { type: 'string', default: 'local' }, issuer: { type: 'string', default: 'local-backend' }, state: { type: 'string' },
    deployment: { type: 'string' }, commit: { type: 'string', default: '0000000' },
  },
});

async function main(): Promise<number> {
  if (!args.origin || !args.manifest) throw new LocalRefusal('usage', USAGE);
  const origin = originOf(args.origin);
  const port = portNumber(args.port, 'service');
  const { project: projectId, issuer, commit } = args as { project: string; issuer: string; commit: string };
  if (!/^[a-z0-9-]{1,64}$/.test(projectId)) throw new LocalRefusal('project_invalid', `projet refusé : ${JSON.stringify(projectId)} (minuscules, chiffres et tirets)`);
  if (!issuer || issuer.length > 200) throw new LocalRefusal('issuer_invalid', `émetteur refusé : ${JSON.stringify(issuer)}`);
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new LocalRefusal('commit_invalid', `commit refusé : ${JSON.stringify(commit)} (hexadécimal, 7 à 64 caractères)`);
  const manifest = await readManifest(fromCaller(args.manifest));
  // Par défaut, un manifeste ou une origine modifiés ouvrent un nouveau déploiement au lieu d'un refus 409 immutable_deployment.
  const deploymentId = args.deployment ?? `local-${createHash('sha256').update(JSON.stringify({ origin, commit, manifest })).digest('hex').slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deploymentId)) throw new LocalRefusal('deployment_invalid', `déploiement refusé : ${JSON.stringify(deploymentId)} (lettres, chiffres, tirets ou soulignés)`);
  const root = args.state ? guardedPath(fromCaller(args.state)) : localPath('.local/runtime/serve');

  const rt = await runtime();
  const claim = rt.claimRoot(root);
  if (claim === 'busy') throw new LocalRefusal('occupied', `racine ${root} déjà possédée par un autre service`);
  // Un service disparu (SIGKILL, crash) ou une fermeture non confirmée laisse ses ressources ouvertes dans l'enregistrement.
  const open = rt.openResources(await rt.readRecord(root));
  const refusal = open.length
    ? new LocalRefusal('uncertain_resources', `fermeture précédente non confirmée (${open.join(' ; ')}) : vérifier qu'aucun service ne tourne encore pour cette racine, puis supprimer ${rt.recordPathOf(root)}`)
    : port !== 0 && (await tcpProbe(port)) !== 'refused' ? new LocalRefusal('occupied', `port ${port} non libre ; aucun service lancé`) : null;
  if (refusal) {
    claim.release();
    throw refusal;
  }

  const record: OwnerRecord = {
    generation: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), state: 'starting',
    ports: { service: port, demo: Number(new URL(origin).port || (origin.startsWith('https:') ? 443 : 80)) }, resources: {},
  };
  const hostConfig = join(root, 'host.json');
  let close: (() => Promise<void>) | undefined;
  let stopping: Promise<boolean> | null = null;
  const cancel = new AbortController();
  // Après un signal, seul `stop` écrit l'enregistrement : le démarrage en cours ne doit pas y réinscrire une ressource ouverte.
  const publish = () => (stopping ? Promise.resolve() : rt.publishRecord(root, record));
  const stop = (reason: string) => (stopping ??= (async () => {
    cancel.abort();
    log(`arrêt (${reason})`);
    let ok = true;
    // Sans `close`, Miniflare n'a pas été créé et ne le sera plus : `startService` vérifie l'annulation avant de le créer.
    try {
      await close?.();
      if (record.resources.service) record.resources.service = { phase: 'closed', port: record.resources.service.port };
    } catch (e) {
      ok = false;
      log(`service non arrêté : ${(e as Error).message}`);
    }
    // Un host.json sans service derrière laisserait un lanceur signer pour une instance arrêtée.
    if (ok) {
      await rm(hostConfig, { force: true }).catch((e: Error) => {
        ok = false;
        log(`${hostConfig} non supprimé : ${e.message}`);
      });
    }
    record.state = ok ? 'closed' : 'failed';
    await rt.publishRecord(root, record).catch((e: Error) => {
      ok = false;
      log(`enregistrement final non écrit : ${e.message}`);
    });
    log(ok ? 'service arrêté, fermeture confirmée' : `fermeture non confirmée : ${rt.recordPathOf(root)} bloque la reprise`);
    claim.release();
    return ok;
  })());
  const stopped = new Promise<boolean>((done) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void stop(`signal ${signal}`).then(done));
  });

  try {
    const keyPath = join(root, 'keys/issuer-private.jwk.json');
    const pubPath = join(root, 'keys/issuer-public.jwk.json');
    if (!existsSync(keyPath) || !existsSync(pubPath)) {
      const keys = await rt.generateIssuerKeys();
      await rt.writePrivateFile(keyPath, JSON.stringify(keys.privateJwk));
      await rt.writePrivateFile(pubPath, JSON.stringify(keys.publicJwk));
    }
    const publicJwk = JSON.parse(readFileSync(pubPath, 'utf8'));
    record.resources.service = { phase: 'creating', port };
    await publish();
    const service = await rt.startService({
      root, port, rebuild: true, bundlePath: join(root, 'worker.mjs'),
      projects: [{ projectId, issuer, publicJwk, attestableCapabilities: ['thread.participate', 'thread.moderate'], allowedOrigin: origin }],
      own: (closer) => (close = closer), cancel: cancel.signal,
    });
    record.resources.service = { phase: 'running', port: service.port };
    record.instanceId = service.instanceId;
    record.build = service.build;
    await publish();
    const health = await localFetch(`${service.url}/v1/health`, deadlineIn(10_000));
    if ((health.json as { instanceId?: string } | null)?.instanceId !== service.instanceId) throw new Error(`le service sur ${service.url} n'est pas l'instance lancée`);
    const credentials = await rt.reconcileCredentials(service.db, join(root, 'credentials'), { import: { projectId, label: 'serve-local', capabilities: ['deployment.import'] } });
    const imported = await localFetch(`${service.url}/v1/projects/${projectId}/reviews/${manifest.reviewKey}/deployments/${deploymentId}`, deadlineIn(10_000), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.import!.token}` },
      body: JSON.stringify({ commit, buildId: 'local', url: `${origin}/`, manifest }),
    });
    if (imported.status !== 200 && imported.status !== 201) throw new Error(`import refusé : ${imported.status} ${imported.text}`);
    log(`service ${service.url} (instance ${service.instanceId}), déploiement ${deploymentId} de la revue ${manifest.reviewKey} pour ${origin}`);
    await rt.writePrivateFile(hostConfig, `${JSON.stringify({
      serviceUrl: service.url, instanceId: service.instanceId, projectId, reviewKey: manifest.reviewKey, deploymentId,
      issuer, audience: rt.SERVICE_AUDIENCE, origin, privateKeyPath: keyPath,
    }, null, 2)}\n`);
    record.state = 'ready';
    await publish();
    if (!stopping) process.stdout.write(`${JSON.stringify({ event: 'ready', hostConfig, serviceUrl: service.url })}\n`);
  } catch (e) {
    if (stopping) return (await stopping) ? 0 : 1;
    log(`échec : ${(e as Error).message}`);
    await stop('échec du lancement');
    return 1;
  }
  return (await stopped) ? 0 : 1;
}

await main().then((code) => process.exit(code), (e: Error) => {
  console.error(e instanceof LocalRefusal ? `refusé (${e.reason}) : ${e.message}` : `échec : ${e.stack ?? e.message}`);
  process.exit(1);
});
