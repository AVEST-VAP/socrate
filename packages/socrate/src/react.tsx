import { useCallback, useDebugValue, useLayoutEffect, useMemo, useRef } from 'react';
import { SocrateReview as Review } from '@socrate/react';
import { CLIENT_MARK, RENDER_MARK } from './mark.ts';

/** `import.meta.env.SOCRATE` d'un build de preview ; `origin` absent, le composant ne vérifie pas l'origine de la page. */
export type SocratePreview = { serviceUrl: string; projectId: string; reviewKey: string; deploymentId: string; origin?: string };
export type NavigationAdapter = { current(): string; go(route: string): void };
export type SocrateReviewProps = {
  preview: SocratePreview;
  getIdentityAssertion: (signal: AbortSignal) => Promise<string>;
  navigation: NavigationAdapter;
  editorial?: boolean;
};

// Une page encadrée ou servie depuis une autre origine que celle du build n'obtiendrait aucune session : rien n'est rendu.
function useTopLevelAt(origin: string | undefined): boolean {
  useDebugValue(CLIENT_MARK);
  if (typeof window === 'undefined') return false;
  let framed: boolean;
  try {
    framed = window.self !== window.top;
  } catch {
    framed = true;
  }
  return !framed && (origin === undefined || origin === window.location.origin);
}

export function SocrateReview({ preview, getIdentityAssertion, ...props }: SocrateReviewProps) {
  const { serviceUrl, projectId, reviewKey, deploymentId } = preview;
  // Le client interne se recrée quand `preview` ou la fonction d'assertion change d'identité : seule une valeur différente en crée un.
  const context = useMemo(() => ({ serviceUrl, projectId, reviewKey, deploymentId }), [serviceUrl, projectId, reviewKey, deploymentId]);
  // Une fonction écrite en ligne chez l'hôte change à chaque rendu : le client appelle toujours la dernière, sans être recréé.
  const latest = useRef(getIdentityAssertion);
  useLayoutEffect(() => {
    latest.current = getIdentityAssertion;
  });
  const assertion = useCallback((signal: AbortSignal) => latest.current(signal), []);
  if (!useTopLevelAt(preview.origin)) return null;
  return <Review key={RENDER_MARK} {...props} preview={context} getIdentityAssertion={assertion} />;
}
