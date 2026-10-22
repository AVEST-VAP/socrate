// Sans dépendance : importé par le chunk navigateur de capture sans entraîner les schémas zod.
export const HTML_ATTRIBUTES = ['class', 'role', 'type', 'for', 'data-socrate-id', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-haspopup', 'aria-modal'] as const;
const HTML_UNSAFE = /<\s*\/?\s*(script|style|iframe|object|embed|link|meta)\b|javascript:/i;

const HTML_TOKEN = /([^<]+)|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/y;
const HTML_ATTRIBUTE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'))?/g;

/**
 * Forme canonique du sérialiseur client : texte sans `<`, balises dont chaque attribut est nu ou cité, rien d'autre
 * (ni commentaire, ni valeur non citée). Les valeurs citées sont sautées en bloc, un `>` cité ne ferme donc pas la balise.
 * Refuse balises actives et tout attribut hors liste ; l'extrait n'est jamais réinjecté comme HTML.
 */
export function isSanitizedHtml(html: string): boolean {
  if (HTML_UNSAFE.test(html)) return false;
  HTML_TOKEN.lastIndex = 0;
  while (HTML_TOKEN.lastIndex < html.length) {
    const m = HTML_TOKEN.exec(html);
    if (!m) return false;
    for (const a of (m[4] ?? '').matchAll(HTML_ATTRIBUTE)) if (!(HTML_ATTRIBUTES as readonly string[]).includes(a[1]!.toLowerCase())) return false;
  }
  return true;
}
