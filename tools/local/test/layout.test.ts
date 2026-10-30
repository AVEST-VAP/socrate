import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_COLORS, cluster, colorOf, hull, initialsOf, place, relativeDate } from '../../../packages/react/src/layout.ts';
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

const overlap = (p: { x: number; y: number }, a: { x: number; y: number; width: number; height: number }) =>
  Math.max(0, Math.min(p.x + size.width, a.x + a.width) - Math.max(p.x, a.x)) * Math.max(0, Math.min(p.y + size.height, a.y + a.height) - Math.max(p.y, a.y));
const onScreen = (p: { x: number; y: number }, v = view) => p.x >= 8 && p.x + size.width <= v.width - 8 && p.y >= 8 && p.y + size.height <= v.height - 72;

test('cible avec point : le côté libre le plus proche du geste, aligné sur lui, sans recouvrir la cible', () => {
  const bloc = { x: 24, y: 77, width: 1232, height: 352 };
  assert.deepEqual(place(bloc, size, view, { x: 30, y: 250 }), { x: 10, y: 437, sheet: false }, 'grand bloc : dessous, à gauche du clic');
  const bas = { x: 24, y: 300, width: 1232, height: 300 };
  assert.deepEqual(place(bas, size, view, { x: 900, y: 400 }), { x: 880, y: 172, sheet: false }, 'pas de place dessous : dessus');
  const bouton = { x: 500, y: 200, width: 120, height: 32 };
  assert.deepEqual(place(bouton, size, view, { x: 508, y: 216 }), { x: 152, y: 196, sheet: false }, 'petite cible, clic à gauche : à gauche');
  assert.deepEqual(place(bouton, size, view, { x: 616, y: 216 }), { x: 628, y: 196, sheet: false }, 'petite cible, clic à droite : à droite');
  assert.deepEqual(place({ x: 40, y: 40, width: 200, height: 560 }, size, view, { x: 100, y: 300 }), { x: 248, y: 280, sheet: false }, 'colonne haute : à droite, à hauteur du clic');
});

test('cible en bord d’écran : côté libre opposé, bulle bornée, bande de la toolbar exclue', () => {
  const droite = { x: 1180, y: 300, width: 100, height: 40 };
  assert.deepEqual(place(droite, size, view, { x: 1200, y: 320 }), { x: 832, y: 300, sheet: false }, 'bord droit : à gauche');
  const bas = { x: 500, y: 620, width: 120, height: 28 };
  assert.deepEqual(place(bas, size, view, { x: 510, y: 634 }), { x: 152, y: 528, sheet: false }, 'bas de la zone utile : à gauche, au-dessus de la toolbar');
  const haut = { x: 500, y: 0, width: 120, height: 30 };
  assert.deepEqual(place(haut, size, view, { x: 510, y: 15 }), { x: 152, y: 8, sheet: false }, 'bord haut : à gauche, bornée en haut');
  const liste = { width: 900, height: 720 };
  const sousLaListe = place({ x: 700, y: 100, width: 500, height: 80 }, size, liste, { x: 880, y: 140 });
  assert.equal(sousLaListe.y, 188, 'élément coupé par la liste : dessous');
  assert.ok(sousLaListe.x + size.width <= 892, JSON.stringify(sousLaListe));
});

test('place insuffisante : le moins de recouvrement, bulle entière à l’écran et hors de la toolbar', () => {
  const large = { x: 140, y: 24, width: 1000, height: 600 };
  const p = place(large, size, view, { x: 600, y: 300 });
  assert.deepEqual(p, { x: 8, y: 528, sheet: false }, 'coin bas, côté le plus proche du clic');
  assert.ok(onScreen(p));
  assert.ok(overlap(p, large) < overlap({ x: 580, y: 312 }, large), 'moins couvert que sous le point');

  const page = { x: 0, y: -500, width: 1280, height: 3000 };
  assert.deepEqual(place(page, size, view, { x: 640, y: 300 }), { x: 620, y: 312, sheet: false }, 'élément plus grand que la fenêtre : sous le point du clic');
  const sansPoint = place(page, size, view);
  assert.ok(onScreen(sansPoint), JSON.stringify(sansPoint));

  for (const a of [{ x: 8, y: 8, width: 1264, height: 640 }, { x: 900, y: 0, width: 380, height: 648 }, { x: 0, y: 0, width: 380, height: 648 }, { x: -200, y: -200, width: 900, height: 2000 }]) {
    for (const near of [undefined, { x: Math.max(0, a.x) + 10, y: 300 }]) {
      const q = place(a, size, view, near);
      assert.ok(onScreen(q), JSON.stringify({ a, q }));
    }
  }
  assert.equal(overlap(place({ x: 900, y: 0, width: 380, height: 648 }, size, view, { x: 1000, y: 300 }), { x: 900, y: 0, width: 380, height: 648 }), 0, 'colonne droite pleine hauteur : à sa gauche');
});

test('fil : pastille et élément ne font qu’une cible ; feuille inchangée sous 520 px', () => {
  assert.deepEqual(hull({ x: 100, y: 100, width: 200, height: 40 }, { x: 294, y: 78, width: 28, height: 28 }), { x: 100, y: 78, width: 222, height: 62 });
  const a = hull({ x: 100, y: 100, width: 200, height: 40 }, { x: 294, y: 78, width: 28, height: 28 });
  assert.deepEqual(place(a, size, view, { x: 308, y: 92 }), { x: 330, y: 72, sheet: false }, 'à droite de la pastille');
  assert.deepEqual(place({ x: 10, y: 10, width: 300, height: 400 }, size, { width: 375, height: 700 }, { x: 40, y: 40 }), { x: 8, y: 508, sheet: true });
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
