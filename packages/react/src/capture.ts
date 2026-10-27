import { sha256Hex, type ImageMeta, type Target } from '@socrate/contract';
import { cleanText, contextOf, isSocrate, nearbyText, offsetOf, roleOf, sameOriginFrames, sanitizedExcerpt } from './locate.ts';

export type CaptureStatus =
  | { kind: 'inactive'; reason: null | 'refused' | 'stopped' | 'wrong-tab' | 'unsupported' | 'failed'; detail?: string }
  | { kind: 'requesting' }
  | { kind: 'active' }
  | { kind: 'selecting' }
  | { kind: 'capturing' };

/**
 * `shared` : le partage qui a produit l'image n'a pas été révoqué depuis ; fermer Socrate arrête le flux sans révoquer. `current` : ce brouillon est encore celui du panneau.
 * `element` et `frame` : l'élément vivant désigné, qui ancre la bulle puis la pastille tant que ce document vit.
 * `point` : point du geste (clic, coin de la zone, fin de la sélection) relatif au coin de l'élément ; ancre la bulle, n'entre pas dans la cible publiée.
 */
export type TargetedDraft = Readonly<{ target: Target; image: Readonly<{ blob: Blob; url: string; meta: ImageMeta }>; restoreFocus: HTMLElement | null; element: Element; frame: HTMLIFrameElement | null; point: Readonly<Point>; shared: () => boolean; current: () => boolean }>;
type Point = { x: number; y: number };

type CaptureHandleTrack = MediaStreamTrack & { getCaptureHandle?: () => { handle: string; origin: string } | null };
type HandleConfig = { handle: string; exposeOrigin: boolean; permittedOrigins: string[] };
type MediaDevicesWithHandle = MediaDevices & { setCaptureHandleConfig?: (c: HandleConfig) => void };
/** `grabFrame` est dans la spécification W3C Image Capture et dans Chrome, pas encore dans lib.dom. */
type FrameGrabber = ImageCapture & { grabFrame(): Promise<ImageBitmap> };

/**
 * Masquage des contrôles, plus un pixel hors Socrate dont l'opacité varie à chaque image tant que la règle est posée :
 * la capture d'onglet n'émet une image que sur un dommage de rendu, et le seul masquage d'une page au repos n'en produisait pas.
 * Écart d'au plus 1 % d'opacité sur un pixel ; `html::after` de l'hôte est remplacé pendant le masquage seulement.
 */
const HIDE_STYLE = '[data-socrate]{visibility:hidden!important}'
  + 'html::after{content:""!important;position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;z-index:2147483647!important;pointer-events:none!important;animation:socrate-repaint .25s linear infinite alternate!important}'
  + '@keyframes socrate-repaint{from{background:rgba(0,0,0,0)}to{background:rgba(0,0,0,.01)}}';
/** Curseur de ciblage, posé dans chaque document écouté pendant la sélection seulement. */
const CROSSHAIR = 'html,html *{cursor:crosshair!important}';
/** Témoin de fraîcheur : le bouton principal de la toolbar, plein de cette couleur dans tous ses états (la toolbar est blanche). */
const WITNESS = '[data-socrate="toolbar"] [data-socrate-action="target"]';
const LAUNCHER_RGB = [0x2a, 0x4f, 0xd6];
const HOVER = ['mousemove', 'pointerover', 'mouseover', 'pointerout', 'mouseout', 'pointerenter', 'mouseenter', 'pointerleave', 'mouseleave'] as const;
const INTERCEPTED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend', 'selectstart', 'dragstart'] as const;
const FRESH_FRAME_DEADLINE_MS = 2_000;
const LAUNCHER_SHOWN_RATIO = 0.3;

