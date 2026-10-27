import type { EditorialRef, Manifest, Marker, Target, Zone } from '@socrate/contract';
import type { NavigationAdapter } from './panel.tsx';
import { OWN_EDITORIAL, afterNavigation, resolveEditorial, resolveSelector, type Resolution } from './locate.ts';

export type { Resolution };

// Même clé que `editorialKey` du contrat, recopiée pour ne pas tirer zod dans ce chunk.
const editorialKey = (ref: EditorialRef) => (ref.instance ? `${ref.id}#${ref.instance}` : ref.id);

/** Vie d'un panneau affiché : fausse dès le masquage ou le démontage, après quoi aucune continuation de guidage ne touche le DOM. */
export type Cycle = { alive: boolean };

const LAYER = 'position:absolute;z-index:2147483002;font:12px system-ui,sans-serif;';
const KIND_LABEL: Record<Marker['kind'], string> = { new: 'Nouveau', changed: 'Modifié', review: 'Avis demandé' };

function place(doc: Document, node: HTMLElement, el: HTMLElement, style: (r: DOMRect, x: number, y: number) => string) {
  const r = el.getBoundingClientRect();
  const win = doc.defaultView!;
  node.style.cssText = LAYER + style(r, win.scrollX, win.scrollY);
  doc.body.append(node);
}

// Couche et contour appartiennent au cycle qui les a posés : un cycle ne libère jamais ceux du suivant.
let owner: Cycle | null = null;
let layer: MarkerLayer | null = null;
let highlight: HTMLElement | null = null;

const clearHighlight = (cycle: Cycle) => {
  if (owner !== cycle) return;
  highlight?.remove();
  highlight = null;
};

/** Libère repères, explication, contour et observation du cycle s'il les détient encore. */
export function release(cycle: Cycle | null): void {
  if (!cycle || owner !== cycle) return;
  layer?.stop();
  layer = null;
  clearHighlight(cycle);
  owner = null;
}

const claim = (cycle: Cycle) => {
  if (owner !== cycle) release(owner);
  owner = cycle;
};

/** Contour en position absolue dans le document : il suit le défilement sans écouteur. */
function showHighlight(cycle: Cycle, el: HTMLElement): void {
  claim(cycle);
  clearHighlight(cycle);
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const doc = el.ownerDocument;
  highlight = doc.createElement('div');
  highlight.dataset.socrate = 'highlight';
  place(doc, highlight, el, (r, x, y) => `pointer-events:none;left:${r.left + x - 4}px;top:${r.top + y - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;outline:3px solid #2a4fd6;border-radius:6px;`);
}

export type MarkerReport = { shown: string[]; missing: string[]; ambiguous: string[] };

/** Repères du mode « Voir les changements » : seule observation du DOM, active entre `start` et `stop`. */
export class MarkerLayer {
  private observer: MutationObserver | null = null;
  private nodes: HTMLElement[] = [];
  private frame = 0;
  private open: string | null = null;

  private readonly doc: Document;
  private readonly markers: Marker[];
  private readonly onReport: (r: MarkerReport) => void;

  constructor(doc: Document, markers: Marker[], onReport: (r: MarkerReport) => void) {
    this.doc = doc;
    this.markers = markers;
    this.onReport = onReport;
  }

