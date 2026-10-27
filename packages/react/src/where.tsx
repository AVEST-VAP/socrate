import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Target, ThreadWithMessages } from '@socrate/contract';
import type { ReviewClient } from './client.ts';
import { ICON } from './conversation.tsx';

// Styles de cette vue, dans son chunk : le panneau chargé à l'arrivée n'en porte rien.
const WHERE_CSS = `
.socrate-where canvas { display: block; max-width: 100%; height: auto; margin: 8px 0; border: 1px solid #e4e4e7; border-radius: 8px; }
.socrate-where dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; margin: 8px 0; }
.socrate-where dd { margin: 0; overflow-wrap: anywhere; }
.socrate-where pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; background: #f4f4f5; border-radius: 6px; padding: 8px; margin: 0; }
`;

/** Contexte laissé autour de la cible dans la vue recadrée, en pixels CSS de la page capturée. */
const MARGIN = 96;
const FRAME_COLOR = '#f5a623';

type Box = { x: number; y: number; width: number; height: number };
/**
 * Zone de l'image à afficher et cadre de la cible, en pixels de l'image.
 * Le rectangle et le viewport enregistrés sont en pixels CSS, relatifs à la fenêtre (`getBoundingClientRect`) : l'image est cette fenêtre au moment du ciblage,
 * défilement compris, donc aucun décalage de défilement ne s'ajoute. L'échelle est celle de l'image (largeur de l'image sur largeur du viewport),
 * égale à `devicePixelRatio` pour une capture à pleine résolution, qui sert de repli.
 */
export function cropOf(t: Target, image: { width: number; height: number }, whole: boolean): { crop: Box; frame: Box; scale: number } {
  const scale = image.width / t.viewport.width || t.viewport.devicePixelRatio;
  const vw = image.width / scale;
  const vh = image.height / scale;
  const r = t.rect;
  const css = whole ? { x: 0, y: 0, width: vw, height: vh } : (() => {
    const x = Math.max(0, Math.min(vw, r.x - MARGIN));
    const y = Math.max(0, Math.min(vh, r.y - MARGIN));
    return { x, y, width: Math.max(1, Math.min(vw, r.x + r.width + MARGIN) - x), height: Math.max(1, Math.min(vh, r.y + r.height + MARGIN) - y) };
  })();
  const px = (b: Box): Box => ({ x: Math.round(b.x * scale), y: Math.round(b.y * scale), width: Math.round(b.width * scale), height: Math.round(b.height * scale) });
  const crop = px(css);
  const box = px({ x: r.x - css.x, y: r.y - css.y, width: r.width, height: r.height });
  return { crop: { ...crop, width: Math.min(crop.width, image.width - crop.x), height: Math.min(crop.height, image.height - crop.y) }, frame: box, scale };
}

