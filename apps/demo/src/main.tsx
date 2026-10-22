import { Component, StrictMode, Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { NavigationAdapter } from '@socrate/react';
import { login, logout, me, type Me } from './host-api.ts';
import { RappelModal } from './scene-modal.tsx';

// Une seule revue par onglet : l'application ouverte dans la vue scindée ne monte pas Socrate.
const SocrateEntry = __SOCRATE_PREVIEW__ && window === window.top ? lazy(() => import('./socrate.tsx')) : null;

class OptionalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Déploiement B fictif de la continuité : la mention de rappel disparaît, un statut précède le client, le rendez-vous de 14 h 30 est listé deux fois et la vue scindée montre deux applications. */
const SCENE_B = __SOCRATE_PREVIEW__ && __DEMO_SCENE_B__;

const listeners = new Set<() => void>();
const navigation: NavigationAdapter = {
  current: () => window.location.pathname,
  go: (route) => {
    window.history.pushState(null, '', route);
    listeners.forEach((l) => l());
  },
};
window.addEventListener('popstate', () => listeners.forEach((l) => l()));
const useRoute = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => window.location.pathname);

function Link({ to, children }: { to: string; children: React.ReactNode }) {
  return <a href={to} onClick={(e) => { e.preventDefault(); navigation.go(to); }}>{children}</a>;
}

const PERSONAS: Array<{ id: string; label: string }> = [
  { id: 'claire', label: 'Claire Morel, relectrice produit' },
  { id: 'karim', label: 'Karim Benali, développeur' },
  { id: 'claire-impersonation', label: 'Claire Morel explorant le compte du Cabinet Dupont' },
  { id: 'invite', label: 'Invité sans capacité de participation' },
];

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <main style={{ padding: 32 }}>
      <h1>Agenda Démo</h1>
      <p>Application hôte fictive. Choisissez une identité fictive pour ouvrir une session de l’hôte.</p>
      {PERSONAS.map((p) => (
        <button key={p.id} className="persona" disabled={busy} onClick={async () => { setBusy(true); onLogin(await login(p.id)); }}>
          Se connecter comme {p.label}
        </button>
      ))}
    </main>
  );
}

function Settings({ route }: { route: string }) {
  const [delay, setDelay] = useState('24');
  return (
    <div className="layout settings">
      <aside>
        <h2>Réglages</h2>
        <nav><Link to="/reglages/general">Général</Link><Link to="/reglages/rappels">Rappels</Link></nav>
      </aside>
      <main>
        {route === '/reglages/rappels' ? (
          <article {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'reglages-rappels' })}>
            <h1>Rappels automatiques</h1>
            <label {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'rappel-delai' })}>Délai de rappel avant le rendez-vous (heures) <input value={delay} onChange={(e) => setDelay(e.target.value)} /></label>
            <p {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'rappel-libelle' })}>Libellé affiché au client : « Rappel automatique ».</p>
            <RappelModal />
          </article>
        ) : (
          <article><h1>Général</h1><p>Nom du cabinet, horaires, fuseau.</p></article>
        )}
      </main>
    </div>
  );
}

// Traductions fictives de l'hôte : Socrate ne les lit ni ne les modifie, seul l'attribut déclaré rattache un élément à un texte préparé.
const TEXTES = {
  'rdv.rappel.sms': 'Un rappel vous sera envoyé par SMS {delai} avant le rendez-vous.',
  'rdv.rappel.email': 'Un rappel vous sera envoyé par e-mail {delai} avant le rendez-vous.',
};
const t = (key: keyof typeof TEXTES, values: Record<string, string>) => TEXTES[key].replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');

function Application({ route }: { route: string }) {
  return (
    <div className="layout">
      <main>
        {route.startsWith('/rendez-vous/') ? (
          <article {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'fiche-rendez-vous' })}>
            <h1>Rendez-vous du 21 octobre, 14 h 30</h1>
            {SCENE_B && <p>Statut : confirmé par le client.</p>}
            <p>Mme Fictive Durand · Consultation</p>
            {SCENE_B ? <p>Rappel envoyé la veille.</p> : <p {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'rappel-mention' })}><em>Rappel recalculé</em> : envoi prévu la veille à 14 h 30.</p>}
            <p data-testid="variante-sms" {...(__SOCRATE_PREVIEW__ && { 'data-socrate-wording': 'rappel-sms' })}>{t('rdv.rappel.sms', { delai: '24 heures' })}</p>
            <p data-testid="variante-email" {...(__SOCRATE_PREVIEW__ && { 'data-socrate-wording': 'rappel-email' })}>{t('rdv.rappel.email', { delai: '24 heures' })}</p>
            <ul aria-label="Historique du rappel">
              <li data-testid="occurrence-1">Rappel recalculé</li>
              <li data-testid="occurrence-2">Rappel recalculé</li>
            </ul>
            <button>Modifier l’heure</button>
          </article>
        ) : (
          <article>
            <h1>Agenda</h1>
            <p>Semaine du 20 octobre.</p>
            <ul>
              <li {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'ligne-rendez-vous', 'data-socrate-instance': 'rdv-1042' })}><Link to="/rendez-vous/rdv-1042">Ouvrir le rendez-vous de 14 h 30</Link></li>
              <li {...(__SOCRATE_PREVIEW__ && { 'data-socrate-id': 'ligne-rendez-vous', 'data-socrate-instance': 'rdv-1043' })}>Rendez-vous de 16 h, sans rappel</li>
              {SCENE_B && <li data-socrate-id="ligne-rendez-vous" data-socrate-instance="rdv-1042">Rappel du rendez-vous de 14 h 30</li>}
            </ul>
          </article>
        )}
      </main>
    </div>
  );
}

