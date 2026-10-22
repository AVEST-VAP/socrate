import { createServer } from 'vite';
import config from '../../../apps/demo/vite.config.ts';

const server = await createServer({
  ...config, configFile: false,
  plugins: [...config.plugins ?? [], {
    name: 'navigation-adapter-fixture', enforce: 'pre',
    transform(source, id) {
      if (!id.endsWith('/apps/demo/src/main.tsx')) return;
      return source.replace('current: () => window.location.pathname,',
        "current: () => location.search === '?adapter=other' ? '/route-logique' : window.location.pathname + location.search,");
    },
  }],
});
await server.listen();
