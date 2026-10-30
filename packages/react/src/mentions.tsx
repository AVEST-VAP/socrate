import { useEffect, useState } from 'react';
import type { Actor } from '@socrate/contract';
import type { ReviewClient } from './client.ts';
import { Avatar } from './conversation.tsx';
import { AGENT_MENTION, matchMentions } from './mention.ts';

// Styles de ces suggestions, dans leur chunk.
const MENTIONS_CSS = `
.socrate-mentions { list-style: none; margin: 0; padding: 4px; border-top: 1px solid #e4e4e7; max-height: 180px; overflow: auto; }
.socrate-mentions li { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.socrate-mentions li[data-active] { background: #eff6ff; }
`;

const known = new WeakMap<ReviewClient, { at: number; asked: Promise<Actor[]> }>();
const FRESH_MS = 60_000;

/** Personnes qui ont déjà écrit sur le projet, gardées une minute : un nouvel auteur arrive sans recharger, et une frappe ne fait pas une requête. Un échec laisse la saisie libre et sera retenté. */
function peopleOf(client: ReviewClient): Promise<Actor[]> {
  const cached = known.get(client);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.asked;
  const url = `${client.preview.serviceUrl}/v1/projects/${encodeURIComponent(client.preview.projectId)}/people`;
  const asked = (async () => {
    const read = (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: client.signal });
    let res = await read((client.currentSession ?? (await client.openSession())).sessionToken);
    // Session expirée pendant la saisie : une seule reprise avec une session neuve.
    if (res.status === 401) res = await read((await client.openSession()).sessionToken);
    if (!res.ok) throw new Error(String(res.status));
    return ((await res.json()) as { items: Actor[] }).items;
  })();
  known.set(client, { at: Date.now(), asked });
  asked.catch(() => known.delete(client));
  return asked;
}

/** Suggestions sous le champ, dans le flux : la bulle grandit avec elles au lieu de les couper. Le champ garde le focus et ses flèches. */
export function MentionMenu({ client, me, query, active, onItems, onPick }: {
  client: ReviewClient; me: string | null; query: string; active: number; onItems: (names: string[]) => void; onPick: (name: string) => void;
}) {
  const [people, setPeople] = useState<Actor[]>([]);
  useEffect(() => {
    let live = true;
    peopleOf(client).then((p) => { if (live) setPeople(p); }, () => {});
    return () => { live = false; };
  }, [client]);
  const items = matchMentions(people.filter((p) => p.key !== me), query);
  const names = items.map((i) => i.displayName).join('\n');
  useEffect(() => onItems(names ? names.split('\n') : []), [names]);
  if (!items.length) return null;
  return (
    <>
    <style>{MENTIONS_CSS}</style>
    <ul className="socrate-mentions" id="socrate-mentions" role="listbox" aria-label="Personnes à mentionner" data-testid="socrate-mentions">
      {items.map((p, i) => (
        <li key={p.key} id={`socrate-mention-${i}`} role="option" aria-selected={i === active} data-active={i === active || undefined}
          onPointerDown={(e) => { e.preventDefault(); onPick(p.displayName); }}>
          {p.key !== AGENT_MENTION.key && <Avatar actor={p} />}
          <span>{p.key === AGENT_MENTION.key ? 'agent · pour votre agent, rien ne se lance' : p.displayName}</span>
        </li>
      ))}
    </ul>
    </>
  );
}
