import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Manifest, Revision, Target, ThreadWithMessages } from '@socrate/contract';
import { ReviewClient, SocrateApiError, isStaleTargeted, ownerOf } from './client.ts';
import type { CaptureStatus, TabCapture } from './capture.ts';
import { HOST_CSS, PANEL_CSS } from './styles.ts';
import type { SocrateReviewProps } from './index.tsx';
import { admissibleRange, afterNavigation, aimsAtSelection, cleanText, currentSelection, findTarget, inContext, isEditable, isSocrate, nearbyText, offsetOf, rectOf, roleOf, sameOriginFrames, sameOriginRoute, screenOf, type Spot } from './locate.ts';
import { LIST_DEFAULT, LIST_WIDE, cluster, colorOf, initialsOf, listBounds, listWidthOf, place, type Box } from './layout.ts';
import { Composer, Conversation, ConversationList, ICON, Notice, SEND_HINT, TARGETED_LABELS, changeState, describeCapture, describeThread, threadActions, useSubmission, type Review, type ThreadAction } from './conversation.tsx';
import { Tip } from './tip.tsx';
import type { Status } from './panel.tsx';

// Surfaces éditoriales historiques : chargées seulement quand l'hôte passe `editorial`.
const Panel = lazy(() => import('./panel.tsx').then((m) => ({ default: m.Panel })));
// Connexion et révocation des agents : chargées à l'ouverture de « Connecter un agent ».
const AgentsView = lazy(() => import('./agents.tsx').then((m) => ({ default: m.AgentsView })));

const LIST_STYLE = { position: 'fixed', top: 0, right: 0, maxWidth: '100vw', height: '100vh', border: 'none', borderLeft: '1px solid #e4e4e7', boxShadow: '-8px 0 24px -12px rgb(0 0 0 / .12)', zIndex: 2147483000, background: '#fff' } as const;
const BUBBLE_STYLE = { position: 'fixed', border: '1px solid #e4e4e7', borderRadius: 12, boxShadow: '0 12px 32px -8px rgb(0 0 0 / .2), 0 2px 6px rgb(0 0 0 / .05)', zIndex: 2147483002, background: '#fff', colorScheme: 'light' } as const;
/** Largeur choisie pour la liste, seule préférence gardée pour la session de l'onglet ; aucun texte de brouillon. */
const WIDTH_KEY = 'socrate-largeur-liste';
const storedWidth = () => { try { return Number(sessionStorage.getItem(WIDTH_KEY)) || LIST_DEFAULT; } catch { return LIST_DEFAULT; } };
const HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } as const;
const INACTIVE: CaptureStatus = { kind: 'inactive', reason: null };
const noSubscription = () => () => {};

type Bubble = { kind: 'draft'; mode: 'comment' | 'correction'; at: Box } | { kind: 'thread'; threadId: string; at: Box } | { kind: 'cluster'; threadIds: string[]; at: Box };
/** Menu Socrate posé dans le document de l'hôte : correction d'une sélection, ou actions d'une pastille. */
type ContextMenu = { x: number; y: number; keyboard: boolean; restore: HTMLElement | null } & ({ kind: 'correction'; range: Range; frame: HTMLIFrameElement | null } | { kind: 'thread'; threadIds: string[] });
/** Élément vivant d'un fil confirmé, avec le rôle et le texte relevés à la confirmation. */
type Anchor = { element: WeakRef<Element>; frame: HTMLIFrameElement | null; role: string; text: string };
export type Actions = RefObject<((action: string, control: HTMLElement, event: Event) => void) | null>;

const boxOf = (r: Box): Box => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const CENTER = (): Box => ({ x: innerWidth / 2, y: innerHeight / 3, width: 0, height: 0 });
const quote = (text: string) => { const t = cleanText(text); return `« ${t.length > 40 ? `${t.slice(0, 39)}…` : t} »`; };
/** Texte actuel d'une correction : source complète d'un texte préparé de la révision, sinon la sélection enregistrée. */
const originalOf = (target: Target, manifest: Manifest | null) => (target.wording ? manifest?.wordings?.find((w) => w.id === target.wording)?.source : undefined) ?? target.text;

/**
 * L'élément vivant garde son sens : connecté au même cadre, sur la route du ciblage (route hôte comprise), même rôle et même texte qu'à la confirmation,
 * et toujours dans le contexte enregistré : un nœud recyclé par l'hôte dans une autre ligne perd son ancre.
 */
const sameContext = (el: Element, a: Anchor, t: Target) =>
  el.isConnected && el.ownerDocument.defaultView?.location.pathname === t.route
  && (!a.frame || (a.frame.isConnected && a.frame.contentDocument === el.ownerDocument && location.pathname === t.hostRoute))
  && roleOf(el) === a.role && nearbyText(el) === a.text && (!t.context || inContext(el, t.context));

function describeLoadError(e: unknown): string {
  if (e instanceof SocrateApiError) return `${e.message}${e.retryable ? ' Vous pouvez réessayer.' : ''}`;
  return e instanceof Error ? `${e.message}.` : 'Erreur inattendue.';
}

/** Document `about:blank` d'une iframe Socrate, vidé et stylé, prêt pour un portail React. */
function useFrameDoc(ref: RefObject<HTMLIFrameElement | null>, title: string): HTMLElement | null {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const prepare = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.documentElement.lang = 'fr';
      doc.title = title;
      doc.head.replaceChildren();
      const style = doc.createElement('style');
      style.textContent = PANEL_CSS;
      doc.head.append(style);
      doc.body.replaceChildren();
      // Un fichier lâché hors d'un composeur n'est jamais ouvert à la place du panneau.
      const guard = (e: DragEvent) => {
        if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
      };
      doc.addEventListener('dragover', guard);
      doc.addEventListener('drop', guard);
      setMount(doc.body);
    };
    if (frame.contentDocument?.readyState === 'complete') prepare();
    else frame.addEventListener('load', prepare, { once: true });
    return () => frame.removeEventListener('load', prepare);
  }, [ref, title]);
  return mount;
}

/**
 * Racine de Socrate, montée à l'arrivée pour l'identité connectée : un client, une session et une liste de fils partagés par la toolbar, la liste, la bulle et les pastilles.
 * La toolbar reste affichée ; fermer la liste, un fil ou « Tout fermer » ne la masque pas.
 */
