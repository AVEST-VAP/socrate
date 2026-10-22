import { Fragment } from 'react';
import type { Manifest, Target, ThreadWithMessages, Wording } from '@socrate/contract';
import type { Owner, ReviewClient, Submission, SubmissionView } from './client.ts';
import { Notice, useSubmission } from './conversation.tsx';
import { ProposalView } from './proposal.tsx';

type Shared = { client: ReviewClient; threads: ThreadWithMessages[]; refresh: () => Promise<void>; seen: Owner | null; canParticipate: boolean; revisionId: string };

// Styles livrés avec ce chunk, rendus en place dans l'iframe (sans hoisting React vers le document de l'hôte).
const STYLE = <style>{`
.socrate-proposals { list-style: none; padding: 0; margin: 6px 0; }
.socrate-facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 4px 0; }
.socrate-facts dd { margin: 0; overflow-wrap: anywhere; }
`}</style>;

const LABELS = {
  sending: 'Publication de la proposition…',
  published: 'Proposition publiée, sans capture.',
  keptEdit: 'Votre proposition précédente est publiée. Le texte modifié depuis reste en brouillon.',
  refreshFailed: 'Proposition publiée. La liste n’a pas pu être rechargée.',
};

/** Revue regroupée : seulement la sélection éditoriale du manifeste, jamais un inventaire des textes de la page. */
export function WordingReview({ manifest, ...shared }: Shared & { manifest: Manifest }) {
  return <>{STYLE}{(manifest.wordings ?? []).map((w) => <WordingCard key={w.id} wording={w} zone={manifest.zones.find((z) => z.id === w.zone)?.title} {...shared} />)}</>;
}

function WordingFacts({ wording, zone }: { wording: Wording; zone?: string }) {
  return (
    <dl className="socrate-meta socrate-facts">
      {(zone || wording.context) && <><dt>Contexte</dt><dd>{[zone, wording.context].filter(Boolean).join(' · ')}</dd></>}
      {wording.variant && <><dt>Variante</dt><dd>{wording.variant}</dd></>}
      <dt>Langue</dt><dd>{wording.locale}</dd>
      {wording.key && <><dt>Clé</dt><dd>{wording.key}</dd></>}
      <dt>Source</dt><dd data-testid="socrate-wording-source">{wording.source}</dd>
      {wording.examples?.map((e) => <Fragment key={e}><dt>Rendu</dt><dd>{e}</dd></Fragment>)}
    </dl>
  );
}

function WordingCard({ wording, zone, client, threads, refresh, seen, canParticipate, revisionId }: Shared & { wording: Wording; zone?: string }) {
  const { submission, view } = useSubmission(client, { kind: 'proposal', wordingId: wording.id }, LABELS, refresh);
  const pending = view.phase.kind === 'uncertain' || view.phase.kind === 'identity-blocked';
  const field = `socrate-proposal-${wording.id}`;
  return (
    <article className="socrate-zone" data-testid="socrate-wording" data-wording={wording.id}>
      <h3>{wording.question}</h3>
      <WordingFacts wording={wording} zone={zone} />
      <Proposals wordingId={wording.id} threads={threads} />
      <Notice view={view} submission={submission} testId="socrate-pending-proposal" />
      <label htmlFor={field} className="socrate-visually-hidden">Remplacement proposé pour « {wording.source} »</label>
      <textarea id={field} className="socrate-textarea" rows={2} value={view.draft.text} onChange={(e) => submission.edit(e.target.value)} placeholder="Remplacement proposé" disabled={!canParticipate} />
      <div className="socrate-actions">
        <button type="button" className="socrate-button" onClick={() => seen && void submission.publish({ seen, revisionId })}
          disabled={view.phase.kind === 'sending' || !canParticipate || !seen || (!view.draft.text.trim() && !pending)}>Proposer</button>
      </div>
    </article>
  );
}

