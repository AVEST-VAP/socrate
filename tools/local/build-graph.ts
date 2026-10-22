/** Fichiers chargés par des imports statiques, une seule fois même avec partage ou cycle. */
export function staticClosure(chunks: ReadonlyArray<{ file: string; imports: readonly string[] }>, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of chunks.find((c) => c.file === file)?.imports ?? []) visit(dependency);
  };
  roots.forEach(visit);
  return [...seen];
}
