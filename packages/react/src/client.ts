import type { Actor, ApiError, AttachmentMeta, AttachmentOperation, AttachmentReservation, Deployment, Exploring, ImageMeta, ListProposal, PageProposalInput, Reservation, Revision, Review, Session, Target, Thread, ThreadWithMessages } from '@socrate/contract';
import type { TargetedDraft } from './capture.ts';

export type PreviewContext = { serviceUrl: string; projectId: string; reviewKey: string; deploymentId: string };

export class SocrateApiError extends Error {
  status: number;
  code: ApiError['code'];
  retryable: boolean;
  constructor(status: number, body: ApiError) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
  }
}

export class NetworkError extends Error {}

export type Owner = Readonly<{ actor: Actor; exploring: Exploring }>;
export const ownerOf = (s: Session): Owner => Object.freeze({ actor: s.actor, exploring: s.exploring });
const exploringKey = (e: Exploring) => (e ? `${e.account}\u0000${e.organisation ?? ''}` : '');
export const sameOwner = (a: Owner, b: Owner) => a.actor.key === b.actor.key && exploringKey(a.exploring) === exploringKey(b.exploring);
export const describeOwner = (o: Owner) => `${o.actor.displayName}${o.exploring ? ` (compte exploré : ${o.exploring.account})` : ''}`;

export type Slot = { kind: 'comment' } | { kind: 'targeted' } | { kind: 'reply'; threadId: string } | { kind: 'state'; threadId: string } | { kind: 'proposal'; wordingId: string };
export const slotId = (slot: Slot) => slot.kind === 'comment' || slot.kind === 'targeted' ? slot.kind : slot.kind === 'proposal' ? `proposal:${slot.wordingId}` : `${slot.kind}:${slot.threadId}`;
/** Pièce choisie par la personne, vérifiée et empreinte calculée localement ; ses octets ne partent qu'avec l'intention qui la porte. */
export type DraftAttachment = Readonly<{ id: string; file: Blob; meta: AttachmentMeta }>;
type Pieces = readonly DraftAttachment[];
/** `body` garde le commentaire saisi, vide quand seule la proposition ou des pièces sont publiées : le remplacement ne redevient jamais un commentaire. */
export type Payload =
  | Readonly<{ kind: 'comment'; body: string; proposal?: ListProposal; attachments: Pieces }>
  | Readonly<{ kind: 'targeted'; body: string; target: Target; image: ImageMeta; blob: Blob; source: TargetedDraft; proposal?: PageProposalInput; attachments: Pieces }>
  | Readonly<{ kind: 'reply'; threadId: string; body: string; attachments: Pieces }>
  | Readonly<{ kind: 'state'; threadId: string; state: Thread['state']; expectedVersion: number }>;
export type Intent = Readonly<{ key: string; payload: Payload; owner: Owner; draftRevision: number }>;
export type Knowledge = 'no-possible-write' | 'possible-write';
export type Refusal = Readonly<{ status: number; code: ApiError['code']; message: string }>;
export type AttemptResult =
  | { kind: 'committed' }
  | { kind: 'not-written'; reason: Refusal }
  | { kind: 'unknown'; reason: string }
  | { kind: 'not-emitted'; reason: string }
  | { kind: 'capture-lost' }
  | { kind: 'identity-blocked'; current: Owner };

/** Le partage de l'image a été interrompu : plus aucune émission, et la lecture sans mutation n'a constaté aucune publication validée. */
class CaptureLost extends Error {}
export const isStaleTargeted = (intent: Intent | null) => intent?.payload.kind === 'targeted' && !intent.payload.source.shared();
export type Phase =
  | { kind: 'idle' }
  | { kind: 'sending'; intent: Intent }
  | { kind: 'uncertain'; intent: Intent }
  | { kind: 'identity-blocked'; intent: Intent; current: Owner }
  | { kind: 'confirmed'; intent: Intent }
  | { kind: 'refused'; intent: Intent; reason: Refusal };
