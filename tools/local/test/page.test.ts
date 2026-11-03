import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Target } from '@socrate/contract';

// Adresse de la preview simulée : `pageOf` et `sameOriginRoute` lisent `location.origin`.
Object.defineProperty(globalThis, 'location', { value: new URL('https://preview.example/reglages'), configurable: true });
const { pageOf, sameOriginRoute } = await import('../../../packages/react/src/locate.ts');
const target = (url: string, extra: Partial<Target> = {}) => ({ url, route: '/reglages/rappels', ...extra }) as Target;

test('page rejouée : chemin, requête et fragment de la même origine, route de l’hôte pour une iframe', () => {
  assert.equal(pageOf(target('https://preview.example/reglages/rappels?modal=apercu#bas')), '/reglages/rappels?modal=apercu#bas');
  assert.equal(pageOf(target('https://preview.example/reglages/rappels', { frame: [] })), '/reglages/rappels', 'chemin de frame vide : document principal');
  assert.equal(pageOf(target('https://preview.example/app?modal=x', { frame: ['iframe'], hostRoute: '/vue-scindee' })), '/vue-scindee');
});

test('page rejouée : jamais une autre origine ni une adresse protocolaire relative', () => {
  assert.equal(pageOf(target('https://ailleurs.example/reglages/rappels?modal=x')), '/reglages/rappels', 'autre origine : la route seule');
  assert.equal(pageOf(target('https://preview.example//outside.example/path')), '/reglages/rappels', '`//hôte/…` refusé');
  assert.equal(pageOf(target('pas une url')), '/reglages/rappels');
  for (const bad of ['//outside.example/path', '//outside.example', 'https://outside.example/', 'reglages']) assert.equal(sameOriginRoute(bad), false, bad);
  assert.equal(sameOriginRoute('/reglages/rappels?modal=x'), true);
});
