import type { Actor } from '@socrate/contract';

/** Pseudo-personne en tête des suggestions. */
export const AGENT_MENTION: Actor = { key: '@agent', displayName: 'agent' };
const MAX = 6;
const fold = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Fragment `@…` en cours de saisie, du `@` jusqu'au curseur, ou null. Deux mots au plus : prénom et nom. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|[\s(])@([\p{L}\p{N}'’-]*(?: [\p{L}\p{N}'’-]*)?)$/u.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]! } : null;
}

export function matchMentions(people: Actor[], query: string): Actor[] {
  const q = fold(query);
  return [AGENT_MENTION, ...people].filter((p) => fold(p.displayName).split(/\s+/).some((w) => w.startsWith(q)) || fold(p.displayName).startsWith(q)).slice(0, MAX);
}

/** Remplace le fragment par la mention complète ; rend le texte et la position du curseur. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const before = `${text.slice(0, start)}@${name} `;
  return { text: before + text.slice(caret).replace(/^ /, ''), caret: before.length };
}
