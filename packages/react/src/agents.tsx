import { useCallback, useEffect, useState, type FormEvent, type RefObject } from 'react';
import { USER_CODE_PATTERN, formatUserCode, normalizeUserCode, type AgentToken, type DeviceDetails } from '@socrate/contract';
import { SocrateApiError, type ReviewClient } from './client.ts';
import { ICON } from './conversation.tsx';

// Styles de cette vue, dans son chunk : le panneau chargé à l'arrivée n'en porte rien.
const AGENTS_CSS = `
.socrate-input { flex: 1; height: 36px; padding: 0 10px; border: 1px solid #e4e4e7; border-radius: 8px; font: inherit; letter-spacing: .08em; text-transform: uppercase; }
.socrate-input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgb(37 99 235 / .16); }
.socrate-card { border: 1px solid #e4e4e7; border-radius: 10px; padding: 12px; margin-top: 10px; }
.socrate-card p { margin: 0 0 8px; }
.socrate-agents ul { list-style: none; margin: 0; padding: 0; }
.socrate-agent { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 8px 0; border-top: 1px solid #f4f4f5; }
`;

/**
 * Route du projet sous la session du panneau, renouvelée une fois si le service la dit expirée : lecture, ou décision et révocation sans corps.
 * Ici plutôt que dans le client, pour que le panneau chargé à l'arrivée n'en porte rien.
 */
