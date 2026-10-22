'use strict';
const mode = process.argv[2] ?? 'ready';
setInterval(() => undefined, 1_000);
process.on('SIGTERM', () => (mode === 'stubborn' ? undefined : process.exit(0)));
if (mode === 'ready' || mode === 'stubborn') console.log(mode);
else if (mode === 'exit-early') process.exit(3);
else if (mode === 'eof') require('node:fs').closeSync(1);
