import { LocalRefusal, instanceName, localCommand, portNumber } from './local-run.ts';

const name = instanceName(process.env.SOCRATE_INSTANCE ?? 'demo');
const ports = { service: portNumber(process.env.SOCRATE_SERVICE_PORT ?? 8787, 'service'), demo: portNumber(process.env.SOCRATE_DEMO_PORT ?? 5173, 'démo') };
const deadlineMs = Number(process.env.SOCRATE_LAUNCH_DEADLINE_MS ?? 60_000);
if (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 600_000) throw new LocalRefusal('deadline_invalid', `échéance de lancement refusée : ${JSON.stringify(process.env.SOCRATE_LAUNCH_DEADLINE_MS)} (entier de millisecondes, 600 000 au plus)`);
const report = await localCommand({ action: 'launch', instance: name, ports, reset: process.argv.includes('--reset'), deadlineMs, log: console.log });
if (report.kind !== 'ready') {
  console.error(report.kind === 'refused' ? `lancement refusé (${report.reason}) : ${report.detail}` : `rapport inattendu ${report.kind}`);
  process.exit(1);
}
console.log(`démonstration : ${report.instance.demoOrigin} (instance ${report.instance.instanceId}, Ctrl+C pour arrêter les deux services)`);
