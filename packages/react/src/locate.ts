import { HTML_ATTRIBUTES, isSanitizedHtml, type EditorialRef, type Target } from '@socrate/contract';

/** Lecture du DOM de l'hôte partagée par la capture, le guidage et les pastilles. */

export type Resolution = { kind: 'found'; element: HTMLElement } | { kind: 'missing' } | { kind: 'ambiguous'; count: number };

/** Un seul élément accepté : zéro ou plusieurs correspondances ne sont jamais rattachées au premier venu. */
export function resolveEditorial(doc: Document, ref: EditorialRef): Resolution {
  const all = [...doc.querySelectorAll<HTMLElement>(`[data-socrate-id="${CSS.escape(ref.id)}"]`)];
  return settle(ref.instance ? all.filter((el) => el.dataset.socrateInstance === ref.instance) : all);
}

export function resolveSelector(doc: Document, selector: string): Resolution {
  try {
    return settle([...doc.querySelectorAll<HTMLElement>(selector)]);
  } catch {
    return { kind: 'missing' };
  }
}

function settle(matches: HTMLElement[]): Resolution {
  if (matches.length === 1) return { kind: 'found', element: matches[0]! };
  return matches.length === 0 ? { kind: 'missing' } : { kind: 'ambiguous', count: matches.length };
}

/** Seul un identifiant éditorial porté par l'élément lui-même confirme une cible ; un ancêtre suivi de `nth-of-type` reste une position. */
export const OWN_EDITORIAL = /^\[data-socrate-id="([^"]+)"\](?:\[data-socrate-instance="([^"]+)"\])?$/;

export const SOCRATE = '[data-socrate]';
/** Sans `instanceof` : un élément d'iframe appartient à un autre royaume que l'onglet. */
export const isSocrate = (t: EventTarget | null) => !!(t as Element | null)?.closest?.(SOCRATE);

/** Coin du contenu d'une iframe dans le viewport de l'onglet, référentiel de l'image : bord et marge intérieure compris, sans transformation. */
export const offsetOf = (frame: HTMLIFrameElement | null) => {
  if (!frame) return { x: 0, y: 0 };
  const r = frame.getBoundingClientRect();
  const cs = getComputedStyle(frame);
  return { x: r.left + frame.clientLeft + parseFloat(cs.paddingLeft), y: r.top + frame.clientTop + parseFloat(cs.paddingTop) };
};

/** Iframes directes de même origine, surfaces Socrate exclues. Une autre origine (document illisible) n'est jamais observée. */
export const sameOriginFrames = () => [...document.querySelectorAll('iframe')].filter((f) => {
  try {
    return !isSocrate(f) && !!f.contentDocument && f.contentWindow!.location.origin === location.origin;
  } catch {
    return false;
  }
});

const IMPLICIT_ROLES: Record<string, string> = { BUTTON: 'button', A: 'link', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading', IMG: 'img', LI: 'listitem', NAV: 'navigation', MAIN: 'main', DIALOG: 'dialog' };

export function roleOf(el: Element): string {
  return (el.getAttribute('role') ?? IMPLICIT_ROLES[el.tagName] ?? el.tagName.toLowerCase()).slice(0, 64);
}

export function nearbyText(el: Element): string {
  const own = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const text = own || (el.parentElement?.innerText ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 500);
}

export const cleanText = (s: string) => s.replace(/\s+/g, ' ').trim();

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]';
/** Frappe destinée à l'hôte : champ, éditeur riche ou contrôle de saisie accessible. */
export const isEditable = (t: EventTarget | null) => !!(t as Element | null)?.closest?.(EDITABLE) || !!(t as HTMLElement | null)?.isContentEditable;

export const inRects = (range: Range, x: number, y: number) => [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);

/** Premier ancêtre affiché en bloc (paragraphe, titre, cellule…) : l'unité de texte d'un geste de correction. */
function blockOf(node: Node): Element | null {
  for (let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement; el && el !== el.ownerDocument.body; el = el.parentElement) {
    const display = el.ownerDocument.defaultView!.getComputedStyle(el).display;
    if (!display.startsWith('inline') && display !== 'contents') return el;
  }
  return null;
}

/**
 * Clic droit au pointeur qui vise la sélection vivante : sur ses rectangles, ou ailleurs dans le même bloc de texte (mot voisin).
 * La plage est relue à chaque geste : aucune sélection mémorisée, une plage détachée ne compte plus. Un lien ou un champ garde son menu natif.
 */
export function aimsAtSelection(range: Range, target: EventTarget | null, x: number, y: number): boolean {
  if (inRects(range, x, y)) return true;
  const el = target as Element | null;
  if (!range.startContainer.isConnected || !el?.closest || el.closest('a[href]') || isEditable(el)) return false;
  const block = blockOf(range.commonAncestorContainer);
  return block !== null && block === blockOf(el);
}

