import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';

const VARIANTS = {
  courte: { title: 'Modèle de rappel court', width: 420, intro: 'Envoyé par SMS au client fictif.' },
  detaillee: { title: 'Modèle de rappel détaillé', width: 640, intro: 'Envoyé par e-mail avec l’adresse du cabinet fictif et les consignes de préparation.' },
} as const;
type Variant = keyof typeof VARIANTS;

const DELAIS = ['La veille', '48 h avant', '72 h avant'];

const S = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(43,33,24,.45)' },
  popup: { position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', maxWidth: '90vw', background: '#fff8e6', border: '3px solid #7a4b1f', padding: 20 },
  scroll: { maxHeight: 120, overflow: 'auto', border: '1px dotted #7a4b1f', padding: 8, margin: '8px 0' },
  menu: { background: '#fff', border: '2px solid #7a4b1f', padding: 4, display: 'grid' },
} as const;

/** Scène de démonstration non adaptée à Socrate : wrappers Base UI utilisés tels quels, sans attribut ni API Socrate. */
export function RappelModal() {
  const [variant, setVariant] = useState<Variant>('courte');
  const [open, setOpen] = useState(false);
  const [libelle, setLibelle] = useState('Rappel automatique');
  const [delai, setDelai] = useState(DELAIS[0]!);
  const [saved, setSaved] = useState(0);
  const v = VARIANTS[variant];
  return (
    <section {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'scene-modal' })}>
      <p>Enregistrements du modèle : <output data-testid="scene-saved">{saved}</output></p>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger onClick={() => setVariant('courte')} data-testid="open-courte">Modèle court</Dialog.Trigger>{' '}
        <Dialog.Trigger onClick={() => setVariant('detaillee')} data-testid="open-detaillee">Modèle détaillé</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop style={S.backdrop} />
          <Dialog.Popup style={{ ...S.popup, width: v.width }} data-testid="scene-dialog" data-variant={variant}>
            <Dialog.Title>{v.title}</Dialog.Title>
            <Dialog.Description data-testid="scene-intro">{v.intro}</Dialog.Description>
            <label>Libellé affiché <input data-testid="scene-libelle" value={libelle} onChange={(e) => setLibelle(e.target.value)} /></label>
            <div style={S.scroll} data-testid="scene-scroll">
              {Array.from({ length: 12 }, (_, i) => <p key={i}>Consigne fictive n° {i + 1} : arriver dix minutes en avance.</p>)}
            </div>
            <p>
              <button type="button" {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'modal-enregistrer' })} data-testid="scene-save" onClick={() => setSaved((n) => n + 1)}>Enregistrer le rappel</button>{' '}
              <Dialog.Close>Fermer</Dialog.Close>
            </p>
            <Menu.Root>
              <Menu.Trigger data-testid="scene-menu-trigger">Délai : {delai}</Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner sideOffset={4}>
                  <Menu.Popup style={S.menu} data-testid="scene-menu">
                    {DELAIS.map((d) => <Menu.Item key={d} onClick={() => setDelai(d)}>{d}</Menu.Item>)}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
