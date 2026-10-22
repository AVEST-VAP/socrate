import type { PurgeReport } from '@socrate/contract';
import { LocalRefusal, runtime } from './local-run.ts';
import type { OwnerRecord, ServiceInstance } from './runtime.ts';
const { claimRoot, openResources, publishRecord, readRecord, startService } = await runtime();

type Db = ServiceInstance['db'];
type Bucket = Awaited<ReturnType<ServiceInstance['mf']['getR2Bucket']>>;
type PurgeEnv = { DB: Db; CAPTURES: Bucket };
// shortcut: signature recopiée de purge.ts, module Worker hors du programme TypeScript de tools (types workerd) ; à aligner si elle change.
type PurgeModule = {
  authorizePurge(env: PurgeEnv, token: string, projectId: string): Promise<void>;
  purgeExpired(env: PurgeEnv, projectId: string, now?: number): Promise<PurgeReport>;
};

/** Clé d'admission propre à ce module, jamais exportée : seul `Maintenance.run`, après la prise de la racine, construit une maintenance. */
const ADMISSION = Symbol('admission');
const notExclusive = () => new LocalRefusal('not_exclusive', 'opération réservée à la phase de maintenance exclusive (npm run sauvegarde) : une instance en service ou une phase terminée ne suffit pas');

/**
 * Phase de maintenance exclusive d'une instance locale. Elle n'existe qu'après la prise du verrou de la racine et la preuve, par
 * l'enregistrement de possession, que toutes les ressources du propriétaire précédent sont fermées : aucun workerd antérieur, donc
 * aucun téléversement, import ou session en vol. Son propre Worker refuse toute route hors santé. Le modificateur `private` du
 * constructeur disparaît à l'exécution : l'admission repose sur la clé du module, le handle est gelé sur la racine et les liaisons
 * acquises par `run`, et `#open` repasse à faux à la fin de la phase. Ni un appel JavaScript du constructeur, ni un `ServiceInstance`
 * interactif, ni un objet recopié, ni un handle périmé ne sont acceptés par la purge, l'export, la restauration ou le nettoyage.
 */
export class Maintenance {
  #open = true;
  readonly root: string;
  readonly url: string;
  readonly instanceId: string;
  readonly build: string;
  readonly db: Db;
  readonly bucket: Bucket;
  readonly #mf: ServiceInstance['mf'];

  private constructor(admission: typeof ADMISSION, root: string, service: ServiceInstance, bucket: Bucket) {
    if (admission !== ADMISSION) throw notExclusive();
    this.root = root;
    this.url = service.url;
    this.instanceId = service.instanceId;
    this.build = service.build;
    this.db = service.db;
    this.bucket = bucket;
    this.#mf = service.mf;
    Object.freeze(this);
  }

  static assert(m: Maintenance): void {
    if (!(typeof m === 'object' && m !== null && #open in m && m.#open)) throw notExclusive();
  }

  /** Déclenche une fois le `scheduled` du Worker de maintenance, appelé hors `fetch` donc permis en phase exclusive : nettoyage manuel, aucune tâche planifiée. */
  async scheduled(cron: string) {
    Maintenance.assert(this);
    return (await this.#mf.getWorker()).scheduled({ cron });
  }

  /**
   * Ouvre la phase, exécute `work`, puis ferme son service. La fermeture est reçue dès la construction de Miniflare, avant `ready`
   * et les migrations. Si elle n'est pas confirmée, l'enregistrement garde le service ouvert et le verrou n'est pas libéré par ce
   * processus : la racine reste refusée à toute reprise, sans effacement ni nouvelle tentative automatique.
   */
  static async run<T>(root: string, work: (m: Maintenance) => Promise<T>): Promise<T> {
    const claim = claimRoot(root);
    if (claim === 'busy') throw new LocalRefusal('occupied', `instance de ${root} en service : arrêter la démonstration (Ctrl+C) puis relancer la commande`);
    const record: OwnerRecord = { generation: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), state: 'starting', ports: { service: 0, demo: 0 }, resources: { service: { phase: 'creating', port: 0 } } };
    try {
      const previous = await readRecord(root);
      const open = openResources(previous);
      if (open.length) throw new LocalRefusal('uncertain_resources', `racine ${root} sans preuve de fermeture de son propriétaire précédent (${open.join(' ; ')}) : racine conservée, aucune maintenance`);
      if (previous && previous !== 'unreadable') record.ports = previous.ports;
      await publishRecord(root, record);
    } catch (e) {
      claim.release();
      throw e;
    }
    let close: (() => Promise<void>) | undefined;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      const service = await startService({ root, projects: [], maintenance: true, own: (c) => { close = c; } });
      Object.assign(record, { state: 'ready', instanceId: service.instanceId, build: service.build });
      record.resources.service = { phase: 'running', port: service.port };
      await publishRecord(root, record);
      const m = new Maintenance(ADMISSION, root, service, await service.mf.getR2Bucket('CAPTURES'));
      try {
        outcome = { ok: true, value: await work(m) };
      } finally {
        m.#open = false;
      }
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (close) {
      try {
        await close();
      } catch (d) {
        record.state = 'failed';
        await publishRecord(root, record).catch(() => undefined);
        const primary = outcome.ok ? '' : ` ; l'opération avait échoué : ${(outcome.error as Error).message}`;
        throw new LocalRefusal('close_unconfirmed', `fermeture du service de maintenance non confirmée (${(d as Error).message})${primary} : racine ${root} conservée, aucune reprise automatique`, { cause: outcome.ok ? d : new AggregateError([outcome.error, d]) });
      }
    }
    record.resources.service = { phase: 'closed', port: record.resources.service?.port ?? 0 };
    record.state = 'closed';
    try {
      await publishRecord(root, record);
    } catch (e) {
      throw new LocalRefusal('close_unrecorded', `service fermé mais fermeture non écrite (${(e as Error).message}) : racine ${root} conservée telle quelle`);
    }
    claim.release();
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
// Un appelant JavaScript ne peut ni remplacer `assert` ni ajouter une voie d'admission à la classe.
Object.freeze(Maintenance);

/** Purge manuelle du projet sous maintenance exclusive, avec l'accès `review.archive` du projet et l'horloge donnée. */
export async function purgeProject(m: Maintenance, input: { projectId: string; token: string; now?: number }): Promise<PurgeReport> {
  Maintenance.assert(m);
  const { authorizePurge, purgeExpired } = (await import('../../apps/service/src/purge.ts' as string)) as PurgeModule;
  const env: PurgeEnv = { DB: m.db, CAPTURES: m.bucket };
  await authorizePurge(env, input.token, input.projectId);
  return purgeExpired(env, input.projectId, input.now);
}
