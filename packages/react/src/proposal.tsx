import type { Proposal } from '@socrate/contract';

// Vue de lecture seule, chargée dès qu'un fil porte une proposition : ni la revue des textes ni l'éditeur n'y sont liés.
const STYLE = '.socrate-proposal { border-left: 3px solid #2a4fd6; padding: 4px 8px; margin: 6px 0; } .socrate-proposal p { white-space: pre-wrap; overflow-wrap: anywhere; }';

export function ProposalView({ proposal }: { proposal: Proposal }) {
  const w = proposal.wording;
  const d = proposal.drift;
  return (
    <div className="socrate-proposal" data-testid="socrate-proposal" data-drift={d?.status ?? 'libre'}>
      <style>{STYLE}</style>
      <p><strong>Original</strong> « {proposal.original} »</p>
      <p><strong>Remplacement</strong> « {proposal.replacement} »</p>
      <p className="socrate-meta">
        {w ? `Texte préparé ${w.id}${w.key ? `, clé ${w.key}` : ''}, ${w.locale}${w.variant ? `, ${w.variant}` : ''}` : 'Texte libre, sans clé de traduction'} · révision source {proposal.sourceRevisionId.slice(0, 8)}
      </p>
      {d && d.status !== 'current' && (
        <p className="socrate-status" data-kind="error" role="status" data-testid="socrate-drift">
          Décalage : {d.status === 'changed' ? <>dans la révision {d.revisionId.slice(0, 8)}, le texte source vaut « {d.currentSource} »</> : <>ce texte est absent de la sélection de la révision {d.revisionId.slice(0, 8)}</>}. L’original de la proposition est conservé.
        </p>
      )}
    </div>
  );
}