/** Calque vide plein écran posé par une bibliothèque pour fermer un popup au clic extérieur : la relectrice vise ce qu'il recouvre. */
const isClickShield = (el: Element) => {
  if (el.childElementCount > 0 || el.textContent?.trim()) return false;
  const r = el.getBoundingClientRect();
  const v = el.ownerDocument.defaultView!;
  return r.left <= 0 && r.top <= 0 && r.right >= v.innerWidth && r.bottom >= v.innerHeight;
};
/** Conteneur modal ou latéral de la cible ; son libellé : `aria-label`, `aria-labelledby` ou premier titre, texte normalisé tronqué à 80 unités UTF-16. */
const MODAL = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
function containerOf(el: Element): Target['container'] {
  const box = el.closest(MODAL);
  if (!box) return undefined;
  const named = box.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => box.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
  const label = cleanText(box.getAttribute('aria-label') || named || box.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')?.textContent || '').replace(/\p{C}/gu, '');
  if (!label || label.length <= 80) return label ? { label } : {};
  // Coupure par points de code, jamais au milieu d'une paire de substitution ; 80 unités UTF-16 au plus, comme le contrat.
  let cut = '';
  for (const c of label) {
    if (cut.length + c.length > 79) break;
    cut += c;
  }
  return { label: `${cut}…` };
}
const viewportOf = () => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY });
const sameViewport = (a: Target['viewport'], b: Target['viewport']) => a.width === b.width && a.height === b.height && a.devicePixelRatio === b.devicePixelRatio && a.scrollX === b.scrollX && a.scrollY === b.scrollY;

/**
 * Partage ponctuel de l'onglet courant. Le flux reste local : une seule image est extraite au ciblage,
 * aucune vidéo ni historique de frames, rien n'est envoyé tant que la relectrice ne publie pas.
 */
export class TabCapture {
  private readonly handle = crypto.randomUUID();
  /** Incrémentée à chaque activation, interruption ou démontage : toute continuation d'une génération passée est abandonnée. */
  private generation = 0;
  /** Incrémenté à chaque révocation du partage (arrêt, mauvais onglet, échec, démontage) : une image n'est plus émise après la révocation qui la concerne. */
  private consent = 0;
  private stream: MediaStream | null = null;
  private grabber: FrameGrabber | null = null;
  private statusValue: CaptureStatus = { kind: 'inactive', reason: null };
  private draftValue: TargetedDraft | null = null;
  private readonly listeners = new Set<() => void>();
  private highlight: HTMLDivElement | null = null;
  private teardownSelection: (() => void) | null = null;
  private hideStyle: HTMLStyleElement | null = null;
  invalidatedNotice: string | null = null;
  onDraft: (() => void) | null = null;

  get status(): CaptureStatus {
    return this.statusValue;
  }

  get draft(): TargetedDraft | null {
    return this.draftValue;
  }

  /** Un reciblage a été refusé alors qu'un brouillon existait : ce brouillon est antérieur, aucune nouvelle publication ciblée jusqu'à un ciblage réussi. */
  get draftSuperseded(): boolean {
    return this.draftValue !== null && this.invalidatedNotice !== null;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(status: CaptureStatus): void {
    this.statusValue = status;
    for (const l of this.listeners) l();
  }

  attach(): void {
    const md = navigator.mediaDevices as MediaDevicesWithHandle | undefined;
    md?.setCaptureHandleConfig?.({ handle: this.handle, exposeOrigin: true, permittedOrigins: [window.location.origin] });
  }

  dispose(): void {
    this.generation += 1;
    this.consent += 1;
    this.cancelSelection();
    this.discardDraft();
    this.stop();
    this.reveal();
    this.statusValue = { kind: 'inactive', reason: null };
  }

  async activate(): Promise<void> {
    if (this.stream || this.statusValue.kind === 'requesting') return;
    const md = navigator.mediaDevices;
    if (!md?.getDisplayMedia || typeof ImageCapture === 'undefined') return this.set({ kind: 'inactive', reason: 'unsupported', detail: 'getDisplayMedia ou ImageCapture indisponible dans ce navigateur' });
    const gen = ++this.generation;
    this.set({ kind: 'requesting' });
    let stream: MediaStream;
    try {
      stream = await md.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' } as DisplayMediaStreamOptions);
    } catch (e) {
      if (gen === this.generation) this.set({ kind: 'inactive', reason: 'refused', detail: (e as Error).name });
      return;
    }
    const close = () => stream.getTracks().forEach((t) => t.stop());
    // Démonté ou remplacé pendant le sélecteur : le partage accordé trop tard est fermé, jamais laissé sans propriétaire.
    if (gen !== this.generation) return close();
    const track = stream.getVideoTracks()[0] as CaptureHandleTrack | undefined;
    if (!track) {
      close();
      return this.set({ kind: 'inactive', reason: 'failed', detail: 'aucune piste vidéo' });
    }
    this.stream = stream;
    track.addEventListener('ended', () => {
      if (this.stream === stream) this.interrupt('stopped');
    });
    track.addEventListener('capturehandlechange', () => {
      if (this.stream === stream && !this.rightTab()) this.interrupt('wrong-tab');
    });
    if (!this.rightTab()) return this.interrupt('wrong-tab');
    this.grabber = new ImageCapture(track) as FrameGrabber;
    this.set({ kind: 'active' });
  }

  private rightTab(): boolean {
    const track = this.stream?.getVideoTracks()[0] as CaptureHandleTrack | undefined;
    if (!track || track.readyState !== 'live') return false;
    const h = track.getCaptureHandle?.();
    return h?.handle === this.handle;
  }

  /** Arrêt, mauvais onglet ou échec : le flux est fermé, l'image du brouillon invalidée, le texte conservé par le panneau. */
  private interrupt(reason: 'stopped' | 'wrong-tab' | 'failed', detail?: string): void {
    this.generation += 1;
    this.consent += 1;
    this.cancelSelection();
    if (this.draftValue) {
      this.discardDraft();
      this.invalidatedNotice = 'Le partage a été interrompu : l’image du brouillon est abandonnée. Réactivez la capture puis ciblez à nouveau.';
    }
    this.stop();
    this.set({ kind: 'inactive', reason, detail });
  }

  private stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.grabber = null;
  }

