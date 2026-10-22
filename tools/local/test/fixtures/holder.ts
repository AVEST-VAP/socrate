import { localPath, runtime } from '../../local-run.ts';

const rt = await runtime();
const root = localPath(process.argv[2]!);
const claim = rt.claimRoot(root);
if (claim === 'busy') {
  console.log('busy');
  process.exit(3);
}
console.log('held');
setInterval(() => undefined, 1_000);
process.on('SIGTERM', () => {
  claim.release();
  process.exit(0);
});