export type Notice = { kind: 'loading' | 'error' | 'success' | 'info'; text: string; retry?: 'resend' | 'refresh' } | null;
/** Remplacement en cours de rédaction, attaché à la cible du ciblage où il a été écrit : tout nouveau ciblage exige un rattachement explicite. */
export type ReplacementDraft = Readonly<{ text: string; for: Target }>;
/** Message du fil : le commentaire, ou à défaut le remplacement proposé ; vide pour un message fait de pièces. */
export const messageOf = (p: { body: string; proposal?: { replacement: string } }) => p.body || p.proposal?.replacement || '';
/** Résumé lisible d'une intention en attente : son texte, ou le nombre de ses pièces. */
export const describePayload = (p: Exclude<Payload, { kind: 'state' }>) => {
  const n = p.attachments.length;
  const pieces = n ? `${n} pièce${n > 1 ? 's' : ''} jointe${n > 1 ? 's' : ''}` : '';
  const text = messageOf(p);
  return text ? `« ${text} »${pieces ? ` avec ${pieces}` : ''}` : pieces;
};
const OPERATION: Record<'comment' | 'targeted' | 'reply', AttachmentOperation> = { comment: 'thread.create', targeted: 'thread.targeted', reply: 'message.create' };
type Draft = Readonly<{ text: string; replacement: ReplacementDraft | null; attachments: Pieces; revision: number }>;
/** Vidéo en cours de compression avant d'entrer au brouillon ; `cancel` la retire. */
export type Converting = Readonly<{ name: string; progress: number; cancel: () => void }>;
export type SubmissionView = Readonly<{ draft: Draft; preparing: boolean; converting: Converting | null; phase: Phase; knowledge: Knowledge; notice: Notice }>;
export type Labels = { sending: string; published: string; keptEdit: string; refreshFailed: string };

export function describeRefusal(r: Refusal): string {
  if (r.code === 'forbidden') return 'Action refusée : vous n’avez pas cette capacité.';
  if (r.code === 'state_conflict') return 'L’état du retour a changé entre-temps ; cette transition n’a pas été appliquée.';
  if (r.code === 'origin_not_registered') return 'Cette origine n’est pas enregistrée pour la revue.';
  return r.message;
}

export class Submission {
  private readonly client: ReviewClient;
  private readonly slot: Slot;
  private labels: Labels;
  private refresh: () => Promise<void>;
  private draft: Draft = { text: '', replacement: null, attachments: [], revision: 0 };
  private phase: Phase = { kind: 'idle' };
  private preparing = false;
  private converting: Converting | null = null;
  private knowledge: Knowledge = 'no-possible-write';
  private notice: Notice = null;
  private snapshot: SubmissionView;
  private readonly listeners = new Set<() => void>();

  constructor(client: ReviewClient, slot: Slot, labels: Labels, refresh: () => Promise<void>) {
    this.client = client;
    this.slot = slot;
    this.labels = labels;
    this.refresh = refresh;
    this.snapshot = this.build();
  }

  configure(labels: Labels, refresh: () => Promise<void>): void {
    this.labels = labels;
    this.refresh = refresh;
  }