  deactivate(): void {
    this.interrupt('stopped');
  }

  /**
   * « Tout fermer » : les pistes sont arrêtées sans révoquer l'image d'un envoi en cours ou incertain (`keep`), repris sous la même clé.
   * Un brouillon encore modifiable perd son image et demandera un nouveau ciblage ; son texte reste dans le panneau.
   */
  release(keep: TargetedDraft | null): void {
    this.generation += 1;
    this.cancelSelection();
    if (this.draftValue && this.draftValue !== keep) {
      this.discardDraft();
      this.invalidatedNotice = 'Tout a été fermé : le partage est arrêté et l’image du brouillon abandonnée. Ciblez à nouveau.';
    }
    this.stop();
    this.set({ kind: 'inactive', reason: null });
  }

  discardDraft(): void {
    if (this.draftValue) URL.revokeObjectURL(this.draftValue.image.url);
    this.draftValue = null;
    for (const l of this.listeners) l();
  }

  /** Les gestes ne sont interceptés que pendant la sélection ; Escape l'annule et rend le contrôle à l'application. */
  startSelection(): void {
    if (this.statusValue.kind !== 'active') return;
    if (!this.rightTab()) return this.interrupt('wrong-tab');
    const restoreFocus = document.activeElement instanceof HTMLElement && !isSocrate(document.activeElement) ? document.activeElement : null;
    const box = document.createElement('div');
    box.dataset.socrate = 'highlight';
    box.setAttribute('aria-hidden', 'true');
    box.popover = 'manual';
    Object.assign(box.style, { position: 'fixed', margin: '0', padding: '0', border: '2px solid #f5a623', background: 'rgba(245,166,35,.12)', pointerEvents: 'none', inset: 'auto', display: 'none', overflow: 'visible' });
    document.body.append(box);
    try { box.showPopover(); } catch { /* top layer indisponible : le z-index fixe suffit */ }
    this.highlight = box;
    const place = (r: { left: number; top: number; width: number; height: number }) => Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // Un jeu d'écouteurs par document : l'onglet, puis chaque iframe directe de même origine, ses coordonnées ramenées à celles de l'onglet.
    const listen = (win: Window, frame: HTMLIFrameElement | null) => {
      const doc = win.document;
      let start: { x: number; y: number } | null = null;
      const pick = (x: number, y: number) => doc.elementsFromPoint(x, y).find((el) => !isSocrate(el) && !isClickShield(el) && el !== doc.documentElement && el !== doc.body) ?? null;
      const shifted = (r: { left: number; top: number; width: number; height: number }) => {
        const o = offsetOf(frame);
        return new DOMRect(r.left + o.x, r.top + o.y, r.width, r.height);
      };
      const onMove = (e: PointerEvent) => {
        if (isSocrate(e.target)) return;
        e.stopImmediatePropagation();
        if (start) return place(shifted({ left: Math.min(start.x, e.clientX), top: Math.min(start.y, e.clientY), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) }));
        const el = pick(e.clientX, e.clientY);
        if (el) place(shifted(el.getBoundingClientRect()));
      };
      const swallow = (e: Event) => {
        if (isSocrate(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const p = e as PointerEvent;
        if (e.type === 'pointerdown') start = { x: p.clientX, y: p.clientY };
        if (e.type === 'pointerup' && start) {
          const area = Math.abs(p.clientX - start.x) > 8 && Math.abs(p.clientY - start.y) > 8
            ? { left: Math.min(start.x, p.clientX), top: Math.min(start.y, p.clientY), width: Math.abs(p.clientX - start.x), height: Math.abs(p.clientY - start.y) }
            : null;
          const el = area ? pick(area.left + area.width / 2, area.top + area.height / 2) : pick(p.clientX, p.clientY);
          start = null;
          const at = shifted(area ? { left: area.left + area.width, top: area.top + area.height, width: 0, height: 0 } : { left: p.clientX, top: p.clientY, width: 0, height: 0 });
          // Le click suit mouseup dans la même tâche : l'interception reste en place jusqu'à lui.
          if (el) setTimeout(() => void this.shoot(el, area && shifted(area), restoreFocus, frame, { x: at.x, y: at.y }), 0);
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.cancelSelection();
      };
      const still = (e: Event) => { if (!isSocrate(e.target)) e.stopImmediatePropagation(); };
      const cursor = doc.createElement('style');
      cursor.textContent = CROSSHAIR;
      doc.head?.append(cursor);
      win.addEventListener('pointermove', onMove, true);
      win.addEventListener('keydown', onKey, true);
      for (const t of INTERCEPTED) win.addEventListener(t, swallow, true);
      for (const t of HOVER) win.addEventListener(t, still, true);
      return () => {
        cursor.remove();
        for (const t of HOVER) win.removeEventListener(t, still, true);
        win.removeEventListener('pointermove', onMove, true);
        win.removeEventListener('keydown', onKey, true);
        for (const t of INTERCEPTED) win.removeEventListener(t, swallow, true);
      };
    };
    const frames = new Map<HTMLIFrameElement, { doc: Document; off: () => void }>();
    // ponytail: relevé des iframes à chaque frame d'affichage pendant la sélection seulement ; couvre ajout, retrait, navigation et rechargement sans observateur par cas.
    let raf = 0;
    const sync = () => {
      for (const [f, b] of frames) if (!f.isConnected || f.contentDocument !== b.doc) { b.off(); frames.delete(f); }
      for (const f of sameOriginFrames()) if (!frames.has(f)) frames.set(f, { doc: f.contentDocument!, off: listen(f.contentWindow!, f) });
      raf = requestAnimationFrame(sync);
    };
    const offTop = listen(window, null);
    sync();
    this.teardownSelection = () => {
      cancelAnimationFrame(raf);
      offTop();
      for (const b of frames.values()) b.off();
      frames.clear();
      box.remove();
      this.highlight = null;
    };
    this.set({ kind: 'selecting' });
  }

  cancelSelection(): void {
    if (!this.teardownSelection) return;
    this.teardownSelection();
    this.teardownSelection = null;
    if (this.statusValue.kind === 'selecting') this.set({ kind: 'active' });
  }

  /**
   * Correction sur une sélection de texte : la plage clonée par l'appelant est photographiée telle qu'elle est affichée, contrôles masqués.
   * La cible garde le texte sélectionné exact (l'original d'un texte libre côté service), l'ancêtre commun comme élément et contexte.
   */
  shootSelection(range: Range, frame: HTMLIFrameElement | null): Promise<void> {
    const node = range.commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const text = cleanText(range.toString());
    if (this.statusValue.kind !== 'active' || !el || !text) return Promise.resolve();
    const r = range.getBoundingClientRect();
    const rects = range.getClientRects();
    const end = rects[rects.length - 1] ?? r;
    const o = offsetOf(frame);
    const focused = el.ownerDocument.activeElement;
    const restoreFocus = focused instanceof HTMLElement && !isSocrate(focused) ? focused : null;
    return this.shoot(el, new DOMRect(r.x + o.x, r.y + o.y, r.width, r.height), restoreFocus, frame, { x: end.right + o.x, y: end.top + end.height / 2 + o.y }, { range, text });
  }

  private async shoot(el: Element, area: DOMRect | null, restoreFocus: HTMLElement | null, frame: HTMLIFrameElement | null, point: Point, selection?: { range: Range; text: string }): Promise<void> {
    this.teardownSelection?.();
    this.teardownSelection = null;
    if (!this.rightTab()) return this.interrupt('wrong-tab');
    const gen = this.generation;
    this.set({ kind: 'capturing' });
    // Contexte figé au ciblage : l'image n'est retenue que si route, cible et viewport n'ont pas bougé jusqu'à la fin de l'encodage.
    // Route et URL du document de la cible ; rectangle et viewport dans le référentiel de l'onglet capturé.
    const doc = el.ownerDocument;
    const loc = doc.defaultView!.location;
    const viewport = viewportOf();
    const rectNow = () => {
      const r = el.getBoundingClientRect();
      const o = offsetOf(frame);
      return new DOMRect(r.x + o.x, r.y + o.y, r.width, r.height);
    };
    const elRect = rectNow();
    const rect = area ?? elRect;
    // Seul le rattachement déclaré par l'hôte compte : deux textes identiques sans attribut restent distincts.
    const wording = el.closest('[data-socrate-wording]')?.getAttribute('data-socrate-wording');
    const selector = selectorOf(el);
    const context = contextOf(el, selector);
    const container = containerOf(el);
    const target: Target = {
      url: loc.href.slice(0, 2048), route: loc.pathname.slice(0, 512) || '/', frame: frame ? [selectorOf(frame)] : [], ...(frame && { hostRoute: location.pathname.slice(0, 512) || '/' }),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport,
      role: roleOf(el), text: selection?.text ?? nearbyText(el), selector, html: sanitizedExcerpt(el),
      ...(wording && /^[a-z0-9][a-z0-9-]{0,63}$/.test(wording) && { wording }), ...(context && { context }), ...(container && { container }),
    };
    const launcher = document.querySelector(WITNESS)?.getBoundingClientRect() ?? null;
    try {
      const canvas = await this.freshFrame(launcher, viewport);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encodage PNG impossible'))), 'image/png'));
      const meta: ImageMeta = { contentType: 'image/png', size: blob.size, sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())), width: canvas.width, height: canvas.height };
      if (gen !== this.generation) return;
      const consent = this.consent;
      // Contrôlé après la frame et l'encodage, juste avant l'installation : aucune attente ne reste entre ce contrôle et le brouillon.
      // Une iframe fermée ou rechargée laisse son ancien document connecté à lui-même : le cadre est vérifié d'abord.
      if (frame && (!frame.isConnected || frame.contentDocument !== doc)) throw new Error('l’iframe de la cible a été fermée ou rechargée pendant la capture, ciblez à nouveau');
      const now = rectNow();
      const moved = Math.abs(now.x - elRect.x) > 0.5 || Math.abs(now.y - elRect.y) > 0.5 || Math.abs(now.width - elRect.width) > 0.5 || Math.abs(now.height - elRect.height) > 0.5;
      if (loc.href.slice(0, 2048) !== target.url || !el.isConnected || moved || !sameViewport(viewport, viewportOf())) {
        throw new Error('la route, la cible ou le viewport a changé pendant la capture, ciblez à nouveau');
      }
      if (selection && cleanText(selection.range.toString()) !== selection.text) throw new Error('la sélection a changé pendant la capture, sélectionnez à nouveau le texte');
      if (!this.rightTab()) return this.interrupt('wrong-tab');
      this.discardDraft();
      this.invalidatedNotice = null;
      const draft: TargetedDraft = Object.freeze({
        target, image: Object.freeze({ blob, url: URL.createObjectURL(blob), meta }), restoreFocus, element: el, frame,
        point: Object.freeze({ x: point.x - elRect.x, y: point.y - elRect.y }),
        // Sans flux, seule une fermeture de Socrate a pu l'arrêter : toute révocation incrémente `consent`.
        shared: () => consent === this.consent && (this.stream === null || this.rightTab()),
        current: () => this.draftValue === draft,
      });
      this.draftValue = draft;
      this.set({ kind: 'active' });
      this.onDraft?.();
    } catch (e) {
      this.reveal();
      if (gen !== this.generation) return;
      // Un brouillon déjà présent reste affiché comme antérieur : voir `draftSuperseded`.
      this.invalidatedNotice = `Capture impossible : ${(e as Error).message}.`;
      this.set({ kind: 'active' });
    }
  }

