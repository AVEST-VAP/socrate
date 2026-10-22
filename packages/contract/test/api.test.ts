import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesQuerySchema, millisecondBound, threadFilterSchema } from '../src/index.ts';

/** Comparaison exacte en unités de 10^-n seconde, sans passer par Date au-delà de la seconde. */
function exact(storedMs: number, boundValue: string): { since: boolean; before: boolean } {
  const [, whole, fraction = ''] = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(boundValue)!;
  const n = Math.max(3, fraction.length);
  const b = BigInt(Date.parse(`${whole}Z`)) * 10n ** BigInt(n - 3) + BigInt(fraction.padEnd(n, '0') || '0');
  const t = BigInt(storedMs) * 10n ** BigInt(n - 3);
  return { since: t >= b, before: t < b };
}

test('borne à la milliseconde : >= et < équivalents à la borne exacte sur la grille stockée', () => {
  const fractions = ['', '.0', '.5', '.000', '.0000', '.0001', '.1239', '.123456789', '.999', '.9990', '.9991', '.9999', '.999999999'];
  const seconds = ['2026-10-18T10:00:00', '2026-10-18T23:59:59', '2026-12-31T23:59:59'];
  let cases = 0;
  for (const s of seconds) {
    for (const f of fractions) {
      const value = `${s}${f}Z`;
      assert.ok(threadFilterSchema.safeParse({ updatedSince: value, updatedBefore: value }).success, `${value} reste accepté`);
      const normalized = millisecondBound(value);
      const center = Date.parse(normalized);
      for (let t = center - 3; t <= center + 3; t++) {
        const stored = new Date(t).toISOString();
        // Le SQL compare des textes ISO de même format : la comparaison lexicale doit suivre la comparaison exacte.
        assert.deepEqual({ since: stored >= normalized, before: stored < normalized }, exact(t, value), `${stored} contre ${value}`);
        cases++;
      }
    }
  }
  assert.equal(millisecondBound('2026-10-18T10:00:00.0001Z'), '2026-10-18T10:00:00.001Z');
  assert.equal(millisecondBound('2026-10-18T10:00:00.0000Z'), '2026-10-18T10:00:00.000Z');
  assert.equal(millisecondBound('2026-10-18T23:59:59.9999Z'), '2026-10-19T00:00:00.000Z', 'franchit seconde et jour');
  assert.equal(millisecondBound('2026-12-31T23:59:59.9991Z'), '2027-01-01T00:00:00.000Z', 'franchit l’année');
  assert.equal(millisecondBound('2026-10-18T10:00:00Z'), '2026-10-18T10:00:00.000Z');
  assert.equal(cases, seconds.length * fractions.length * 7);
});

test('fin de l’an 9999 : la borne arrondie reste ordonnée après les données courantes et la dernière milliseconde stockable', () => {
  const max = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
  const stored = [Date.UTC(2026, 9, 18, 10), Date.UTC(2026, 11, 31, 23, 59, 59, 999), max - 1, max];
  for (const f of ['.999', '.9990', '.9991', '.9999']) {
    const value = `9999-12-31T23:59:59${f}Z`;
    assert.ok(threadFilterSchema.safeParse({ updatedSince: value, updatedBefore: value }).success, `${value} reste accepté`);
    const normalized = millisecondBound(value);
    for (const t of stored) {
      const iso = new Date(t).toISOString();
      assert.deepEqual({ since: iso >= normalized, before: iso < normalized }, exact(t, value), `${iso} contre ${value}`);
    }
  }
  assert.equal(millisecondBound('9999-12-31T23:59:59.9999Z'), '9999-12-31T24:00:00.000Z', 'même instant que l’an 10000, écrit à quatre chiffres');
  assert.equal(millisecondBound('9999-12-31T23:59:59.999999999Z'), '9999-12-31T24:00:00.000Z');
  assert.equal(millisecondBound('9999-12-31T23:59:59.9990Z'), '9999-12-31T23:59:59.999Z');
  assert.equal(Date.parse(millisecondBound('9999-12-31T23:59:59.9999Z')), max + 1);
});

test('marqueur : c2 avec portée accepté, c1 reconnu pour la resynchronisation, le reste refusé', () => {
  const hex = 'a'.repeat(32);
  for (const since of [`c2.${hex}.${'0'.repeat(32)}.0`, `c2.${hex}.${hex}.123456789012345`, `c1.${hex}.7`]) assert.ok(changesQuerySchema.safeParse({ since }).success, since);
  for (const since of [`c2.${hex}.7`, `c2.${hex}.${'a'.repeat(31)}.1`, `c2.${hex}.${'A'.repeat(32)}.1`, `c3.${hex}.${hex}.1`, `c2.${hex}.${hex}.`, 'c1.bad.1', `c1.${hex}.${hex}.1`]) {
    assert.equal(changesQuerySchema.safeParse({ since }).success, false, since);
  }
});
