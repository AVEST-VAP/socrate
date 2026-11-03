import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffOf, lastActivity, mentionsAgent, mentionsName, ownReplies, ownThreads, replyTo, waitsFor } from '../src/handoff.ts';

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

test('mention de personne : nom entier, et elle attend tant que la personne n’a pas écrit', () => {
  assert.ok(mentionsName('@Noémie LEMAIRE tu valides ?', 'Noémie LEMAIRE'));
  assert.ok(mentionsName('ok (@noémie lemaire)', 'Noémie LEMAIRE'));
  assert.ok(!mentionsName('@Noémie LEMAIRE-DURAND', 'Noémie LEMAIRE'));
  assert.ok(!mentionsName('mail@Noémie LEMAIRE', 'Noémie LEMAIRE'));
  const noemie = { key: 'po', displayName: 'Noémie LEMAIRE' };
  const asked = [msg(1, 'po', 'Le bouton ?'), msg(2, 'dev', '@Noémie LEMAIRE c’est P1 ?')];
  assert.ok(waitsFor(asked, noemie));
  assert.ok(!waitsFor([...asked, msg(3, 'po', 'Oui.')], noemie), 'sa réponse lève l’attente');
  assert.ok(waitsFor([...asked, msg(3, 'po', 'Corrigé.', 'Claude')], noemie), 'son agent ne répond pas à sa place');
  assert.ok(!waitsFor([msg(1, 'po', '@Noémie LEMAIRE note pour moi')], noemie), 'se mentionner soi-même ne compte pas');
});

const at = (h: number) => `2026-11-02T${String(h).padStart(2, '0')}:00:00.000Z`;
const dated = (seq: number, key: string, h: number, via: string | null = null) => ({ ...msg(seq, key, `message ${seq}`, via), createdAt: at(h) });
const thread = (threadId: string, messages: ReturnType<typeof dated>[], updated = messages.at(-1)!.createdAt) => ({ threadId, createdAt: messages[0]!.createdAt, updatedAt: updated, messages });

test('réponse reçue : dernier message d’une autre personne ou d’un agent, jamais le sien', () => {
  assert.equal(replyTo([dated(1, 'po', 9)], 'po'), null, 'seule, elle attend une réponse');
  assert.equal(replyTo([dated(1, 'po', 9), dated(2, 'dev', 10)], 'po')?.seq, 2);
  assert.equal(replyTo([dated(1, 'po', 9), dated(2, 'dev', 10), dated(3, 'po', 11)], 'po'), null, 'sa réplique lève le signal');
  assert.equal(replyTo([dated(1, 'po', 9), dated(2, 'dev', 10, 'Claude')], 'po')?.seq, 2, 'agent d’un autre');
  assert.equal(replyTo([dated(1, 'po', 9), dated(2, 'po', 10, 'Claude')], 'po')?.seq, 2, 'son propre agent répond aussi');
  assert.equal(replyTo([], 'po'), null);
});

test('mes retours : fils dont elle a écrit le premier message, toutes pages et tous états, le plus récemment actif d’abord', () => {
  const ancien = thread('a', [dated(1, 'po', 8), dated(2, 'dev', 15)]);
  const recent = thread('b', [dated(1, 'po', 12)]);
  const resolu = thread('c', [dated(1, 'po', 9)], at(16));
  const autre = thread('d', [dated(1, 'dev', 7), dated(2, 'po', 17)]);
  const egal = thread('e', [dated(1, 'po', 12)]);
  assert.equal(lastActivity(resolu), at(16), 'changement d’état sans message');
  assert.equal(lastActivity(ancien), at(15));
  assert.deepEqual(ownThreads([recent, ancien, autre, resolu, egal], 'po').map((t) => t.threadId), ['c', 'a', 'b', 'e'], 'réponse au fil d’un autre exclue, égalité par identifiant');
  assert.equal(ownReplies([recent, ancien, autre, resolu, egal], 'po'), 1, 'seul le fil répondu compte ; une résolution sans message ne dit pas qui a répondu');
  assert.deepEqual(ownThreads([recent], 'dev'), []);
  assert.equal(ownReplies([autre], 'dev'), 1, 'réponse d’une autre personne au fil de dev');
});
