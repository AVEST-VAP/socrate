import { useEffect, useRef, useState } from 'react';
import type { ThreadWithMessages } from '@socrate/contract';
import type { ReviewClient } from './client.ts';
import { Avatar, Conversation, ICON, canChangeState, changeState, excerptOf, type Review } from './conversation.tsx';
import { containerLabel, openContainerHint } from './container.ts';
import { isEditable, sameOriginRoute, screenOf } from './locate.ts';
import type { Status } from './panel.tsx';
import { Shot } from './where.tsx';

// Styles de cette vue, dans son chunk : le panneau chargé à l'arrivée n'en porte rien.
const TRIAGE_CSS = `
.socrate-triage { display: flex; flex-direction: column; height: 100vh; background: #fff; }
.socrate-triage-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px; border-bottom: 1px solid #e4e4e7; }
.socrate-triage-head h1 { font-size: 14px; line-height: 20px; font-weight: 600; margin: 0; }
.socrate-triage-head .socrate-meta { flex: 1; font-variant-numeric: tabular-nums; }
.socrate-triage-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr) minmax(280px, 380px); }
.socrate-triage-main[data-done] { grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); }
.socrate-triage-queue { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid #e4e4e7; }
.socrate-triage-queue .socrate-filter { margin: 8px; align-self: flex-start; }
.socrate-triage-queue ol { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; list-style: none; margin: 0; padding: 0 8px 8px; }
.socrate-triage-queue button.socrate-row[aria-current="true"] { background: #eff6ff; box-shadow: inset 2px 0 0 #2563eb; }
.socrate-triage-queue li[data-state="resolved"] .socrate-row { opacity: .65; }
.socrate-triage-queue .socrate-row-text { -webkit-line-clamp: 2; }
.socrate-triage-stage { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: #f4f4f5; }
.socrate-triage-tools { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 8px 12px; }
.socrate-triage-tools .socrate-filter { background: #e4e4e7; }
.socrate-triage-view { flex: 1; min-height: 0; padding: 0 12px 12px; overflow: hidden; }
button.socrate-triage-shot { display: block; width: 100%; height: 100%; padding: 0; border: none; background: none; cursor: zoom-in; }
button.socrate-triage-shot[data-zoom="target"] { cursor: zoom-out; }
.socrate-triage canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
.socrate-triage-card { max-width: 520px; margin: 32px auto; padding: 16px; border: 1px solid #e4e4e7; border-radius: 10px; background: #fff; max-height: calc(100% - 64px); overflow: auto; }
.socrate-triage-card p { margin: 0 0 8px; }
.socrate-triage-card dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; margin: 8px 0; }
.socrate-triage-card dd { margin: 0; overflow-wrap: anywhere; }
.socrate-triage-card pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; background: #f4f4f5; border-radius: 6px; padding: 8px; margin: 0; }
.socrate-triage-side { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid #e4e4e7; }
.socrate-triage-context { flex: none; padding: 12px 16px 8px; display: grid; gap: 2px; overflow-wrap: anywhere; }
.socrate-triage-context strong { color: #09090b; font-size: 13px; line-height: 18px; font-weight: 600; }
.socrate-triage-thread { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 4px 16px 12px; }
.socrate-triage-thread .socrate-messages { max-height: none; }
.socrate-triage-actions { flex: none; padding: 12px 16px; border-top: 1px solid #e4e4e7; display: grid; gap: 8px; }
.socrate-triage-actions > div { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.socrate-triage-done { max-width: 420px; margin: 64px auto; padding: 0 16px; display: grid; gap: 8px; justify-items: center; text-align: center; }
.socrate-triage-done h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.socrate-triage-done p { margin: 0; }
@media (max-width: 599px) {
  .socrate-triage-main, .socrate-triage-main[data-done] { display: flex; flex-direction: column; overflow: auto; overscroll-behavior: contain; }
  .socrate-triage-stage { order: 1; flex: none; height: 42vh; }
  .socrate-triage-side { order: 2; flex: none; border-left: none; }
  .socrate-triage-queue { order: 3; flex: none; border-right: none; border-top: 1px solid #e4e4e7; }
  .socrate-triage-queue ol { overflow: visible; }
  .socrate-triage-thread { overflow: visible; }
  .socrate-triage-keys { display: none; }
}
`;

type Filter = 'open' | 'resolved';
type Shown = { kind: 'loading' } | { kind: 'ready'; bitmap: ImageBitmap } | { kind: 'failed'; why: string };
type Entry = { shown: Shown; live: boolean };

const idsOf = (threads: ThreadWithMessages[], filter: Filter) => threads.filter((t) => t.state === filter).map((t) => t.threadId);
const drop = (e: Entry) => {
  e.live = false;
  if (e.shown.kind === 'ready') e.shown.bitmap.close();
};