export default function ReviewFrame({ preview, getIdentityAssertion, navigation, editorial = false, actions }: SocrateReviewProps & { actions: Actions }) {
  const client = useMemo(() => new ReviewClient(preview, getIdentityAssertion), [preview, getIdentityAssertion]);
  useEffect(() => {
    client.attach();
    return () => client.dispose();
  }, [client]);

  // Feuille limitée aux éléments `[data-socrate]` posés dans le document de l'hôte.
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.socrate = 'style';
    style.textContent = HOST_CSS;
    document.head.append(style);
    return () => style.remove();
  }, []);

  const [listOpen, setListOpen] = useState(false);
  // La liste affiche les agents à la place des conversations jusqu'au retour ou à sa fermeture.
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [focusGeneral, setFocusGeneral] = useState(0);
  const [pref, setPref] = useState(storedWidth);
  const [resizing, setResizing] = useState(false);
  const [pinsHidden, setPinsHidden] = useState(false);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  // Brouillon rouvert parce qu'un nouveau ciblage l'aurait réaffecté en silence.
  const [held, setHeld] = useState(false);
  // Raccourci à caractère unique, désactivable pour la session (WCAG 2.1.4).
  const [shortcut, setShortcut] = useState(true);

  // Données partagées.
  const session = useSyncExternalStore(client.subscribe, () => client.currentSession, () => null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [threads, setThreads] = useState<ThreadWithMessages[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'loading', text: 'Chargement de la revue…' });
  const refresh = useCallback(async () => {
    setThreads(await client.threads());
  }, [client]);
  const load = useCallback(async () => {
    setStatus({ kind: 'loading', text: 'Chargement de la revue…' });
    try {
      await client.openSession();
      const d = await client.deployment();
      setRevision(d.revision);
      await refresh();
      setStatus(null);
    } catch (e) {
      if (e instanceof SocrateApiError && e.code === 'forbidden') setStatus({ kind: 'error', text: 'Votre accès ne permet pas de participer à cette revue.' });
      else setStatus({ kind: 'error', text: describeLoadError(e), retry: () => void load() });
    }
  }, [client, refresh]);
  useEffect(() => {
    void load();
  }, [load]);
  const loaded = revision !== null;
  // Écran courant relu à chaque rendu ; l'API Navigation (pushState compris) et popstate déclenchent ce rendu.
  const [routeTick, setRouteTick] = useState(0);
  useEffect(() => {
    const bump = () => setRouteTick((n) => n + 1);
    const platform = (window as Window & { navigation?: EventTarget }).navigation;
    platform?.addEventListener('currententrychange', bump);
    window.addEventListener('popstate', bump);
    return () => {
      platform?.removeEventListener('currententrychange', bump);
      window.removeEventListener('popstate', bump);
    };
  }, []);
  const route = location.pathname;
  const reread = useCallback(async () => {
    setStatus({ kind: 'loading', text: 'Relecture des conversations…' });
    try {
      await refresh();
      setStatus(null);
    } catch (e) {
      setStatus({ kind: 'error', text: describeLoadError(e), retry: () => void reread() });
    }
  }, [refresh]);
  // Relecture à l'affichage et au retour d'onglet ; en mode éditorial, quand la liste est affichée comme avant.
  const live = !editorial || listOpen;
  useEffect(() => {
    if (!live || !loaded) return;
    void reread();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reread();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [live, loaded, reread, editorial || listOpen]);

  const seen = session ? ownerOf(session) : null;
  const canModerate = session?.capabilities.includes('thread.moderate') ?? false;
  const canParticipate = session?.capabilities.includes('thread.participate') ?? false;
  const review: Review = { client, session, seen, revision, threads, refresh, canModerate, canParticipate };

  // Capture : chunk chargé au premier « Commenter un élément » ou à la première correction.
  const [capture, setCapture] = useState<TabCapture | null>(null);
  const captureRef = useRef<TabCapture | null>(null);
  const loadingCapture = useRef<Promise<TabCapture | null> | null>(null);
  const anchors = useRef(new Map<string, Anchor>());
  // Partage, image, ancres et surfaces suivent la vie du client : un nouveau contexte (preview, identité) ne publie jamais l'ancien.
  const owner = useRef<ReviewClient | null>(null);
  useEffect(() => {
    owner.current = client;
    return () => {
      owner.current = null;
      captureRef.current?.dispose();
      captureRef.current = null;
      loadingCapture.current = null;
      anchors.current.clear();
      setCapture(null);
      setBubble(null);
      setMenu(null);
    };
  }, [client]);
  const loadCapture = () => (loadingCapture.current ??= import('./capture.ts').then(({ TabCapture }) => {
    if (owner.current !== client) return null;
    const c = new TabCapture();
    c.attach();
    captureRef.current = c;
    setCapture(c);
    return c;
  }, (error: unknown) => {
    console.error('[socrate] chargement de la capture impossible', error);
    loadingCapture.current = null;
    setNote('La capture n’a pas pu être chargée. L’application reste utilisable ; rechargez la page pour réessayer.');
    return null;
  }));
  const subscribe = capture?.subscribe ?? noSubscription;
  const captureStatus = useSyncExternalStore(subscribe, () => capture?.status ?? INACTIVE, () => capture?.status ?? INACTIVE);
  const selecting = captureStatus.kind === 'selecting' || captureStatus.kind === 'capturing';
  const shot = useSyncExternalStore(subscribe, () => capture?.draft ?? null, () => capture?.draft ?? null);
  const superseded = capture?.draftSuperseded ?? false;
  const mode = useRef<'comment' | 'correction'>('comment');
  const onDraft = useRef(() => {});
  onDraft.current = () => {
    const draft = captureRef.current?.draft;
    if (!draft) return;
    setNote(null);
    opener.current = null;
    setHeld(false);
    if (editorial) setListOpen(true);
    else setBubble({ kind: 'draft', mode: mode.current, at: boxOf(draft.target.rect) });
  };
  useEffect(() => {
    if (capture) capture.onDraft = () => onDraft.current();
  }, [capture]);

  /** Un brouillon non envoyé reste à sa cible : un nouveau ciblage ou une correction le rouvre au lieu de le réaffecter. `retarget` : demandé depuis ce brouillon. */
  const holdDraft = () => {
    if (editorial || !draftKept) return false;
    setMenu(null);
    setMoreOpen(false);
    setHeld(true);
    setBubble({ kind: 'draft', mode: mode.current, at: shot ? boxOf(shot.target.rect) : CENTER() });
    return true;
  };

  const startTargeting = async (retarget = false) => {
    setMenu(null);
    setMoreOpen(false);
    setNote(null);
    if (captureRef.current?.status.kind === 'selecting') return captureRef.current.cancelSelection();
    if (!retarget && holdDraft()) return;
    mode.current = 'comment';
    const c = captureRef.current ?? (await loadCapture());
    if (!c) return;
    if (c.status.kind === 'selecting') return c.cancelSelection();
    if (c.status.kind === 'inactive') await c.activate();
    if (c.status.kind === 'active') c.startSelection();
  };

  /** La plage est revalidée après la permission : une sélection changée entre-temps n'est jamais remplacée par une autre. */
  const startCorrection = async (range: Range, frame: HTMLIFrameElement | null) => {
    setMenu(null);
    setMoreOpen(false);
    setNote(null);
    if (holdDraft()) return;
    const c = captureRef.current ?? (await loadCapture());
    if (!c) return;
    if (c.status.kind === 'selecting') c.cancelSelection();
    if (c.status.kind === 'inactive') await c.activate();
    if (c.status.kind !== 'active') return;
    const now = admissibleRange(range.startContainer.ownerDocument!);
    if (!now || now.compareBoundaryPoints(Range.START_TO_START, range) !== 0 || now.compareBoundaryPoints(Range.END_TO_END, range) !== 0) {
      setNote('La sélection a changé pendant la demande de partage : sélectionnez à nouveau le texte à corriger.');
      return;
    }
    mode.current = 'correction';
    await c.shootSelection(range, frame);
  };

  const targeted = useSubmission(client, { kind: 'targeted' }, TARGETED_LABELS, refresh);
  const giveBack = useCallback(() => {
    const el = captureRef.current?.draft?.restoreFocus;
    captureRef.current?.discardDraft();
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, []);

  // Après confirmation du service : la bulle se ferme, l'élément vivant ancre la pastille du nouveau fil.
  const [anchorTick, setAnchorTick] = useState(0);
  const confirmed = targeted.view.phase.kind === 'confirmed' && targeted.view.phase.intent.payload.kind === 'targeted' ? targeted.view.phase.intent.payload : null;
  useEffect(() => {
    if (!confirmed) return;
    if (confirmed.source.current()) {
      giveBack();
      setBubble((b) => (b?.kind === 'draft' ? null : b));
      setAnnounce('Commentaire envoyé.');
    }
    const t = threads.find((x) => x.capture?.sha256 === confirmed.image.sha256 && x.target?.selector === confirmed.target.selector && x.target.text === confirmed.target.text);
    if (t && !anchors.current.has(t.threadId)) {
      const el = confirmed.source.element;
      anchors.current.set(t.threadId, { element: new WeakRef(el), frame: confirmed.source.frame, role: roleOf(el), text: nearbyText(el) });
      setAnchorTick((n) => n + 1);
    }
  }, [confirmed, threads, giveBack]);

  // Réarrangement : défilement et redimensionnement repositionnent, dans l'onglet et ses iframes de même origine dès qu'une bulle ou une pastille est suivie ;
  // mutations du DOM relocalisent les pastilles. Chaque passage relâche les iframes fermées ou rechargées et accroche les nouvelles.
  const [layoutTick, setLayoutTick] = useState(0);
  const outsideBubble = useRef<(e: PointerEvent) => void>(() => {});
  useEffect(() => {
    const resize = () => setLayoutTick((n) => n + 1);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const [domTick, setDomTick] = useState(0);
  const targetedThreads = !pinsHidden && threads.some((t) => t.target);
  const tracking = targetedThreads || bubble !== null;
  useEffect(() => {
    if (!tracking) return;
    let raf = 0;
    let dirty = false;
    const frames = new Map<HTMLIFrameElement, { doc: Document; off: () => void }>();
    const schedule = (dom: boolean) => {
      dirty ||= dom;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        sync();
        if (dirty && targetedThreads) setDomTick((n) => n + 1);
        dirty = false;
        setLayoutTick((n) => n + 1);
      });
    };
    const onLayout = () => schedule(false);
    const onDom = () => schedule(true);
    const mine = (n: Node) => isSocrate(n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
    const watch = (win: Window) => {
      const doc = win.document;
      win.addEventListener('scroll', onLayout, true);
      if (win !== window) win.addEventListener('resize', onLayout);
      const away = (e: PointerEvent) => outsideBubble.current(e);
      win.addEventListener('pointerdown', away, true);
      // `load` d'une iframe ou d'une image ne remonte pas à la fenêtre : écouté sur le document.
      doc.addEventListener('load', onDom, true);
      // Un changement de texte seul n'ajoute ni ne retire de nœud : seule sa cible dit s'il vient de Socrate (ligne recyclée par l'hôte).
      const observer = new (win as typeof window).MutationObserver((records) => {
        if (records.every((r) => mine(r.target) || (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(mine)))) return;
        onDom();
      });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
      return () => {
        observer.disconnect();
        win.removeEventListener('scroll', onLayout, true);
        if (win !== window) win.removeEventListener('resize', onLayout);
        win.removeEventListener('pointerdown', away, true);
        doc.removeEventListener('load', onDom, true);
      };
    };
    const sync = () => {
      for (const [f, b] of frames) if (!f.isConnected || f.contentDocument !== b.doc) { b.off(); frames.delete(f); }
      for (const f of sameOriginFrames()) if (!frames.has(f)) frames.set(f, { doc: f.contentDocument!, off: watch(f.contentWindow!) });
    };
    const offTop = watch(window);
    sync();
    return () => {
      cancelAnimationFrame(raf);
      offTop();
      for (const b of frames.values()) b.off();
    };
  }, [tracking, targetedThreads]);

  /** Cible de chaque fil sur cet écran : élément vivant retenu au ciblage tant que son contexte concorde, sinon règle de `findTarget` ; jamais un élément arbitraire. */
  const spotOf = (t: ThreadWithMessages): Spot | null => {
    if (!t.target) return null;
    const a = anchors.current.get(t.threadId);
    const el = a?.element.deref();
    const kept = a && el && sameContext(el, a, t.target) ? { element: el, frame: a.frame } : null;
    if (kept) return kept;
    // Une ancre sortie de son contexte est remplacée par la cible de la règle de rechargement, revérifiée de même aux mutations suivantes.
    const found = findTarget(t.target, t.deploymentId === preview.deploymentId);
    if (found) anchors.current.set(t.threadId, { element: new WeakRef(found.element), frame: found.frame, role: roleOf(found.element), text: nearbyText(found.element) });
    else anchors.current.delete(t.threadId);
    return found;
  };
  const spots = useMemo(() => {
    const m = new Map<string, Spot>();
    for (const t of threads) {
      const s = spotOf(t);
      if (s) m.set(t.threadId, s);
    }
    return m;
  }, [threads, domTick, anchorTick, routeTick, preview.deploymentId]);
  const located = useMemo(() => new Set(spots.keys()), [spots]);

  const wide = typeof window !== 'undefined' && window.innerWidth >= LIST_WIDE;
  const paneWidth = wide ? listWidthOf(pref, innerWidth) : innerWidth;
  const listWidth = listOpen ? paneWidth : 0;
  /** Coin haut droit de la cible, borné à la place laissée par la liste : position de la pastille et ancre de son fil. */
  const pinAt = (r: DOMRect) => ({ x: Math.max(4, Math.min(r.right - 6, innerWidth - listWidth - 34)), y: Math.max(4, r.top - 22) });
  const pins = useMemo(() => {
    if (pinsHidden) return [];
    const points: Array<{ t: ThreadWithMessages; x: number; y: number }> = [];
    for (const t of threads) {
      const s = spots.get(t.threadId);
      const r = s && rectOf(s);
      if (r) points.push({ t, ...pinAt(r) });
    }
    return cluster(points);
  }, [pinsHidden, threads, spots, layoutTick, listWidth]);

  // Écran étroit : la liste couvre la page, la bulle devient une feuille.
  const viewport = { width: innerWidth - (wide ? listWidth : 0), height: innerHeight };
  const anchorOf = (b: Bubble): Box => {
    if (b.kind === 'draft' && shot) {
      const r = rectOf({ element: shot.element, frame: shot.frame });
      return r ? { x: r.x + shot.point.x, y: r.y + shot.point.y, width: 0, height: 0 } : b.at;
    }
    if (b.kind === 'thread') {
      const s = spots.get(b.threadId);
      const r = s && rectOf(s);
      return r ? { ...pinAt(r), width: 28, height: 28 } : b.at;
    }
    return b.at;
  };
  const bubbleRef = useRef<HTMLIFrameElement>(null);
  const bubbleDoc = useFrameDoc(bubbleRef, 'Conversation Socrate');
  const [bubbleHeight, setBubbleHeight] = useState(120);
  const bubbleWidth = Math.min(340, viewport.width - 16);
  const thread = bubble?.kind === 'thread' ? threads.find((t) => t.threadId === bubble.threadId) ?? null : null;
  const showBubble = bubble !== null && (bubble.kind !== 'thread' || thread !== null);
  const at = showBubble ? place(anchorOf(bubble!), { width: bubbleWidth, height: bubbleHeight }, viewport) : null;

  // Contrôle qui a ouvert le fil affiché (pastille, ligne de la liste) : il reprend le focus à la fermeture, sinon la toolbar.
  const opener = useRef<HTMLElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const focusControl = (action: string) => toolbarRef.current?.querySelector<HTMLElement>(`[data-socrate-action="${action}"]`)?.focus({ preventScroll: true });
  /**
   * Masque la bulle sans rien publier : un brouillon reste repris par « Brouillon », un envoi en attente garde sa clé. `discard` : abandon explicite ou brouillon vide.
   * `focus` : geste clavier ou croix, le focus revient au déclencheur ; un clic extérieur le laisse à sa destination dans l'application.
   */
  const closeBubble = useCallback(({ discard = false, focus = true }: { discard?: boolean; focus?: boolean } = {}) => {
    setHeld(false);
    const restore = opener.current ?? captureRef.current?.draft?.restoreFocus ?? null;
    opener.current = null;
    if (discard) {
      targeted.submission.edit('');
      targeted.submission.editReplacement(null);
      targeted.submission.editAttachments([]);
      captureRef.current?.discardDraft();
    }
    if (focus) {
      if (restore?.isConnected) restore.focus({ preventScroll: true });
      else focusControl('launcher');
    }
    setBubble(null);
  }, [targeted.submission]);

  /** Une ligne ouvre toujours son fil dans la liste, que la cible soit localisée ou non ; « Voir sur la page » passe par `goTo`. */
  const openThread = (threadId: string) => setExpanded((e) => (e === threadId ? null : threadId));
  const closeList = () => {
    setListOpen(false);
    setAgentsOpen(false);
    focusControl('launcher');
  };

  /**
   * « Voir sur la page » et « Aller à la page » : navigation explicite de l'hôte vers l'écran enregistré (route de l'hôte pour une iframe), même origine seulement, sauf s'il est déjà affiché.
   * La cible est ensuite localisée par la même règle que les pastilles ; absente ou ambiguë, le fil reste lisible dans la liste, sans élément de remplacement.
   */
  const goTo = async (threadId: string) => {
    const t = threads.find((x) => x.threadId === threadId);
    const screen = t?.target ? screenOf(t.target) : null;
    if (!t || !screen || !sameOriginRoute(screen)) return;
    setMenu(null);
    if (screen !== location.pathname) navigation.go(screen);
    const alive = { get alive() { return owner.current === client; } };
    const r = await afterNavigation(alive, () => {
      const spot = spotOf(t);
      return spot ? { kind: 'found' as const, spot } : { kind: 'missing' as const };
    }, 120);
    if (!alive.alive) return;
    if (r.kind === 'missing') {
      setListOpen(true);
      setExpanded(threadId);
      return;
    }
    // Écran large : la liste reste ouverte mais la ligne se replie, pour un seul composeur du fil.
    if (wide) setExpanded(null);
    else setListOpen(false);
    r.spot.element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = rectOf(r.spot);
    opener.current = null;
    setBubble({ kind: 'thread', threadId, at: box ? boxOf(box) : CENTER() });
  };

  /** Action d'un fil depuis le menu de sa pastille ; mêmes entrées que sa ligne et ses boutons. */
  const runThreadAction = (action: ThreadAction, threadIds: string[], at: Box) => {
    setMenu(null);
    const t = threads.find((x) => x.threadId === threadIds[0]);
    if (action === 'open') setBubble(threadIds.length > 1 ? { kind: 'cluster', threadIds, at } : { kind: 'thread', threadId: threadIds[0]!, at });
    else if (action === 'state' && t) changeState(review, t);
    else if (action === 'goto') void goTo(threadIds[0]!);
  };

  const keepWidth = (w: number) => {
    setPref(w);
    try { sessionStorage.setItem(WIDTH_KEY, String(w)); } catch { /* stockage indisponible : la largeur reste en mémoire */ }
  };
  // Capture du pointeur sur la poignée, iframes rendues inertes pendant le geste : le tracé traverse le bord de la liste sans s'interrompre.
  const endResize = useRef<(() => void) | null>(null);
  const startResize = (e: PointerEvent, handle: HTMLElement) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const w0 = paneWidth;
    let w = w0;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    const move = (m: PointerEvent) => setPref((w = listWidthOf(w0 + x0 - m.clientX, innerWidth)));
    const end = () => {
      endResize.current = null;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('lostpointercapture', end);
      setResizing(false);
      keepWidth(w);
    };
    endResize.current = end;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', end);
  };
  // Poignée démontée pendant le geste (liste ou Socrate fermés, fenêtre devenue étroite, racine démontée) : la capture rendue au document n'atteint plus son écouteur.
  useEffect(() => () => endResize.current?.(), [listOpen, wide]);
  const bounds = listBounds(innerWidth);
  const onResizeKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    const next = { ArrowLeft: paneWidth + step, ArrowRight: paneWidth - step, Home: bounds.min, End: bounds.max }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    keepWidth(listWidthOf(next, innerWidth));
  };

  /** « Tout fermer » : liste, bulle et menus fermés, partage arrêté ; la toolbar reste. Un envoi en cours ou incertain garde son image et sa clé pour être repris. */
  const closeAll = () => {
    const p = targeted.view.phase;
    const inFlight = p.kind === 'sending' || p.kind === 'uncertain' || p.kind === 'identity-blocked' ? p.intent.payload : null;
    captureRef.current?.release(inFlight?.kind === 'targeted' ? inFlight.source : null);
    setMenu(null);
    setMoreOpen(false);
    setListOpen(false);
    setHeld(false);
    // Un brouillon écrit reste repris par « Brouillon ».
    setBubble(null);
  };

  const openPinMenu = (pin: HTMLElement, at: { x: number; y: number } | null) => {
    const r = pin.getBoundingClientRect();
    setMoreOpen(false);
    setMenu({ kind: 'thread', threadIds: pin.dataset.threads!.split(' '), x: at?.x ?? r.right + 4, y: at?.y ?? r.top, keyboard: !at, restore: pin });
  };
  const keys = useRef((_: KeyboardEvent) => {});
  keys.current = (e) => {
    const t = (e.composedPath()[0] ?? e.target) as Element | null;
    const pin = t?.closest?.<HTMLElement>('[data-socrate="pin"]');
    if (pin && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return openPinMenu(pin, null);
    }
    // C seul, hors champ, composition, répétition et combinaison : copie, onglets et frappe de l'hôte restent intacts.
    if (!shortcut || (e.key !== 'c' && e.key !== 'C') || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isEditable(t)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void startTargeting();
  };

  // Ciblage abandonné quand l'onglet perd le focus ou se masque : aucun mode ne reste armé hors de la vue. Le focus d'une iframe de la page ne compte pas.
  useEffect(() => {
    if (!selecting) return;
    const away = () => {
      if (document.visibilityState === 'hidden' || document.activeElement?.tagName !== 'IFRAME') captureRef.current?.cancelSelection();
    };
    window.addEventListener('blur', away);
    document.addEventListener('visibilitychange', away);
    return () => {
      window.removeEventListener('blur', away);
      document.removeEventListener('visibilitychange', away);
    };
  }, [selecting]);

  // Clic extérieur, dans l'onglet ou une iframe de même origine : la bulle se masque sans envoi ni perte et le geste continue dans l'application.
  // Aucun `preventDefault` : un lien navigue normalement. Les contrôles Socrate et le geste de ciblage en cours ne comptent pas.
  const dismiss = useRef<(focus: boolean) => void>(() => {});
  const selectingNow = useRef(false);
  selectingNow.current = selecting;
  outsideBubble.current = (e) => {
    if (showBubble && !selectingNow.current && !isSocrate(e.target)) dismiss.current(false);
  };

  // Correction : menu au clic droit sur une sélection admissible ; Maj + clic droit garde le menu natif.
  useEffect(() => {
    const hooked = new Map<Window, Document>();
    const frameOf = (doc: Document) => sameOriginFrames().find((f) => f.contentDocument === doc) ?? null;
    // Geste au pointeur : bouton enfoncé (Ctrl+clic macOS au bouton 0, appui long) ou bouton 2 (Windows ouvre au relâchement). Sinon touche Menu ou Maj+F10.
    let pressed = false;
    // Sélection visée par l'appui du geste en cours, relue à cet appui : Chromium sous macOS la vide dès l'appui du bouton droit,
    // avant le `contextmenu`. Elle ne sert qu'au `contextmenu` au pointeur de ce même geste et le geste suivant la remplace.
    let aimed: Range | null = null;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const onDown = () => { pressed = true; };
    const onUp = () => { pressed = false; };
    const onPress = (e: MouseEvent) => {
      aimed = null;
      if (e.shiftKey || !(e.button === 2 || (mac && e.button === 0 && e.ctrlKey))) return;
      const range = admissibleRange((e.currentTarget as Window).document);
      if (!range || !aimsAtSelection(range, e.target, e.clientX, e.clientY)) return;
      e.preventDefault();
      aimed = range.cloneRange();
    };
    const onContext = (e: MouseEvent) => {
      const held = pressed;
      pressed = false;
      const pointer = held || e.button === 2;
      const pin = (e.target as Element | null)?.closest?.<HTMLElement>('[data-socrate="pin"]');
      if (pin) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return openPinMenu(pin, pointer ? { x: e.clientX, y: e.clientY } : null);
      }
      const gesture = aimed;
      aimed = null;
      if (e.shiftKey && pointer) return;
      const doc = (e.currentTarget as Window).document;
      // Au pointeur, seul le geste qui vise la sélection vivante (ses rectangles ou le même bloc de texte) la corrige ; ailleurs, menu natif.
      // L'annulation empêche aussi Chromium sous macOS de remplacer la sélection par le mot cliqué. La touche Menu et Maj+F10 visent la sélection.
      const range = pointer && gesture?.startContainer.isConnected && gesture.startContainer.ownerDocument === doc ? gesture : admissibleRange(doc);
      if (!range || (pointer && range !== gesture && !aimsAtSelection(range, e.target, e.clientX, e.clientY))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Après un Ctrl+clic, le relâchement du bouton principal effacerait la sélection que le menu va corriger.
      if (held && e.button === 0) (e.currentTarget as Window).addEventListener('mouseup', (u) => u.preventDefault(), { capture: true, once: true });
      const frame = doc === document ? null : frameOf(doc);
      const o = offsetOf(frame);
      const r = range.getBoundingClientRect();
      const atSelection = !pointer && e.clientX === 0 && e.clientY === 0;
      setMoreOpen(false);
      setMenu({ kind: 'correction', range: range.cloneRange(), frame, x: (atSelection ? r.right : e.clientX) + o.x, y: (atSelection ? r.bottom : e.clientY) + o.y, keyboard: !pointer, restore: doc.activeElement as HTMLElement | null });
    };
    // Raccourcis dans chaque document de l'hôte accroché : C pour cibler, touche Menu ou Maj+F10 sur une pastille.
    const onKey = (e: KeyboardEvent) => keys.current(e);
    const hook = (win: Window) => {
      if (hooked.get(win) === win.document) return;
      hooked.set(win, win.document);
      win.addEventListener('contextmenu', onContext, true);
      win.addEventListener('keydown', onKey, true);
      win.addEventListener('pointerdown', onDown, true);
      win.addEventListener('mousedown', onPress, true);
      win.addEventListener('pointerup', onUp, true);
      win.addEventListener('pointercancel', onUp, true);
    };
    // Une iframe de même origine est accrochée quand le pointeur y entre : aucun relevé périodique.
    const onOver = (e: PointerEvent) => {
      const f = e.target as Element;
      if (f.tagName !== 'IFRAME' || isSocrate(f)) return;
      const frame = sameOriginFrames().find((x) => x === f);
      if (frame) hook(frame.contentWindow!);
    };
    hook(window);
    window.addEventListener('pointerover', onOver, true);
    return () => {
      window.removeEventListener('pointerover', onOver, true);
      for (const win of hooked.keys()) {
        try {
          win.removeEventListener('contextmenu', onContext, true);
          win.removeEventListener('keydown', onKey, true);
          win.removeEventListener('pointerdown', onDown, true);
          win.removeEventListener('mousedown', onPress, true);
          win.removeEventListener('pointerup', onUp, true);
          win.removeEventListener('pointercancel', onUp, true);
        } catch { /* fenêtre fermée */ }
      }
    };
  }, []);

  // Les menus de l'hôte se ferment au premier geste hors d'eux, et par Échap ; flèches haut et bas entre leurs entrées.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    if (menu.keyboard) menuRef.current?.querySelector('button')?.focus();
    const away = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => {
      const items = [...menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && i >= 0) {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus();
        return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMenu(null);
      if (menu.keyboard) menu.restore?.focus({ preventScroll: true });
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', away, true);
    };
  }, [menu]);

  // Échap ferme « Plus d'options » et rend le focus à son bouton.
  useEffect(() => {
    if (!moreOpen) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMoreOpen(false);
      focusControl('more');
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [moreOpen]);
  // Alt+Maj+S place le focus sur la toolbar, y compris sous une modal de l'hôte qui garde Tab dans son cycle.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'KeyS' || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      focusControl('target');
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  // Contrôles de l'hôte : le filtre permanent de `index.tsx` intercepte le geste et appelle cette table.
  useLayoutEffect(() => {
    actions.current = (action, control, event) => {
      if (control.getAttribute('aria-disabled') === 'true') return;
      if (action === 'target') void startTargeting(control.dataset.retarget === 'true');
      else if (action === 'launcher') { setMoreOpen(false); setAgentsOpen(false); setListOpen((o) => !o); }
      else if (action === 'agents') { setMoreOpen(false); setAgentsOpen(true); setListOpen(true); }
      else if (action === 'more') setMoreOpen((o) => !o);
      else if (action === 'close') closeAll();
      else if (action === 'general') { setMoreOpen(false); setAgentsOpen(false); setListOpen(true); setFocusGeneral((n) => n + 1); }
      else if (action === 'resize') { if (event.type === 'pointerdown') startResize(event as PointerEvent, control); }
      else if (action === 'pins') { setMoreOpen(false); setPinsHidden((h) => !h); }
      else if (action === 'stop') { setMoreOpen(false); captureRef.current?.deactivate(); }
      else if (action === 'correct-selection') { const s = currentSelection(); if (s) void startCorrection(s.range.cloneRange(), s.frame); }
      else if (action === 'correct' && menu?.kind === 'correction') void startCorrection(menu.range, menu.frame);
      else if (action === 'thread' && menu?.kind === 'thread') runThreadAction(control.dataset.thread as ThreadAction, menu.threadIds, boxOf(menu.restore?.getBoundingClientRect() ?? CENTER()));
      else if (action === 'shortcut') setShortcut((on) => !on);
      else if (action === 'note') setNote(null);
      else if (action === 'reload') void load();
      else if (action === 'draft') setBubble({ kind: 'draft', mode: mode.current, at: shot ? boxOf(shot.target.rect) : CENTER() });
      else if (action === 'pin') {
        const ids = control.dataset.threads!.split(' ');
        const r = boxOf(control.getBoundingClientRect());
        opener.current = control;
        setBubble(ids.length > 1 ? { kind: 'cluster', threadIds: ids, at: r } : { kind: 'thread', threadId: ids[0]!, at: r });
      }
    };
  });
  useEffect(() => () => { actions.current = null; }, [actions]);

  // Focus : la liste reçoit son titre à l'ouverture, la bulle son champ.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const generalRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (listOpen && !editorial) headingRef.current?.focus();
  }, [listOpen, editorial]);
  useEffect(() => {
    if (focusGeneral && !editorial) generalRef.current?.focus();
  }, [focusGeneral]);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const bubbleKey = bubble ? (bubble.kind === 'thread' ? bubble.threadId : bubble.kind) : null;
  // Focus posé dès le rendu, sans attendre une frame : un Échap immédiat vise déjà la bulle. La frame suivante rattrape un champ monté plus tard.
  useLayoutEffect(() => {
    if (!showBubble || !bubbleKey) return;
    const focus = () => fieldRef.current?.focus({ preventScroll: true });
    focus();
    const raf = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(raf);
  }, [showBubble, bubbleKey, shot]);
  // Échap au niveau du document de la bulle : le focus peut retomber sur son body quand un bouton se désactive pendant un envoi.
  useEffect(() => {
    const doc = bubbleDoc?.ownerDocument;
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      dismiss.current(true);
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [bubbleDoc]);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !showBubble) return;
    const ro = new (el.ownerDocument.defaultView as typeof window).ResizeObserver(() => setBubbleHeight(el.offsetHeight + 2));
    ro.observe(el);
    return () => ro.disconnect();
  }, [showBubble, bubbleDoc]);

  // Menu aligné à droite de la toolbar, décalé quand une toolbar étroite le ferait sortir de la fenêtre.
  const moreRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const m = moreRef.current;
    if (!m) return;
    m.style.right = '0';
    m.style.right = `${Math.min(0, m.getBoundingClientRect().left - 8)}px`;
  });
  const listRef = useRef<HTMLIFrameElement>(null);
  const listDoc = useFrameDoc(listRef, 'Revue Socrate');
  const openCount = threads.filter((t) => t.state === 'open').length;
  const sharing = captureStatus.kind !== 'inactive';
  const captureNote = captureStatus.kind === 'inactive' && captureStatus.reason ? describeCapture(captureStatus) : captureStatus.kind === 'requesting' ? describeCapture(captureStatus) : null;
  const shownNote = note ?? (bubble?.kind === 'draft' ? null : capture?.invalidatedNotice ?? captureNote) ?? (status?.kind === 'error' ? status.text : null);
  // Toolbar et message centrés sur la place laissée par la liste ouverte en écran large ; libellés retirés quand cette place se réduit.
  const room = innerWidth - (wide ? listWidth : 0);
  const center = room / 2;
  const hasSelection = moreOpen && currentSelection() !== null;
  const { draft: written, phase } = targeted.view;
  const replacementChanged = !!written.replacement?.text.trim() && written.replacement.text.trim() !== originalOf(written.replacement.for, revision?.manifest ?? null).trim();
  // Brouillon à ne pas perdre ni réaffecter : texte, correction modifiée, envoi en cours ou au résultat incertain.
  const draftKept = targeted.view.preparing || !!written.attachments.length || !!written.text.trim() || replacementChanged || phase.kind === 'sending' || phase.kind === 'uncertain' || phase.kind === 'identity-blocked';
  // Un brouillon ciblé masqué par un clic extérieur, un fil ou la fermeture reste atteignable depuis la toolbar.
  dismiss.current = (focus) => closeBubble({ discard: bubble?.kind === 'draft' && !draftKept, focus });
  const draftHidden = !editorial && bubble?.kind !== 'draft' && (shot !== null || draftKept);
  const menuThreads = menu?.kind === 'thread' ? menu.threadIds.map((id) => threads.find((t) => t.threadId === id)).filter((t) => !!t) : [];
  const menuItems = menuThreads.length === 1 ? threadActions(review, menuThreads[0]!, false) : menuThreads.length ? [{ action: 'open' as const, label: `Ouvrir les ${menuThreads.length} conversations` }] : [];
  const targetTip = selecting ? 'Annuler le ciblage · Échap' : `Commenter un élément${shortcut ? ' · C' : ''}`;

  return (
    <>
      <Tip doc={document} />
      <div ref={toolbarRef} data-socrate="toolbar" role="toolbar" aria-label="Socrate" aria-keyshortcuts="Alt+Shift+S" data-compact={room < 720 || undefined} data-narrow={room < 520 || undefined} style={{ left: center, maxWidth: room - 16 }}>
        <button type="button" data-socrate-action="target" data-capture={captureStatus.kind === 'inactive' ? `inactive:${captureStatus.reason ?? ''}` : captureStatus.kind} aria-pressed={selecting}
          aria-label={selecting ? 'Annuler le ciblage' : 'Commenter un élément'} aria-keyshortcuts={shortcut ? 'C' : undefined} data-socrate-tip={targetTip}>
          {ICON.comment}<span data-label>Commenter</span>
        </button>
        {selecting && <span data-hint>Cliquez un élément · Échap</span>}
        {draftHidden && <button type="button" data-socrate-action="draft" data-socrate-tip="Reprendre le brouillon non envoyé">Brouillon</button>}
        <span data-sep aria-hidden="true" />
        <button type="button" data-socrate="launcher" data-socrate-action="launcher" aria-expanded={listOpen} aria-controls="socrate-frame" aria-label={`Conversations (${openCount} ouvertes)`} data-socrate-tip="Conversations">
          {ICON.list}{openCount > 0 && <span data-count aria-hidden="true">{openCount}</span>}
        </button>
        <button type="button" data-socrate-action="more" aria-expanded={moreOpen} aria-haspopup="menu" aria-label="Plus d’options" data-socrate-tip="Plus d’options">{ICON.more}</button>
        <span data-sep aria-hidden="true" />
        <button type="button" data-socrate-action="close" aria-label="Tout fermer et arrêter le partage" data-socrate-tip="Tout fermer et arrêter le partage">{ICON.close}</button>
        {moreOpen && (
          <div ref={moreRef} data-socrate="menu" role="menu" aria-label="Options Socrate" style={{ position: 'absolute', right: 0, bottom: 56 }}>
            <button type="button" role="menuitem" data-socrate-action="general">Commentaire général</button>
            <button type="button" role="menuitem" data-socrate-action="correct-selection" aria-disabled={!hasSelection} aria-describedby={hasSelection ? undefined : 'socrate-correct-why'}>
              <span>Proposer une correction{!hasSelection && <small id="socrate-correct-why">Sélectionnez d’abord un texte de la page</small>}</span>
            </button>
            <button type="button" role="menuitem" data-socrate-action="pins">{pinsHidden ? 'Afficher les pastilles' : 'Masquer les pastilles'}</button>
            <button type="button" role="menuitemcheckbox" aria-checked={shortcut} data-socrate-action="shortcut">Raccourci C pour commenter</button>
            <button type="button" role="menuitem" data-socrate-action="agents">Connecter un agent</button>
            {sharing && <button type="button" role="menuitem" data-socrate-action="stop">Arrêter le partage</button>}
          </div>
        )}
        <span role="status" aria-live="polite" style={HIDDEN}>{announce}</span>
      </div>
      {shownNote && (
        <p data-socrate="note" role="status" data-testid="socrate-note" style={{ left: center }}>
          <span>{shownNote}</span>
          {(captureNote || capture?.invalidatedNotice) && !note && <button type="button" data-socrate-action="target">Réessayer</button>}
          {status?.kind === 'error' && status.retry && shownNote === status.text && <button type="button" data-socrate-action="reload">Réessayer</button>}
          <button type="button" data-socrate-action="note" aria-label="Fermer ce message">{ICON.close}</button>
        </p>
      )}
      {menu?.kind === 'correction' && (
        <div ref={menuRef} data-socrate="menu" role="menu" aria-label="Correction" style={{ left: Math.min(menu.x, innerWidth - 256), top: Math.min(menu.y + 4, innerHeight - 52) }}>
          <button type="button" role="menuitem" data-socrate-action="correct">Proposer une correction de {quote(menu.range.toString())}</button>
        </div>
      )}
      {menu?.kind === 'thread' && menuItems.length > 0 && (
        <div ref={menuRef} data-socrate="menu" role="menu" aria-label="Actions de la conversation" style={{ left: Math.min(menu.x, innerWidth - 216), top: Math.min(menu.y + 4, innerHeight - 132) }}>
          {menuItems.map((it) => <button key={it.action} type="button" role="menuitem" data-socrate-action="thread" data-thread={it.action}>{it.label}</button>)}
        </div>
      )}
      {pins.map((g) => {
        const t = g[0]!.t;
        const label = g.length > 1 ? `${g.length} conversations ici` : describeThread(t);
        return (
          <button key={t.threadId} type="button" data-socrate="pin" data-socrate-action="pin" data-threads={g.map((p) => p.t.threadId).join(' ')} data-state={g.every((p) => p.t.state === 'resolved') ? 'resolved' : 'open'}
            aria-label={label} aria-haspopup="menu" aria-keyshortcuts="Shift+F10" data-socrate-tip={label} style={{ left: g[0]!.x, top: g[0]!.y, background: colorOf(t.author.key) }}>
            {initialsOf(t.author.displayName)}{g.length > 1 && <span data-count>{g.length}</span>}
          </button>
        );
      })}
      {listOpen && wide && (
        <div data-socrate="resize" data-socrate-action="resize" role="separator" aria-orientation="vertical" aria-label="Largeur des conversations" aria-controls="socrate-frame"
          aria-valuenow={paneWidth} aria-valuemin={bounds.min} aria-valuemax={bounds.max} tabIndex={0} data-active={resizing || undefined}
          data-socrate-tip="Glisser ou flèches gauche et droite pour régler la largeur" style={{ right: paneWidth - 5 }} onKeyDown={onResizeKey} />
      )}
      {/* Liste couvrant la page : la bande de la toolbar reste sous le panneau, hors de son composeur. */}
      <iframe ref={listRef} id="socrate-frame" title="Revue Socrate" src="about:blank" style={{ ...LIST_STYLE, ...(!wide && { boxSizing: 'border-box', paddingBottom: 64 }), width: paneWidth, display: listOpen ? undefined : 'none', pointerEvents: resizing ? 'none' : undefined }} data-socrate="panel" />
      <iframe ref={bubbleRef} id="socrate-bubble" title="Conversation Socrate" src="about:blank" data-socrate="bubble"
        style={{ ...BUBBLE_STYLE, display: showBubble ? undefined : 'none', left: at?.x ?? 0, top: at?.y ?? 0, width: at?.sheet ? viewport.width - 16 : bubbleWidth, height: bubbleHeight, pointerEvents: resizing ? 'none' : undefined }} />
      {listDoc && createPortal(
        <Boundary>
          {!editorial && <Tip doc={listDoc.ownerDocument} />}
          {agentsOpen
            ? <Suspense fallback={<p className="socrate-meta">Chargement…</p>}><AgentsView client={client} onBack={() => setAgentsOpen(false)} onClose={closeList} headingRef={headingRef} /></Suspense>
            : editorial
            ? <Suspense fallback={<p className="socrate-meta">Chargement…</p>}><Panel client={client} capture={capture} navigation={navigation} visible={listOpen} onClose={closeList} revision={revision} threads={threads} status={status} refresh={refresh} /></Suspense>
            : <ConversationList review={review} title={revision?.manifest.title ?? null} status={status} route={route} located={located} expanded={expanded} onOpen={openThread} onGoto={(id) => void goTo(id)} onClose={closeList} headingRef={headingRef} generalRef={generalRef} />}
        </Boundary>,
        listDoc,
      )}
      {bubbleDoc && showBubble && createPortal(
        <Boundary>
          <Tip doc={bubbleDoc.ownerDocument} />
          <div ref={contentRef} className="socrate-bubble" data-testid="socrate-bubble" data-kind={bubble!.kind}>
            {bubble!.kind === 'draft' && (
              <Draft mode={bubble!.mode} review={review} capture={capture} shot={shot} superseded={superseded} held={held} kept={draftKept}
                fieldRef={fieldRef} onClose={closeBubble} onRetarget={() => void startTargeting(true)} onDiscarded={() => setAnnounce('Brouillon supprimé.')} />
            )}
            {bubble!.kind === 'thread' && thread && <Conversation thread={thread} review={review} onClose={() => closeBubble()} inputRef={fieldRef} />}
            {bubble!.kind === 'cluster' && (
              <>
                <div className="socrate-bubble-head"><span>{bubble!.threadIds.length} conversations ici</span><button type="button" className="socrate-icon" aria-label="Fermer" data-socrate-tip="Fermer · Échap" onClick={() => closeBubble()}>{ICON.close}</button></div>
                <ul className="socrate-rows" style={{ padding: 0 }}>
                  {bubble!.threadIds.map((id) => threads.find((t) => t.threadId === id)).filter((t) => !!t).map((t) => (
                    <li key={t.threadId}><button type="button" className="socrate-row" data-thread={t.threadId} onClick={() => setBubble({ kind: 'thread', threadId: t.threadId, at: bubble!.at })}>
                      <span className="socrate-avatar" style={{ width: 24, height: 24, background: colorOf(t.author.key) }} aria-hidden="true">{initialsOf(t.author.displayName)}</span>
                      <span><strong>{t.author.displayName}</strong><span className="socrate-row-text">{t.proposal ? `Correction proposée : « ${t.proposal.replacement} »` : t.messages[0]?.body}</span></span>
                    </button></li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Boundary>,
        bubbleDoc,
      )}
    </>
  );
}

/** Brouillon ancré : avatar, champ et flèche ; en correction, le texte actuel enregistré par le service puis le remplacement. */
function Draft({ mode, review, capture, shot, superseded, held, kept, fieldRef, onClose, onRetarget, onDiscarded }: {
  mode: 'comment' | 'correction'; review: Review; capture: TabCapture | null; shot: TabCapture['draft']; superseded: boolean; held: boolean; kept: boolean;
  fieldRef: RefObject<HTMLTextAreaElement | null>; onClose: (o?: { discard?: boolean; focus?: boolean }) => void; onRetarget: () => void; onDiscarded: () => void;
}) {
  const { client, session, seen, revision, refresh, canParticipate } = review;
  const { submission, view } = useSubmission(client, { kind: 'targeted' }, TARGETED_LABELS, refresh);
  const [withComment, setWithComment] = useState(false);
  const phase = view.phase.kind;
  const pending = phase === 'uncertain' || phase === 'identity-blocked' ? view.phase.intent : null;
  const busy = phase === 'sending';
  const target = shot && !superseded ? shot.target : null;
  const manifest = revision?.manifest ?? null;
  const wording = target?.wording ? manifest?.wordings?.find((w) => w.id === target.wording) ?? null : null;
  // Un texte préparé absent de la sélection de cette révision est refusé par le service : commentaire seulement.
  const absent = !!target?.wording && !wording;
  const original = target ? originalOf(target, manifest) : '';
  const replacement = view.draft.replacement;
  const correcting = mode === 'correction' && !absent;
  useEffect(() => {
    if (!target || mode !== 'correction') return;
    if (absent) {
      if (replacement?.for === target) submission.editReplacement(null);
    } else if (replacement?.for !== target) submission.editReplacement({ text: original, for: target });
  }, [target, mode, absent]);
  useEffect(() => {
    // Texte préparé : la partie sélectionnée est présélectionnée dans le remplacement, qui reprend la source complète.
    const el = fieldRef.current;
    const i = wording && shot ? wording.source.indexOf(shot.target.text) : -1;
    if (correcting && el && i >= 0 && replacement?.for === target && el.value === wording!.source) el.setSelectionRange(i, i + shot!.target.text.length);
  }, [correcting, wording, shot, replacement?.for]);
  const elsewhere = !!replacement?.text.trim() && !!target && replacement.for !== target;
  const text = view.draft.text.trim();
  const changed = !!replacement?.text.trim() && replacement.for === target && replacement.text.trim() !== original.trim();
  const ready = correcting ? changed : !!text || !!view.draft.attachments.length;
  const canSend = !busy && canParticipate && !!seen && !isStaleTargeted(pending) && (pending ? true : !!target && !elsewhere && ready);
  // Masquer ne perd jamais rien : seul un brouillon vide disparaît. L'abandon d'un texte est un geste distinct ; celui d'un envoi en attente reste « Abandonner la reprise ».
  const discard = () => {
    onClose({ discard: true });
    onDiscarded();
  };
  const send = () => seen && revision && void submission.publish({ seen, capture: target ? shot : null, revisionId: revision.revisionId });
  const me = session?.actor ?? null;
  const disabled = session !== null && !canParticipate;
  return (
    <section data-testid="socrate-draft" data-mode={mode} aria-label={correcting ? 'Proposer une correction' : 'Nouveau commentaire'}>
      {(correcting || kept) && (
        <div className="socrate-bubble-head">
          <span>{correcting ? 'Proposer une correction' : ''}</span>
          {kept && !pending && !busy && !view.preparing && <button type="button" className="socrate-button link" onClick={discard}>Supprimer le brouillon</button>}
        </div>
      )}
      {held && <p className="socrate-meta" role="status" data-testid="socrate-draft-held">Ce brouillon n’est pas envoyé : envoyez-le ou supprimez-le avant de cibler un autre élément.</p>}
      <Notice view={view.notice?.kind === 'success' ? { ...view, notice: null } : view} submission={submission} testId="socrate-pending-targeted" />
      {capture?.invalidatedNotice && (
        <p className="socrate-status" data-kind="error" role="alert" data-testid="socrate-capture-invalidated">
          {capture.invalidatedNotice} Le texte est conservé.{' '}
          <button type="button" className="socrate-button link" onClick={onRetarget}>Cibler à nouveau</button>
        </p>
      )}
      {correcting && (
        <div className="socrate-quote" data-testid="socrate-original">
          <p className="socrate-meta">Texte actuel</p>
          <p>« {original} »</p>
        </div>
      )}
      {mode === 'correction' && absent && <p className="socrate-meta" data-testid="socrate-wording-absent">Ce texte préparé n’est pas dans la sélection de cette révision : aucune correction ne peut être enregistrée, un commentaire reste possible.</p>}
      {elsewhere && (
        <p className="socrate-meta" data-testid="socrate-kept-replacement">
          Une correction rédigée pour « {replacement!.for.text.slice(0, 80)} » n’est pas rattachée à ce ciblage.{' '}
          <button type="button" className="socrate-button link" onClick={() => submission.editReplacement(null)}>Retirer la correction</button>
        </p>
      )}
      {correcting ? (
        <>
          <Composer me={me} label="Correction proposée" placeholder="Texte corrigé" inputRef={fieldRef} value={replacement?.text ?? ''} busy={busy} disabled={disabled}
            onChange={(t) => target && submission.editReplacement({ text: t, for: target })} onSend={send} canSend={canSend} media={{ submission, items: view.draft.attachments, locked: !!pending }} />
          {withComment || text
            ? <div style={{ marginTop: 8 }}><Composer me={null} label="Commentaire facultatif" placeholder="Pourquoi cette correction ? (facultatif)" value={view.draft.text} busy={busy} disabled={disabled} onChange={(t) => submission.edit(t)} onSend={send} canSend={canSend} sendButton={false} /></div>
            : <button type="button" className="socrate-button link" style={{ marginLeft: 32 }} onClick={() => setWithComment(true)}>+ Ajouter un commentaire</button>}
        </>
      ) : (
        <Composer me={me} label="Votre commentaire" placeholder="Ajouter un commentaire" inputRef={fieldRef} value={view.draft.text} busy={busy} disabled={disabled}
          onChange={(t) => submission.edit(t)} onSend={send} canSend={canSend} media={{ submission, items: view.draft.attachments, locked: !!pending }} />
      )}
      {!target && !pending && !capture?.invalidatedNotice && <p className="socrate-meta" data-testid="socrate-targeted-blocked">Envoi bloqué : un nouveau ciblage est nécessaire. Le texte est conservé. <button type="button" className="socrate-button link" onClick={onRetarget}>Cibler à nouveau</button></p>}
      {disabled && <p className="socrate-meta">Votre accès ne permet pas de publier.</p>}
      <p className="socrate-meta socrate-hint">{SEND_HINT} · Échap pour masquer</p>
    </section>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[socrate] panneau arrêté après une erreur de rendu', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="socrate-panel" data-testid="socrate-panel-failed">
        <div className="socrate-body">
          <p role="alert" className="socrate-status" data-kind="error">Le panneau Socrate a rencontré une erreur et s’est arrêté. L’application reste utilisable ; rechargez la page pour rouvrir la revue.</p>
        </div>
      </div>
    );
  }
}
