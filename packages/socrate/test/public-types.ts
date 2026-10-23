// Contrôle de typage seul (npm run typecheck) : les déclarations publiées de `types/` décrivent exactement les sources construites.
import type * as PublicReact from '../types/react.d.ts';
import type * as PublicVite from '../types/vite.d.ts';
import type * as React from '../src/react.tsx';
import type * as Vite from '../src/vite.ts';
import type { SocratePreview } from '../src/preview.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const proofs: [
  Same<PublicReact.SocrateReviewProps, React.SocrateReviewProps>,
  Same<PublicReact.SocratePreview, React.SocratePreview>,
  Same<PublicReact.NavigationAdapter, React.NavigationAdapter>,
  Same<Parameters<typeof PublicReact.SocrateReview>, Parameters<typeof React.SocrateReview>>,
  Same<PublicVite.SocrateViteOptions, Vite.SocrateViteOptions>,
  Same<typeof PublicVite.socrate, typeof Vite.socrate>,
  Same<Required<PublicReact.SocratePreview>, SocratePreview>,
  Same<Exclude<ImportMetaEnv['SOCRATE'], false>, SocratePreview>,
] = [true, true, true, true, true, true, true, true];
const rendered: ReturnType<typeof PublicReact.SocrateReview> = null as unknown as ReturnType<typeof React.SocrateReview>;
void proofs;
void rendered;