  private conceal(): void {
    if (this.hideStyle) return;
    const s = document.createElement('style');
    s.dataset.socrate = 'hide';
    s.textContent = HIDE_STYLE;
    document.head.append(s);
    this.hideStyle = s;
  }

  private reveal(): void {
    this.hideStyle?.remove();
    this.hideStyle = null;
  }

  /**
   * Masque les contrôles Socrate par visibilité (sans toucher au focus ni aux popups de l'hôte),
   * puis n'accepte qu'une frame où le lanceur n'apparaît plus : preuve de fraîcheur par le contenu, pas par le temps.
   * Observé dans Chromium local : sur une page au repos, la capture d'onglet n'émettait aucune frame pour le seul masquage et
   * le `grabFrame` en attente restait vide jusqu'à l'échéance. Le pixel animé de `HIDE_STYLE` entretient un dommage
   * de rendu pendant le masquage, sans garantie documentée de nouveauté : le contrôle de contenu ci-dessous reste le seul juge.
   */
  private async freshFrame(launcher: DOMRect | null, viewport: Target['viewport']): Promise<HTMLCanvasElement> {
    const grabber = this.grabber;
    if (!grabber) throw new Error('partage inactif');
    if (!launcher || launcher.width < 8 || launcher.height < 8 || launcher.left < 0 || launcher.top < 0 || launcher.right > viewport.width || launcher.bottom > viewport.height) {
      throw new Error('barre Socrate hors de la vue : la fraîcheur de l’image ne peut pas être contrôlée');
    }
    this.conceal();
    try {
      const deadline = performance.now() + FRESH_FRAME_DEADLINE_MS;
      const canvas = document.createElement('canvas');
      while (performance.now() < deadline) {
        const frame = await grabBefore(grabber, deadline);
        if (!this.rightTab()) {
          frame?.close();
          throw new Error('onglet partagé différent');
        }
        if (!frame) continue;
        const { width: w, height: h } = frame;
        const ctx = w && h && Math.abs(w / h - viewport.width / viewport.height) <= 0.02 ? canvas.getContext('2d', { willReadFrequently: true })! : null;
        if (ctx) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(frame, 0, 0);
        }
        frame.close();
        if (ctx && !showsLauncher(ctx, launcher, w / viewport.width)) return canvas;
      }
      throw new Error('aucune image fraîche sans les contrôles Socrate dans le délai');
    } finally {
      this.reveal();
    }
  }
}

