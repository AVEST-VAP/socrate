// Produit l'archive `sauvegarde-v1/` avec le code de 87954e3, dernier état au format socrate-sauvegarde/1, données fictives.
// Exécuté depuis une extraction de ce commit, jamais depuis le dépôt courant :
//   git archive 87954e3 package.json tsconfig.json tools/local packages/contract apps/service apps/demo/.socrate | tar -x -C .tmp/v1src
//   mkdir -p .tmp/v1src/node_modules/@socrate && ln -s ../../packages/contract .tmp/v1src/node_modules/@socrate/contract
//   mkdir -p .tmp/v1src/apps/service/test/fixtures && cp apps/service/test/fixtures/generer-sauvegarde-v1.ts .tmp/v1src/apps/service/test/fixtures/ && node .tmp/v1src/apps/service/test/fixtures/generer-sauvegarde-v1.ts
import { createHash } from 'node:crypto';
import { startBench, importDemo, call, sessionClient, key, PROJECT, REVIEW } from '../helpers.ts';
import { exportBackup } from '../../../../tools/local/backup.ts';
import { Maintenance } from '../../../../tools/local/maintenance.ts';
import { localPath } from '../../../../tools/local/local-run.ts';

const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;
const bench = await startBench();
const ok = (r: { status: number; json: unknown }, status: number) => { if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.json)}`); return r.json as Record<string, any>; };
ok(await importDemo(bench, 'local-1'), 201);
const claire = await sessionClient(bench, { deploymentId: 'local-1' });
const g = ok(await call(claire, 'POST', `${base}/threads`, { kind: 'global', body: 'Commentaire général d’avant les pièces jointes.' }, { 'Idempotency-Key': key() }), 201);
ok(await call(claire, 'POST', `${base}/threads/${g.threadId}/messages`, { body: 'Réponse d’avant les pièces jointes.' }, { 'Idempotency-Key': key() }), 201);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('capture fictive format 1 '.repeat(40))]);
const reserved = ok(await call(claire, 'POST', `${base}/targeted`, {
  kind: 'targeted', body: 'Retour ciblé d’avant les pièces jointes.',
  target: {
    url: 'http://127.0.0.1:5173/reglages/rappels', route: '/reglages/rappels', rect: { x: 10, y: 20, width: 120, height: 36 },
    viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }, role: 'button', text: 'Enregistrer le rappel',
    selector: 'button[data-socrate-id="modal-enregistrer"]', html: '<button type="button" data-socrate-id="modal-enregistrer">Enregistrer le rappel</button>',
  },
  image: { contentType: 'image/png', size: png.byteLength, sha256: createHash('sha256').update(png).digest('hex'), width: 1280, height: 800 },
}, { 'Idempotency-Key': key() }), 201);
const put = await fetch(`${claire.url}${base}/captures/${reserved.captureId}?attempt=${reserved.attempt}`, { method: 'PUT', headers: { Authorization: `Bearer ${claire.token}`, Origin: claire.origin!, 'Content-Type': 'image/png' }, body: png });
if (put.status !== 200) throw new Error(`capture ${put.status}`);
ok(await call(claire, 'POST', `${base}/captures/${reserved.captureId}/commit`, { attempt: reserved.attempt }), 201);
await bench.stop();
const out = localPath('.tmp', 'sauvegarde-v1');
const r = await Maintenance.run(bench.root, (m) => exportBackup(m, out));
console.log(JSON.stringify({ dossier: r.dir, format: r.manifest.format, empreinte: r.manifestSha256, tables: r.manifest.tables.map((t) => `${t.name}:${t.rows}`), objets: r.manifest.objects.length }));
