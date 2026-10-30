import { useEffect, useState } from 'react';
import { ATTACHMENT_TYPES, MAX_ATTACHMENTS, MAX_ATTACHMENT_NAME, SIGNATURE_BYTES, isAttachmentType, safeName, sha256Hex, signatureMatches, type Attachment, type AttachmentType } from '@socrate/contract';
import type { Converting, DraftAttachment, ReviewClient } from './client.ts';

// Pièces jointes humaines : préparation locale, aperçu avant envoi et lecture protégée, chargées au premier usage, jamais à l'ouverture.

// Styles de cette vue, dans son chunk : le panneau chargé à l'arrivée n'en porte rien.
const MEDIA_CSS = `
.socrate-tray { padding: 2px 6px 4px; }
.socrate-tray ul, .socrate-media { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.socrate-tray > p { margin: 6px 4px 0; }
.socrate-chip { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 4px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; }
.socrate-chip-preview { width: 32px; height: 32px; flex-shrink: 0; display: grid; place-items: center; overflow: hidden; border-radius: 6px; background: #f4f4f5; color: #71717a; }
.socrate-chip-preview img, .socrate-chip-preview video { width: 100%; height: 100%; object-fit: cover; }
.socrate-chip-text { min-width: 0; flex: 1; display: grid; }
.socrate-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; font-weight: 500; }
.socrate-media { margin-top: 8px; }
.socrate-media-item { display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.socrate-media-item img, .socrate-media-item video { display: block; width: 100%; max-height: 220px; object-fit: contain; border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; }
.socrate-media-load { display: flex; align-items: center; gap: 8px; padding: 0 12px; min-height: 40px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fff; font-size: 13px; cursor: pointer; }
.socrate-media-load:hover { background: #f4f4f5; }
`;

