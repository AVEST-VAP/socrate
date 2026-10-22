import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const target = new URL('../../../node_modules/playwright-core/lib/coreBundle.js', import.meta.url).href;
const before = 'promises2.push(this._client.send("Emulation.setFocusEmulationEnabled", { enabled: true }));';

registerHooks({
  load(url, context, next) {
    const out = next(url, context);
    if (url !== target) return out;
    const source = out.source == null ? readFileSync(new URL(url), 'utf8') : String(out.source);
    if (source.split(before).length !== 2) throw new Error('native-focus-hook : cible Playwright absente ou non unique, version à revoir');
    globalThis.socrateNativeFocus = true;
    console.log('banc : émulation de focus Playwright retirée, aucun visibilitychange injecté');
    return { ...out, source: source.replace(before, 'void 0;') };
  },
});
