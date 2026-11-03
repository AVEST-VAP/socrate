import type { Target } from '@socrate/contract';
import { activations } from './activation.ts';
import { cleanText, isSocrate, roleOf } from './locate.ts';

// Hors du chunk de la racine : seuls la capture, les vues de capture et le retour vers une fenêtre en ont besoin.

/** Libellés qui nomment le composant et non son contenu, comparés sans casse, accents ni ponctuation. */
const GENERIC_LABELS = new Set(['dialog', 'dialogue', 'dialog box', 'dialogue box', 'alert dialog', 'alertdialog', 'modal', 'modale', 'modal dialog', 'modal window', 'boite de dialogue', 'fenetre', 'fenetre modale', 'window', 'drawer', 'tiroir', 'panel', 'side panel', 'panneau', 'panneau lateral', 'sidebar', 'sheet', 'side sheet', 'popup', 'pop up', 'popin', 'pop in', 'popover', 'pop over', 'overlay', 'title', 'titre', 'untitled', 'sans titre']);
export const isGenericLabel = (label: string) => GENERIC_LABELS.has(label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());

/** Nom lisible du conteneur d'une cible ; un libellé générique enregistré par une version antérieure vaut absence de nom. */
export const containerLabel = (t: Target) => (t.container?.label && !isGenericLabel(t.container.label) ? t.container.label : null);
/** Consigne d'ouverture du conteneur, ou null si la cible n'était dans aucun (ou pour un retour antérieur à ce relevé). */
export function openContainerHint(t: Target): string | null {
  if (!t.container) return null;
  const label = containerLabel(t);
  return label ? `C’était dans la fenêtre « ${label} ». Ouvrez-la pour retrouver l’élément.` : 'C’était dans une fenêtre ou un panneau. Ouvrez-le pour retrouver l’élément.';
}

/** Texte d'une ligne : espaces compactés, caractères de contrôle retirés. */
export const oneLine = (s: string) => cleanText(cleanText(s).replace(/\p{C}/gu, ''));
/** Coupure par points de code, jamais au milieu d'une paire de substitution ; `max` unités UTF-16 au plus, points de suspension compris. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = '';
  for (const c of text) {
    if (cut.length + c.length > max - 1) break;
    cut += c;
  }
  return `${cut}…`;
}

/** Contrôle dont l'activation peut ouvrir une fenêtre ; `data-socrate-opener` le désigne explicitement. */
const INTERACTIVE = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [data-socrate-opener]';
type Opener = NonNullable<NonNullable<Target['container']>['opener']>;
/** Même règle que `OPENER_KEY` du contrat, recopiée pour ne pas tirer zod dans ce chunk. */
const OPENER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Nom accessible simplifié d'un déclencheur : `aria-labelledby`, `aria-label`, texte, `title`, le premier non vide, sans lecture du rendu ; 80 unités au plus. */
export function openerName(el: Element): string {
  const by = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
  return clip([by, el.getAttribute('aria-label'), el.textContent, el.getAttribute('title')].map((s) => oneLine(s ?? '')).find(Boolean) ?? '', 80);
}

/**
 * Contrôle qui a ouvert le conteneur `box`, hors de lui et hors Socrate : l'unique `[aria-controls~=id]` (Base UI, Radix),
 * le plus récemment activé de plusieurs, sinon la dernière activation du document de la cible survenue hors du conteneur.
 */
export function openerOf(box: Element, selectorOf: (el: Element) => string): Opener | undefined {
  const doc = box.ownerDocument;
  const outside = (el: Element) => !box.contains(el) && !isSocrate(el);
  const recent = activations.map((r) => (r.deref() as Element | undefined)?.closest?.(INTERACTIVE)).filter((el): el is Element => !!el?.isConnected && el.ownerDocument === doc && outside(el));
  const controls = box.id ? [...doc.querySelectorAll(`[aria-controls~="${CSS.escape(box.id)}"]`)].filter(outside) : [];
  const el = (controls.length === 1 ? controls[0] : recent.find((a) => controls.includes(a))) ?? recent[0];
  if (!el) return undefined;
  const name = openerName(el);
  const selector = selectorOf(el);
  const id = el.getAttribute('data-socrate-id');
  const key = el.getAttribute('data-socrate-opener');
  return {
    role: roleOf(el), ...(name && { name }), ...(selector && { selector }),
    ...(id && id.length <= 128 && id === oneLine(id) && { socrateId: id }), ...(key && OPENER_KEY.test(key) && { key }),
  };
}
