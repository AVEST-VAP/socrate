export type Io = {
  cwd: string; env: Record<string, string | undefined>; log: (line: string) => void;
  /** Consignes et progression sur la sortie d'erreur : la sortie standard reste au résultat, lisible par un agent avec `--json`. */
  warn?: (line: string) => void;
  /** Texte lu sur l'entrée standard, pour un message passé en `-`. */
  stdin?: () => Promise<string>;
};

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Jetons lus ou reçus pendant la commande : `redact` les retire de toute sortie, même recopiés par un message d'erreur. */
export const secrets = new Set<string>();
