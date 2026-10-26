import { Suspense, lazy, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { Actor, Message, Revision, Session, ThreadWithMessages } from '@socrate/contract';
import type { CaptureStatus } from './capture.ts';
import { describeOwner, isStaleTargeted, describePayload, slotId, type DraftAttachment, type Labels, type Owner, type ReviewClient, type Slot, type Submission, type SubmissionView } from './client.ts';
import { colorOf, initialsOf, relativeDate } from './layout.ts';
import { screenOf } from './locate.ts';

const AttachmentTray = lazy(() => import('./media.tsx').then((m) => ({ default: m.AttachmentTray })));
export const MessageMedia = lazy(() => import('./media.tsx').then((m) => ({ default: m.MessageMedia })));

const ProposalView = lazy(() => import('./proposal.tsx').then((m) => ({ default: m.ProposalView })));

export function useSubmission(client: ReviewClient, slot: Slot, labels: Labels, refresh: () => Promise<void>): { submission: Submission; view: SubmissionView } {
  const key = slotId(slot);
  const submission = useMemo(() => client.submission(slot, labels, refresh), [client, key]);
  submission.configure(labels, refresh);
  const view = useSyncExternalStore(submission.subscribe, () => submission.view, () => submission.view);
  return { submission, view };
}

export function Notice({ view, submission, testId }: { view: SubmissionView; submission: Submission; testId: string }) {
  const n = view.notice;
  const pending = view.phase.kind === 'uncertain' || view.phase.kind === 'identity-blocked' ? view.phase.intent : null;
  const stale = isStaleTargeted(pending);
  return (
    <>
      {n && (
        <div className="socrate-status" data-kind={n.kind === 'info' ? 'success' : n.kind} role={n.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
          {n.text}{' '}
          {n.retry === 'resend' && <button type="button" className="socrate-button link" onClick={() => void submission.retry()}>{stale ? 'Vérifier la publication' : 'Réessayer'}</button>}
          {n.retry === 'refresh' && <button type="button" className="socrate-button link" onClick={() => void submission.retryRefresh()}>Réessayer</button>}
        </div>
      )}
      {pending && (
        <p className="socrate-meta" data-testid={testId}>
          Envoi en attente de {describeOwner(pending.owner)}{pending.payload.kind !== 'state' ? <> : {describePayload(pending.payload)}</> : <> : passer à l’état {pending.payload.state === 'resolved' ? 'résolu' : 'ouvert'}</>}.{' '}
          {view.knowledge === 'possible-write' ? 'Il a peut-être déjà été publié. ' : ''}
          {stale
            ? 'Le partage a été interrompu : cet envoi n’est plus réémis. « Vérifier la publication » lit seulement si elle a été validée sous sa clé ; un nouvel envoi demande un nouveau ciblage.'
            : 'Réessayer reprend cet envoi tel quel, avec sa clé, son texte et ses pièces d’origine ; le texte modifié depuis reste en brouillon.'}{' '}
          <button type="button" className="socrate-button link" onClick={() => submission.abandon()}>Abandonner la reprise</button>
        </p>
      )}
    </>
  );
}

export function describeCapture(s: CaptureStatus): string {
  if (s.kind === 'requesting') return 'Autorisation de partage de l’onglet demandée…';
  if (s.kind === 'active') return 'Partage de cet onglet actif. Le flux reste dans le navigateur ; seule l’image prise au ciblage est publiée.';
  if (s.kind === 'selecting') return 'Sélection : cliquez un élément ou tracez une zone dans l’application. Échap annule.';
  if (s.kind === 'capturing') return 'Capture de l’image…';
  if (s.reason === 'refused') return 'Partage refusé. Activez la capture pour réessayer.';
  if (s.reason === 'stopped') return 'Partage arrêté. Activez la capture pour cibler à nouveau.';
  if (s.reason === 'wrong-tab') return 'Mauvais onglet partagé : seul l’onglet de cette revue est accepté. Rien n’a été capturé ni publié ; activez la capture à nouveau en choisissant cet onglet.';
  if (s.reason === 'unsupported') return `Capture indisponible : ${s.detail ?? 'navigateur non compatible'}.`;
  if (s.reason === 'failed') return `Capture interrompue${s.detail ? ` : ${s.detail}` : ''}.`;
  return 'Capture inactive. Le bouton « Activer la capture » demande le partage de cet onglet.';
}

/** Mêmes libellés pour la bulle, la liste et le panneau éditorial : une seule intention ciblée par client. */
export const TARGETED_LABELS: Labels = {
  sending: 'Publication du retour ciblé…',
  published: 'Retour ciblé publié avec son image.',
  keptEdit: 'Votre retour ciblé précédent est publié. Le brouillon en cours est conservé.',
  refreshFailed: 'Retour ciblé publié. La liste n’a pas pu être rechargée.',
};
export const COMMENT_LABELS: Labels = {
  sending: 'Publication en cours…',
  published: 'Commentaire publié.',
  keptEdit: 'Votre envoi précédent est publié. Le texte modifié depuis reste en brouillon, à publier explicitement.',
  refreshFailed: 'Commentaire publié. La liste n’a pas pu être rechargée.',
};
const REPLY_LABELS: Labels = {
  sending: 'Envoi de la réponse…',
  published: 'Réponse publiée.',
  keptEdit: 'Votre réponse précédente est publiée. Le texte modifié depuis reste en brouillon, à publier explicitement.',
  refreshFailed: 'Réponse publiée. La liste n’a pas pu être rechargée.',
};
export const STATE_LABELS: Labels = {
  sending: 'Changement d’état…',
  published: 'État du retour modifié.',
  keptEdit: 'État du retour modifié.',
  refreshFailed: 'État du retour modifié. La liste n’a pas pu être rechargée.',
};

const svg = (d: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{d}</svg>;
/** Une seule famille, Lucide 0.544 (ISC) : tracés publics recopiés, sans dépendance. */
export const ICON = {
  comment: svg(<><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /><path d="M12 8v6M9 11h6" /></>),
  list: svg(<><path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" /></>),
  more: svg(<><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>),
  send: svg(<path d="m5 12 7-7 7 7M12 19V5" />),
  check: svg(<path d="M20 6 9 17l-5-5" />),
  reopen: svg(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>),
  close: svg(<path d="M18 6 6 18M6 6l12 12" />),
  attach: svg(<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />),
};
const MEDIA_LIMITS = 'images ≤10 Mio, MP4 ou WebM ≤50 Mio, sinon vidéos ≤15 min';
const LIMITS = `Glisser, coller ou choisir · 4 pièces, ${MEDIA_LIMITS}`;
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

export const SEND_HINT = 'Entrée pour envoyer · Maj+Entrée pour aller à la ligne';

/** Données partagées par la liste, la bulle et le panneau éditorial. */
export type Review = {
  client: ReviewClient;
  session: Session | null;
  seen: Owner | null;
  revision: Revision | null;
  threads: ThreadWithMessages[];
  refresh: () => Promise<void>;
  canModerate: boolean;
  canParticipate: boolean;
};

export const Avatar = ({ actor, size = 24 }: { actor: Actor; size?: 24 | 28 }) => (
  <span className="socrate-avatar" data-size={size} style={{ width: size, height: size, background: colorOf(actor.key) }} aria-hidden="true">{initialsOf(actor.displayName)}</span>
);

const When = ({ iso }: { iso: string }) => <time dateTime={iso} title={new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}>{relativeDate(iso)}</time>;

/**
 * Champ à flèche : Entrée ou ⌘/Ctrl Entrée envoie, Maj+Entrée va à la ligne ; jamais d'envoi à la frappe, à la perte de focus, pendant une composition IME ni sur une touche maintenue.
 * Sans `onSend`, champ seul. `sendButton` faux : même clavier, flèche portée par un autre champ du même envoi.
 * Avec `media`, collage, dépôt et « Joindre » passent par le même `addAttachments` ; rien pendant un envoi en cours ou incertain, rien n'est envoyé avant le geste d'envoi.
 */
export function Composer({ me, label, placeholder, value, onChange, onSend, canSend = false, busy = false, disabled, inputRef, sendButton = true, media }: {
  me: Actor | null; label: string; placeholder: string; value: string; onChange: (text: string) => void;
  media?: { submission: Submission; items: readonly DraftAttachment[]; locked: boolean };
  onSend?: () => void; canSend?: boolean; busy?: boolean; disabled?: boolean; inputRef?: RefObject<HTMLTextAreaElement | null>; sendButton?: boolean;
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const preparing = media?.submission.view.preparing ?? false;
  // Pendant la préparation, le champ et le retrait des pièces prêtes restent libres ; seuls l'envoi et les nouveaux ajouts attendent.
  const canRemove = !!media && !disabled && !busy && !media.locked;
  const canAttach = canRemove && !preparing;
  const attach = (files: File[]) => { if (canAttach && files.length) void media.submission.addAttachments(files); };
  // Safari distribue `compositionend` avant le keydown d'Entrée qui valide la composition : ce keydown n'envoie pas.
  const composed = useRef(false);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!onSend || e.key !== 'Enter' || e.shiftKey || e.altKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composed.current) return;
    e.preventDefault();
    if (!e.repeat && canSend && !preparing) onSend();
  };
  // Seuls les fichiers sont pris : un texte glissé ou collé garde le comportement du champ.
  const drag = media && {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none';
      setDropping(canAttach);
    },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      attach([...e.dataTransfer.files]);
    },
  };
  const send = onSend && sendButton && (
    <button type="button" className="socrate-send" aria-label="Envoyer" data-socrate-tip="Envoyer · Entrée" aria-keyshortcuts="Enter" aria-busy={busy || undefined} disabled={!canSend || preparing} onClick={onSend}>
      {ICON.send}
    </button>
  );
  return (
    <div className="socrate-composer" {...drag}>
      {me && <Avatar actor={me} />}
      <div className="socrate-field">
        <label htmlFor={id} className="socrate-visually-hidden">{label}</label>
        <textarea ref={inputRef} id={id} rows={1} value={value} placeholder={placeholder} readOnly={busy} disabled={disabled}
          aria-keyshortcuts={onSend ? 'Enter Meta+Enter Control+Enter' : undefined}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!media || !files.length) return;
            // Texte et image du même collage (cellules d'un tableur) : le texte entre d'abord par le collage natif, puis les pièces.
            if (e.clipboardData.getData('text/plain')) return void setTimeout(() => attach(files));
            e.preventDefault();
            attach(files);
          }}
          onCompositionEnd={() => { composed.current = true; setTimeout(() => { composed.current = false; }, 0); }}
          onKeyDown={onKeyDown} />
        {media && (media.items.length > 0 || media.submission.view.converting) && <Suspense fallback={<p className="socrate-meta" role="status">Chargement des aperçus…</p>}><AttachmentTray items={media.items} converting={media.submission.view.converting} disabled={!canRemove}
          onRemove={(id) => media.submission.editAttachments(media.items.filter((a) => a.id !== id))} /></Suspense>}
        {(media || send) && (
          <div className="socrate-field-foot">
            {media && <>
              <input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime" hidden aria-label="Images ou vidéos locales"
                onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; attach(files); }} />
              <button type="button" className="socrate-icon" aria-label="Joindre des images ou vidéos" aria-description={LIMITS} data-socrate-tip={`Joindre des images ou vidéos · ${LIMITS}`}
                disabled={!canAttach || media.items.length >= 4} onClick={() => fileRef.current?.click()}>{ICON.attach}</button>
            </>}
            {send}
          </div>
        )}
        {dropping && <div className="socrate-drop" data-testid="socrate-drop" aria-hidden="true">Déposer pour joindre · {MEDIA_LIMITS}</div>}
      </div>
    </div>
  );
}

