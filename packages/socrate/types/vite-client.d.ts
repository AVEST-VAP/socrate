// Types `import.meta.env.SOCRATE` defined by the `@meyer0x/socrate/vite` plugin.
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly SOCRATE: false | Required<import('./react.js').SocratePreview>;
}
