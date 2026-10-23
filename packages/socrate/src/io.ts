export type Io = { cwd: string; env: Record<string, string | undefined>; log: (line: string) => void };

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
