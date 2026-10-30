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