  get view(): SubmissionView {
    return this.snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private build(): SubmissionView {
    return Object.freeze({ draft: Object.freeze({ ...this.draft }), preparing: this.preparing, converting: this.converting, phase: this.phase, knowledge: this.knowledge, notice: this.notice });
  }

  private emit(): void {
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }

  edit(text: string): void {
    this.draft = { ...this.draft, text, revision: this.draft.revision + 1 };
    this.emit();
  }

  editReplacement(replacement: ReplacementDraft | null): void {
    this.draft = { ...this.draft, replacement, revision: this.draft.revision + 1 };
    this.emit();
  }

  /** Pièces du brouillon : une intention déjà émise garde sa propre liste, jamais modifiée par ces gestes. */
  editAttachments(attachments: Pieces): void {
    this.draft = { ...this.draft, attachments: Object.freeze([...attachments]), revision: this.draft.revision + 1 };
    this.emit();
  }

  /**
   * Chaque pièce prête entre aussitôt au brouillon ; la fermeture du panneau ou une autre identité arrête la préparation, conversion
   * comprise, et rien de ce qui était en cours n'entre au brouillon.
   */
  async addAttachments(files: File[]): Promise<void> {
    if (this.preparing || ['sending', 'uncertain', 'identity-blocked'].includes(this.phase.kind)) return;
    const session = this.client.currentSession;
    if (!session) return;
    const owner = ownerOf(session);
    const stillOwner = () => { const current = this.client.currentSession; return !!current && sameOwner(owner, ownerOf(current)); };
    const changed = new AbortController();
    const signal = AbortSignal.any([this.client.signal, changed.signal]);
    const unsubscribe = this.client.subscribe(() => { if (this.client.currentSession && !stillOwner()) changed.abort(); });
    this.preparing = true;
    this.notice = { kind: 'loading', text: 'Préparation des pièces…' };
    this.emit();
    try {
      const { prepareFiles } = await import('./media.tsx');
      const refused = await prepareFiles(files, () => this.draft.attachments.length, signal, (c) => {
        this.converting = c;
        this.emit();
      }, (piece) => { if (stillOwner()) this.editAttachments([...this.draft.attachments, piece]); });
      if (!stillOwner()) return;
      this.notice = refused.length ? { kind: 'error', text: refused.join(' ') } : null;
    } catch {
      this.notice = { kind: 'error', text: 'Lecture du fichier impossible. Choisissez-le à nouveau.' };
    } finally {
      unsubscribe();
      this.preparing = false;
      this.emit();
    }
  }

  /**
   * Le remplacement et la révision affichée sont figés dans l'intention avec le texte : une modification du brouillon pendant l'envoi ne change pas la charge.
   * Un remplacement écrit pour un autre élément n'est jamais publié avec ce ciblage.
   */
  async publish(input: { seen: Owner; state?: Thread['state']; expectedVersion?: number; capture?: TargetedDraft | null; revisionId?: string }): Promise<void> {
    if (this.preparing || this.phase.kind === 'sending') return;
    if (this.phase.kind === 'uncertain' || this.phase.kind === 'identity-blocked') return this.retry();
    let payload: Payload;
    if (this.slot.kind === 'state') {
      if (input.state === undefined || input.expectedVersion === undefined) return;
      payload = { kind: 'state', threadId: this.slot.threadId, state: input.state, expectedVersion: input.expectedVersion };
    } else if (this.slot.kind === 'targeted') {
      if (!input.capture) return;
      const r = this.draft.replacement;
      const replacement = r?.text.trim();
      if (replacement && (r!.for !== input.capture.target || !input.revisionId)) return;
      const proposal = replacement ? Object.freeze({ replacement, revisionId: input.revisionId! }) : undefined;
      const body = this.draft.text.trim();
      const attachments = this.draft.attachments;
      if (!body && !proposal && !attachments.length) return;
      const { target, image } = input.capture;
      payload = Object.freeze({ kind: 'targeted', body, target, image: image.meta, blob: image.blob, source: input.capture, attachments, ...(proposal && { proposal }) });
    } else if (this.slot.kind === 'proposal') {
      const replacement = this.draft.text.trim();
      if (!replacement || !input.revisionId) return;
      payload = Object.freeze({ kind: 'comment', body: replacement, proposal: Object.freeze({ wordingId: this.slot.wordingId, replacement, revisionId: input.revisionId }), attachments: [] });
    } else {
      const body = this.draft.text.trim();
      const attachments = this.draft.attachments;
      if (!body && !attachments.length) return;
      payload = this.slot.kind === 'comment' ? { kind: 'comment', body, attachments } : { kind: 'reply', threadId: this.slot.threadId, body, attachments };
    }
    const intent: Intent = Object.freeze({ key: crypto.randomUUID(), payload, owner: input.seen, draftRevision: this.draft.revision });
    this.knowledge = 'no-possible-write';
    this.phase = { kind: 'sending', intent };
    this.notice = { kind: 'loading', text: this.labels.sending };
    this.emit();
    await this.run(intent);
  }

  async retry(): Promise<void> {
    if (this.phase.kind !== 'uncertain' && this.phase.kind !== 'identity-blocked') return;
    const intent = this.phase.intent;
    this.phase = { kind: 'sending', intent };
    this.notice = { kind: 'loading', text: this.labels.sending };
    this.emit();
    await this.run(intent);
  }

  abandon(): void {
    if (this.phase.kind !== 'uncertain' && this.phase.kind !== 'identity-blocked') return;
    const payload = this.phase.intent.payload;
    this.phase = { kind: 'idle' };
    if (payload.kind !== 'state' && this.draft.text.trim() === '' && !this.draft.replacement?.text.trim() && !this.draft.attachments.length) {
      this.draft = { text: payload.body, replacement: payload.kind === 'targeted' && payload.proposal ? { text: payload.proposal.replacement, for: payload.target } : null, attachments: payload.attachments, revision: this.draft.revision + 1 };
    }
    this.notice = {
      kind: 'info',
      text: this.knowledge === 'possible-write'
        ? 'Reprise abandonnée. L’envoi précédent a peut-être déjà été publié ; rien n’est annulé ni republié. Le brouillon est conservé.'
        : 'Reprise abandonnée. Rien n’a été publié. Le brouillon est conservé.',
    };
    this.emit();
  }

  async retryRefresh(): Promise<void> {
    const conflict = this.phase.kind === 'refused' && this.phase.reason.code === 'state_conflict' ? this.phase.reason : null;
    this.notice = { kind: 'loading', text: conflict ? `${describeRefusal(conflict)} Relecture de la liste…` : 'Rechargement de la liste…' };
    this.emit();
    try {
      await this.refresh();
      this.notice = conflict ? { kind: 'info', text: `${describeRefusal(conflict)} La liste est relue : la prochaine action utilise la version à jour.` } : null;
    } catch {
      this.notice = conflict
        ? { kind: 'error', text: `${describeRefusal(conflict)} La liste n’a pas pu être relue.`, retry: 'refresh' }
        : { kind: 'error', text: this.phase.kind === 'confirmed' ? this.labels.refreshFailed : 'La liste n’a pas pu être rechargée.', retry: 'refresh' };
    }
    this.emit();
  }

  private async run(intent: Intent): Promise<void> {
    const result = await this.client.send(intent, (text) => {
      this.notice = { kind: 'loading', text };
      this.emit();
    });
    if (result.kind === 'committed') {
      this.knowledge = 'possible-write';
      this.phase = { kind: 'confirmed', intent };
      const edited = this.draft.revision !== intent.draftRevision || (intent.payload.kind === 'targeted' && !intent.payload.source.current());
      if (!edited && intent.payload.kind !== 'state') this.draft = { text: '', replacement: null, attachments: [], revision: this.draft.revision + 1 };
      this.notice = { kind: 'success', text: edited ? this.labels.keptEdit : this.labels.published };
      this.emit();
      try {
        await this.refresh();
      } catch {
        this.notice = { kind: 'error', text: this.labels.refreshFailed, retry: 'refresh' };
        this.emit();
      }
      return;
    }
    if (result.kind === 'not-written') {
      if (this.knowledge === 'no-possible-write' && result.reason.code === 'state_conflict') {
        this.phase = { kind: 'refused', intent, reason: result.reason };
        this.notice = { kind: 'loading', text: `${describeRefusal(result.reason)} Relecture de la liste…` };
        this.emit();
        try {
          await this.refresh();
          this.notice = { kind: 'info', text: `${describeRefusal(result.reason)} La liste est relue : la prochaine action utilise la version à jour.` };
        } catch {
          this.notice = { kind: 'error', text: `${describeRefusal(result.reason)} La liste n’a pas pu être relue.`, retry: 'refresh' };
        }
        this.emit();
        return;
      }
      if (this.knowledge === 'no-possible-write') {
        this.phase = { kind: 'refused', intent, reason: result.reason };
        // Une révision changée ne se corrige pas dans le texte : le message du service demande de recharger la page.
        const next = intent.payload.kind === 'state' ? 'Rien n’a été modifié.' : result.reason.code === 'revision_changed' ? 'Le brouillon est conservé.' : 'Rien n’a été publié : corrigez le texte puis publiez à nouveau.';
        this.notice = { kind: 'error', text: `${describeRefusal(result.reason)} ${next}` };
      } else {
        this.phase = { kind: 'uncertain', intent };
        this.notice = { kind: 'error', text: `${describeRefusal(result.reason)} Cette nouvelle tentative ne prouve pas que l’envoi précédent n’a pas été publié ; reprenez ou abandonnez explicitement.`, retry: 'resend' };
      }
      this.emit();
      return;
    }
    if (result.kind === 'identity-blocked') {
      this.phase = { kind: 'identity-blocked', intent, current: result.current };
      this.notice = {
        kind: 'error',
        text: `L’identité de l’hôte a changé (${describeOwner(result.current)}). L’envoi de ${describeOwner(intent.owner)} n’est pas réémis sous cette identité${this.knowledge === 'possible-write' ? ' ; il a peut-être déjà été publié' : ''}. Revenez sous l’identité initiale pour reprendre, ou abandonnez la reprise.`,
        retry: 'resend',
      };
      this.emit();
      return;
    }
    if (result.kind === 'capture-lost') {
      if (this.knowledge === 'no-possible-write') {
        this.phase = { kind: 'idle' };
        this.notice = { kind: 'error', text: 'Le partage a été interrompu avant la validation : rien n’a été publié et l’image est abandonnée. Le texte est conservé ; réactivez la capture puis ciblez à nouveau.' };
      } else {
        this.phase = { kind: 'uncertain', intent };
        this.notice = {
          kind: 'error',
          text: 'Le partage a été interrompu : cet envoi n’est plus réémis. Aucune publication validée n’est constatée sous sa clé à cette lecture, ce qui ne prouve pas qu’un envoi déjà parti n’aboutira pas. Vérifiez à nouveau, ou abandonnez la reprise puis ciblez à nouveau pour un nouvel envoi.',
          retry: 'resend',
        };
      }
      this.emit();
      return;
    }
    if (result.kind === 'unknown') this.knowledge = 'possible-write';
    this.phase = { kind: 'uncertain', intent };
    this.notice = { kind: 'error', text: `${result.reason}. Votre brouillon est conservé.`, retry: 'resend' };
    this.emit();
  }
}

export class ReviewClient {
  readonly preview: PreviewContext;
  private readonly getAssertion: (signal: AbortSignal) => Promise<string>;
  private lifetime = new AbortController();
  private generation = 0;
  private session: Session | null = null;
  private pending: Promise<Session> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly submissions = new Map<string, Submission>();