/** Sélection de texte admissible pour une correction : hors contrôles Socrate et champs éditables, 500 caractères au plus. */
export function admissibleRange(doc: Document): Range | null {
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  // Valeur saisie jamais lue : une sélection qui touche le champ actif garde le menu natif.
  const active = doc.activeElement;
  if (active?.closest(EDITABLE) && range.intersectsNode(active)) return null;
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el || el.closest(`${SOCRATE}, ${EDITABLE}`)) return null;
  const text = cleanText(range.toString());
  return text && text.length <= 500 ? range : null;
}

/** Première sélection admissible de l'onglet ou d'une iframe directe de même origine, avec son cadre. */
export function currentSelection(): { range: Range; frame: HTMLIFrameElement | null } | null {
  const top = admissibleRange(document);
  if (top) return { range: top, frame: null };
  for (const f of sameOriginFrames()) {
    const range = admissibleRange(f.contentDocument!);
    if (range) return { range, frame: f };
  }
  return null;
}

/** `probable` : retrouvée par son texte sur un autre déploiement, affichée comme position probable. */
export type Spot = { element: Element; frame: HTMLIFrameElement | null; probable?: boolean };
type Context = NonNullable<Target['context']>;

const sameRole = (el: Element, t: Target) => roleOf(el) === t.role && nearbyText(el) === t.text;

const DROPPED = 'script,style,iframe,object,embed,link,meta,template,noscript,svg,canvas,video,audio';
/** Bornes de la recherche répétée : au-delà, refus sans clonage. */
const MAX_CANDIDATES = 300;
const MAX_NODES = 64;
const MAX_CONTEXT_HTML = 1000;
const MAX_DEPTH = 3;

/**
 * Seul propriétaire de l'assainissement : balises actives et commentaires retirés, attributs réduits à une liste fermée, valeurs saisies jamais lues.
 * `emptyFields` vide aussi champs et éditeurs, avant le retrait de l'attribut `contenteditable` qui les signale.
 */
function sanitizedClone(el: Element, emptyFields = false): Element {
  const clone = el.cloneNode(true) as Element;
  if (emptyFields) for (const n of [clone, ...clone.querySelectorAll(EDITABLE)]) if (n.matches(EDITABLE)) n.replaceChildren();
  clone.querySelectorAll(DROPPED).forEach((n) => n.remove());
  const comments = el.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const dropped: Node[] = [];
  while (comments.nextNode()) dropped.push(comments.currentNode);
  dropped.forEach((n) => n.parentNode?.removeChild(n));
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const a of [...node.attributes]) if (!(HTML_ATTRIBUTES as readonly string[]).includes(a.name.toLowerCase())) node.removeAttribute(a.name);
  }
  return clone;
}

/** Extrait historique de la cible, tronqué à 4 000 caractères : format enregistré par `Target.html`, inchangé. */
export function sanitizedExcerpt(el: Element): string {
  let html = sanitizedClone(el).outerHTML.slice(0, 4000);
  while (html && !isSanitizedHtml(html)) html = html.slice(0, Math.max(0, html.lastIndexOf('<')));
  return html;
}

const small = (el: Element) => el.getElementsByTagName('*').length < MAX_NODES;
/** Sérialisation assainie complète d'un ancêtre borné, jamais tronquée, champs et éditeurs vidés ; null au-delà des bornes. */
function contextHtml(el: Element): string | null {
  if (!small(el)) return null;
  const html = sanitizedClone(el, true).outerHTML;
  return html.length <= MAX_CONTEXT_HTML ? html : null;
}

/** Ancêtre désigné par le chemin d'indices d'enfants, ou null si l'élément n'est pas à cette position. */
function ancestorAt(el: Element, path: readonly number[]): Element | null {
  let cur = el;
  for (let i = path.length - 1; i >= 0; i--) {
    const parent = cur.parentElement;
    if (!parent || parent.children[path[i]!] !== cur) return null;
    cur = parent;
  }
  return cur;
}

/** L'élément est au chemin enregistré sous un ancêtre dont la sérialisation complète est identique, hors surfaces Socrate. */
export function inContext(el: Element, c: Context): boolean {
  const a = ancestorAt(el, c.path);
  return !!a && !a.querySelector(SOCRATE) && contextHtml(a) === c.html;
}

/** Candidats de même structure : le sélecteur capturé sans ses positions, pour suivre une ligne déplacée. Null si invalide ou trop nombreux. */
function familyOf(doc: Document, selector: string): Element[] | null {
  try {
    const all = doc.querySelectorAll(selector.replace(/:nth-of-type\(\d+\)/g, ''));
    return all.length <= MAX_CANDIDATES ? [...all] : null;
  } catch {
    return null;
  }
}

