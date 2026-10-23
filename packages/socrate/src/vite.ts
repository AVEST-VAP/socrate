// Plugin Vite : `import.meta.env.SOCRATE` vaut `false` hors preview, de sorte que le code Socrate de l'hôte disparaisse du bundle.
import { resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { loadConfig, type LoadedConfig } from './config.ts';
import { completeHeadersFile } from './csp.ts';
import { PREVIEW_ENV, clientPreview, parsePreview } from './preview.ts';

export type SocrateViteOptions = { config?: string };

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    throw new Error(`[socrate] ${(e as Error).message}`);
  }
}

export function socrate(options: SocrateViteOptions = {}): Plugin {
  let config: LoadedConfig | undefined;
  let outDir = '';
  let active = false;
  return {
    name: 'socrate',
    enforce: 'post',
    config(user, env) {
      const raw = process.env[PREVIEW_ENV];
      // `vite preview` sert un build déjà fait : rien à définir ni à vérifier.
      if (env.isPreview) return;
      if (raw === undefined || raw === '') return { define: { 'import.meta.env.SOCRATE': 'false' } };
      if (env.command === 'serve') throw new Error(`[socrate] ${PREVIEW_ENV} is set: preview builds only, \`vite serve\` is refused`);
      const root = resolve(user.root ?? process.cwd());
      config = guarded(() => loadConfig(root, options.config));
      const preview = guarded(() => parsePreview(raw, config!));
      active = true;
      return { define: { 'import.meta.env.SOCRATE': JSON.stringify(clientPreview(preview)) } };
    },
    configResolved(resolved: ResolvedConfig) {
      outDir = resolve(resolved.root, resolved.build.outDir);
    },
    writeBundle: {
      sequential: true,
      handler() {
        if (!active || !config?.csp) return;
        const file = resolve(outDir, config.csp);
        guarded(() => completeHeadersFile(file, config!.service));
      },
    },
  };
}

export default socrate;