const CONTACTS = { durand: 'Mme Fictive Durand', martin: 'M. Fictif Martin', petit: 'Mme Fictive Petit' };
type Contact = keyof typeof CONTACTS;
const ACTIVITY_KEY = 'demo-activite';
const DOT = { width: 12, height: 12, borderRadius: 6 };
const BERNARD = 'Appel de M. Fictif Bernard';
const CALLS = Array.from({ length: 40 }, (_, i) => ({ id: i, label: i === 4 || i === 24 ? BERNARD : `Appel n° ${i + 1}` }));

/**
 * Page d'activité d'une application métier, sans aucun attribut Socrate : indicateur vide parmi des blocs vides sans rapport, note de suivi,
 * lignes aux boutons identiques déplaçables et supprimables (ordre gardé pour l'onglet), longue liste de relances indiscernables,
 * longue liste d'appels distincts sauf deux jumeaux dont le premier est supprimable, courte liste d'étiquettes identiques.
 */
function Activity() {
  const [rows, setRows] = useState<Contact[]>(() => JSON.parse(sessionStorage.getItem(ACTIVITY_KEY) ?? '["durand","martin","petit"]'));
  const [calls, setCalls] = useState(CALLS);
  const save = (next: Contact[]) => { sessionStorage.setItem(ACTIVITY_KEY, JSON.stringify(next)); setRows(next); };
  return (
    <div className="layout">
      <main>
        <article>
          <h1>Activité</h1>
          <div className="outils"><button type="button" aria-label="Notifications"><div className="pictogramme" style={{ ...DOT, background: '#888' }} /><div className="indicateur" data-testid="indicateur" style={{ ...DOT, background: '#c33' }} /></button></div>
          <section><h2>Suivi</h2><p data-testid="note-suivi">Rappeler Mme Fictive Durand avant vendredi.</p></section>
          <ul aria-label="Contacts">
            {/* Clés d'index : comme certaines listes réelles, l'hôte recycle les nœuds d'une ligne pour une autre. */}
            {rows.map((id, i) => <li key={i} data-testid={`contact-${id}`}><span>{CONTACTS[id]}</span> <button type="button">Modifier</button></li>)}
          </ul>
          <p>
            <button type="button" onClick={() => save(['martin', ...rows.filter((r) => r !== 'martin')])}>Remonter M. Fictif Martin</button>
            <button type="button" onClick={() => save(rows.filter((r) => r !== 'martin'))}>Retirer M. Fictif Martin</button>
          </p>
          <div className="espaceurs">{Array.from({ length: 6 }, (_, i) => <div key={i} />)}</div>
          <ul aria-label="Relances" style={{ columns: 4 }}>{Array.from({ length: 40 }, (_, i) => <li key={i}><span>Relance</span></li>)}</ul>
          <ul aria-label="Appels" style={{ columns: 4 }}>{calls.map((c) => <li key={c.id}><span>{c.label}</span></li>)}</ul>
          <p><button type="button" onClick={() => setCalls(calls.filter((c) => c.id !== 4))}>Retirer le premier appel de M. Fictif Bernard</button></p>
          <ul aria-label="Étiquettes">{Array.from({ length: 3 }, (_, i) => <li key={i}>À rappeler</li>)}</ul>
        </article>
      </main>
    </div>
  );
}

/** Vue scindée : l'application elle-même en iframe de même origine, à côté d'un widget tiers d'origine opaque (iframe sandbox sans allow-same-origin). */
function SplitView() {
  const [open, setOpen] = useState(true);
  const [exports, setExports] = useState(0);
  return (
    <div className="layout split">
      <main>
        <article>
          <h1>Vue scindée</h1>
          <p>Semaine du 20 octobre, comparée aux réglages.</p>
          <button data-testid="split-export" onClick={() => setExports((n) => n + 1)}>Exporter la semaine</button>
          <p>Exports : <output data-testid="split-exports">{exports}</output></p>
          <button data-testid="split-toggle" onClick={() => setOpen(!open)}>{open ? 'Fermer la vue scindée' : 'Ouvrir la vue scindée'}</button>
          <iframe title="Widget tiers" sandbox="allow-scripts" srcDoc={'<button onclick="this.textContent=\'Widget cliqué\'">Widget tiers</button>'} />
        </article>
      </main>
      {open && <iframe title="Application en vue scindée" src="/reglages/rappels" data-testid="split-frame" />}
      {open && SCENE_B && <iframe title="Seconde application en vue scindée" src="/reglages/rappels" />}
    </div>
  );
}

function App() {
  const route = useRoute();
  const [user, setUser] = useState<Me | null | undefined>(undefined);
  useEffect(() => { void me().then(setUser); }, []);
  if (user === undefined) return <main style={{ padding: 32 }}>Chargement de l’hôte…</main>;
  if (!user) return <Login onLogin={setUser} />;
  return (
    <>
      <header className="topbar">
        <nav><Link to="/">Agenda</Link><Link to="/reglages/rappels">Réglages</Link><Link to="/vue-scindee">Vue scindée</Link><Link to="/activite">Activité</Link></nav>
        <span>
          {user.displayName}{user.exploring ? ` · explore ${user.exploring.organisation}` : ''}{' '}
          <button onClick={async () => { await logout(); setUser(null); }}>Se déconnecter</button>
        </span>
      </header>
      {route === '/vue-scindee' ? <SplitView /> : route === '/activite' ? <Activity /> : route.startsWith('/reglages') ? <Settings route={route} /> : <Application route={route} />}
      {SocrateEntry && <OptionalBoundary><Suspense fallback={null}><SocrateEntry user={user} navigation={navigation} /></Suspense></OptionalBoundary>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