/** « Résolu dans abc1234 » ou « Rouvert », avec le déploiement relevé à la résolution, pour un changement d'état écrit avec son message. */
export const describeTransition = (t: NonNullable<Message['transition']>) =>
  `${t.state === 'resolved' ? `Résolu${t.commit ? ` dans ${t.commit.slice(0, 7)}` : ''}` : 'Rouvert'}${t.deploymentId ? ` · déploiement ${t.deploymentId}` : ''}`;

function MessageView({ m, client }: { m: Message; client: ReviewClient }) {
  return (
    <div className="socrate-msg" data-testid="socrate-message">
      <Avatar actor={m.author} />
      <div>
        <strong title={m.exploring ? `Compte exploré : ${m.exploring.account}` : undefined}>{m.author.displayName}</strong>
        {m.via && <span className="socrate-meta" data-testid="socrate-via">· via {m.via} </span>}
        <When iso={m.createdAt} />
        {m.transition && <p className="socrate-meta" data-testid="socrate-transition">{describeTransition(m.transition)}</p>}
        <p>{m.body}</p>
        {m.attachments.length > 0 && <Suspense fallback={null}><MessageMedia client={client} attachments={m.attachments} /></Suspense>}
      </div>
    </div>
  );
}

const pieces = (t: ThreadWithMessages) => t.messages.reduce((n, m) => n + m.attachments.length, 0);
const repliesOf = (t: ThreadWithMessages) => {
  const n = t.messages.length - 1;
  return n > 0 ? `${n} réponse${n > 1 ? 's' : ''}` : '';
};
export const describeThread = (t: ThreadWithMessages) => [`Conversation de ${t.author.displayName}`, t.state === 'open' ? 'ouverte' : 'résolue', repliesOf(t)].filter(Boolean).join(', ');

