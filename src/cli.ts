#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { agents } from './agents/index.js';
import { Repo, retention } from './git.js';

const help = `Usage: undoturn <command>

  checkpoint [-m message]   Save the current working tree
  undo [n]                  Restore the previous working state (n defaults to 1)
  redo                      Restore the state saved before undo/restore
  list | log                List checkpoints on the current timeline
  diff [id]                 Compare the working tree with a checkpoint
  restore <id>              Restore a checkpoint, saving the current working tree
  prune [--keep n] [--dry-run]
                            Remove older checkpoints (default: keep 100)
  install <agent>           Add a project hook
  uninstall <agent>         Remove only the undoturn project hook
  status | doctor           Show repository and hook status

Agents: ${Object.keys(agents).join(', ')}
`;

async function hookCwd(): Promise<string> {
  if (process.stdin.isTTY) return process.cwd();
  const input = await new Promise<string>((resolve) => {
    let payload = '';
    const timer = setTimeout(() => finish(''), 250);
    const onData = (chunk: string) => {
      payload += chunk;
      if (payload.length > 1024 * 1024) finish('');
    };
    const onEnd = () => finish(payload);
    const onError = () => finish('');
    function finish(value: string): void {
      clearTimeout(timer);
      process.stdin.off('data', onData).off('end', onEnd).off('error', onError).pause();
      resolve(value);
    }
    process.stdin.setEncoding('utf8').on('data', onData).once('end', onEnd).once('error', onError);
  });
  try {
    const cwd: unknown = JSON.parse(input)?.cwd;
    if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;
  } catch { /* Hook inputs are optional. */ }
  return process.cwd();
}

async function main([command, ...args]: string[]): Promise<void> {
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(help);
    return;
  }
  if (command === 'checkpoint' && args[0] === '--hook') {
    const agent = args[1] ?? 'agent';
    try {
      new Repo(await hookCwd(), Date.now() + 7_000).checkpoint(`Before ${agent} turn`);
    } catch { /* A checkpoint failure must not interrupt an agent. */ }
    console.log(agent === 'cursor' ? '{"continue":true}' : '{}');
    return;
  }

  const repo = new Repo(process.cwd());
  switch (command) {
    case 'checkpoint': {
      if (args.length && (args.length !== 2 || args[0] !== '-m')) {
        throw new Error('Usage: undoturn checkpoint [-m message]');
      }
      const id = repo.checkpoint(args[1] ?? 'Manual checkpoint');
      console.log(id ? `Checkpoint ${id}` : 'Working tree unchanged; no new checkpoint.');
      break;
    }
    case 'undo': {
      const count = Number(args[0] ?? '1');
      if (args.length > 1 || !/^\d+$/.test(args[0] ?? '1') || !Number.isSafeInteger(count) || count < 1) {
        throw new Error('Usage: undoturn undo [positive integer]');
      }
      console.log(`Restored checkpoint ${repo.undo(count)}. Run undoturn redo to reverse it.`);
      break;
    }
    case 'redo':
      if (args.length) throw new Error('Usage: undoturn redo');
      console.log(`Restored saved working tree ${repo.redo()}.`);
      break;
    case 'restore':
      if (args.length !== 1) throw new Error('Usage: undoturn restore <id>');
      console.log(`Restored checkpoint ${repo.restore(args[0]!)}. Run undoturn redo to reverse it.`);
      break;
    case 'prune': {
      let keep: string | undefined;
      let dryRun = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--keep' && keep === undefined && args[i + 1] !== undefined) {
          keep = args[++i];
        } else if (args[i] === '--dry-run' && !dryRun) {
          dryRun = true;
        } else {
          throw new Error('Usage: undoturn prune [--keep n] [--dry-run]');
        }
      }
      const { removed, retained } = repo.prune(retention(keep), dryRun);
      console.log(`${dryRun ? 'Would prune' : 'Pruned'} ${removed} checkpoint(s); ${retained} retained.`);
      break;
    }
    case 'list':
    case 'log':
      if (args.length) throw new Error(`Usage: undoturn ${command}`);
      process.stdout.write(repo.list() || 'No checkpoints.\n');
      break;
    case 'diff':
      if (args.length > 1) throw new Error('Usage: undoturn diff [id]');
      process.stdout.write(repo.diff(args[0]));
      break;
    case 'install':
    case 'uninstall': {
      const name = args[0];
      const agent = name && Object.hasOwn(agents, name) ? agents[name] : undefined;
      if (args.length !== 1 || !agent) {
        throw new Error(`Usage: undoturn ${command} <${Object.keys(agents).join('|')}>`);
      }
      console.log(agent[command](repo.root));
      break;
    }
    case 'status':
    case 'doctor':
      if (args.length) throw new Error(`Usage: undoturn ${command}`);
      console.log(repo.status());
      if (command === 'doctor') {
        for (const agent of Object.values(agents)) {
          try {
            console.log(`${agent.name}: ${agent.detect(repo.root) ? 'hook installed' : 'hook not installed'} (${agent.docs})`);
          } catch (error) {
            console.log(`${agent.name}: ${(error as Error).message}`);
          }
        }
      }
      break;
    default:
      throw new Error(`Unknown command: ${command}. Run undoturn --help.`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`undoturn: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
