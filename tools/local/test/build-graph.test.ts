import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticClosure } from '../build-graph.ts';

test('panneau : racine et dépendances statiques partagées ou cycliques comptées une fois, entrée et bootstrap déjà chargés exclus', () => {
  const chunks = [
    { file: 'entry', imports: ['react'] },
    { file: 'bootstrap', imports: ['entry', 'shared'] },
    { file: 'frame', imports: ['entry', 'locate', 'shared'] },
    { file: 'locate', imports: ['frame', 'shared'] },
    { file: 'shared', imports: [] },
  ];
  const loaded = new Set(staticClosure(chunks, ['entry', 'bootstrap']));
  const files = staticClosure(chunks, ['frame']).filter((f) => !loaded.has(f));
  assert.deepEqual(files, ['frame', 'locate']);
  const gzip = new Map([['frame', 22_966], ['locate', 1_865]]);
  assert.equal(files.reduce((sum, file) => sum + gzip.get(file)!, 0), 24_831);
  assert.deepEqual(staticClosure(chunks, ['entry', 'entry']), ['entry', 'react']);
});