/** Instantané de la piste rendu par `grabFrame`, ou null si elle est refusée ou arrive après l'échéance ; une frame tardive est fermée à son arrivée. */
function grabBefore(grabber: FrameGrabber, deadline: number): Promise<ImageBitmap | null> {
  const grab = grabber.grabFrame();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
      grab.then((b) => b.close(), () => undefined);
    }, Math.max(0, deadline - performance.now()));
    grab.then((b) => { clearTimeout(timer); resolve(b); }, () => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * Les contrôles sont masqués par une seule règle de style, donc dans la même frame. Le lanceur plein bleu en est le témoin :
 * toute sa surface est lue, libellé blanc compris, et il est vu tant qu'une part notable reste de sa couleur.
 */
function showsLauncher(ctx: CanvasRenderingContext2D, r: DOMRect, scale: number): boolean {
  const x = Math.floor(r.left * scale);
  const y = Math.floor(r.top * scale);
  const w = Math.max(1, Math.floor(r.width * scale));
  const h = Math.max(1, Math.floor(r.height * scale));
  const data = ctx.getImageData(x, y, w, h).data;
  let blue = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i]! - LAUNCHER_RGB[0]!) < 40 && Math.abs(data[i + 1]! - LAUNCHER_RGB[1]!) < 40 && Math.abs(data[i + 2]! - LAUNCHER_RGB[2]!) < 40) blue++;
  }
  return blue / (w * h) >= LAUNCHER_SHOWN_RATIO;
}

function selectorOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== el.ownerDocument.body && parts.length < 5) {
    const id = cur.getAttribute('data-socrate-id');
    if (id) {
      const instance = cur.getAttribute('data-socrate-instance');
      parts.unshift(`[data-socrate-id="${id}"]${instance ? `[data-socrate-instance="${instance}"]` : ''}`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    cur = parent;
  }
  return parts.join(' > ').slice(0, 300);
}
