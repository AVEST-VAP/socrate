export type Me = { persona: string; displayName: string; role: 'relectrice' | 'developpeur' | 'invite'; exploring: { account: string; organisation: string | null } | null };

export async function me(): Promise<Me | null> {
  const r = await fetch('/api/me');
  return r.ok ? r.json() : null;
}
export async function login(persona: string): Promise<Me> {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona }) });
  if (!r.ok) throw new Error('connexion refusée');
  return r.json();
}
export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}
