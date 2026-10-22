import { createRoot } from 'react-dom/client';
import { SocrateReview, type SocrateReviewProps } from './index.tsx';

export type { SocrateReviewProps };

/**
 * Entrée autonome servie par le Worker, avec sa propre React : l'hôte n'installe aucun paquet Socrate.
 * Un changement d'identité se traite comme la `key` du composant : démonter puis remonter.
 */
export function mount(container: Element, props: SocrateReviewProps): () => void {
  const root = createRoot(container);
  root.render(<SocrateReview {...props} />);
  return () => root.unmount();
}