async function projectCall<T>(client: ReviewClient, path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const url = `${client.preview.serviceUrl}/v1/projects/${encodeURIComponent(client.preview.projectId)}${path}`;
  for (let attempt = 0; ; attempt++) {
    const session = (attempt === 0 && client.currentSession) || (await client.openSession());
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${session.sessionToken}` }, signal: client.signal }).catch(() => {
      throw new Error('Réseau indisponible : la réponse du service n’est pas arrivée.');
    });
    const body = await res.json().catch(() => null);
    if (res.ok) return body as T;
    if (attempt === 0 && (body?.code === 'session_expired' || body?.code === 'unauthenticated')) continue;
    throw new SocrateApiError(res.status, body ?? { code: 'persistence_uncertain', message: `HTTP ${res.status}`, requestId: '', retryable: true });
  }
}

/** Après Autoriser, la commande récupère son jeton à sa prochaine scrutation : la liste est relue jusqu'à le voir, 30 secondes au plus. */
const AWAIT_EVERY_MS = 2000;
const AWAIT_FOR_MS = 30_000;

const date = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const reason = (e: unknown) => (e instanceof SocrateApiError || e instanceof Error ? e.message : 'Erreur inattendue.');

type Step =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'details'; details: DeviceDetails }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string };

/**
 * « Connecter un agent » : code affiché par `npx @meyer0x/socrate login`, détails relus au service, avertissement, puis décision explicite ; « Mes agents » liste
 * et révoque les jetons délégués de la personne connectée. Chargé seulement quand on l'ouvre.
 */
export function AgentsView({ client, onBack, onClose, headingRef }: { client: ReviewClient; onBack: () => void; onClose: () => void; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [agents, setAgents] = useState<AgentToken[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<DeviceDetails | null>(null);
  const project = client.preview.projectId;

  const reload = useCallback(async () => {
    try {
      setAgents((await projectCall<{ items: AgentToken[] }>(client, '/agents')).items);
      setListError(null);
    } catch (e) {
      setListError(reason(e));
    }
  }, [client]);
  useEffect(() => {
    headingRef.current?.focus();
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!awaiting) return;
    let stopped = false;
    const until = Date.now() + AWAIT_FOR_MS;
    // Le jeton de cette demande : même agent et même machine, émis après la demande.
    const arrived = (a: AgentToken) => a.agent === awaiting.agent && a.machine === awaiting.machine && a.createdAt >= awaiting.createdAt;
    void (async () => {
      while (!stopped && Date.now() < until) {
        await new Promise((r) => setTimeout(r, AWAIT_EVERY_MS));
        if (stopped) return;
        try {
          const items = (await projectCall<{ items: AgentToken[] }>(client, '/agents')).items;
          if (stopped) return;
          setAgents(items);
          setListError(null);
          if (items.some(arrived)) break;
        } catch (e) {
          if (!stopped) setListError(reason(e));
        }
      }
      if (!stopped) setAwaiting(null);
    })();
    return () => { stopped = true; };
  }, [awaiting, client]);

  const typed = normalizeUserCode(code);
  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    if (!USER_CODE_PATTERN.test(typed)) return setStep({ kind: 'error', text: 'Le code compte huit caractères, comme KPXD-4821.' });
    setStep({ kind: 'busy', text: 'Vérification du code…' });
    try {
      setStep({ kind: 'details', details: await projectCall<DeviceDetails>(client, `/devices/${typed}`) });
    } catch (err) {
      setStep({ kind: 'error', text: reason(err) });
    }
  };
  const decide = async (details: DeviceDetails, approve: boolean) => {
    setStep({ kind: 'busy', text: approve ? 'Autorisation…' : 'Refus…' });
    try {
      await projectCall(client, `/devices/${normalizeUserCode(details.userCode)}/${approve ? 'approve' : 'deny'}`, 'POST');
      setCode('');
      setStep({ kind: 'done', text: approve ? `${details.agent} sur ${details.machine} est autorisé. Revenez au terminal : la commande se termine d’elle-même.` : 'Demande refusée. La commande s’arrête sans jeton.' });
      if (approve) setAwaiting(details);
    } catch (err) {
      setStep({ kind: 'error', text: reason(err) });
    }
  };
  const revoke = async (a: AgentToken) => {
    try {
      await projectCall(client, `/agents/${encodeURIComponent(a.tokenId)}/revoke`, 'POST');
      setAgents((list) => list?.filter((x) => x.tokenId !== a.tokenId) ?? null);
    } catch (e) {
      setListError(reason(e));
    }
  };

  return (
    <div className="socrate-panel socrate-agents" data-testid="socrate-agents" onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); }}>
      <style>{AGENTS_CSS}</style>
      <div className="socrate-list-head">
        <div className="socrate-list-title">
          <button type="button" className="socrate-icon" aria-label="Retour aux conversations" data-socrate-tip="Retour aux conversations" onClick={onBack}>{ICON.list}</button>
          <h1 ref={headingRef} tabIndex={-1}>Agents</h1>
          <button type="button" className="socrate-icon" aria-label="Fermer" data-socrate-tip="Fermer · Échap" onClick={onClose}>{ICON.close}</button>
        </div>
      </div>
      <div className="socrate-body">
        <section className="socrate-section" aria-labelledby="socrate-connecter">
          <h2 id="socrate-connecter">Connecter un agent</h2>
          <p className="socrate-meta">Dans le terminal de votre dépôt, lancez <code>npx @meyer0x/socrate login</code>, puis saisissez le code qu’il affiche.</p>
          <form className="socrate-actions" onSubmit={lookup}>
            <label htmlFor="socrate-code" className="socrate-visually-hidden">Code affiché par la commande</label>
            <input id="socrate-code" className="socrate-input" value={code} onChange={(e) => { setCode(e.target.value); if (step.kind !== 'busy') setStep({ kind: 'idle' }); }}
              placeholder="XXXX-XXXX" autoComplete="off" spellCheck={false} maxLength={12} data-testid="socrate-code" />
            <button type="submit" className="socrate-button secondary" disabled={step.kind === 'busy' || !typed}>Continuer</button>
          </form>
          {step.kind === 'busy' && <p className="socrate-status" role="status">{step.text}</p>}
          {step.kind === 'error' && <p className="socrate-status" data-kind="error" role="alert">{step.text}</p>}
          {step.kind === 'done' && <p className="socrate-status" data-kind="success" role="status" data-testid="socrate-agent-done">{step.text}</p>}
          {step.kind === 'details' && (
            <div className="socrate-card" data-testid="socrate-device">
              <p><strong>Autoriser {step.details.agent} sur {step.details.machine} à lire, répondre et résoudre en votre nom sur {project} ?</strong></p>
              <p className="socrate-meta">Code {formatUserCode(normalizeUserCode(step.details.userCode))} · demandé le {date(step.details.createdAt)} · valable jusqu’à {date(step.details.expiresAt)}. L’accès dure 30 jours et se révoque ici.</p>
              <p className="socrate-status" data-kind="error">N’approuvez que si vous venez de lancer cette commande.</p>
              <div className="socrate-actions">
                <button type="button" className="socrate-button" onClick={() => void decide(step.details, true)}>Autoriser</button>
                <button type="button" className="socrate-button secondary" onClick={() => void decide(step.details, false)}>Refuser</button>
              </div>
            </div>
          )}
        </section>
        <section className="socrate-section" aria-labelledby="socrate-mes-agents">
          <h2 id="socrate-mes-agents">Mes agents</h2>
          {listError && <p className="socrate-status" data-kind="error" role="alert">{listError}</p>}
          {awaiting && <p className="socrate-status" role="status" data-testid="socrate-agent-awaiting">En attente de la commande…</p>}
          {agents?.length === 0 && !awaiting && <p className="socrate-meta">Aucun agent connecté sur {project}.</p>}
          <ul aria-label="Mes agents">
            {agents?.map((a) => (
              <li key={a.tokenId} className="socrate-agent" data-testid="socrate-agent">
                <div>
                  <strong>{a.agent}</strong> sur {a.machine}
                  <div className="socrate-meta">Connecté le {date(a.createdAt)} · {a.lastUsedAt ? `utilisé le ${date(a.lastUsedAt)}` : 'jamais utilisé'} · expire le {date(a.expiresAt)}</div>
                </div>
                <button type="button" className="socrate-button secondary" onClick={() => void revoke(a)} aria-label={`Révoquer ${a.agent} sur ${a.machine}`}>Révoquer</button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
