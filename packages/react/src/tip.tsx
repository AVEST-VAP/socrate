import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const HOVER_DELAY_MS = 400;
const GRACE_MS = 100;
const EDGE = 8;

/**
 * Infobulle partagée d'un document, l'hôte ou une iframe Socrate : texte de `data-socrate-tip` au survol (400 ms) et au focus clavier, jamais au toucher.
 * Survolable avec un délai de grâce, persistante tant que survol ou focus restent, masquée par Échap sans déplacer le focus, jamais focusable.
 * Le nom accessible reste porté par le bouton : l'infobulle n'ajoute qu'un rappel visuel, raccourci compris.
 */
export function Tip({ doc }: { doc: Document }) {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const win = doc.defaultView!;
    let hovered: Element | null = null;
    let focused: Element | null = null;
    let overTip = false;
    let timer = 0;
    const sync = () => {
      const el = [focused, hovered].find((e) => e?.isConnected) ?? null;
      setTip(el ? { text: el.getAttribute('data-socrate-tip')!, rect: el.getBoundingClientRect() } : null);
    };
    const later = (fn: () => void, ms: number) => {
      win.clearTimeout(timer);
      timer = win.setTimeout(fn, ms);
    };
    const ownerOf = (t: EventTarget | null) => (t as Element | null)?.closest?.('[data-socrate-tip]') ?? null;
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      if ((e.target as Element | null)?.closest?.('[data-socrate="tip"]')) {
        overTip = true;
        win.clearTimeout(timer);
        return;
      }
      overTip = false;
      const el = ownerOf(e.target);
      if (el === hovered) return win.clearTimeout(timer);
      if (el) later(() => { hovered = el; sync(); }, hovered ? 0 : HOVER_DELAY_MS);
      else if (hovered) later(() => { if (!overTip) { hovered = null; sync(); } }, GRACE_MS);
      else win.clearTimeout(timer);
    };
    const onFocus = (e: FocusEvent) => {
      const el = ownerOf(e.target);
      focused = el?.matches(':focus-visible') ? el : null;
      sync();
    };
    const onBlur = () => {
      focused = null;
      sync();
    };
    const clear = () => {
      win.clearTimeout(timer);
      if (!hovered && !focused) return false;
      hovered = focused = null;
      sync();
      return true;
    };
    // Premier Échap consommé quand une infobulle est affichée : il ne ferme ni un menu, ni la bulle, ni une modal de l'hôte.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !clear()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    win.addEventListener('pointerover', onOver, true);
    win.addEventListener('pointerdown', clear, true);
    win.addEventListener('scroll', clear, true);
    win.addEventListener('keydown', onKey, true);
    doc.addEventListener('focusin', onFocus, true);
    doc.addEventListener('focusout', onBlur, true);
    return () => {
      win.clearTimeout(timer);
      win.removeEventListener('pointerover', onOver, true);
      win.removeEventListener('pointerdown', clear, true);
      win.removeEventListener('scroll', clear, true);
      win.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', onFocus, true);
      doc.removeEventListener('focusout', onBlur, true);
    };
  }, [doc]);
  // Au-dessus du déclencheur, sinon dessous ; bornée aux bords du document après mesure.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const win = doc.defaultView!;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.max(EDGE, Math.min(tip.rect.left + tip.rect.width / 2 - width / 2, win.innerWidth - width - EDGE));
    const y = tip.rect.top - height - 6 >= EDGE ? tip.rect.top - height - 6 : tip.rect.bottom + 6;
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' });
  }, [tip, doc]);
  return tip && createPortal(<div ref={ref} data-socrate="tip" role="tooltip" style={{ visibility: 'hidden' }}>{tip.text}</div>, doc.body);
}
