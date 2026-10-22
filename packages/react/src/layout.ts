/** Calculs purs de présentation : placement de la bulle, regroupement des pastilles, initiales, couleurs et dates. */

export type Box = { x: number; y: number; width: number; height: number };
const GAP = 8;
const EDGE = 8;
/** Hauteur réservée à la toolbar en bas de fenêtre. */
const TOOLBAR = 72;
const POINT_GAP = 12;

/**
 * Ancre ponctuelle (largeur et hauteur nulles, point du clic) : sous le point puis au-dessus, décalée de 20 px vers la gauche.
 * Ancre rectangulaire : à droite, puis à gauche, dessous, dessus. Toujours à 8 px des bords, jamais dans la bande de la toolbar.
 * Sous 520 px de large, feuille en bas d'écran.
 */
export function place(a: Box, size: { width: number; height: number }, view: { width: number; height: number }): { x: number; y: number; sheet: boolean } {
  if (view.width < 520) return { x: EDGE, y: Math.max(EDGE, view.height - size.height - TOOLBAR), sheet: true };
  const bottom = view.height - TOOLBAR;
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, view.width - size.width - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, bottom - size.height));
  const fitsX = (x: number) => x >= EDGE && x + size.width <= view.width - EDGE;
  const fitsY = (y: number) => y >= EDGE && y + size.height <= bottom;
  if (a.width === 0 && a.height === 0) {
    const under = a.y + POINT_GAP;
    const over = a.y - POINT_GAP - size.height;
    return { x: clampX(a.x - 20), y: fitsY(under) ? under : fitsY(over) ? over : clampY(under), sheet: false };
  }
  const right = a.x + a.width + GAP;
  const left = a.x - GAP - size.width;
  const below = a.y + a.height + GAP;
  const above = a.y - GAP - size.height;
  if (fitsX(right)) return { x: right, y: clampY(a.y), sheet: false };
  if (fitsX(left)) return { x: left, y: clampY(a.y), sheet: false };
  if (fitsY(below)) return { x: clampX(a.x), y: below, sheet: false };
  if (fitsY(above)) return { x: clampX(a.x), y: above, sheet: false };
  return { x: clampX(a.x + a.width - size.width), y: clampY(a.y + a.height - size.height), sheet: false };
}

/** Regroupe les points à moins de `radius` px du premier point de chaque groupe, dans l'ordre reçu. */
export function cluster<T extends { x: number; y: number }>(points: T[], radius = 20): T[][] {
  const groups: T[][] = [];
  for (const p of points) {
    const g = groups.find((g) => Math.hypot(g[0]!.x - p.x, g[0]!.y - p.y) < radius);
    if (g) g.push(p);
    else groups.push([p]);
  }
  return groups;
}

/** Couleurs d'auteur, blanc à 4,5:1 au moins sur chacune. Deux auteurs peuvent la partager : l'initiale et le nom les distinguent. */
export const AUTHOR_COLORS = ['#7A3FD1', '#B0306A', '#0F766E', '#A15C07', '#4D7C0F', '#9F3A2A'] as const;

/** Couleur stable dérivée de la clé de l'acteur vérifié, jamais d'une présence. */
export function colorOf(actorKey: string): string {
  // FNV-1a 32 bits : répartition stable et dispersée sur six couleurs.
  let h = 0x811c9dc5;
  for (const c of actorKey) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length]!;
}

export function initialsOf(displayName: string): string {
  return displayName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]!.toLocaleUpperCase('fr')).join('') || '?';
}

const RTF = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];

export function relativeDate(iso: string, now = Date.now()): string {
  const s = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, n] of UNITS) if (Math.abs(s) >= n) return RTF.format(Math.round(s / n), unit);
  return 'à l’instant';
}

/** Liste latérale : 380 px par défaut, au moins 320, au plus 960 en laissant 280 px à l'application et à sa toolbar ; sous 600 px de fenêtre, elle couvre la page. */
export const LIST_DEFAULT = 380;
export const LIST_WIDE = 600;
export const listBounds = (view: number) => ({ min: 320, max: Math.max(320, Math.min(960, view - 280)) });
export function listWidthOf(pref: number, view: number): number {
  const { min, max } = listBounds(view);
  return Math.round(Math.min(max, Math.max(min, pref)));
}
