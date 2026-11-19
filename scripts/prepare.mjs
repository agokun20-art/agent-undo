import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// npm's Git-dependency preparation can inherit global mode and skip local devDependencies.
if (!existsSync(compiler)) {
  run([process.env.npm_execpath, 'ci', '--global=false', '--prefix', root, '--include=dev', '--ignore-scripts']);
}
run([compiler]);
