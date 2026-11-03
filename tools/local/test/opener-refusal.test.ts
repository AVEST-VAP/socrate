import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { issuesOf, targetSchema, type ApiError } from '@socrate/contract';
import { refusesOpener } from '../../../packages/react/src/client.ts';

const base = {
  url: 'http://127.0.0.1:5174/reglages/rappels', route: '/reglages/rappels',
  rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
  role: 'p', text: 'Envoyé par SMS au client fictif.', selector: 'p', html: '<p>Envoyé par SMS au client fictif.</p>',
};
const refusal = (issues: ApiError['issues'], code: ApiError['code'] = 'invalid_request'): ApiError => ({ code, message: 'retour ciblé invalide', requestId: 'banc', retryable: false, ...(issues && { issues }) });

test('repli du déclencheur : seul le rejet exact de la clé inconnue `opener`, tel que le rend un Worker 0.5.0, retire le champ', () => {
  // Forme réelle : le schéma 0.5.0 de la cible, sous `target`, passé par `issuesOf` comme le fait le Worker.
  const before = z.strictObject({ target: targetSchema.extend({ container: z.strictObject({ label: z.string().max(80).optional() }).optional() }) });
  const r = before.safeParse({ target: { ...base, container: { label: 'Modèle de rappel court', opener: { role: 'button', name: 'Modèle court' } } } });
  assert.equal(r.success, false);
  const real = issuesOf(r.error!).map(({ path, message }) => ({ path, message }));
  assert.deepEqual(real.map((i) => i.path), ['target.container.opener']);
  assert.equal(refusesOpener(refusal(real)), true, 'rejet réel reconnu');
  const unknown = real[0]!;
  for (const [why, e] of [
    ['aucun corps', null],
    ['autre code', refusal([unknown], 'invalid_manifest')],
    ['issues absentes', refusal(undefined)],
    ['issues vides', refusal([])],
    ['champ du déclencheur invalide', refusal([{ path: 'target.container.opener.name', message: 'texte invalide' }])],
    ['autre message sous le même chemin', refusal([{ path: 'target.container.opener', message: 'Invalid input' }])],
    ['clé inconnue ailleurs dans la fenêtre', refusal([{ path: 'target.container.kind', message: unknown.message }])],
    ['refus mêlé à un autre', refusal([unknown, { path: 'body', message: 'message vide' }])],
  ] as const) assert.equal(refusesOpener(e), false, why);
});