  start(): void {
    if (this.observer) return;
    this.render();
    this.observer = new MutationObserver((records) => {
      if (records.every((r) => [...r.addedNodes, ...r.removedNodes].every((n) => n instanceof HTMLElement && n.dataset.socrate !== undefined))) return;
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.render());
    });
    this.observer.observe(this.doc.body, { childList: true, subtree: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    cancelAnimationFrame(this.frame);
    this.clear();
  }

  private clear(): void {
    for (const n of this.nodes) n.remove();
    this.nodes = [];
  }

  private render(): void {
    this.clear();
    const report: MarkerReport = { shown: [], missing: [], ambiguous: [] };
    for (const m of this.markers) {
      const key = editorialKey(m.target);
      const r = resolveEditorial(this.doc, m.target);
      if (r.kind !== 'found') {
        report[r.kind].push(key);
        continue;
      }
      report.shown.push(key);
      const badge = this.doc.createElement('button');
      badge.type = 'button';
      badge.dataset.socrate = 'marker';
      badge.dataset.marker = key;
      badge.dataset.kind = m.kind;
      badge.textContent = KIND_LABEL[m.kind];
      badge.setAttribute('aria-expanded', String(this.open === key));
      // Le lanceur intercepte le clic en capture et relaie cet événement : l'hôte ne voit aucun geste.
      badge.addEventListener('socrate-marker', () => {
        this.open = this.open === key ? null : key;
        this.render();
      });
      // Au-dessus du coin gauche : un élément pleine largeur garde son repère hors du panneau posé à droite.
      place(this.doc, badge, r.element, (rect, x, y) => `left:${rect.left + x}px;top:${rect.top + y}px;transform:translateY(-100%);padding:2px 8px;border-radius:10px;border:1px solid #2a4fd6;background:#fff;color:#2a4fd6;cursor:pointer;`);
      this.nodes.push(badge);
      if (this.open === key) {
        const note = this.doc.createElement('p');
        note.dataset.socrate = 'marker-note';
        note.setAttribute('role', 'note');
        note.textContent = m.explanation;
        place(this.doc, note, r.element, (rect, x, y) => `left:${rect.left + x}px;top:${rect.top + y + 16}px;max-width:320px;margin:0;padding:6px 10px;border-radius:6px;background:#1d2b5c;color:#fff;`);
        this.nodes.push(note);
      }
    }
    this.onReport(report);
  }
}

export const describeMarkers = (r: MarkerReport) =>
  `${r.shown.length} repère(s) affiché(s)${r.missing.length ? `, ${r.missing.length} absent(s) de cette page` : ''}${r.ambiguous.length ? `, ${r.ambiguous.length} ambigu(s) non rattaché(s)` : ''}.`;

/** Navigue par l'adaptateur de l'hôte puis met en évidence la cible si elle est seule à l'écran ; n'ouvre ni ne remplit rien. */
export async function followZone(cycle: Cycle, zone: Zone, navigation: NavigationAdapter): Promise<string | null> {
  if (!cycle.alive) return null;
  navigation.go(zone.route);
  clearHighlight(cycle);
  const r: Resolution = zone.target ? await afterNavigation(cycle, () => resolveEditorial(document, zone.target!)) : { kind: 'missing' };
  if (!cycle.alive) return null;
  if (r.kind === 'found') showHighlight(cycle, r.element);
  const rest = zone.instructions ?? 'Poursuivez la manipulation décrite par la zone.';
  return r.kind === 'found' ? 'Élément mis en évidence dans l’application.' : r.kind === 'ambiguous' ? `Plusieurs éléments correspondent : aucun n’est mis en évidence. ${rest}` : `Élément absent de l’écran. ${rest}`;
}

/** Localise la cible dans l'écran courant ; `onResult` reçoit faux quand elle n'y est pas confirmée (absente, ambiguë ou seulement indicative). */
export async function locateTarget(cycle: Cycle, t: Target, navigation: NavigationAdapter, onResult?: (found: boolean) => void) {
  if (!cycle.alive) return null;
  const framed = !!t.frame?.length;
  // Une cible d'iframe navigue l'hôte par sa propre route ; une charge antérieure sans elle n'est pas devinée : l'écran courant seul est examiné.
  const route = framed ? t.hostRoute : t.route;
  if (route) navigation.go(route);
  clearHighlight(cycle);
  const own = OWN_EDITORIAL.exec(t.selector);
  const inDoc = (d: Document) => (own ? resolveEditorial(d, own[2] ? { id: own[1]!, instance: own[2] } : { id: own[1]! }) : resolveSelector(d, t.selector));
  let frame: Resolution | null = null;
  const r = await afterNavigation<Resolution>(cycle, () => {
    if (!framed) return inDoc(document);
    frame = resolveSelector(document, t.frame![0]!);
    const d = frame.kind === 'found' ? (frame.element as HTMLIFrameElement).contentDocument : null;
    return frame.kind === 'ambiguous' ? frame : d ? inDoc(d) : { kind: 'missing' };
  });
  if (!cycle.alive) return null;
  const kind = r.kind === 'found' && !own ? 'indicative' : r.kind;
  if (r.kind === 'found' && own) showHighlight(cycle, r.element);
  const where = (frame as Resolution | null)?.kind === 'ambiguous' ? 'Plusieurs cadres correspondent à celui de la cible : elle n’est rattachée à aucun.'
    : (frame as Resolution | null)?.kind === 'missing' ? 'Cadre de la cible absent de cet écran.' : null;
  const text = where ?? (kind === 'found' ? 'Cible mise en évidence.'
    : kind === 'indicative' ? 'Position indicative non confirmée : la cible n’a pas d’identifiant éditorial propre, aucun élément n’est mis en évidence. Route, image et contexte d’origine font foi.'
    : kind === 'ambiguous' ? 'Cible ambiguë sur ce déploiement : elle n’est rattachée à aucun élément.' : 'Cible non localisable sur ce déploiement. Le retour et son image d’origine restent valables.');
  onResult?.(kind === 'found');
  const legacy = framed && !t.hostRoute ? ' Retour antérieur sans route de l’hôte : seul l’écran courant est examiné.' : '';
  return <p className="socrate-meta" role="status" data-testid="socrate-locate" data-resolution={kind}>{text}{legacy}</p>;
}

export function OriginView({ manifest: m }: { manifest: Manifest }) {
  return (
    <div className="socrate-meta" data-testid="socrate-origin">
      <p><strong>Avant.</strong> {m.before}</p>
      <p><strong>Maintenant.</strong> {m.now}</p>
      <ul>{m.zones.map((z) => <li key={z.id}>{z.title}{z.instructions && ` : ${z.instructions}`}</li>)}</ul>
    </div>
  );
}

/** Une seule couche par document : le second appel du même cycle retire repères et observation, `null` signale la sortie du mode. */
export function toggleMarkers(cycle: Cycle, m: Manifest, onText: (text: string | null) => void): void {
  if (!cycle.alive) return;
  if (layer && owner === cycle) {
    release(cycle);
    onText(null);
    return;
  }
  claim(cycle);
  layer = new MarkerLayer(document, m.zones.flatMap((z) => z.markers ?? []), (r) => onText(describeMarkers(r)));
  layer.start();
}