  constructor(preview: PreviewContext, getAssertion: (signal: AbortSignal) => Promise<string>) {
    this.preview = preview;
    this.getAssertion = getAssertion;
  }

  get currentSession(): Session | null {
    return this.session;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attach(): void {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    this.generation += 1;
  }

  /** Interrompu à la fermeture du panneau. */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  dispose(): void {
    this.lifetime.abort();
    this.session = null;
    this.pending = null;
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  submission(slot: Slot, labels: Labels, refresh: () => Promise<void>): Submission {
    const id = slotId(slot);
    let s = this.submissions.get(id);
    if (!s) {
      s = new Submission(this, slot, labels, refresh);
      this.submissions.set(id, s);
    } else s.configure(labels, refresh);
    return s;
  }

  async openSession(): Promise<Session> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const p = (async () => {
      let assertion: string;
      try {
        assertion = await this.getAssertion(this.lifetime.signal);
      } catch (e) {
        if (this.lifetime.signal.aborted) throw new NetworkError('panneau fermé, demande d’assertion abandonnée');
        throw e;
      }
      const res = await this.transport('POST', '/v1/auth/session', { assertion }, {});
      if (!res.ok) throw new SocrateApiError(res.status, await res.json().catch(() => ({ code: 'persistence_uncertain', message: `HTTP ${res.status}`, requestId: '', retryable: true })) as ApiError);
      const session = (await res.json()) as Session;
      if (generation !== this.generation || this.lifetime.signal.aborted) throw new NetworkError('panneau fermé, session abandonnée');
      this.session = session;
      this.notify();
      return session;
    })().finally(() => {
      if (this.pending === p) this.pending = null;
    });
    this.pending = p;
    return p;
  }

  private invalidate(used: Session): void {
    if (this.session === used) {
      this.session = null;
      this.notify();
    }
  }

  private async transport(method: string, path: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    if (this.lifetime.signal.aborted) throw new NetworkError('panneau fermé, requête abandonnée');
    const h: Record<string, string> = { ...headers };
    const raw = body instanceof Blob;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    try {
      return await fetch(`${this.preview.serviceUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal });
    } catch {
      throw new NetworkError('réseau indisponible, la réponse du service n’est pas arrivée');
    }
  }

  private static expired(err: ApiError | null): boolean {
    return err !== null && (err.code === 'session_expired' || err.code === 'unauthenticated');
  }

  /** Lecture sous la session courante, renouvelée une seule fois si le service la dit expirée. */
  private async get(path: string, signal?: AbortSignal): Promise<Response> {
    let s = this.session ?? (await this.openSession());
    let res = await this.transport('GET', path, undefined, { Authorization: `Bearer ${s.sessionToken}` }, signal);
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as ApiError | null;
      if (ReviewClient.expired(err)) {
        this.invalidate(s);
        s = this.session ?? (await this.openSession());
        res = await this.transport('GET', path, undefined, { Authorization: `Bearer ${s.sessionToken}` }, signal);
        if (!res.ok) throw new SocrateApiError(res.status, (await res.json().catch(() => ({ code: 'persistence_uncertain', message: `HTTP ${res.status}`, requestId: '', retryable: true }))) as ApiError);
      } else throw new SocrateApiError(res.status, err ?? { code: 'persistence_uncertain', message: `HTTP ${res.status}`, requestId: '', retryable: true });
    }
    return res;
  }

  private async read<T>(path: string): Promise<T> {
    return (await (await this.get(path)).json()) as T;
  }

  private base(): string {
    return `/v1/projects/${encodeURIComponent(this.preview.projectId)}/reviews/${encodeURIComponent(this.preview.reviewKey)}`;
  }

  deployment(): Promise<{ review: Review; revision: Revision; deployment: Deployment }> {
    return this.read(`${this.base()}/deployments/${encodeURIComponent(this.preview.deploymentId)}`);
  }

  revision(revisionId: string): Promise<Revision> {
    return this.read(`${this.base()}/revisions/${encodeURIComponent(revisionId)}`);
  }

  async threads(): Promise<ThreadWithMessages[]> {
    return (await this.read<{ items: ThreadWithMessages[] }>(`${this.base()}/threads`)).items;
  }

  captureUrl(captureId: string): string {
    return `${this.base()}/captures/${encodeURIComponent(captureId)}`;
  }

  async captureBlob(captureId: string): Promise<Blob> {
    return (await this.get(this.captureUrl(captureId))).blob();
  }

  /** Octets d'une pièce rattachée, lus sous la session courante ; jamais d'adresse publique ni de jeton dans une URL. */
  async attachmentBlob(attachmentId: string, signal: AbortSignal): Promise<Blob> {
    const owner = ownerOf(this.session ?? await this.openSession());
    const blob = await (await this.get(`${this.base()}/attachments/${encodeURIComponent(attachmentId)}`, signal)).blob();
    if (signal.aborted || !this.session || !sameOwner(owner, ownerOf(this.session))) throw new NetworkError('Lecture annulée après fermeture ou changement d’identité.');
    return blob;
  }

  /**
   * Pièces de l'intention, sous sa clé : réservation de la même liste, puis octets des seules pièces non encore reçues, une requête par pièce.
   * Rend la réponse d'échec à remonter, ou `null` quand toutes les pièces sont reçues.
   */
  private async attachmentSteps(intent: Intent, auth: Record<string, string>, progress: (text: string) => void): Promise<Response | null> {
    const p = intent.payload;
    if (p.kind === 'state' || !p.attachments.length) return null;
    if (p.kind === 'targeted' && !p.source.shared()) throw new CaptureLost();
    const reserved = await this.transport('POST', `${this.base()}/attachments`, { operation: OPERATION[p.kind], attachments: p.attachments.map((a) => a.meta) }, { ...auth, 'Idempotency-Key': intent.key });
    if (reserved.status !== 201) return reserved;
    const r = (await reserved.json()) as AttachmentReservation;
    for (const [i, item] of r.items.entries()) {
      if (p.kind === 'targeted' && !p.source.shared()) throw new CaptureLost();
      if (item.uploaded) continue;
      const piece = p.attachments[i]!;
      progress(`Téléversement de « ${piece.meta.name} » (${i + 1}/${p.attachments.length})…`);
      const up = await this.transport('PUT', `${this.base()}/attachments/${encodeURIComponent(item.attachmentId)}`, piece.file, { ...auth, 'Content-Type': piece.meta.contentType });
      if (!up.ok) return up;
    }
    return null;
  }

  /**
   * Réservation, octets puis validation, tous sous la clé de l'intention : une reprise reprend la même opération serveur.
   * Le partage est revérifié avant chaque émission ; une fois interrompu, seule une lecture sans mutation peut reconnaître
   * une publication déjà validée sous cette clé.
   */
  private async targetedSteps(intent: Intent, s: Session, progress: (text: string) => void): Promise<Response> {
    const p = intent.payload;
    if (p.kind !== 'targeted') throw new Error('intention non ciblée');
    const auth = { Authorization: `Bearer ${s.sessionToken}` };
    if (!p.source.shared()) {
      const seen = await this.transport('GET', `${this.base()}/targeted`, undefined, { ...auth, 'Idempotency-Key': intent.key });
      if (seen.status === 404) throw new CaptureLost();
      return seen;
    }
    const pieces = p.attachments.length ? { attachments: p.attachments.map((a) => a.meta) } : {};
    const reserve = (target: Target) => this.transport('POST', `${this.base()}/targeted`, { kind: 'targeted', body: messageOf(p), target, image: p.image, ...(p.proposal && { proposal: p.proposal }), ...pieces }, { ...auth, 'Idempotency-Key': intent.key });
    let reserved = await reserve(p.target);
    // Service antérieur au champ `container`, ou relevé refusé : la même charge sans lui, refusée avant toute écriture, donc sans conflit de clé.
    if (reserved.status === 422 && ((await reserved.clone().json().catch(() => null)) as ApiError | null)?.issues?.every((i) => i.path.startsWith('target.container'))) {
      const { container: _, ...target } = p.target;
      reserved = await reserve(target);
    }
    if (reserved.status !== 201) return reserved;
    const r = (await reserved.json()) as Reservation;
    if (!p.source.shared()) throw new CaptureLost();
    if (!r.uploaded) {
      const up = await this.transport('PUT', `${this.captureUrl(r.captureId)}?attempt=${encodeURIComponent(r.attempt)}`, p.blob, { ...auth, 'Content-Type': 'image/png' });
      if (!up.ok) return up;
      if (!p.source.shared()) throw new CaptureLost();
    }
    const failed = await this.attachmentSteps(intent, auth, progress);
    if (failed) return failed;
    if (!p.source.shared()) throw new CaptureLost();
    return this.transport('POST', `${this.captureUrl(r.captureId)}/commit`, { attempt: r.attempt }, auth);
  }

  private endpoint(payload: Payload): { method: 'POST' | 'PUT'; path: string; body: unknown } {
    if (payload.kind === 'targeted') return { method: 'POST', path: `${this.base()}/targeted`, body: null };
    // Sans pièce, la charge garde la forme d’avant les pièces jointes : même empreinte côté service pour une reprise.
    const pieces = payload.kind !== 'state' && payload.attachments.length ? { attachments: payload.attachments.map((a) => a.meta) } : {};
    if (payload.kind === 'comment') return { method: 'POST', path: `${this.base()}/threads`, body: { kind: 'global', body: payload.body, ...(payload.proposal && { proposal: payload.proposal }), ...pieces } };
    if (payload.kind === 'reply') return { method: 'POST', path: `${this.base()}/threads/${encodeURIComponent(payload.threadId)}/messages`, body: { body: payload.body, ...pieces } };
    return { method: 'PUT', path: `${this.base()}/threads/${encodeURIComponent(payload.threadId)}/state`, body: { state: payload.state, expectedVersion: payload.expectedVersion } };
  }

  async send(intent: Intent, progress: (text: string) => void = () => {}): Promise<AttemptResult> {
    const { method, path, body } = this.endpoint(intent.payload);
    let s: Session;
    try {
      s = this.session ?? (await this.openSession());
    } catch (e) {
      return { kind: 'not-emitted', reason: `session Socrate indisponible (${(e as Error).message})` };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const owner = ownerOf(s);
      if (!sameOwner(owner, intent.owner)) return { kind: 'identity-blocked', current: owner };
      let res: Response;
      try {
        const auth = { Authorization: `Bearer ${s.sessionToken}` };
        res = intent.payload.kind === 'targeted'
          ? await this.targetedSteps(intent, s, progress)
          : (await this.attachmentSteps(intent, auth, progress)) ?? await this.transport(method, path, body, { ...auth, 'Idempotency-Key': intent.key });
      } catch (e) {
        if (e instanceof CaptureLost) return { kind: 'capture-lost' };
        return { kind: 'unknown', reason: (e as Error).message };
      }
      if (res.ok) {
        try {
          await res.json();
          return { kind: 'committed' };
        } catch {
          return { kind: 'unknown', reason: 'réponse du service illisible' };
        }
      }
      const err = (await res.json().catch(() => null)) as ApiError | null;
      if (attempt === 0 && ReviewClient.expired(err)) {
        this.invalidate(s);
        try {
          s = this.session ?? (await this.openSession());
        } catch (e) {
          return { kind: 'not-emitted', reason: `renouvellement de session impossible (${(e as Error).message})` };
        }
        continue;
      }
      if (err && res.status >= 400 && res.status < 500 && !err.retryable) return { kind: 'not-written', reason: { status: res.status, code: err.code, message: err.message } };
      return { kind: 'unknown', reason: err?.message ?? `HTTP ${res.status}` };
    }
    return { kind: 'unknown', reason: 'session renouvelée sans réponse exploitable' };
  }
}
