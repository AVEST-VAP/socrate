/** Mention `@agent` : un simple mot du message. Elle ne déclenche rien ; la CLI et le panneau la lisent pour savoir ce qu'une personne confie à son agent. */
const MARK = /(?:^|[\s(])@agent(?![\p{L}\p{N}_-])/iu;
export const mentionsAgent = (body: string) => MARK.test(body);

type HandoffMessage = { seq: number; body: string; via?: string | null; author: { key: string } };
export type Handoff = { state: 'pending' | 'answered' | 'superseded'; seq: number; body: string };

/**
 * Dernière consigne de `actorKey` dans un fil, jamais celle d'une autre personne : un relecteur ne pilote pas l'agent d'un développeur.
 * Les messages qui la suivent décident de son état : aucun, elle attend ; d'une personne, elle est annulée, le travail repart de la conversation ; sinon, un agent y a répondu.
 */
export function handoffOf(messages: readonly HandoffMessage[], actorKey: string): Handoff | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.via || m.author.key !== actorKey || !mentionsAgent(m.body)) continue;
    const after = messages.slice(i + 1);
    return { state: !after.length ? 'pending' : after.some((n) => !n.via) ? 'superseded' : 'answered', seq: m.seq, body: m.body };
  }
  return null;
}

const fold = (t: string) => t.toLocaleLowerCase('fr');
/** `@Prénom Nom` en entier dans le texte, sans suite de nom. Une mention est du texte : elle prévient, elle ne donne aucun droit. */
export function mentionsName(body: string, displayName: string): boolean {
  const text = fold(body);
  const name = `@${fold(displayName)}`;
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    const before = text[i - 1];
    const after = text.slice(i + name.length);
    if ((before === undefined || /[\s(]/.test(before)) && !/^[\p{L}\p{N}_-]/u.test(after)) return true;
  }
  return false;
}

/** Une autre personne attend cette personne : mentionnée dans un message, et elle n'a rien écrit depuis. Les messages d'agent en son nom ne comptent pas comme sa réponse. */
export function waitsFor(messages: readonly HandoffMessage[], actor: { key: string; displayName: string }): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.author.key === actor.key && !m.via) return false;
    if (m.author.key !== actor.key && mentionsName(m.body, actor.displayName)) return true;
  }
  return false;
}
