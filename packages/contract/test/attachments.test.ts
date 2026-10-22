import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { signatureMatches, SIGNATURE_BYTES } from '../src/attachments.ts';

const ftyp = (major: string, brands: string[] = [], size = 16 + brands.length * 4) => {
  const b = Buffer.alloc(16 + brands.length * 4);
  b.writeUInt32BE(size);
  b.write(`ftyp${major}`, 4, 'ascii');
  brands.forEach((brand, i) => b.write(brand, 16 + i * 4, 'ascii'));
  return b;
};

test('MP4 : boîte ftyp complète et bornée, marque vidéo explicite, aucun profil image', async () => {
  const real = await readFile(new URL('../../../tools/local/fixtures/media/parcours.mp4', import.meta.url));
  assert.equal(signatureMatches('video/mp4', real.subarray(0, SIGNATURE_BYTES)), true);
  const av1 = await readFile(new URL('../../../tools/local/fixtures/media/parcours-av1.mp4', import.meta.url));
  assert.equal(signatureMatches('video/mp4', av1.subarray(0, SIGNATURE_BYTES)), true);
  for (const b of [ftyp('isom', ['av01', 'iso2', 'mp41']), ftyp('mp41'), ftyp('mp42'), ftyp('isom', ['iso2', 'avc1', 'mp41']), ftyp('mp42', Array(12).fill('isom'))]) {
    assert.equal(signatureMatches('video/mp4', b), true);
  }
  const avif = await readFile(new URL('../../../tools/local/fixtures/media/non-mp4.avif', import.meta.url));
  for (const b of [avif, ftyp('isom', ['av01', 'avif', 'mp41']), ftyp('isom', ['av01']), ftyp('av01', ['mp41']), ftyp('isom'), ftyp('avif', ['isom']), ftyp('isom', ['mp42', 'avif']), ftyp('mif1', ['mp41']), ftyp('heic'), ftyp('qt  '), ftyp('isom', ['mp41'], 16), ftyp('mp42', [], 0), ftyp('mp42', [], 1), ftyp('mp42', [], 12), ftyp('mp42', [], 17), ftyp('mp42', [], 20), ftyp('mp42', Array(13).fill('isom'))]) {
    assert.equal(signatureMatches('video/mp4', b), false, b.toString('hex'));
  }
  for (let length = 0; length < 32; length++) {
    assert.equal(signatureMatches('video/mp4', real.subarray(0, length)), false, `tête tronquée ${length}`);
  }
  const sliced = Buffer.concat([Buffer.alloc(3), ftyp('mp42')]).subarray(3);
  assert.equal(signatureMatches('video/mp4', sliced), true, 'offset réel du tableau');
});