/** Images voulues seulement : celles qui sortent de la liste sont abandonnées et leurs bitmaps libérés, au plus trois restent décodés. */
function useShots(client: ReviewClient, wanted: string[]) {
  const entries = useRef(new Map<string, Entry>());
  const [, repaint] = useState(0);
  const key = wanted.join(' ');
  useEffect(() => {
    const all = entries.current;
    for (const [id, e] of all) {
      if (wanted.includes(id)) continue;
      drop(e);
      all.delete(id);
    }
    for (const id of wanted) {
      if (all.has(id)) continue;
      const e: Entry = { shown: { kind: 'loading' }, live: true };
      all.set(id, e);
      client.captureBlob(id).then((b) => createImageBitmap(b)).then((bitmap) => {
        if (!e.live) return bitmap.close();
        e.shown = { kind: 'ready', bitmap };
        repaint((n) => n + 1);
      }, (error: Error) => {
        if (!e.live) return;
        e.shown = { kind: 'failed', why: error.message };
        repaint((n) => n + 1);
      });
    }
  }, [client, key]);
  useEffect(() => () => {
    entries.current.forEach(drop);
    entries.current.clear();
  }, [client]);
  return (id: string): Shown => entries.current.get(id)?.shown ?? { kind: 'loading' };
}

/** Retour sans image : commentaire général, ancien retour sans capture, ou capture illisible. */
function Card({ thread, why }: { thread: ThreadWithMessages; why?: string }) {
  const t = thread.target;
  return (
    <div className="socrate-triage-card" data-testid="socrate-triage-card">
      <p><strong>{t ? 'Pas d’image pour ce retour' : 'Commentaire général'}</strong></p>
      <p className="socrate-meta">{why ?? (t ? 'Ce retour n’a pas de capture : voici ce qui a été enregistré.' : 'Il porte sur toute la revue : aucune cible ni capture.')}</p>
      {t && <dl className="socrate-meta">
        <dt>Page</dt><dd>{t.hostRoute ?? t.route}</dd>
        {t.text && <><dt>Texte ciblé</dt><dd>« {t.text} »</dd></>}
      </dl>}
      {t?.html && <pre>{t.html}</pre>}
    </div>
  );
}

/** Où le retour a été écrit : page, conteneur nommé s'il l'est, et version si ce n'est plus celle de cet écran. */
function Context({ thread, sameDeployment }: { thread: ThreadWithMessages; sameDeployment: boolean }) {
  const t = thread.target;
  if (!t) return <div className="socrate-triage-context socrate-meta" data-testid="socrate-triage-context"><strong>Toute la revue</strong></div>;
  const label = containerLabel(t);
  return (
    <div className="socrate-triage-context socrate-meta" data-testid="socrate-triage-context">
      {t.container && <strong>{label ? `Dans la fenêtre « ${label} »` : 'Dans une fenêtre ou un panneau'}</strong>}
      <span>Page {t.hostRoute ?? t.route}</span>
      {!sameDeployment && <span>Écrit sur une version précédente de la page.</span>}
    </div>
  );
}

/**
 * Vue plein écran : la file des retours, la capture entière avec sa cible encadrée, la conversation et ses droits habituels.
 * La file est figée à l'ouverture et au changement de filtre : un retour résolu y reste, seuls les nouveaux retours s'ajoutent à la fin. Elle couvre toute la revue, pas seulement cet écran.
 * « Résoudre et suivant » n'avance qu'après confirmation du service ; un échec s'affiche dans la conversation, qui reste sélectionnée.
 * Les brouillons de réponse vivent dans le client : changer de retour ne les perd pas.
 */