/** Auteur du fil ou modération, avec participation : seuls ceux-là voient Résoudre et Rouvrir. */
export const canChangeState = ({ session, canModerate, canParticipate }: Review, t: ThreadWithMessages) => canParticipate && (session?.actor.key === t.author.key || canModerate);

/** Transition d'état par la même intention que le bouton du fil : un échec ou une incertitude s'affiche dans ce fil et sa ligne. */
export function changeState(review: Review, t: ThreadWithMessages): void {
  if (review.seen) void review.client.submission({ kind: 'state', threadId: t.threadId }, STATE_LABELS, review.refresh).publish({ seen: review.seen, state: t.state === 'open' ? 'resolved' : 'open', expectedVersion: t.version });
}

export type ThreadAction = 'open' | 'state' | 'goto';
/** Actions d'un fil, mêmes entrées pour sa pastille, sa ligne et leurs boutons ; « Aller à la page » seulement pour un autre écran. */
export function threadActions(review: Review, t: ThreadWithMessages, elsewhere: boolean): Array<{ action: ThreadAction; label: string }> {
  return [
    { action: 'open', label: 'Ouvrir la conversation' },
    ...(canChangeState(review, t) ? [{ action: 'state' as const, label: t.state === 'open' ? 'Résoudre' : 'Rouvrir' }] : []),
    ...(elsewhere ? [{ action: 'goto' as const, label: 'Aller à la page' }] : []),
  ];
}

