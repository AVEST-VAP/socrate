import type { Plugin } from 'vite';

export type SocrateViteOptions = {
  /** Path of socrate.yml, relative to the Vite root. Default: the first socrate.yml from the Vite root up to the Git root. */
  config?: string;
};

/** Defines `import.meta.env.SOCRATE`: `false` unless `SOCRATE_PREVIEW` is set by `socrate preview prepare`, then the preview context, checked against socrate.yml. */
export declare function socrate(options?: SocrateViteOptions): Plugin;
export default socrate;
