import type { Target } from '@socrate/contract';

// Hors du chunk de la racine : seuls la capture et les vues de capture en ont besoin.

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
