import { useEffect, useState } from 'react';
import { SocrateReview, type NavigationAdapter, type PreviewContext } from '@socrate/react';
import type { Me } from './host-api.ts';

async function previewInfo(): Promise<PreviewContext> {
  const r = await fetch('/api/preview-context');
  if (!r.ok) throw new Error('contexte preview indisponible');
  return r.json();
}
async function identityAssertion(signal: AbortSignal): Promise<string> {
  const r = await fetch('/api/socrate/assertion', { method: 'POST', signal });
  if (!r.ok) throw new Error('assertion d’identité refusée par l’hôte');
  return (await r.json()).assertion;
}

// Mode éditorial de la démo : `?editorial=1` le retient pour l'origine, `?editorial=0` le retire ; il réactive guidage et revue des textes pour leurs tests.
const flag = new URLSearchParams(location.search).get('editorial');
if (flag) flag === '1' ? localStorage.setItem('socrate-editorial', '1') : localStorage.removeItem('socrate-editorial');
const editorial = localStorage.getItem('socrate-editorial') === '1';

export default function SocrateEntry({ user, navigation }: { user: Me; navigation: NavigationAdapter }) {
  const [preview, setPreview] = useState<PreviewContext | null>(null);
  useEffect(() => { void previewInfo().then(setPreview).catch(() => setPreview(null)); }, []);
  return preview && <SocrateReview key={`${user.persona}:${user.exploring?.account ?? ''}`} preview={preview} getIdentityAssertion={identityAssertion} navigation={navigation} editorial={editorial} />;
}