/**
 * Contexte enregistré à la capture : le plus proche des trois ancêtres, assaini en entier dans les bornes, qui distingue la cible
 * parmi les candidats de même structure. Absent si aucun ne la distingue : la cible n'est alors pas durablement identifiée.
 */
export function contextOf(el: Element, selector: string): Target['context'] {
  const family = familyOf(el.ownerDocument, selector);
  if (!family?.includes(el)) return undefined;
  const path: number[] = [];
  let cur = el;
  for (let depth = 0; depth < MAX_DEPTH && cur.parentElement; depth++) {
    const parent: Element = cur.parentElement;
    path.unshift([...parent.children].indexOf(cur));
    cur = parent;
    // Les ancêtres suivants contiennent celui-ci : ils dépassent aussi les bornes ou contiennent aussi Socrate.
    const html = cur.querySelector(SOCRATE) ? null : contextHtml(cur);
    if (html === null) return undefined;
    const c = { html, path: [...path] };
    if (family.every((other) => other === el || !inContext(other, c))) return c;
  }
  return undefined;
}

/** Un seul candidat retenu, jamais le premier d'un ensemble. */
const only = (hits: Element[]) => (hits.length === 1 ? hits[0]! : null);

/** Texte propre : nœuds texte de l'élément hors balises retirées par l'assainissement, sans lecture du rendu. Même lecture pour l'extrait enregistré et pour un candidat. */
function ownText(root: Node): string {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : (n as Element).matches(DROPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP),
  });
  let text = '';
  while (walker.nextNode()) text += walker.currentNode.nodeValue;
  return text;
}

const MIN_TEXT = 12;
const MAX_TEXT = 500;
const references = new WeakMap<Target, string>();
/** Texte de référence d'une cible : texte propre de l'extrait enregistré au ciblage (`html`), espaces compactés, 500 caractères au plus ; jamais `text`, qui peut être une sélection ou le texte d'un parent. */
function referenceOf(t: Target): string {
  let text = references.get(t);
  if (text === undefined) {
    const parsed = document.createElement('template');
    parsed.innerHTML = t.html;
    text = cleanText(ownText(parsed.content)).slice(0, MAX_TEXT);
    references.set(t, text);
  }
  return text;
}

/** Lectures partagées par les fils d'une même passe (une tâche, sans mutation possible entre deux fils) ; oubliées à la microtâche suivante. */
let pass: { candidates: Map<Document, Map<string, Element[] | null>>; flat: Map<Element, string> } | null = null;
function currentPass() {
  if (!pass) {
    pass = { candidates: new Map(), flat: new Map() };
    queueMicrotask(() => { pass = null; });
  }
  return pass;
}

/**
 * Seul élément de même balise (celle qui ouvre l'extrait) et même rôle, hors Socrate, dont le texte propre commence par le texte de référence entier
 * (`referenceOf`, 12 caractères au moins : en deçà, un libellé comme « Modifier » n'identifie rien). Casse conservée : extrait et candidat sont lus
 * dans le DOM, hors CSS, une majuscule changée est une édition. Une cible sans texte propre n'est pas relocalisée.
 * Coût borné : au-delà de `MAX_CANDIDATES` éléments de même balise et même rôle, refus ; le texte propre n'est lu que sur ceux dont `textContent`,
 * sans espaces, contient la référence sans espaces. Les éléments masqués comptent pour l'ambiguïté, mais un candidat unique non rendu n'est pas retenu.
 */
function byText(doc: Document, t: Target): Element | null {
  const tag = /^<([\w-]+)/.exec(t.html)?.[1];
  const text = referenceOf(t);
  if (!tag || text.length < MIN_TEXT) return null;
  const p = currentPass();
  const key = `${tag}\n${t.role}`;
  const byDoc = p.candidates.get(doc) ?? p.candidates.set(doc, new Map()).get(doc)!;
  let same = byDoc.get(key);
  if (same === undefined) {
    const all = [...doc.getElementsByTagName(tag)].filter((el) => roleOf(el) === t.role);
    byDoc.set(key, same = all.length > MAX_CANDIDATES ? null : all.filter((el) => !isSocrate(el)));
  }
  if (!same) return null;
  const compact = text.replace(/\s/g, '');
  const flat = (el: Element) => p.flat.get(el) ?? p.flat.set(el, el.textContent!.replace(/\s/g, '')).get(el)!;
  const hit = only(same.filter((el) => flat(el).includes(compact) && cleanText(ownText(el)).startsWith(text)));
  return hit && hit.getClientRects().length > 0 && hit.checkVisibility({ visibilityProperty: true }) ? hit : null;
}