const FORMATS = 'PNG, JPEG ou WebP jusqu’à 10 Mio, MP4 ou WebM jusqu’à 50 Mio, sinon 15 min';
const isVideo = (t: AttachmentType) => ATTACHMENT_TYPES[t].media === 'video';

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} Kio`;
  return `${(n / (1024 * 1024)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mio`;
}

type Piece = { blob: Blob; type: AttachmentType; name: string };

/**
 * Vérifie et prépare les fichiers choisis, un à un. Un MOV, ou un MP4 ou WebM au-delà de 50 Mio, est d'abord converti ; `onConverting`
 * suit cette conversion, que son `cancel` abandonne sans refus et sans toucher aux fichiers suivants. Le fichier produit, ou le fichier
 * d'origine, passe ensuite les mêmes contrôles : format admis, taille dans sa borne, signature des premiers octets et empreinte SHA-256
 * que le service revérifie. Chaque pièce prête est remise aussitôt à `onReady` ; `signal` arrête tout. Rend les refus, avec leur raison.
 */
export async function prepareFiles(files: File[], count: () => number, signal: AbortSignal, onConverting: (c: Converting | null) => void, onReady: (a: DraftAttachment) => void): Promise<string[]> {
  const refused: string[] = [];
  for (const file of files) {
    if (signal.aborted) break;
    const original = safeName(file.name) || 'pièce sans nom';
    const refuse = (why: string) => void refused.push(`« ${original} » n’est pas ajouté : ${why}`);
    const declared = isAttachmentType(file.type) ? file.type : null;
    const convert = file.type === 'video/quicktime' || (!!declared && isVideo(declared) && file.size > ATTACHMENT_TYPES[declared].maxBytes);
    if (!convert && !declared) {
      refuse(`formats acceptés ${FORMATS}.`);
      continue;
    }
    if (count() >= MAX_ATTACHMENTS) {
      refuse(`${MAX_ATTACHMENTS} pièces au plus par message.`);
      continue;
    }
    const piece = !convert && declared ? { blob: file, type: declared, name: original } : await converted(file, original, signal, onConverting, refuse);
    if (!piece || signal.aborted) continue;
    const { blob, type, name } = piece;
    const { maxBytes, label } = ATTACHMENT_TYPES[type];
    if (blob.size === 0 || blob.size > maxBytes) {
      refuse(blob.size ? `${formatBytes(blob.size)}, au-delà de ${formatBytes(maxBytes)}.` : 'fichier vide.');
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!signatureMatches(type, bytes.subarray(0, SIGNATURE_BYTES))) {
      refuse(`son contenu n’est pas un fichier ${label}.`);
      continue;
    }
    // Le fichier vient de l'iframe ; le transport attend un Blob du document propriétaire.
    if (!signal.aborted) onReady(Object.freeze({ id: crypto.randomUUID(), file: new Blob([blob], { type }), meta: Object.freeze({ name, contentType: type, size: blob.size, sha256: await sha256Hex(bytes) }) }));
  }
  return refused;
}

/** Conversion préalable d'une vidéo : la pièce produite, ou `null` quand elle est retirée, arrêtée ou refusée. */
async function converted(file: File, name: string, signal: AbortSignal, onConverting: (c: Converting | null) => void, refuse: (why: string) => void): Promise<Piece | null> {
  const removed = new AbortController();
  const stop = AbortSignal.any([signal, removed.signal]);
  let percent = -1;
  const progress = (ratio: number) => {
    if (Math.floor(ratio * 100) === percent) return;
    percent = Math.floor(ratio * 100);
    onConverting(Object.freeze({ name, progress: percent / 100, cancel: () => removed.abort() }));
  };
  progress(0);
  try {
    const m = await import('./convert.ts');
    try {
      // Le fichier vient de l'iframe ; mediabunny n'accepte qu'un Blob du document propriétaire.
      const { blob, type } = await m.convertVideo(new Blob([file]), progress, stop);
      return stop.aborted ? null : { blob, type, name: `${Array.from(name.replace(/\.[^.]*$/, '')).slice(0, MAX_ATTACHMENT_NAME - 5).join('')}.${type === 'video/mp4' ? 'mp4' : 'webm'}` };
    } catch (e) {
      if (!stop.aborted) refuse(e instanceof m.Refusal ? e.message : 'la compression a échoué dans ce navigateur.');
      return null;
    }
  } finally {
    onConverting(null);
  }
}

/** Aperçu local : adresse `blob:` créée pour cet affichage et révoquée à son retrait. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

// Lucide « video » et « x » (ISC), même famille que la toolbar.
const VIDEO_ICON = <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>;

const RemoveButton = ({ name, disabled, onClick }: { name: string; disabled: boolean; onClick: () => void }) => (
  <button type="button" className="socrate-icon" aria-label={`Retirer « ${name} »`} data-socrate-tip="Retirer cette pièce" disabled={disabled} onClick={onClick}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12" /></svg>
  </button>
);

function DraftChip({ item, disabled, onRemove }: { item: DraftAttachment; disabled: boolean; onRemove: () => void }) {
  const url = useObjectUrl(item.file);
  const { name, contentType, size } = item.meta;
  return (
    <li className="socrate-chip" data-testid="socrate-attachment-draft" data-type={contentType}>
      <span className="socrate-chip-preview" aria-hidden="true">
        {url && !isVideo(contentType) && <img src={url} alt="" />}
        {url && isVideo(contentType) && <video src={url} muted preload="metadata" tabIndex={-1} />}
        {!url && VIDEO_ICON}
      </span>
      <span className="socrate-chip-text"><span className="socrate-chip-name">{name}</span><span className="socrate-meta">{ATTACHMENT_TYPES[contentType].label} · {formatBytes(size)}</span></span>
      <RemoveButton name={name} disabled={disabled} onClick={onRemove} />
    </li>
  );
}

/** Pièces du brouillon : aperçu, nom, taille, retrait individuel et quota ; figées pendant l'envoi. Une vidéo en compression reste retirable. */
export function AttachmentTray({ items, converting, disabled, onRemove }: { items: readonly DraftAttachment[]; converting: Converting | null; disabled: boolean; onRemove: (id: string) => void }) {
  return (
    <div className="socrate-tray">
      <style>{MEDIA_CSS}</style>
      <ul aria-label="Pièces à envoyer">
        {items.map((it) => <DraftChip key={it.id} item={it} disabled={disabled} onRemove={() => onRemove(it.id)} />)}
        {converting && (
          <li className="socrate-chip" data-testid="socrate-attachment-converting" aria-busy="true">
            <span className="socrate-chip-preview" aria-hidden="true">{VIDEO_ICON}</span>
            <span className="socrate-chip-text"><span className="socrate-chip-name">{converting.name}</span><span className="socrate-meta">Compression… {converting.progress.toLocaleString('fr-FR', { style: 'percent' })}</span></span>
            <RemoveButton name={converting.name} disabled={false} onClick={converting.cancel} />
          </li>
        )}
      </ul>
      <p className="socrate-meta" data-testid="socrate-attachment-quota">{items.length} sur {MAX_ATTACHMENTS} pièces · {FORMATS}</p>
    </div>
  );
}

type Load = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; blob: Blob } | { kind: 'error'; text: string };

/**
 * Pièce d'un message publié, lue par la session du client qui l'affiche. Une image se charge à l'affichage du fil, une vidéo au
 * geste « Charger la vidéo » ; aucune lecture automatique. Une réponse arrivée après le démontage (fil fermé, identité changée) est ignorée.
 */
function Published({ client, a }: { client: ReviewClient; a: Attachment }) {
  const video = isVideo(a.contentType);
  const [load, setLoad] = useState<Load>(video ? { kind: 'idle' } : { kind: 'loading' });
  useEffect(() => {
    if (load.kind !== 'loading') return;
    const controller = new AbortController();
    client.attachmentBlob(a.attachmentId, controller.signal).then(
      (blob) => { if (!controller.signal.aborted) setLoad({ kind: 'ready', blob }); },
      (e: Error) => { if (!controller.signal.aborted) setLoad({ kind: 'error', text: e.message }); },
    );
    return () => controller.abort();
  }, [client, a.attachmentId, load.kind]);
  const url = useObjectUrl(load.kind === 'ready' ? load.blob : null);
  const caption = <span className="socrate-meta">{a.name} · {formatBytes(a.size)}</span>;
  return (
    <li className="socrate-media-item" data-testid="socrate-attachment" data-type={a.contentType} data-state={load.kind}>
      {url && !video && <img src={url} alt={a.name} />}
      {url && video && <video src={url} controls preload="metadata" playsInline aria-label={a.name} />}
      {load.kind === 'idle' && (
        <button type="button" className="socrate-media-load" onClick={() => setLoad({ kind: 'loading' })}>
          {VIDEO_ICON}<span>Charger la vidéo · {formatBytes(a.size)}</span>
        </button>
      )}
      {load.kind === 'loading' && <span className="socrate-meta" role="status">Chargement de « {a.name} »…</span>}
      {load.kind === 'error' && (
        <span className="socrate-status" data-kind="error" role="alert">
          « {a.name} » indisponible : {load.text}{' '}
          <button type="button" className="socrate-button link" onClick={() => setLoad({ kind: 'loading' })}>Réessayer</button>
        </span>
      )}
      {caption}
    </li>
  );
}

export function MessageMedia({ client, attachments }: { client: ReviewClient; attachments: Attachment[] }) {
  const session = client.currentSession;
  const owner = JSON.stringify([session?.actor.key, session?.exploring]);
  return (
    <>
      <style>{MEDIA_CSS}</style>
      <ul className="socrate-media" aria-label={`${attachments.length} pièce${attachments.length > 1 ? 's' : ''} jointe${attachments.length > 1 ? 's' : ''}`}>
        {attachments.map((a) => <Published key={`${owner}:${a.attachmentId}`} client={client} a={a} />)}
      </ul>
    </>
  );
}
