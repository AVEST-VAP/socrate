import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeenRequest } from '../browser.ts';
import { phaseTrace, traceProblems } from '../network-trace.ts';

const req = (path: string, method = 'GET'): SeenRequest => ({ url: `http://127.0.0.1:6979${path}`, method, headers: {}, postData: null });
const initial401 = (r: { phase: string; method: string; path: string; status: number | null }) => r.phase === 'avant-connexion' && r.method === 'GET' && r.path === '/api/me' && r.status === 401;
const none = { blocked: [], failed: [] };

test('une requête émise avant l’ouverture garde sa phase même si sa réponse arrive après', async () => {
  const ctx = { seen: [] as SeenRequest[] };
  const trace = phaseTrace(ctx, 'avant-connexion');
  trace.begin('connecte');
  const early = req('/assets/frame-x.js');
  ctx.seen.push(early);
  trace.begin('revue-ouverte');
  early.outcome = { status: 200, bytes: 24_110 };
  ctx.seen.push(req('/v1/auth/session', 'POST'));
  ctx.seen[1]!.outcome = { status: 201, bytes: 220 };
  assert.deepEqual(trace.records().map((r) => [r.phase, r.path]), [['connecte', '/assets/frame-x.js'], ['revue-ouverte', '/v1/auth/session']]);
  assert.throws(() => Object.assign(trace.records()[0]!, { phase: 'revue-ouverte' }), TypeError);
});

test('une requête sans issue fait échouer la collecte dans un délai borné, sans compter zéro octet', async () => {
  const ctx = { seen: [] as SeenRequest[] };
  const trace = phaseTrace(ctx, 'avant-connexion');
  ctx.seen.push(req('/api/me'));
  const started = Date.now();
  const incomplete = await trace.settle({ quietMs: 50, timeoutMs: 200 });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(incomplete.length, 1);
  const [r] = trace.records();
  assert.equal(r!.bytes, null);
  assert.equal(r!.error, 'sans issue');
  assert.equal(traceProblems(trace.records(), none, incomplete, initial401).length, 2);
});

test('seul le 401 initial de /api/me est attendu ; échecs, blocages et autres 4xx sont refusés', async () => {
  const ctx = { seen: [req('/ancienne-page')] };
  const trace = phaseTrace(ctx, 'avant-connexion');
  ctx.seen.push(req('/api/me'));
  ctx.seen[1]!.outcome = { status: 401, bytes: 25 };
  trace.begin('connecte');
  ctx.seen.push(req('/api/login', 'POST'), req('/assets/socrate-x.js'), req('/api/me'));
  ctx.seen[2]!.outcome = { status: 200, bytes: 86 };
  ctx.seen[3]!.outcome = { error: 'abort injecté' };
  ctx.seen[4]!.outcome = { status: 401, bytes: 25 };
  assert.deepEqual(await trace.settle({ quietMs: 10, timeoutMs: 200 }), []);
  const problems = traceProblems(trace.records(), { blocked: ['GET http://exemple.invalid/'], failed: ['GET /x : ECONNREFUSED'] }, [], initial401);
  assert.deepEqual(problems, [
    'bloquée : GET http://exemple.invalid/',
    'échec du transport : GET /x : ECONNREFUSED',
    'inattendue en connecte : GET http://127.0.0.1:6979/assets/socrate-x.js abort injecté',
    'inattendue en connecte : GET http://127.0.0.1:6979/api/me 401',
  ]);
  assert.deepEqual(traceProblems(trace.records().slice(0, 2), none, [], initial401), []);
});