/** Image recadrée (ou entière) dessinée à la résolution de la capture, cible encadrée. */
function Shot({ bitmap, target, whole }: { bitmap: ImageBitmap; target: Target; whole: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { crop, frame, scale } = cropOf(target, bitmap, whole);
  useEffect(() => {
    const canvas = ref.current!;
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    // Trait d'au moins 3 pixels CSS de la page, et visible une fois l'image entière réduite à la largeur du panneau.
    const line = Math.max(3 * scale, crop.width / 120);
    ctx.lineWidth = line;
    ctx.strokeStyle = FRAME_COLOR;
    ctx.strokeRect(frame.x - line / 2, frame.y - line / 2, frame.width + line, frame.height + line);
  }, [bitmap, crop.x, crop.y, crop.width, crop.height, frame.x, frame.y, frame.width, frame.height, scale]);
  const label = whole ? 'Capture entière prise au ciblage, cible encadrée' : 'Capture prise au ciblage, recadrée autour de la cible encadrée';
  return <canvas ref={ref} role="img" aria-label={label} data-testid="socrate-where-image" data-whole={whole || undefined}
    data-crop={[crop.x, crop.y, crop.width, crop.height].join(',')} data-frame={[frame.x, frame.y, frame.width, frame.height].join(',')} data-scale={scale} />;
}

type Image = { kind: 'loading' } | { kind: 'ready'; bitmap: ImageBitmap } | { kind: 'none'; why: string };

/**
 * « Voir où c’était » : la capture automatique du fil, recadrée et encadrée sur la cible, quand celle-ci n'est pas retrouvée avec certitude sur l'écran courant.
 * Une cible enregistrée dans une fenêtre ou un panneau le dit ; un retour antérieur sans ce relevé n'en dit rien. Sans image, la route, le texte et l'extrait.
 * `onRetry` relance la recherche (après l'ouverture d'une fenêtre, par exemple) ; absent, la vue ne propose pas Réessayer et n'y renvoie pas.
 * `sameDeployment` : sur le déploiement du retour, l'élément est seulement absent de l'écran ; sur un autre, la page a changé. Chargée à la demande.
 */
export function WhereView({ thread, client, sameDeployment, onBack, onClose, onRetry, headingRef }: {
  thread: ThreadWithMessages; client: ReviewClient; sameDeployment: boolean; onBack?: () => void; onClose?: () => void; onRetry?: () => Promise<boolean>; headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const t = thread.target!;
  const capture = thread.capture;
  const [image, setImage] = useState<Image>(capture ? { kind: 'loading' } : { kind: 'none', why: 'Ce retour n’a pas de capture : voici ce qui a été enregistré.' });
  const [whole, setWhole] = useState(false);
  const [retry, setRetry] = useState<'idle' | 'busy' | 'missed'>('idle');
  useEffect(() => {
    headingRef?.current?.focus();
    if (!capture) return;
    let bitmap: ImageBitmap | null = null;
    let live = true;
    client.captureBlob(capture.captureId).then((b) => createImageBitmap(b)).then((b) => {
      bitmap = b;
      if (live) setImage({ kind: 'ready', bitmap: b });
      else b.close();
    }, (e: Error) => live && setImage({ kind: 'none', why: `La capture n’a pas pu être chargée (${e.message}) : voici ce qui a été enregistré.` }));
    return () => {
      live = false;
      bitmap?.close();
    };
  }, [client, capture?.captureId]);
  const again = async () => {
    if (retry === 'busy') return;
    setRetry('busy');
    if (!(await onRetry!())) setRetry('missed');
  };
  const then = onRetry ? ', puis cliquez sur Réessayer.' : ' pour retrouver l’élément.';
  const container = t.container && (t.container.label ? `C’était dans la fenêtre « ${t.container.label} ». Ouvrez-la${then}` : `C’était dans une fenêtre ou un panneau. Ouvrez-le${then}`);
  return (
    <div className="socrate-panel socrate-where" data-testid="socrate-where" data-thread={thread.threadId} onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented && onClose) onClose(); }}>
      <style>{WHERE_CSS}</style>
      {onBack && (
        <div className="socrate-list-head">
          <div className="socrate-list-title">
            <button type="button" className="socrate-icon" aria-label="Retour aux conversations" data-socrate-tip="Retour aux conversations" onClick={onBack}>{ICON.list}</button>
            <h1 ref={headingRef} tabIndex={-1}>Où c’était</h1>
            {onClose && <button type="button" className="socrate-icon" aria-label="Fermer" data-socrate-tip="Fermer · Échap" onClick={onClose}>{ICON.close}</button>}
          </div>
        </div>
      )}
      <div className="socrate-body">
        <p data-testid="socrate-where-why">{sameDeployment
          ? 'L’élément n’est pas affiché sur cet écran pour le moment (fenêtre fermée, onglet, données différentes). Voici où il était quand le retour a été écrit.'
          : 'Cette version de la page a changé : l’élément n’est pas retrouvé avec certitude. Voici où il était quand le retour a été écrit.'}</p>
        {container && <p className="socrate-status" data-testid="socrate-where-container">{container}</p>}
        {image.kind === 'loading' && <p className="socrate-meta" role="status">Chargement de la capture…</p>}
        {image.kind === 'ready' && <Shot bitmap={image.bitmap} target={t} whole={whole} />}
        {image.kind === 'none' && <p className="socrate-meta" data-testid="socrate-where-none">{image.why}</p>}
        <div className="socrate-actions">
          {image.kind === 'ready' && <button type="button" className="socrate-button secondary" onClick={() => setWhole((w) => !w)}>{whole ? 'Voir la zone de la cible' : 'Voir la capture entière'}</button>}
          {onRetry && <button type="button" className="socrate-button secondary" aria-disabled={retry === 'busy'} onClick={() => void again()}>Réessayer</button>}
        </div>
        {retry === 'busy' && <p className="socrate-meta" role="status">Recherche de l’élément…</p>}
        {retry === 'missed' && <p className="socrate-status" role="status" data-testid="socrate-where-missed">Toujours pas retrouvé sur cet écran.</p>}
        <dl className="socrate-meta">
          <dt>Page</dt><dd>{t.hostRoute ?? t.route}</dd>
          {t.text && <><dt>Texte ciblé</dt><dd>« {t.text} »</dd></>}
        </dl>
        {image.kind === 'none' && t.html && <pre data-testid="socrate-where-html">{t.html}</pre>}
      </div>
    </div>
  );
}
