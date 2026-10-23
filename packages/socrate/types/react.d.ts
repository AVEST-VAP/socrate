import type { ReactNode } from 'react';

/** `import.meta.env.SOCRATE` of a preview build. When `origin` is given, the component renders only on a page of that origin. */
export type SocratePreview = { serviceUrl: string; projectId: string; reviewKey: string; deploymentId: string; origin?: string };
/** Wired to your router: the current route, and a way to open the route of a thread. */
export type NavigationAdapter = { current(): string; go(route: string): void };
export type SocrateReviewProps = {
  preview: SocratePreview;
  /** Calls your backend's identity bridge and returns the signed assertion; `signal` aborts when the component unmounts. */
  getIdentityAssertion: (signal: AbortSignal) => Promise<string>;
  navigation: NavigationAdapter;
  /** Shows the editorial surfaces (zones, markers, grouped wording review). Off by default. */
  editorial?: boolean;
};

/** Review toolbar, pins and conversations. Renders nothing inside an iframe or on another origin than `preview.origin`. Remount it with a `key` when the signed-in user changes. */
export declare function SocrateReview(props: SocrateReviewProps): ReactNode;
