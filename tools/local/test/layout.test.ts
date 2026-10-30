import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_COLORS, cluster, colorOf, initialsOf, place, relativeDate } from '../../../packages/react/src/layout.ts';
import { isGenericLabel, openContainerHint } from '../../../packages/react/src/container.ts';
import type { Target } from '@socrate/contract';

const view = { width: 1280, height: 720 };
const size = { width: 340, height: 120 };

test('bulle : à droite, puis à gauche, dessous, dessus ; jamais hors des bords ; feuille sous 520 px', () => {
  assert.deepEqual(place({ x: 100, y: 100, width: 200, height: 40 }, size, view), { x: 308, y: 100, sheet: false });
  assert.deepEqual(place({ x: 1000, y: 100, width: 200, height: 40 }, size, view), { x: 652, y: 100, sheet: false });
  assert.deepEqual(place({ x: 0, y: 100, width: 1280, height: 40 }, size, view), { x: 8, y: 148, sheet: false });
  assert.deepEqual(place({ x: 0, y: 650, width: 1280, height: 60 }, size, view), { x: 8, y: 522, sheet: false });
  const inside = place({ x: 0, y: 0, width: 1280, height: 720 }, size, view);
  assert.ok(inside.x >= 8 && inside.x + size.width <= 1272 && inside.y >= 8 && inside.y + size.height <= 712, JSON.stringify(inside));
  assert.deepEqual(place({ x: 600, y: 700, width: 10, height: 10 }, size, view).y, 528, 'cible au bord bas : bulle remontée au-dessus de la bande de la toolbar');
  assert.deepEqual(place({ x: 10, y: 10, width: 50, height: 20 }, size, { width: 375, height: 700 }), { x: 8, y: 508, sheet: true });
});

test('point du clic : coin à moins de 24 px dans les deux axes, retourné au-dessus près du bas, borné aux bords et à gauche de la liste', () => {
  const p = place({ x: 760, y: 220, width: 0, height: 0 }, size, view);
  assert.deepEqual(p, { x: 740, y: 232, sheet: false });
  assert.ok(Math.abs(p.x - 760) < 24 && Math.abs(p.y - 220) < 24);
  assert.deepEqual(place({ x: 760, y: 600, width: 0, height: 0 }, size, view), { x: 740, y: 468, sheet: false }, 'au-dessus du point quand la bande de la toolbar est atteinte');
  assert.deepEqual(place({ x: 1270, y: 100, width: 0, height: 0 }, size, view).x, 932, 'bornée au bord droit');
  assert.deepEqual(place({ x: 890, y: 100, width: 0, height: 0 }, size, { width: 900, height: 720 }).x, 552, 'liste ouverte : bornée à la largeur utile');
  assert.deepEqual(place({ x: 4, y: 100, width: 0, height: 0 }, size, view).x, 8, 'bornée au bord gauche');
});

test('libellé de conteneur : un nom de composant n’est pas un nom, sans casse, accents ni ponctuation', () => {
  for (const label of ['Dialog', 'dialog', 'MODAL', 'Modale', 'Drawer', 'Fenêtre', 'Boîte de dialogue', ' Pop-up ']) assert.equal(isGenericLabel(label), true, label);
  for (const label of ['Modifier le client', 'Dialog client', 'Nouveau rendez-vous']) assert.equal(isGenericLabel(label), false, label);
  const hint = (container: Target['container']) => openContainerHint({ container } as Target);
  assert.equal(hint({ label: 'Dialog' }), 'C’était dans une fenêtre ou un panneau. Ouvrez-le pour retrouver l’élément.', 'ancien fil');
  assert.equal(hint({ label: 'Modifier le client' }), 'C’était dans la fenêtre « Modifier le client ». Ouvrez-la pour retrouver l’élément.');
  assert.equal(hint(undefined), null);
});

test('regroupement à 20 px du premier point, ordre conservé', () => {
  const g = cluster([{ id: 1, x: 0, y: 0 }, { id: 2, x: 10, y: 10 }, { id: 3, x: 40, y: 0 }, { id: 4, x: 0, y: 19 }]);
  assert.deepEqual(g.map((x) => x.map((p) => p.id)), [[1, 2, 4], [3]]);
});

test('initiales, couleurs stables et dates relatives', () => {
  assert.equal(initialsOf('Claire Morel'), 'CM');
  assert.equal(initialsOf('  élodie   de la Tour '), 'ÉD');
  assert.equal(initialsOf(''), '?');
  assert.equal(colorOf('demo-host:claire'), colorOf('demo-host:claire'));
  assert.notEqual(colorOf('demo-host:claire'), colorOf('demo-host:karim'));
  assert.ok((AUTHOR_COLORS as readonly string[]).includes(colorOf('x')));
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(relativeDate('2026-10-19T11:59:50Z', now), 'à l’instant');
  assert.equal(relativeDate('2026-10-16T12:00:00Z', now), 'il y a 3 jours');
  assert.equal(relativeDate('2026-10-18T12:00:00Z', now), 'hier');
});