export function TriageView({ review, start, status, shortcut, onClose, onShow }: {
  review: Review; start: string | null; status: Status; shortcut: boolean; onClose: () => void; onShow: (threadId: string, hint: string) => void;
}) {
  const { client, threads } = review;
  const first = threads.find((t) => t.threadId === start);
  const [filter, setFilter] = useState<Filter>(first?.state === 'resolved' ? 'resolved' : 'open');
  const [queue, setQueue] = useState(() => idsOf(threads, filter));
  const [active, setActive] = useState<string | null>(first?.threadId ?? queue[0] ?? null);
  const [zoom, setZoom] = useState<'fit' | 'target'>('fit');
  const [resolving, setResolving] = useState(false);
  // Retour dont la résolution vient d'être confirmée : le suivant se lit dans la file relue, pas dans celle d'avant l'envoi.
  const [passed, setPassed] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const arrived = idsOf(threads, filter).filter((id) => !queue.includes(id));
  if (arrived.length) setQueue([...queue, ...arrived]);
  const items = queue.map((id) => threads.find((t) => t.threadId === id)).filter((t) => !!t);
  const index = items.findIndex((t) => t.threadId === active);
  const thread = items[index] ?? null;
  if (passed && !arrived.length) {
    setPassed(null);
    // La personne a pu changer de retour pendant l'envoi : sa sélection prime.
    if (active === passed) setActive(items[index + 1]?.threadId ?? null);
  }
  const neighbours = thread ? [items[index - 1], thread, items[index + 1]] : [];
  const shotOf = useShots(client, neighbours.flatMap((t) => (t?.capture ? [t.capture.captureId] : [])));
  const shown = thread?.capture ? shotOf(thread.capture.captureId) : null;
  const canResolve = !!thread && thread.state === 'open' && canChangeState(review, thread);
  const page = thread?.target ? screenOf(thread.target) : null;
  const left = items.filter((t) => t.state === filter);

  const move = (step: 1 | -1) => {
    const next = (thread ? index : items.length) + step;
    if (next >= 0) setActive(items[next]?.threadId ?? null);
  };
  const pick = (f: Filter) => {
    const ids = idsOf(threads, f);
    setFilter(f);
    setQueue(ids);
    setActive(ids[0] ?? null);
  };
  const resolveNext = async () => {
    if (!thread || !canResolve || resolving) return;
    setResolving(true);
    const done = await changeState(review, thread);
    setResolving(false);
    if (done) setPassed(thread.threadId);
  };

  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    // Défilement limité à la file : `scrollIntoView` remonterait jusqu'au document de l'hôte. Sous 600 px, la colonne repart du haut.
    const row = rootRef.current!.querySelector<HTMLElement>('[aria-current="true"]');
    const list = row?.closest('ol');
    if (row && list) list.scrollTop = Math.min(row.offsetTop - list.offsetTop, Math.max(list.scrollTop, row.offsetTop - list.offsetTop + row.offsetHeight - list.clientHeight));
    rootRef.current!.querySelector('.socrate-triage-main')!.scrollTop = 0;
    setMessage(thread ? `Retour ${index + 1} sur ${items.length}, de ${thread.author.displayName}` : '');
  }, [active]);

  const onKey = useRef((_: KeyboardEvent) => {});
  onKey.current = (e) => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = isEditable(e.target);
    if (e.key === 'Tab') return keepTab(e, rootRef.current!);
    if (e.key === 'Escape') {
      e.preventDefault();
      // Pendant la saisie, Échap quitte seulement le champ ; le brouillon reste.
      if (typing) headingRef.current?.focus();
      else onClose();
      return;
    }
    if (!shortcut || typing || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === 'arrowdown' || key === 'j') move(1);
    else if (key === 'arrowup' || key === 'k') move(-1);
    else if (e.repeat) return;
    else if (key === 'r' && thread) replyRef.current?.focus();
    else if (key === 'e' && thread) void resolveNext();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const doc = rootRef.current!.ownerDocument;
    const key = (e: KeyboardEvent) => onKey.current(e);
    doc.addEventListener('keydown', key);
    return () => doc.removeEventListener('keydown', key);
  }, []);

  return (
    <div ref={rootRef} className="socrate-triage" role="region" aria-label="Traiter les retours" data-testid="socrate-triage" data-thread={active ?? undefined}>
      <style>{TRIAGE_CSS}</style>
      <header className="socrate-triage-head">
        <h1 ref={headingRef} tabIndex={-1}>Traiter les retours</h1>
        <span className="socrate-meta" data-testid="socrate-triage-position">{thread ? `${index + 1}/${items.length}` : `${items.length}/${items.length}`}</span>
        <button type="button" className="socrate-icon" aria-label="Fermer" data-socrate-tip="Fermer · Échap" onClick={onClose}>{ICON.close}</button>
      </header>
      {status?.kind === 'error' && (
        <div className="socrate-status" style={{ margin: 8 }} data-kind="error" role="alert">
          {status.text}{' '}{status.retry && <button type="button" className="socrate-button link" onClick={status.retry}>Réessayer</button>}
        </div>
      )}
      <span className="socrate-visually-hidden" role="status">{message}</span>
      <div className="socrate-triage-main" data-done={!thread || undefined}>
        <nav className="socrate-triage-queue" aria-label="File des retours">
          <div className="socrate-filter" role="group" aria-label="État">
            {(['open', 'resolved'] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => pick(f)}>{f === 'open' ? 'Ouvertes' : 'Résolues'} <span className="socrate-count">{idsOf(threads, f).length}</span></button>
            ))}
          </div>
          <ol>
            {items.map((t) => (
              <li key={t.threadId} data-testid="socrate-triage-row" data-thread={t.threadId} data-state={t.state}>
                <button type="button" className="socrate-row" aria-current={t.threadId === active ? 'true' : undefined} onClick={() => setActive(t.threadId)}>
                  <Avatar actor={t.author} />
                  <span>
                    <strong>{t.author.displayName}</strong>
                    <span className="socrate-row-text">{excerptOf(t)}</span>
                    <span className="socrate-row-foot"><span className="socrate-tag">{t.state === 'open' ? 'Ouverte' : 'Résolue'}</span>{!t.target && <span className="socrate-tag">Général</span>}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {thread ? (
          <>
            <section className="socrate-triage-stage" aria-label="Capture du retour">
              {shown?.kind === 'ready' && (
                <div className="socrate-triage-tools">
                  <div className="socrate-filter" role="group" aria-label="Zoom de la capture">
                    <button type="button" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>Ajuster</button>
                    <button type="button" aria-pressed={zoom === 'target'} onClick={() => setZoom('target')}>Cible</button>
                  </div>
                  <span className="socrate-meta">État au moment du retour, pas l’état actuel.</span>
                </div>
              )}
              <div className="socrate-triage-view">
                {shown?.kind === 'loading' && <p className="socrate-meta" role="status">Chargement de la capture…</p>}
                {shown?.kind === 'ready' && thread.target && (
                  <button type="button" className="socrate-triage-shot" data-zoom={zoom} aria-label={zoom === 'fit' ? 'Zoomer sur la cible' : 'Voir la capture entière'} onClick={() => setZoom((z) => (z === 'fit' ? 'target' : 'fit'))}>
                    <Shot bitmap={shown.bitmap} target={thread.target} whole={zoom === 'fit'} />
                  </button>
                )}
                {shown?.kind === 'failed' && <Card thread={thread} why={`La capture n’a pas pu être chargée (${shown.why}) : voici ce qui a été enregistré.`} />}
                {!shown && <Card thread={thread} />}
              </div>
            </section>
            <aside className="socrate-triage-side" aria-label="Conversation du retour">
              <Context thread={thread} sameDeployment={thread.deploymentId === client.preview.deploymentId} />
              <div className="socrate-triage-thread"><Conversation key={thread.threadId} thread={thread} review={review} inputRef={replyRef} /></div>
              <div className="socrate-triage-actions">
                <div>
                  {canResolve && <button type="button" className="socrate-button" data-testid="socrate-triage-resolve" aria-keyshortcuts={shortcut ? 'E' : undefined} aria-disabled={resolving} onClick={() => void resolveNext()}>Résoudre et suivant</button>}
                  <button type="button" className="socrate-button secondary" data-testid="socrate-triage-next" aria-keyshortcuts={shortcut ? 'J ArrowDown' : undefined} onClick={() => move(1)}>Suivant</button>
                  {page && sameOriginRoute(page) && <button type="button" className="socrate-button link" data-testid="socrate-triage-show" onClick={() => onShow(thread.threadId, openContainerHint(thread.target!) ?? 'L’élément n’est pas affiché sur cet écran pour le moment.')}>Voir dans la preview</button>}
                </div>
                <p className="socrate-meta socrate-triage-keys" style={{ margin: 0 }}>{shortcut ? 'J/K ou ↓/↑ naviguer · R répondre · E résoudre et suivant · Échap fermer' : 'Échap fermer'}</p>
              </div>
            </aside>
          </>
        ) : (
          <section className="socrate-triage-stage" aria-label="Fin de la file">
            <div className="socrate-triage-done" data-testid="socrate-triage-done">
              {ICON.check}
              {left.length === 0 && filter === 'open' ? <h2>Tout est traité</h2> : <h2>Fin de la file</h2>}
              {left.length > 0 && <>
                <p className="socrate-meta">{left.length} retour{left.length > 1 ? 's' : ''} encore {filter === 'open' ? `ouvert${left.length > 1 ? 's' : ''}` : `résolu${left.length > 1 ? 's' : ''}`}.</p>
                <button type="button" className="socrate-button secondary" onClick={() => setActive(left[0]!.threadId)}>Reprendre</button>
              </>}
              <button type="button" className="socrate-button link" onClick={() => pick(filter === 'open' ? 'resolved' : 'open')}>{filter === 'open' ? `Voir les résolus (${idsOf(threads, 'resolved').length})` : `Voir les ouverts (${idsOf(threads, 'open').length})`}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** La fenêtre entière est couverte : Tab reste dans la vue au lieu de partir vers les contrôles de l'hôte, invisibles dessous. */
function keepTab(e: KeyboardEvent, root: HTMLElement) {
  const all = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not([hidden]), [tabindex="0"]')].filter((el) => el.checkVisibility());
  const i = all.indexOf(root.ownerDocument.activeElement as HTMLElement);
  if (e.shiftKey ? i > 0 : i < all.length - 1) return;
  e.preventDefault();
  (e.shiftKey ? all.at(-1) : all[0])?.focus();
}
