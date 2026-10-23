// CLI `socrate` du paquet : préparation et enregistrement des previews en CI, contrôle d'absence dans un build de production.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkAbsent } from './absent.ts';
import { CliError, type Io } from './io.ts';
import { prepare } from './prepare.ts';
import { register, TOKEN_ENV } from './register.ts';

const USAGE = `usage:
  socrate preview prepare --origin <origin of the preview> [--config socrate.yml]
  socrate preview register --url <deployed preview URL> [--config socrate.yml]
  socrate check-absent <build output directory> [--config socrate.yml]
  socrate --version`;

const SECRETS = [TOKEN_ENV, 'GITHUB_TOKEN', 'GH_TOKEN'];

/** Aucun jeton ne sort, même recopié par un message d'erreur. */
export function redact(text: string, env: Io['env']): string {
  return SECRETS.reduce((out, name) => {
    const secret = env[name];
    return secret && secret.length >= 8 ? out.replaceAll(secret, '***') : out;
  }, text);
}

export async function run(argv: string[], io: Io): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: { origin: { type: 'string' }, url: { type: 'string' }, config: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const command = positionals.join(' ');
  if (values.version) return io.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  if (values.help) return io.log(USAGE);
  if (command === 'preview prepare') return prepare(io, values);
  if (command === 'preview register') return register(io, values);
  if (positionals[0] === 'check-absent' && positionals.length <= 2) return checkAbsent(io, { dist: positionals[1], config: values.config });
  throw new CliError(USAGE, 2);
}

const env = process.env;
await run(process.argv.slice(2), { cwd: process.cwd(), env, log: (line) => console.log(redact(line, env)) }).catch((e: unknown) => {
  console.error(redact(`socrate: ${e instanceof Error ? e.message : String(e)}`, env));
  process.exitCode = e instanceof CliError ? e.exitCode : String((e as { code?: unknown })?.code).startsWith('ERR_PARSE_ARGS') ? 2 : 1;
});
