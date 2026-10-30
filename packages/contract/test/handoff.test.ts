import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffOf, mentionsAgent } from '../src/handoff.ts';

const msg = (seq: number, key: string, body: string, via: string | null = null) => ({ seq, body, via, author: { key } });

test('mention : le mot @agent seul, sans adresse e-mail ni nom plus long', () => {
  for (const yes of ['@agent corrige', 'ok @agent', '(@agent)', '@Agent, regarde', 'fais-le\n@agent']) assert.ok(mentionsAgent(yes), yes);
  for (const no of ['agent', 'moi@agent.fr', '@agents', '@agent-immobilier', '@agent_2']) assert.ok(!mentionsAgent(no), no);
});

test('consigne : dernière de la personne, en attente, répondue par un agent, annulée par une personne', () => {
  const asked = [msg(1, 'po', 'Le bouton est trop petit.'), msg(2, 'dev', '@agent agrandis-le')];
  assert.deepEqual(handoffOf(asked, 'dev'), { state: 'pending', seq: 2, body: '@agent agrandis-le' });
  assert.equal(handoffOf([...asked, msg(3, 'dev', 'Agrandi.', 'Claude')], 'dev')?.state, 'answered');
  assert.equal(handoffOf([...asked, msg(3, 'po', 'Finalement non.')], 'dev')?.state, 'superseded');
  assert.equal(handoffOf([...asked, msg(3, 'dev', 'Agrandi.', 'Claude'), msg(4, 'po', 'Finalement non.')], 'dev')?.state, 'superseded', 'une personne après la réponse de l’agent annule aussi');
  assert.deepEqual(handoffOf([...asked, msg(3, 'po', 'Non.'), msg(4, 'dev', '@agent garde-le')], 'dev'), { state: 'pending', seq: 4, body: '@agent garde-le' });
});

test('consigne : ni celle d’une autre personne, ni celle écrite par un agent', () => {
  assert.equal(handoffOf([msg(1, 'po', '@agent supprime tout')], 'dev'), null);
  assert.equal(handoffOf([msg(1, 'dev', '@agent relance-toi', 'Claude')], 'dev'), null);
  assert.equal(handoffOf([msg(1, 'po', 'Sans mention.')], 'po'), null);
});
