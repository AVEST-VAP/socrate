import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Message, Revision, ThreadWithMessages, Session } from '@socrate/contract';
import type { TabCapture, CaptureStatus } from './capture.ts';
import type { Cycle } from './guide.tsx';
import { ReviewClient, isStaleTargeted, ownerOf, type Owner } from './client.ts';
import { COMMENT_LABELS, MessageMedia, Notice, TARGETED_LABELS, Transition, describeCapture, useSubmission } from './conversation.tsx';

export type NavigationAdapter = { go(route: string): void; current(): string };

// Revue des textes et éditeur de proposition dans leur chunk, chargé à l'ouverture de la revue des textes ou au ciblage ; la vue de lecture d'une proposition dans le sien.
const wordingModule = () => import('./wording.tsx');
const WordingReview = lazy(() => wordingModule().then((m) => ({ default: m.WordingReview })));
const PageProposal = lazy(() => wordingModule().then((m) => ({ default: m.PageProposal })));
const ProposalView = lazy(() => import('./proposal.tsx').then((m) => ({ default: m.ProposalView })));

export type Status = { kind: 'loading' | 'error' | 'success'; text: string; retry?: () => void } | null;

const formatDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

const INACTIVE: CaptureStatus = { kind: 'inactive', reason: null };
/** Guidage, repères et explications d'origine : chargés au premier geste qui les demande, jamais à l'ouverture. */
let guideModule: typeof import('./guide.tsx') | null = null;
const guide = () => import('./guide.tsx').then((g) => (guideModule = g));
// Un seul panneau par onglet ; chaque geste retient le cycle de son clic, invalidé au masquage ou au démontage.
let cycle: Cycle = { alive: false };
const noSubscription = () => () => {};

/**
 * Panneau éditorial historique (option `editorial`) : avant/maintenant, zones, demandes d'avis, repères, textes à relire et retour ciblé dans la liste.
 * Session, révision et fils viennent de la racine partagée. `capture` reste nul tant que la relectrice n'a pas activé le partage.
 */