/** Fil : messages au premier niveau, réponse en bas. Route, cible, image technique et provenance restent dans le panneau éditorial et l'API. */
export function Conversation({ thread, review, onClose, inputRef }: { thread: ThreadWithMessages; review: Review; onClose?: () => void; inputRef?: RefObject<HTMLTextAreaElement | null> }) {
  const { client, session, seen, canParticipate, refresh } = review;
  const reply = useSubmission(client, { kind: 'reply', threadId: thread.threadId }, REPLY_LABELS, refresh);
  const transition = useSubmission(client, { kind: 'state', threadId: thread.threadId }, STATE_LABELS, refresh);
  const replyBusy = reply.view.phase.kind === 'sending';
  const replyPending = reply.view.phase.kind === 'uncertain' || reply.view.phase.kind === 'identity-blocked';
  const statePending = transition.view.phase.kind === 'uncertain' || transition.view.phase.kind === 'identity-blocked';
  const resolve = thread.state === 'open';
  return (
    <section className="socrate-conversation" data-testid="socrate-conversation" data-thread={thread.threadId} data-state={thread.state} aria-label={describeThread(thread)}>
      <div className="socrate-bubble-head">
        <span data-testid="socrate-thread-state" className="socrate-state" data-state={thread.state}>{resolve ? 'Ouverte' : 'Résolue'}</span>
        {canChangeState(review, thread) && (
          <button type="button" className="socrate-icon" aria-label={resolve ? 'Résoudre' : 'Rouvrir'} data-socrate-tip={resolve ? 'Résoudre' : 'Rouvrir'}
            onClick={() => changeState(review, thread)}
            disabled={transition.view.phase.kind === 'sending' || !seen || statePending}>
            {resolve ? ICON.check : ICON.reopen}
          </button>
        )}
        {onClose && <button type="button" className="socrate-icon" aria-label="Fermer" data-socrate-tip="Fermer · Échap" onClick={onClose}>{ICON.close}</button>}
      </div>
      <Notice view={quiet(transition.view)} submission={transition.submission} testId="socrate-pending-state" />
      {thread.proposal && <Suspense fallback={null}><ProposalView proposal={thread.proposal} /></Suspense>}
      <div className="socrate-messages">{thread.messages.map((m) => <MessageView key={m.messageId} m={m} client={client} />)}</div>
      <Notice view={quiet(reply.view)} submission={reply.submission} testId="socrate-pending-reply" />
      <Composer me={session?.actor ?? null} label={`Répondre au retour de ${thread.author.displayName}`} placeholder="Répondre" inputRef={inputRef}
        value={reply.view.draft.text} onChange={(t) => reply.submission.edit(t)} busy={replyBusy} disabled={session !== null && !canParticipate}
        onSend={() => seen && void reply.submission.publish({ seen })}
        media={{ submission: reply.submission, items: reply.view.draft.attachments, locked: replyPending }}
        canSend={!replyBusy && canParticipate && !!seen && (!!reply.view.draft.text.trim() || !!reply.view.draft.attachments.length || replyPending)} />
    </section>
  );
}