/**
 * Cible d'une pastille après navigation, remontage ou rechargement, sans élément vivant retenu :
 * même route et même cadre ; identifiant éditorial propre et unique ; sinon, sur le même déploiement seulement :
 * avec un contexte enregistré, un seul candidat de même structure au même chemin sous un ancêtre identique, sans repli ;
 * sans contexte (retour antérieur ou cible non distinguée), la règle historique, puis un seul candidat dont la sérialisation complète
 * égale l'extrait enregistré et que le sélecteur d'origine désigne encore : un jumeau ne reprend pas la pastille d'une cible supprimée.
 * Sur un autre déploiement, sans identifiant éditorial : un seul élément de même balise et même rôle dont le texte propre commence par le texte propre
 * entier de l'extrait enregistré (`byText`), rendu et rendu `probable` ; le sélecteur positionnel d'un autre build ne désigne plus rien de sûr.
 * Une cible issue d'une sélection (`selection`, fil portant une proposition) ou sans texte propre n'est jamais relocalisée ainsi.
 * L'appelant ne garde pas une position probable d'une mutation à l'autre : il la redemande, et un jumeau apparu la retire.
 * Tout autre cas rend null : aucune pastille n'est posée sur un élément arbitraire.
 */
export function findTarget(t: Target, sameDeployment: boolean, selection = false): Spot | null {
  let frame: HTMLIFrameElement | null = null;
  let doc = document;
  if (t.frame?.length) {
    if (t.hostRoute !== location.pathname) return null;
    const f = resolveSelector(document, t.frame[0]!);
    if (f.kind !== 'found' || f.element.tagName !== 'IFRAME') return null;
    frame = f.element as HTMLIFrameElement;
    try {
      if (!frame.contentDocument) return null;
      doc = frame.contentDocument;
    } catch {
      return null;
    }
  }
  if (doc.defaultView?.location.pathname !== t.route) return null;
  const own = OWN_EDITORIAL.exec(t.selector);
  if (own) {
    const r = resolveEditorial(doc, own[2] ? { id: own[1]!, instance: own[2] } : { id: own[1]! });
    return r.kind === 'found' ? { element: r.element, frame } : null;
  }
  if (!sameDeployment) {
    const hit = selection ? null : byText(doc, t);
    return hit && { element: hit, frame, probable: true };
  }
  const spot = (el: Element | null) => (el ? { element: el, frame } : null);
  const family = () => familyOf(doc, t.selector) ?? [];
  if (t.context) return spot(only(family().filter((el) => inContext(el, t.context!))));
  const r = resolveSelector(doc, t.selector);
  if (r.kind === 'found' && sameRole(r.element, t) && [...doc.getElementsByTagName(r.element.tagName)].filter((el) => sameRole(el, t)).length === 1) return spot(r.element);
  if (!t.html) return null;
  const hit = only(family().filter((el) => roleOf(el) === t.role && small(el) && sanitizedClone(el).outerHTML === t.html));
  return spot(hit && hit.matches(t.selector) ? hit : null);
}

/** Rectangle visible de la cible dans le référentiel de l'onglet, ou null si elle est hors vue, sans taille ou détachée. */
export function rectOf(s: Spot): DOMRect | null {
  if (!s.element.isConnected || (s.frame && (!s.frame.isConnected || s.frame.contentDocument !== s.element.ownerDocument))) return null;
  const r = s.element.getBoundingClientRect();
  const o = offsetOf(s.frame);
  const box = new DOMRect(r.x + o.x, r.y + o.y, r.width, r.height);
  const clip = s.frame?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
  const visible = box.width > 0 && box.height > 0 && box.bottom > Math.max(0, clip.top) && box.top < Math.min(innerHeight, clip.bottom) && box.right > Math.max(0, clip.left) && box.left < Math.min(innerWidth, clip.right);
  return visible ? box : null;
}

/** Laisse l'hôte rendre la route poussée par l'adaptateur de navigation, pendant un nombre borné de frames et sans observer le DOM. */
export async function afterNavigation<R extends { kind: string }>(cycle: { readonly alive: boolean }, resolve: () => R, frames = 30): Promise<R> {
  let r = resolve();
  for (let i = 0; i < frames && r.kind === 'missing' && cycle.alive; i++) {
    await new Promise((ok) => requestAnimationFrame(ok));
    r = resolve();
  }
  return r;
}

/** Écran d'une cible : la route de l'hôte pour une iframe, sinon la route du document ; inconnu pour une charge d'iframe antérieure sans route de l'hôte. */
export const screenOf = (t: Target): string | null => (t.frame?.length ? t.hostRoute ?? null : t.route);

/** Route enregistrée navigable par l'adaptateur : chemin absolu de la même origine, jamais une adresse extérieure. */
export function sameOriginRoute(route: string): boolean {
  try {
    return route.startsWith('/') && new URL(route, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}
