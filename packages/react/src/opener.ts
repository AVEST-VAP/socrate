import type { Target } from '@socrate/contract';
import { openContainerHint, openerName } from './container.ts';
import { docOf, isSocrate, resolveEditorial, resolveSelector, roleOf, type Resolution } from './locate.ts';

// Chargé par « Voir sur la page » seulement, quand la cible d'une fenêtre est absente.

const shown = (el: Element) => el.getClientRects().length > 0 && el.checkVisibility({ visibilityProperty: true });
const unique = (r: Resolution) => (r.kind === 'found' && !isSocrate(r.element) && shown(r.element) ? r.element : null);

/**
 * Déclencheur enregistré retrouvé sur la page de la cible : clé `data-socrate-opener`, puis identifiant éditorial, puis sélecteur
 * dont l'élément garde le rôle et le nom accessible enregistrés ; chaque fois une seule correspondance, rendue. `marked` : il porte encore la clé enregistrée.
 */
function findOpener(t: Target): { element: HTMLElement; marked: boolean } | null {
  const o = t.container?.opener;
  const doc = o && docOf(t)?.doc;
  if (!o || !doc) return null;
  let el = o.key ? unique(resolveSelector(doc, `[data-socrate-opener="${CSS.escape(o.key)}"]`)) : null;
  if (!el && o.socrateId) el = unique(resolveEditorial(doc, { id: o.socrateId }));
  if (!el && o.selector && o.name) {
    const r = unique(resolveSelector(doc, o.selector));
    el = r && roleOf(r) === o.role && openerName(r) === o.name ? r : null;
  }
  return el && { element: el, marked: !!o.key && el.getAttribute('data-socrate-opener') === o.key };
}

/** Consigne posée avec le repère du déclencheur. */
const openerHint = (t: Target) => (t.container?.opener?.name ? `Ouvrez « ${t.container.opener.name} » pour retrouver l’élément.` : 'Ouvrez le contrôle signalé pour retrouver l’élément.');

/**
 * Repère sur un déclencheur non marqué, jamais cliqué par Socrate : défilement jusqu'à lui, cadre sans interaction qui suit défilement et redimensionnement.
 * À son activation par la personne, le repère disparaît et `onActivate` est appelé. Rend la libération, idempotente ; un déclencheur retiré la déclenche.
 */
function markOpener(el: HTMLElement, onActivate: () => void): () => void {
  const doc = el.ownerDocument;
  const win = doc.defaultView!;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const mark = doc.createElement('div');
  mark.dataset.socrate = 'opener';
  mark.setAttribute('aria-hidden', 'true');
  const place = () => {
    if (!el.isConnected) return stop();
    const r = el.getBoundingClientRect();
    mark.style.cssText = `all:initial;position:fixed;z-index:2147483001;pointer-events:none;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;box-sizing:border-box;border:3px solid #2a4fd6;border-radius:6px;box-shadow:0 0 0 4px rgb(42 79 214 / .2)`;
  };
  const onClick = (e: Event) => {
    if (!el.contains(e.target as Node)) return;
    stop();
    onActivate();
  };
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    mark.remove();
    win.removeEventListener('scroll', place, true);
    win.removeEventListener('resize', place);
    doc.removeEventListener('click', onClick, true);
  }
  doc.body.append(mark);
  place();
  win.addEventListener('scroll', place, true);
  win.addEventListener('resize', place);
  doc.addEventListener('click', onClick, true);
  return stop;
}

/**
 * Chemin vers la fenêtre fermée d'une cible absente. Déclencheur marqué : cliqué, puis la cible attendue par `locate`.
 * Non marqué : signalé (`stop` le libère) ; quand la personne l'active et que la cible apparaît, `onFound` la reçoit.
 * Introuvable, ou cible toujours absente après le clic : la consigne d'ouverture de la fenêtre.
 */
export async function reopen<R extends { kind: string }>(t: Target, locate: () => Promise<R>, onFound: (r: R) => void): Promise<{ r: R | null; hint: string | null; stop: (() => void) | null }> {
  const found = findOpener(t);
  if (found?.marked) {
    found.element.click();
    const r = await locate();
    return { r, hint: r.kind === 'found' ? null : openContainerHint(t), stop: null };
  }
  if (!found) return { r: null, hint: openContainerHint(t), stop: null };
  return { r: null, hint: openerHint(t), stop: markOpener(found.element, () => void locate().then((r) => { if (r.kind === 'found') onFound(r); })) };
}