// Le résultat visible (message ajouté, état changé) confirme le succès : seuls erreurs, incertitudes et reprises s'affichent.
const quiet = (v: SubmissionView) => (v.notice?.kind === 'success' ? { ...v, notice: null } : v);

/** Échec ou incertitude d'une transition lancée depuis la ligne, sans ouvrir le fil. */
function RowState({ thread, review }: { thread: ThreadWithMessages; review: Review }) {
  const { submission, view } = useSubmission(review.client, { kind: 'state', threadId: thread.threadId }, STATE_LABELS, review.refresh);
  return <Notice view={quiet(view)} submission={submission} testId="socrate-pending-state" />;
}

/** Menu d'un fil dans la liste : flèches, Échap qui rend le focus au déclencheur, fermeture au premier geste extérieur. */
function ThreadMenu({ items, at, onPick, onClose }: { items: Array<{ action: ThreadAction; label: string }>; at: { x: number; y: number }; onPick: (a: ThreadAction) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const win = el.ownerDocument.defaultView!;
    const { width, height } = el.getBoundingClientRect();
    Object.assign(el.style, {
      left: `${Math.max(8, Math.min(at.x, win.innerWidth - width - 8))}px`,
      top: `${Math.max(8, Math.min(at.y, win.innerHeight - height - 8))}px`,
      maxHeight: `${win.innerHeight - 16}px`, overflowY: 'auto',
    });
  }, [at.x, at.y, items.length]);
  useEffect(() => {
    const el = ref.current!;
    el.querySelector('button')?.focus();
    const away = (e: Event) => { if (!el.contains(e.target as Node)) onClose(); };
    el.ownerDocument.addEventListener('pointerdown', away, true);
    return () => el.ownerDocument.removeEventListener('pointerdown', away, true);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...ref.current!.querySelectorAll('button')];
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
    else if (e.key === 'Tab') onClose();
  };
  return (
    <div ref={ref} className="socrate-menu" role="menu" aria-label="Actions de la conversation" onKeyDown={onKeyDown}
      style={{ left: at.x, top: at.y }}>
      {items.map((it) => <button key={it.action} type="button" role="menuitem" onClick={() => onPick(it.action)}>{it.label}</button>)}
    </div>
  );
}

