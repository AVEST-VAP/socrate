import { isSocrate, sameOriginFrames } from './locate.ts';

// Dans le chunk de la racine : l'activation qui ouvre une fenêtre précède toujours le premier « Commenter ». Le tri se fait au ciblage (`openerOf`).

/** Cibles des derniers appuis de pointeur, Entrée et Espace rendus à l'hôte, la plus récente d'abord ; références faibles, rien n'est retenu d'un nœud retiré. */
export const activations: WeakRef<EventTarget>[] = [];
const note = (e: Event) => {
  const key = (e as KeyboardEvent).key;
  if (key && key !== 'Enter' && key !== ' ') return;
  activations.unshift(new WeakRef(e.target!));
  activations.splice(16);
};

/**
 * Écoute en capture sur le document de l'onglet et de chaque iframe directe de même origine, rattachée à son chargement.
 * Pendant le ciblage, l'interception de la capture arrête ces gestes avant le document : seuls les gestes rendus à l'hôte sont relevés.
 */
export function recordActivations(): () => void {
  let docs: WeakRef<Document>[] = [];
  const attach = (doc?: Document | null) => {
    if (!doc || docs.some((r) => r.deref() === doc)) return;
    // Documents d'iframes rechargées oubliés au passage.
    docs = [...docs.filter((r) => r.deref()), new WeakRef(doc)];
    for (const t of ['pointerdown', 'keydown']) doc.addEventListener(t, note, true);
  };
  const onLoad = (e: Event) => {
    try { if ((e.target as Element).tagName === 'IFRAME' && !isSocrate(e.target)) attach((e.target as HTMLIFrameElement).contentDocument); } catch { /* autre origine : rien à écouter */ }
  };
  attach(document);
  for (const f of sameOriginFrames()) attach(f.contentDocument);
  document.addEventListener('load', onLoad, true);
  return () => {
    document.removeEventListener('load', onLoad, true);
    for (const r of docs) for (const t of ['pointerdown', 'keydown']) r.deref()?.removeEventListener(t, note, true);
  };
}
