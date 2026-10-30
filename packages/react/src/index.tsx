import { Component, Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import type { PreviewContext } from './client.ts';
import type { NavigationAdapter } from './panel.tsx';
import type { Actions } from './frame.tsx';
import type { AgentLogos } from './conversation.tsx';

export type { PreviewContext, NavigationAdapter };

/**
 * L'hôte remonte le composant avec une `key` liée à l'identité (acteur réel et compte
 * exploré) lorsqu'elle change dans le même onglet : brouillons, envois en attente et session repartent de zéro.
 * `agentLogos` associe un nom d'agent en minuscules à l'adresse de son logo ; sans entrée, un monogramme neutre.
 * `editorial` réactive explicitement le panneau historique (avant/maintenant, zones, demandes d'avis, repères, revue des textes) ; faux par défaut.
 */
export type SocrateReviewProps = {
  preview: PreviewContext;
  getIdentityAssertion: (signal: AbortSignal) => Promise<string>;
  navigation: NavigationAdapter;
  editorial?: boolean;
  agentLogos?: AgentLogos;
};

const FAILED = { position: 'fixed', right: 16, bottom: 68, zIndex: 2147483001, margin: 0, font: '14px system-ui, sans-serif', padding: '8px 12px', borderRadius: 6, background: '#fdecec', color: '#8a1c1c' } as const;
const LOAD_FAILED = <p role="alert" style={FAILED} data-socrate="load-failed">Socrate n’a pas pu être chargé. L’application reste utilisable ; rechargez la page pour réessayer.</p>;
const EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchstart', 'touchend'] as const;

// Toolbar, liste, bulle, pastilles et client chargés dès le montage pour l'identité connectée ; la capture reste chargée au premier geste explicite.
const ReviewFrame = lazy(() => import('./frame.tsx'));

export function SocrateReview(props: SocrateReviewProps) {
  const actions: Actions = useRef(null);

  // Seule interception permanente : filtrée aux contrôles Socrate de la page, pour qu'un clic n'ouvre, ne ferme ni ne déplace rien côté hôte.
  useEffect(() => {
    const onEvent = (e: Event) => {
      const control = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-socrate-action], [data-socrate="marker"]') : null;
      if (!control) return;
      e.stopImmediatePropagation();
      // La poignée de largeur démarre son geste à l'appui ; les autres contrôles agissent au clic.
      if (e.type === 'pointerdown' && control.dataset.socrateAction === 'resize') actions.current?.('resize', control, e);
      if (e.type !== 'click') e.preventDefault();
      else if (control.dataset.socrate === 'marker') control.dispatchEvent(new Event('socrate-marker'));
      else actions.current?.(control.dataset.socrateAction!, control, e);
    };
    for (const t of EVENTS) window.addEventListener(t, onEvent, true);
    return () => { for (const t of EVENTS) window.removeEventListener(t, onEvent, true); };
  }, []);

  return (
    <LoadBoundary>
      <Suspense fallback={null}>
        <ReviewFrame {...props} actions={actions} />
      </Suspense>
    </LoadBoundary>
  );
}

class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[socrate] chargement du panneau impossible', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return LOAD_FAILED;
  }
}