type Status = { kind: 'loading' | 'error' | 'success'; text: string; retry?: () => void } | null;
type Scope = 'screen' | 'all';
type StateFilter = 'open' | 'resolved' | 'all';
const STATE_NAMES: Record<StateFilter, string> = { open: 'Ouvertes', resolved: 'Résolues', all: 'Toutes' };

/**
 * Liste peu dense : auteur, date, deux lignes, réponses. Par défaut, fils ouverts de cet écran ; la route enregistrée décide de l'écran, pas la localisation.
 * Les commentaires généraux portent sur la revue : présents dans les deux portées. Une ligne ouvre son fil en place, localisé ou non ;
 * « Voir sur la page » ou « Aller à la page » retrouve sa cible séparément.
 */
export function ConversationList({ review, title, status, route, located, expanded, onOpen, onGoto, onClose, headingRef, generalRef }: {
  review: Review; title: string | null; status: Status; route: string; located: Set<string>; expanded: string | null;
  onOpen: (threadId: string) => void; onGoto: (threadId: string) => void; onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>; generalRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { client, session, seen, threads, refresh, canParticipate } = review;
  const [scope, setScope] = useState<Scope>('screen');
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [menu, setMenu] = useState<{ threadId: string; x: number; y: number; trigger: HTMLElement } | null>(null);
  const comment = useSubmission(client, { kind: 'comment' }, COMMENT_LABELS, refresh);
  const targeted = useSubmission(client, { kind: 'targeted' }, TARGETED_LABELS, refresh);
  const commentBusy = comment.view.phase.kind === 'sending';
  const commentPending = comment.view.phase.kind === 'uncertain' || comment.view.phase.kind === 'identity-blocked';
  const targetedPending = targeted.view.phase.kind === 'uncertain' || targeted.view.phase.kind === 'identity-blocked';
  const here = (t: ThreadWithMessages) => !t.target || screenOf(t.target) === route;
  const inState = (f: StateFilter) => (t: ThreadWithMessages) => f === 'all' || t.state === f;
  const scoped = scope === 'all' ? threads : threads.filter(here);
  const shown = scoped.filter(inState(stateFilter));
  const counts = { screen: threads.filter(here).filter(inState(stateFilter)).length, all: threads.filter(inState(stateFilter)).length };
  const stateCounts = { open: scoped.filter(inState('open')).length, resolved: scoped.filter(inState('resolved')).length, all: scoped.length };
  const lacksCapability = session !== null && !canParticipate;
  const menuThread = menu ? threads.find((t) => t.threadId === menu.threadId) ?? null : null;
  const openMenu = (t: ThreadWithMessages, trigger: HTMLElement, x?: number, y?: number) => {
    const r = trigger.getBoundingClientRect();
    setMenu({ threadId: t.threadId, x: x ?? r.left, y: y ?? r.bottom + 4, trigger });
  };
  const closeMenu = (focus: boolean) => {
    if (focus) menu?.trigger.focus();
    setMenu(null);
  };
  const pick = (a: ThreadAction) => {
    const t = menuThread!;
    closeMenu(a !== 'open' && a !== 'goto');
    if (a === 'open') onOpen(t.threadId);
    else if (a === 'state') changeState(review, t);
    else onGoto(t.threadId);
  };
  const onRowKey = (t: ThreadWithMessages) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    openMenu(t, e.currentTarget);
  };
  const where = scope === 'screen' ? 'sur cet écran' : 'dans cette revue';
  return (
    <div className="socrate-panel" data-testid="socrate-list" onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); }}>
      <div className="socrate-list-head">
        <div className="socrate-list-title">
          <h1 ref={headingRef} tabIndex={-1}>Conversations</h1>
          <button type="button" className="socrate-icon" aria-label="Fermer la liste" data-socrate-tip="Fermer · Échap" onClick={onClose}>{ICON.close}</button>
        </div>
        {(title || session) && (
          <p className="socrate-meta" data-testid="socrate-identity">
            {title}{title && session ? ' · ' : ''}
            {session && <>Connectée comme {session.actor.displayName}{session.exploring ? ` (explore le compte ${session.exploring.account})` : ''}</>}
          </p>
        )}
        <div className="socrate-filters">
          <div className="socrate-filter" role="group" aria-label="Pages">
            <button type="button" aria-pressed={scope === 'screen'} onClick={() => setScope('screen')}>Cet écran <span className="socrate-count">{counts.screen}</span></button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Toutes les pages <span className="socrate-count">{counts.all}</span></button>
          </div>
          <div className="socrate-filter" role="group" aria-label="État">
            {(['open', 'resolved', 'all'] as const).map((f) => (
              <button key={f} type="button" aria-pressed={stateFilter === f} onClick={() => setStateFilter(f)}>{STATE_NAMES[f]} <span className="socrate-count">{stateCounts[f]}</span></button>
            ))}
          </div>
        </div>
      </div>
      <div className="socrate-body" style={{ padding: 0 }}>
        {status && (
          <div className="socrate-status" style={{ margin: '12px 16px' }} data-kind={status.kind} role={status.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
            {status.text}{' '}
            {status.retry && status.kind === 'error' && <button type="button" className="socrate-button link" onClick={status.retry}>Réessayer</button>}
          </div>
        )}
        {targetedPending && <div style={{ margin: '12px 16px 0' }}><Notice view={targeted.view} submission={targeted.submission} testId="socrate-pending-targeted" /></div>}
        {lacksCapability && <p className="socrate-meta" style={{ margin: '12px 16px' }}>Votre accès ne permet pas de publier.</p>}
        {!status && shown.length === 0 && (
          <div className="socrate-empty" data-testid="socrate-empty">
            {ICON.list}
            <p>Aucune conversation{stateFilter === 'open' ? ' ouverte' : stateFilter === 'resolved' ? ' résolue' : ''} {where}.</p>
            {scope === 'screen' && counts.all > 0 && <button type="button" className="socrate-button secondary" onClick={() => setScope('all')}>Voir toutes les pages ({counts.all})</button>}
            {stateFilter === 'open' && stateCounts.resolved > 0 && <button type="button" className="socrate-button secondary" onClick={() => setStateFilter('resolved')}>Voir les résolues ({stateCounts.resolved})</button>}
            {(scope === 'all' || counts.all === 0) && (stateFilter !== 'open' || stateCounts.resolved === 0) && (
              <p>Ciblez un élément de la page avec C, ou <button type="button" className="socrate-button link" onClick={() => generalRef.current?.focus()}>écrivez un commentaire sur la revue</button>.</p>
            )}
          </div>
        )}
        <ul className="socrate-rows" aria-label="Conversations">
          {shown.map((t) => {
            const first = t.messages[0];
            const open = expanded === t.threadId;
            const replies = repliesOf(t);
            const onScreen = here(t);
            const page = t.target ? screenOf(t.target) : null;
            return (
              <li key={t.threadId} data-testid="socrate-row" data-thread={t.threadId} data-state={t.state} data-screen={onScreen ? 'here' : 'elsewhere'}>
                <div className="socrate-row-line">
                  <button type="button" className="socrate-row" aria-expanded={open} onClick={() => onOpen(t.threadId)} onKeyDown={onRowKey(t)}
                    onContextMenu={(e) => { e.preventDefault(); openMenu(t, e.currentTarget, e.clientX, e.clientY); }}>
                    <Avatar actor={t.author} />
                    <span>
                      <strong>{t.author.displayName}</strong>
                      <When iso={t.createdAt} />
                      <span className="socrate-row-text">{t.proposal ? `Correction proposée : « ${t.proposal.replacement} »` : first?.body || `${first?.attachments.length ?? 0} pièce(s) jointe(s)`}</span>
                      <span className="socrate-row-foot">
                        {replies && <span className="socrate-replies">{replies}</span>}
                        {pieces(t) > 0 && <span>{ICON.attach}{pieces(t)}<span className="socrate-visually-hidden"> pièce{pieces(t) > 1 ? 's' : ''} jointe{pieces(t) > 1 ? 's' : ''}</span></span>}
                        {t.state === 'resolved' && <span className="socrate-tag">Résolue</span>}
                        {!t.target ? <span className="socrate-tag">Général</span>
                          : !onScreen ? <span data-testid="socrate-elsewhere">{page ? `Autre page · ${page}` : 'Écran inconnu'}</span>
                          : !located.has(t.threadId) && <span data-testid="socrate-missing">Élément introuvable sur cet écran</span>}
                      </span>
                    </span>
                  </button>
                  <button type="button" className="socrate-icon" aria-label={`Actions de la conversation de ${t.author.displayName}`} data-socrate-tip="Plus d’actions" aria-haspopup="menu"
                    aria-expanded={menu?.threadId === t.threadId} onClick={(e) => (menu?.threadId === t.threadId ? closeMenu(true) : openMenu(t, e.currentTarget))}>{ICON.more}</button>
                </div>
                {onScreen ? located.has(t.threadId) && <button type="button" className="socrate-button link socrate-goto" onClick={() => onGoto(t.threadId)}>Voir sur la page</button>
                  : page && <button type="button" className="socrate-button link socrate-goto" onClick={() => onGoto(t.threadId)}>Aller à la page</button>}
                {!open && <RowState thread={t} review={review} />}
                {open && <div className="socrate-inline"><Conversation thread={t} review={review} /></div>}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="socrate-general">
        <Notice view={comment.view} submission={comment.submission} testId="socrate-pending" />
        <Composer me={session?.actor ?? null} label="Votre commentaire global" placeholder="Commentaire général sur la revue" inputRef={generalRef}
          value={comment.view.draft.text} onChange={(t) => comment.submission.edit(t)} busy={commentBusy} disabled={lacksCapability}
          onSend={() => seen && void comment.submission.publish({ seen })}
          media={{ submission: comment.submission, items: comment.view.draft.attachments, locked: commentPending }}
          canSend={!commentBusy && canParticipate && !!seen && (!!comment.view.draft.text.trim() || !!comment.view.draft.attachments.length || commentPending)} />
        <p className="socrate-meta socrate-hint">{SEND_HINT}</p>
      </div>
      {menu && menuThread && <ThreadMenu items={threadActions(review, menuThread, !here(menuThread) && !!menuThread.target && !!screenOf(menuThread.target))} at={menu} onPick={pick} onClose={() => closeMenu(true)} />}
    </div>
  );
}