export function Panel({ client, capture, navigation, visible, onClose, revision, threads, status, refresh }: {
  client: ReviewClient; capture: TabCapture | null; navigation: NavigationAdapter; visible: boolean; onClose: () => void;
  revision: Revision | null; threads: ThreadWithMessages[]; status: Status; refresh: () => Promise<void>;
}) {
  const subscribe = capture?.subscribe ?? noSubscription;
  const captureStatus = useSyncExternalStore(subscribe, () => capture?.status ?? INACTIVE, () => capture?.status ?? INACTIVE);
  const shot = useSyncExternalStore(subscribe, () => capture?.draft ?? null, () => capture?.draft ?? null);
  const superseded = capture?.draftSuperseded ?? false;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const session = useSyncExternalStore(client.subscribe, () => client.currentSession, () => null);
  const manifest = revision?.manifest ?? null;
  const [zoneNote, setZoneNote] = useState<{ id: string; text: string } | null>(null);
  const [markers, setMarkers] = useState<string | null>(null);
  // Change à chaque fin de cycle : les résultats de localisation affichés sont remis à zéro, pas les brouillons.
  const [epoch, setEpoch] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loaded = manifest !== null;

  useEffect(() => {
    if (!visible) return;
    const c: Cycle = { alive: true };
    cycle = c;
    return () => {
      c.alive = false;
      setMarkers(null);
      setZoneNote(null);
      setEpoch((n) => n + 1);
      guideModule?.release(c);
    };
  }, [visible]);

  // La relecture à l'affichage et au retour d'onglet est faite par la racine partagée.
  useEffect(() => {
    if (visible) headingRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    if (shot && visible) editorRef.current?.focus();
  }, [shot, visible, loaded]);

  const targeted = useSubmission(client, { kind: 'targeted' }, TARGETED_LABELS, refresh);
  const targetedPhase = targeted.view.phase.kind;
  const targetedPending = targeted.view.phase.kind === 'uncertain' || targeted.view.phase.kind === 'identity-blocked' ? targeted.view.phase.intent : null;
  const confirmedSource = targeted.view.phase.kind === 'confirmed' && targeted.view.phase.intent.payload.kind === 'targeted' ? targeted.view.phase.intent.payload.source : null;
  // Un succès ne décrit que le brouillon affiché à son arrivée : un nouveau brouillon ou un refus le rend antérieur, il est retiré.
  const success = targeted.view.notice?.kind === 'success' ? targeted.view.notice : null;
  const [atSuccess, setAtSuccess] = useState<{ notice: typeof success; shot: typeof shot; superseded: boolean }>({ notice: null, shot: null, superseded: false });
  if (success && atSuccess.notice !== success) setAtSuccess({ notice: success, shot, superseded });
  const staleSuccess = success !== null && ((shot !== null && shot !== atSuccess.shot) || (superseded && !atSuccess.superseded));
  const giveBack = useCallback(() => {
    const el = capture?.draft?.restoreFocus;
    capture?.discardDraft();
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, [capture]);
  useEffect(() => {
    if (confirmedSource?.current()) giveBack();
  }, [confirmedSource, giveBack]);

  const replacement = targeted.view.draft.replacement;
  const elsewhere = !!replacement?.text.trim() && !!shot && replacement.for !== shot.target;
  const [wordingsOpen, setWordingsOpen] = useState(false);

  const comment = useSubmission(client, { kind: 'comment' }, COMMENT_LABELS, refresh);

  const seen: Owner | null = session ? ownerOf(session) : null;
  const canModerate = session?.capabilities.includes('thread.moderate') ?? false;
  const canParticipate = session?.capabilities.includes('thread.participate') ?? false;
  const lacksCapability = session !== null && !canParticipate;
  const commentBusy = comment.view.phase.kind === 'sending';
  const commentPending = comment.view.phase.kind === 'uncertain' || comment.view.phase.kind === 'identity-blocked';

  return (
    <div className="socrate-panel" data-testid="socrate-panel">
      <header className="socrate-header">
        <h1 ref={headingRef} tabIndex={-1}>{manifest?.title ?? 'Revue'}</h1>
        <button type="button" className="socrate-button secondary" onClick={onClose} aria-label="Fermer la revue">Fermer</button>
      </header>
      <div className="socrate-body">
        {session && (
          <p className="socrate-meta" data-testid="socrate-identity">
            Connectée comme <strong>{session.actor.displayName}</strong>
            {session.exploring ? <> (explore le compte {session.exploring.account}{session.exploring.organisation ? `, ${session.exploring.organisation}` : ''})</> : null}
            {canModerate ? ' · développeur' : ''}
          </p>
        )}
        {status && (
          <div className="socrate-status" data-kind={status.kind} role={status.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
            {status.text}{' '}
            {status.retry && status.kind === 'error' && (
              <button type="button" className="socrate-button link" onClick={status.retry}>Réessayer</button>
            )}
          </div>
        )}
        {manifest && (
          <>
            <section className="socrate-section" aria-labelledby="socrate-avant-maintenant">
              <h2 id="socrate-avant-maintenant">Avant / maintenant</h2>
              <p><strong>Avant.</strong> {manifest.before}</p>
              <p><strong>Maintenant.</strong> {manifest.now}</p>
            </section>
            <section className="socrate-section" aria-labelledby="socrate-zones">
              <h2 id="socrate-zones">Zones et demandes d’avis</h2>
              <div className="socrate-actions">
                <button type="button" className="socrate-button secondary" aria-pressed={markers !== null} onClick={() => { const c = cycle; void guide().then((g) => g.toggleMarkers(c, manifest, setMarkers)); }}>Voir les changements</button>
              </div>
              {markers && <p className="socrate-meta" role="status">{markers}</p>}
              {manifest.zones.map((zone) => (
                <article className="socrate-zone" key={zone.id} aria-current={navigation.current() === zone.route ? 'page' : undefined}>
                  <h3>
                    <button type="button" className="socrate-button link" onClick={() => { const c = cycle; void guide().then((g) => g.followZone(c, zone, navigation)).then((text) => text && setZoneNote({ id: zone.id, text })); }}>{zone.title}</button>
                  </h3>
                  {zone.instructions && <p className="socrate-meta">{zone.instructions}</p>}
                  {zoneNote?.id === zone.id && <p className="socrate-meta" role="status">{zoneNote.text}</p>}
                  {zone.source && <p className="socrate-meta">Source indicative : <code>{zone.source}</code></p>}
                  {zone.questions.length > 0 && (
                    <ul aria-label={`Demandes d’avis pour ${zone.title}`}>
                      {zone.questions.map((q) => <li key={q}>{q}</li>)}
                    </ul>
                  )}
                </article>
              ))}
            </section>
            <section className="socrate-section" aria-labelledby="socrate-textes">
              <h2 id="socrate-textes">Textes à relire ({manifest.wordings?.length ?? 0})</h2>
              {!manifest.wordings?.length
                ? <p className="socrate-meta" data-testid="socrate-wordings-empty">Aucun texte à relire dans cette révision. Vous pouvez commenter tout texte rencontré en le ciblant dans la page.</p>
                : wordingsOpen
                  ? <Suspense fallback={<p className="socrate-meta">Chargement des textes à relire…</p>}><WordingReview manifest={manifest} client={client} threads={threads} refresh={refresh} seen={seen} canParticipate={canParticipate} revisionId={revision!.revisionId} /></Suspense>
                  : <button type="button" className="socrate-button secondary" onClick={() => setWordingsOpen(true)}>Ouvrir la revue des textes</button>}
            </section>
            <section className="socrate-section" aria-labelledby="socrate-cible">
              <h2 id="socrate-cible">Retour ciblé</h2>
              <p className="socrate-meta" role="status" data-testid="socrate-capture-status" data-capture={captureStatus.kind === 'inactive' ? `inactive:${captureStatus.reason ?? ''}` : captureStatus.kind}>{describeCapture(captureStatus)}</p>
              {capture?.invalidatedNotice && <p className="socrate-status" data-kind="error" role="alert" data-testid="socrate-capture-invalidated">{capture.invalidatedNotice}{superseded && ' Le brouillon précédent, texte et image, est conservé mais ne peut plus être publié : ciblez à nouveau.'}</p>}
              {(captureStatus.kind === 'active' || captureStatus.kind === 'selecting') && (
                <div className="socrate-actions"><button type="button" className="socrate-button secondary" onClick={() => capture?.deactivate()}>Arrêter le partage</button></div>
              )}
              <Notice view={staleSuccess ? { ...targeted.view, notice: null } : targeted.view} submission={targeted.submission} testId="socrate-pending-targeted" />
              {shot && (
                <figure className="socrate-shot" data-testid="socrate-shot" data-superseded={superseded || undefined}>
                  <img src={shot.image.url} alt={superseded ? 'Image du ciblage précédent' : 'Image de l’onglet prise au ciblage'} data-sha256={shot.image.meta.sha256} />
                  <figcaption className="socrate-meta">{superseded ? 'Ciblage précédent, non publiable' : 'Cible'} : {shot.target.role} « {shot.target.text.slice(0, 80)} » sur {shot.target.route}</figcaption>
                </figure>
              )}
              {(shot || targeted.view.draft.text || replacement) && (
                <>
                  {((shot && !superseded) || replacement) && (
                    <Suspense fallback={null}>
                      <PageProposal manifest={manifest} target={shot && !superseded ? shot.target : null} threads={threads} submission={targeted.submission} view={targeted.view} disabled={lacksCapability || targetedPhase === 'sending'} />
                    </Suspense>
                  )}
                  <label htmlFor="socrate-targeted-draft" className="socrate-visually-hidden">Votre retour ciblé</label>
                  <textarea ref={editorRef} id="socrate-targeted-draft" className="socrate-textarea" value={targeted.view.draft.text} onChange={(e) => targeted.submission.edit(e.target.value)} placeholder="Votre retour sur l’élément ciblé" disabled={lacksCapability} />
                  <div className="socrate-actions">
                    <button type="button" className="socrate-button" onClick={() => seen && void targeted.submission.publish({ seen, capture: superseded ? null : shot, revisionId: revision!.revisionId })}
                      disabled={targetedPhase === 'sending' || !canParticipate || !seen || isStaleTargeted(targetedPending) || (!targetedPending && (!shot || superseded || elsewhere || !(targeted.view.draft.text.trim() || replacement?.text.trim())))}>Publier le retour ciblé</button>
                    <button type="button" className="socrate-button secondary" onClick={() => { targeted.submission.edit(''); targeted.submission.editReplacement(null); giveBack(); }} disabled={targetedPhase === 'sending'}>Annuler le brouillon</button>
                  </div>
                  {(!shot || superseded) && !(targetedPhase === 'uncertain' || targetedPhase === 'identity-blocked') && <p className="socrate-meta" data-testid="socrate-targeted-blocked">Publication ciblée bloquée : un nouveau ciblage explicite est nécessaire. Le texte est conservé.</p>}
                </>
              )}
            </section>
            <section className="socrate-section" aria-labelledby="socrate-commentaire">
              <h2 id="socrate-commentaire">Commentaire global</h2>
              <Notice view={comment.view} submission={comment.submission} testId="socrate-pending" />
              <label htmlFor="socrate-draft" className="socrate-visually-hidden">Votre commentaire global</label>
              <textarea id="socrate-draft" className="socrate-textarea" value={comment.view.draft.text} onChange={(e) => comment.submission.edit(e.target.value)} placeholder="Votre avis d’ensemble sur cette revue" disabled={lacksCapability} />
              <div className="socrate-actions">
                <button type="button" className="socrate-button" onClick={() => seen && void comment.submission.publish({ seen })} disabled={commentBusy || !canParticipate || !seen || (!comment.view.draft.text.trim() && !commentPending)}>Publier</button>
              </div>
              {lacksCapability && <p className="socrate-meta">Votre accès ne permet pas de publier.</p>}
            </section>
            <section className="socrate-section" aria-labelledby="socrate-retours">
              <h2 id="socrate-retours">Retours ({threads.length})</h2>
              {threads.length === 0 && <p className="socrate-meta">Aucun retour pour l’instant.</p>}
              {threads.map((t) => (
                <ThreadView key={t.threadId} epoch={epoch} thread={t} client={client} navigation={navigation} revisionId={revision!.revisionId} session={session} seen={seen} canModerate={canModerate} canParticipate={canParticipate} lacksCapability={lacksCapability} onChanged={refresh} />
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function ThreadView({ epoch, thread, client, navigation, revisionId, session, seen, canModerate, canParticipate, lacksCapability, onChanged }: {
  epoch: number; thread: ThreadWithMessages; client: ReviewClient; navigation: NavigationAdapter; revisionId: string; session: Session | null; seen: Owner | null; canModerate: boolean; canParticipate: boolean; lacksCapability: boolean;
  onChanged: () => Promise<void>;
}) {
  const isAuthor = session?.actor.key === thread.author.key;
  const canChangeState = canParticipate && (isAuthor || canModerate);
  const reply = useSubmission(client, { kind: 'reply', threadId: thread.threadId }, {
    sending: 'Envoi de la réponse…',
    published: 'Réponse publiée.',
    keptEdit: 'Votre réponse précédente est publiée. Le texte modifié depuis reste en brouillon, à publier explicitement.',
    refreshFailed: 'Réponse publiée. La liste n’a pas pu être rechargée.',
  }, onChanged);
  const transition = useSubmission(client, { kind: 'state', threadId: thread.threadId }, {
    sending: 'Changement d’état…',
    published: 'État du retour modifié.',
    keptEdit: 'État du retour modifié.',
    refreshFailed: 'État du retour modifié. La liste n’a pas pu être rechargée.',
  }, onChanged);
  const replyBusy = reply.view.phase.kind === 'sending';
  const replyPending = reply.view.phase.kind === 'uncertain' || reply.view.phase.kind === 'identity-blocked';
  const stateBusy = transition.view.phase.kind === 'sending';
  const statePending = transition.view.phase.kind === 'uncertain' || transition.view.phase.kind === 'identity-blocked';
  const next = thread.state === 'open' ? 'resolved' : 'open';

  return (
    <article className="socrate-thread" data-state={thread.state} data-testid="socrate-thread" aria-label={`Retour de ${thread.author.displayName}`}>
      <div className="socrate-thread-head">
        <span className="socrate-badge">{thread.state === 'open' ? 'Ouvert' : 'Résolu'}{thread.kind === 'targeted' ? ' · ciblé' : ''}</span>
        {canChangeState && (
          <button type="button" className="socrate-button secondary" onClick={() => seen && void transition.submission.publish({ seen, state: next, expectedVersion: thread.version })} disabled={stateBusy || !seen || statePending}>
            {thread.state === 'open' ? 'Résoudre' : 'Rouvrir'}
          </button>
        )}
      </div>
      <Notice view={transition.view} submission={transition.submission} testId="socrate-pending-state" />
      <div className="socrate-meta" data-testid="socrate-provenance">
        Publié sur le déploiement {thread.deploymentId}, révision d’origine {thread.revisionId.slice(0, 12)}.
        {thread.revisionId !== revisionId && <Deferred label="Explications d’origine" load={() => Promise.all([guide(), client.revision(thread.revisionId)]).then(([g, r]) => <g.OriginView manifest={r.manifest} />)} />}
      </div>
      {thread.target && thread.capture && <TargetView epoch={epoch} thread={thread} client={client} navigation={navigation} />}
      {thread.proposal && <Suspense fallback={null}><ProposalView proposal={thread.proposal} /></Suspense>}
      {thread.messages.map((m: Message) => (
        <div className="socrate-message" key={m.messageId}>
          <div className="socrate-meta">
            <strong>{m.author.displayName}</strong>
            {m.via ? ` · via ${m.via}` : ''}
            {m.exploring ? ` (compte exploré : ${m.exploring.account})` : ''} · {formatDate(m.createdAt)}
            {m.transition && <> · <Transition m={m} /></>}
          </div>
          <p>{m.body}</p>
          {m.attachments.length > 0 && <Suspense fallback={null}><MessageMedia client={client} attachments={m.attachments} /></Suspense>}
        </div>
      ))}
      <div className="socrate-actions">
        <Notice view={reply.view} submission={reply.submission} testId="socrate-pending-reply" />
        <label htmlFor={`reply-${thread.threadId}`} className="socrate-visually-hidden">Répondre au retour de {thread.author.displayName}</label>
        <textarea id={`reply-${thread.threadId}`} className="socrate-textarea" value={reply.view.draft.text} onChange={(e) => reply.submission.edit(e.target.value)} placeholder="Répondre" rows={2} disabled={lacksCapability} />
        <button type="button" className="socrate-button" onClick={() => seen && void reply.submission.publish({ seen })} disabled={replyBusy || !canParticipate || !seen || (!reply.view.draft.text.trim() && !replyPending)}>Répondre</button>
      </div>
    </article>
  );
}

/** Bouton dont la vue vient d'un chunk paresseux ; une erreur de chargement reste affichée à sa place. */
function Deferred({ label, load }: { label: string; load: () => Promise<ReactNode> }) {
  const [view, setView] = useState<ReactNode>(null);
  return (
    <>
      <button type="button" className="socrate-button link" onClick={() => load().then(setView, (e: Error) => setView(<p className="socrate-status" data-kind="error" role="alert">{e.message}</p>))}>{label}</button>
      {view}
    </>
  );
}

function TargetView({ epoch, thread, client, navigation }: { epoch: number; thread: ThreadWithMessages; client: ReviewClient; navigation: NavigationAdapter }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // « Voir où c’était » suit un échec de « Localiser la cible » dans le même cycle d'ouverture.
  const [missedAt, setMissedAt] = useState<number | null>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const t = thread.target!;
  const c = thread.capture!;
  return (
    <div className="socrate-target" data-testid="socrate-target">
      <dl className="socrate-meta">
        <dt>Route</dt><dd>{t.route}</dd>
        <dt>Cible</dt><dd>{t.role} · {t.selector}</dd>
        <dt>Texte proche</dt><dd>{t.text}</dd>
        <dt>Rectangle</dt><dd>{Math.round(t.rect.x)}, {Math.round(t.rect.y)} · {Math.round(t.rect.width)} × {Math.round(t.rect.height)} (viewport {t.viewport.width} × {t.viewport.height})</dd>
      </dl>
      <pre className="socrate-html" data-testid="socrate-target-html">{t.html}</pre>
      {url ? <img src={url} alt={`Image prise au ciblage (${c.width} × ${c.height})`} data-testid="socrate-target-image" />
        : <button type="button" className="socrate-button link" onClick={() => client.captureBlob(c.captureId).then((b) => setUrl(URL.createObjectURL(b)), (e: Error) => setError(e.message))}>Afficher l’image</button>}
      {error && <p className="socrate-status" data-kind="error" role="alert">{error}</p>}
      <Deferred key={epoch} label="Localiser la cible" load={() => { const c = cycle; return guide().then((g) => g.locateTarget(c, t, navigation, (found) => setMissedAt(found ? null : epoch))); }} />
      {missedAt === epoch && <Deferred key={`where-${epoch}`} label="Voir où c’était" load={() => import('./where.tsx').then((w) => <w.WhereView thread={thread} client={client} sameDeployment={thread.deploymentId === client.preview.deploymentId} />)} />}
    </div>
  );
}
