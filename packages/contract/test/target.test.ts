import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetSchema } from '../src/api.ts';
import { canonicalize } from '../src/index.ts';

const base = {
  url: 'http://127.0.0.1:5174/rendez-vous/rdv-1042', route: '/rendez-vous/rdv-1042',
  rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
  role: 'p', text: 'Mme Fictive Durand · Consultation', selector: '[data-socrate-id="fiche-rendez-vous"] > p:nth-of-type(1)', html: '<p>Mme Fictive Durand · Consultation</p>',
};

test('cible : les charges antérieures, sans frame ni route de l’hôte, sont relues à l’identique, sans défaut injecté', () => {
  for (const old of [base, { ...base, frame: [] }, { ...base, frame: ['div > div > iframe'], route: '/reglages/rappels' }]) {
    const parsed = targetSchema.parse(old);
    assert.deepEqual(parsed, old);
    assert.ok(!('hostRoute' in parsed));
    assert.equal(canonicalize(parsed as never), canonicalize(old as never), 'empreinte canonique inchangée');
  }
});

test('cible d’iframe : la route de l’hôte est conservée à part de celle du document enfant et bornée', () => {
  const child = { ...base, route: '/reglages/rappels', frame: ['div > div > iframe'], hostRoute: '/vue-scindee' };
  assert.deepEqual(targetSchema.parse(child), child);
  assert.equal(targetSchema.safeParse({ ...child, hostRoute: '' }).success, false);
  assert.equal(targetSchema.safeParse({ ...child, hostRoute: 'x'.repeat(513) }).success, false);
});

test('cible : contexte facultatif borné et assaini, absent des charges antérieures', () => {
  const context = { html: '<li><span>M. Fictif Martin</span> <button type="button">Modifier</button></li>', path: [1] };
  assert.deepEqual(targetSchema.parse({ ...base, context }), { ...base, context });
  assert.ok(!('context' in targetSchema.parse(base)));
  for (const bad of [{ ...context, html: '' }, { ...context, html: `<p>${'x'.repeat(995)}</p>` }, { ...context, html: '<li onclick="x()">x</li>' }, { ...context, path: [] }, { ...context, path: [0, 1, 2, 3] }, { ...context, path: [-1] }, { ...context, path: [0.5] }, { ...context, extra: 1 }]) {
    assert.equal(targetSchema.safeParse({ ...base, context: bad }).success, false, JSON.stringify(bad));
  }
});

test('cible : fenêtre contenante facultative, libellé texte borné, absente des charges antérieures', () => {
  for (const container of [{ label: 'Modèle de rappel court' }, {}]) assert.deepEqual(targetSchema.parse({ ...base, container }), { ...base, container });
  assert.ok(!('container' in targetSchema.parse(base)), 'aucun défaut injecté dans un ancien retour');
  for (const bad of [{ label: 'x'.repeat(81) }, { label: 'ligne\nsuivante' }, { label: 'a', kind: 'dialog' }, 'dialog']) {
    assert.equal(targetSchema.safeParse({ ...base, container: bad }).success, false, JSON.stringify(bad));
  }
});

test('cible : déclencheur de la fenêtre facultatif, rôle requis, champs bornés sur une ligne, clé restreinte, absent des charges antérieures', () => {
  const opener = { role: 'button', name: 'Modèle détaillé', selector: '[data-socrate-id="scene-modal"] > button:nth-of-type(2)', socrateId: 'ouvrir-detail', key: 'visit:42' };
  for (const container of [{ label: 'Visite', opener }, { opener: { role: 'button' } }]) assert.deepEqual(targetSchema.parse({ ...base, container }), { ...base, container });
  const old = { ...base, container: { label: 'Visite' } };
  assert.deepEqual(targetSchema.parse(old), old, 'ancien retour relu sans déclencheur injecté');
  assert.equal(canonicalize(targetSchema.parse(old) as never), canonicalize(old as never), 'empreinte canonique inchangée');
  const bad = [
    {}, { ...opener, role: '' }, { ...opener, role: 'x'.repeat(65) },
    { ...opener, name: '' }, { ...opener, name: 'x'.repeat(81) }, { ...opener, name: 'Ouvrir\nla fiche' }, { ...opener, name: 'Ouvrir\u0007' }, { ...opener, name: ' Ouvrir' },
    { ...opener, selector: '' }, { ...opener, selector: 'x'.repeat(301) },
    { ...opener, socrateId: 'a\tb' }, { ...opener, socrateId: 'x'.repeat(129) },
    { ...opener, key: '' }, { ...opener, key: 'visit 42' }, { ...opener, key: 'visit"]' }, { ...opener, key: ':visit' }, { ...opener, key: 'x'.repeat(129) },
    { ...opener, extra: 1 },
  ];
  for (const o of bad) assert.equal(targetSchema.safeParse({ ...base, container: { opener: o } }).success, false, JSON.stringify(o));
  assert.equal(targetSchema.parse({ ...base, container: { opener: { ...opener, name: 'x'.repeat(79) + '…' } } }).container!.opener!.name!.length, 80);
});

test('cible : un service antérieur au déclencheur le refuse sous `target.container.opener` seulement', async () => {
  const { issuesOf } = await import('../src/manifest.ts');
  const { z } = await import('zod');
  // Schéma de la version 0.5.0 : fenêtre avec libellé seul, objet strict.
  const before = targetSchema.extend({ container: z.strictObject({ label: z.string().max(80).optional() }).optional() });
  const r = before.safeParse({ ...base, container: { label: 'Visite', opener: { role: 'button' } } });
  assert.equal(r.success, false);
  assert.deepEqual(issuesOf(r.error!).map((i) => i.path), ['container.opener']);
});