/** Mêmes propositions depuis la liste et depuis la page : le seul critère est l'identifiant déclaré, jamais l'égalité du texte. */
function Proposals({ wordingId, threads }: { wordingId: string; threads: ThreadWithMessages[] }) {
  const found = threads.filter((t) => t.proposal?.wording?.id === wordingId);
  if (found.length === 0) return <p className="socrate-meta">Aucune proposition pour ce texte.</p>;
  return (
    <ul className="socrate-proposals" data-testid="socrate-wording-proposals" aria-label="Propositions pour ce texte">
      {found.map((t) => (
        <li key={t.threadId}>
          <ProposalView proposal={t.proposal!} />
          <span className="socrate-meta">{t.author.displayName} · {t.kind === 'targeted' ? 'depuis la page, avec capture' : 'depuis la revue regroupée'}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Proposition depuis la page : l'élément rattaché montre son texte préparé et ses propositions, un texte libre garde son extrait sans clé.
 * Le remplacement appartient au brouillon du retour ciblé : il survit à l'arrêt du partage et aux reprises, et ne passe à un nouveau ciblage que sur demande.
 */
export function PageProposal({ manifest, target, threads, submission, view, disabled }: {
  manifest: Manifest; target: Target | null; threads: ThreadWithMessages[]; submission: Submission; view: SubmissionView; disabled: boolean;
}) {
  const r = view.draft.replacement;
  const wording = target?.wording ? manifest.wordings?.find((w) => w.id === target.wording) ?? null : null;
  const absent = !!target?.wording && !wording;
  const zone = manifest.zones.find((z) => z.id === wording?.zone)?.title;
  const here = r && r.for === target ? r : null;
  const kept = r && !here && r.text.trim() ? r : null;
  const editor = (d: NonNullable<typeof r>) => (
    <>
      <label htmlFor="socrate-page-replacement" className="socrate-visually-hidden">Remplacement proposé</label>
      <textarea id="socrate-page-replacement" className="socrate-textarea" rows={2} value={d.text} onChange={(e) => submission.editReplacement({ text: e.target.value, for: d.for })} placeholder="Remplacement proposé" disabled={disabled} />
    </>
  );
  return (
    <div className="socrate-proposal-editor" data-testid="socrate-page-proposal" data-wording={wording?.id ?? ''}>
      {STYLE}
      {target && (wording ? (
        <>
          <p className="socrate-meta">Élément rattaché au texte à relire : <strong>{wording.question}</strong></p>
          <WordingFacts wording={wording} zone={zone} />
          <Proposals wordingId={wording.id} threads={threads} />
        </>
      ) : absent
        ? <p className="socrate-meta" data-testid="socrate-wording-absent">Élément rattaché à « {target.wording} », absent de la sélection de cette révision : aucun remplacement n’est proposé, le commentaire reste possible.</p>
        : <p className="socrate-meta" data-testid="socrate-free-text">Texte libre, sans clé de traduction : « {target.text} »</p>)}
      {kept ? (
        <div data-testid="socrate-kept-replacement">
          <p className="socrate-status" data-kind="error" role="status">Remplacement rédigé pour « {kept.for.text.slice(0, 80)} »{target ? ', pas pour ce ciblage : il n’est publié qu’une fois rattaché.' : ' : ciblez à nouveau puis rattachez-le pour le publier.'}</p>
          {editor(kept)}
          {target && !absent && <button type="button" className="socrate-button secondary" onClick={() => submission.editReplacement({ text: kept.text, for: target })} disabled={disabled}>Rattacher à l’élément ciblé</button>}
          <button type="button" className="socrate-button link" onClick={() => submission.editReplacement(null)}>Retirer la proposition</button>
        </div>
      ) : here ? (
        <>
          {editor(here)}
          <button type="button" className="socrate-button link" onClick={() => submission.editReplacement(null)}>Retirer la proposition</button>
        </>
      ) : target && !absent && (
        <button type="button" className="socrate-button secondary" onClick={() => submission.editReplacement({ text: '', for: target })} disabled={disabled || (!wording && !target.text.trim())}>Proposer un remplacement</button>
      )}
    </div>
  );
}
