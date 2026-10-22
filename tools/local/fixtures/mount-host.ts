import { createServer, type Plugin } from 'vite';
import config from '../../../apps/demo/vite.config.ts';

/** Page d'hôte sans React ni paquet Socrate : elle importe l'entrée `mount` à l'URL figée reçue, comme une preview de l'application intégrée. */
const MOUNT_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Hôte mount</title></head>
<body><main><h1>Hôte sans paquet Socrate</h1><p data-testid="host-text">Texte de l’hôte à commenter.</p></main><div id="socrate"></div>
<script type="module">
const client = new URLSearchParams(location.search).get('client');
const getIdentityAssertion = async (signal) => {
  const r = await fetch('/api/socrate/assertion', { method: 'POST', signal });
  if (!r.ok) throw new Error('assertion refusée par l’hôte');
  return (await r.json()).assertion;
};
const navigation = { current: () => location.pathname, go: (route) => history.pushState(null, '', route) };
try {
  const { mount } = await import(client);
  const preview = await (await fetch('/api/preview-context')).json();
  window.socrateUnmount = mount(document.getElementById('socrate'), { preview, getIdentityAssertion, navigation });
  document.body.dataset.mount = 'ok';
} catch (e) {
  document.body.dataset.mount = 'refused';
  document.body.dataset.error = String(e);
}
</script></body></html>`;

const page: Plugin = {
  name: 'mount-host-page',
  configureServer: (server) => void server.middlewares.use((req, res, next) => {
    if (new URL(req.url ?? '/', 'http://hote').pathname !== '/') return next();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(MOUNT_PAGE);
  }),
};

const server = await createServer({ ...config, configFile: false, plugins: [...config.plugins ?? [], page] });
await server.listen();
