// Complète la CSP du fichier de headers d'un build de preview pour que le client joigne le service et affiche ses médias.
import { readFileSync, writeFileSync } from 'node:fs';

/** Le client appelle le service par `fetch` et affiche images et vidéos depuis des adresses `blob:` qu'il crée lui-même. */
export const CSP_SOURCES = (service: string) => ({ 'connect-src': service, 'img-src': 'blob:', 'media-src': 'blob:' });
const HEADER = /^(\s*Content-Security-Policy\s*:\s*)(.*?)(\s*)$/i;

export class CspError extends Error {}

/** Ajoute les sources du client à ses directives ; une directive absente part des sources de `default-src`. Sans `default-src`, elle reste libre. */
export function completePolicy(policy: string, service: string): string {
  const directives = policy.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]);
  const find = (name: string) => directives.find((d) => d[0]!.toLowerCase() === name);
  const fallback = find('default-src');
  for (const [name, source] of Object.entries(CSP_SOURCES(service))) {
    let directive = find(name);
    if (!directive) {
      if (!fallback) continue;
      directive = [name, ...fallback.slice(1)];
      directives.push(directive);
    }
    const sources = directive.slice(1).filter((s) => s.toLowerCase() !== "'none'");
    if (!sources.includes(source)) sources.push(source);
    directive.splice(1, directive.length - 1, ...sources);
  }
  return directives.map((d) => d.join(' ')).join('; ');
}

export function completeHeaders(text: string, service: string, file = 'headers file'): string {
  const lines = text.split('\n');
  const found = lines.flatMap((line, i) => (HEADER.test(line) ? [i] : []));
  if (found.length !== 1) throw new CspError(`${file} must contain exactly one Content-Security-Policy line, found ${found.length}`);
  const i = found[0]!;
  const [, head, policy, tail] = HEADER.exec(lines[i]!)!;
  if (!policy) throw new CspError(`${file}: the Content-Security-Policy line is empty`);
  lines[i] = `${head}${completePolicy(policy, service)}${tail}`;
  return lines.join('\n');
}

export function completeHeadersFile(path: string, service: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CspError(`csp: ${path} not found in the build output`);
  }
  writeFileSync(path, completeHeaders(text, service, path));
}
