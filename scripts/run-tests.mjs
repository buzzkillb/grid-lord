// Portable test runner.
//
// `node --test test/*.test.ts` relies on the shell to expand the glob, which
// cmd.exe on Windows does not do, and Node 20's test runner does not glob on
// its own (that arrived in Node 21). This lists the test files itself and
// passes them explicitly, so `npm test` behaves the same on every platform.
//
// `--experimental-detect-module` is needed because @pump-fun/pump-swap-sdk
// ships its ESM build without a "type": "module" marker; without the flag
// Node 20 treats it as CommonJS and the named imports in src/pumpSwap.ts fail
// (Node 22.7+ detects the syntax by default, so the flag is a no-op there).
//
//   npm test           run every test/*.test.ts
//   npm run test:live  run test/live.test.ts with RUN_LIVE_TX_TESTS=1
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');

const files = live
  ? ['test/live.test.ts']
  : readdirSync(path.join(root, 'test'))
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => path.join('test', f));

const env = { ...process.env };
if (live) env.RUN_LIVE_TX_TESTS = '1';

const result = spawnSync(
  process.execPath,
  ['--experimental-detect-module', '--import', 'tsx', '--test', ...files],
  { cwd: root, env, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
