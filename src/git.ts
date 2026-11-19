import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const namespace = 'refs/worktree/undoturn';
const checkpoints = `${namespace}/checkpoints`;
const redoStack = `${namespace}/redo`;
const safety = `${namespace}/safety`;
const identity = { GIT_AUTHOR_NAME: 'undoturn', GIT_AUTHOR_EMAIL: 'undoturn@localhost',
  GIT_COMMITTER_NAME: 'undoturn', GIT_COMMITTER_EMAIL: 'undoturn@localhost' };

type GitOptions = { env?: NodeJS.ProcessEnv; input?: string | Buffer; missing?: boolean };

function run(cwd: string, args: string[], options: GitOptions = {}, deadline?: number): Buffer {
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new Error('Checkpoint hook timed out.');
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd, input: options.input, env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024, timeout: remaining,
  });
  if (result.error) throw result.error;
  if (options.missing && result.status === 1) return Buffer.alloc(0);
  if (result.status !== 0) {
    throw new Error(result.stderr.toString().trim() || `Git ${args[0]} failed.`);
  }
  return result.stdout;
}

export class Repo {
  readonly root: string;

  constructor(cwd: string, private readonly deadline?: number) {
    this.root = run(cwd, ['rev-parse', '--show-toplevel'], {}, deadline).toString().replace(/\r?\n$/, '');
  }

  private git(args: string[], options?: GitOptions): Buffer {
    return run(this.root, args, options, this.deadline);
  }

  private value(args: string[], options?: GitOptions): string {
    return this.git(args, options).toString().trim();
  }

  private ref(name: string): string | undefined {
    return this.value(['rev-parse', '--verify', '--quiet', name], { missing: true }) || undefined;
  }

  private withIndex<T>(fn: (env: NodeJS.ProcessEnv) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'undoturn-'));
    try {
      return fn({ GIT_INDEX_FILE: join(dir, 'index') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private locked<T>(fn: () => T): T {
    const lock = this.git(['rev-parse', '--path-format=absolute', '--git-path', 'undoturn.lock'])
      .toString().replace(/\r?\n$/, '');
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Another undoturn operation holds ${lock}; remove it only if no operation is running.`);
      }
      throw error;
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      rmSync(lock);
    }
  }

  private snapshot(): string {
    if (this.value(['config', '--bool', '--get', 'core.sparseCheckout'], { missing: true }) === 'true') {
      throw new Error('Sparse checkouts are not supported.');
    }
    return this.withIndex((env) => {
      const index = this.git(['ls-files', '--stage', '-z']);
      if (index.length) this.git(['update-index', '-z', '--index-info'], { env, input: index });
      this.git(['-c', 'core.sparseCheckout=false', 'add', '-A', '--', '.'], { env });
      const staged = this.git(['ls-files', '--stage', '-z'], { env });
      if (staged.toString('latin1').split('\0').some((entry) => entry.startsWith('160000 '))) {
        throw new Error('Submodules and embedded Git repositories are not supported.');
      }
      return this.value(['write-tree'], { env });
    });
  }

  private tree(commit: string): string {
    return this.value(['rev-parse', `${commit}^{tree}`]);
  }

  private commit(tree: string, message: string, parents: string[]): string {
    return this.value(['-c', 'commit.gpgSign=false', 'commit-tree', tree,
      ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'], { env: identity, input: message });
  }

  private setState(checkpoint: string, redo?: string): void {
    this.git(['update-ref', '--stdin'], { input:
      `update ${checkpoints} ${checkpoint}\n${redo ? `update ${redoStack} ${redo}` : `delete ${redoStack}`}\n` });
  }

  checkpoint(message: string): string | undefined {
    return this.locked(() => {
      const previous = this.ref(checkpoints);
      const tree = this.snapshot();
      if (previous && this.tree(previous) === tree) return undefined;
      const id = this.commit(tree, message, previous ? [previous] : []);
      this.setState(id);
      return id;
    });
  }

  private history(): string[] {
    const tip = this.ref(checkpoints);
    return tip ? this.value(['rev-list', '--first-parent', tip]).split('\n') : [];
  }

  private resolveCheckpoint(id: string): string {
    if (!/^[a-f0-9]{4,64}$/i.test(id)) throw new Error('Use a checkpoint ID from undoturn list.');
    const matches = this.history().filter((hash) => hash.startsWith(id.toLowerCase()));
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous checkpoint: ${id}`);
    return matches[0]!;
  }

  private apply(current: string, target: string): void {
    if (current === target) return;
    const ignored = this.git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
      .toString('latin1').split('\0').filter(Boolean).map((path) => path.replace(/\/$/, ''));
    const paths = this.git(['ls-tree', '-r', '--name-only', '-z', target])
      .toString('latin1').split('\0').filter(Boolean);
    const targets = new Set(paths);
    const directories = new Set<string>();
    for (const path of paths) {
      for (let end = path.lastIndexOf('/'); end >= 0; end = path.lastIndexOf('/', end - 1)) {
        directories.add(path.slice(0, end));
      }
    }
    for (const path of ignored) {
      if (directories.has(path)) throw new Error('Restore would overwrite an ignored path.');
      for (let end = path.length; end >= 0; end = path.lastIndexOf('/', end - 1)) {
        if (targets.has(path.slice(0, end))) throw new Error('Restore would overwrite an ignored path.');
      }
    }
    this.withIndex((env) => {
      this.git(['-c', 'core.sparseCheckout=false', 'read-tree', current], { env });
      this.git(['update-index', '--refresh'], { env });
      this.git(['-c', 'core.sparseCheckout=false', 'read-tree', '-m', '-u', current, target], { env });
    });
  }

  private rewind(current: string, original: string, target: string): string {
    const redo = this.ref(redoStack);
    const saved = this.commit(current, 'Safety checkpoint before restore', redo ? [original, redo] : [original]);
    this.git(['update-ref', safety, saved]);
    this.apply(current, this.tree(target));
    this.setState(target, saved);
    return target;
  }

  undo(count: number): string {
    return this.locked(() => {
      const history = this.history();
      const latest = history[0];
      if (!latest) throw new Error('No checkpoints. Run undoturn checkpoint first.');
      const current = this.snapshot();
      const target = history[count - (current === this.tree(latest) ? 0 : 1)];
      if (!target) throw new Error('Not enough checkpoints to undo that far.');
      return this.rewind(current, latest, target);
    });
  }

  redo(): string {
    return this.locked(() => {
      const saved = this.ref(redoStack);
      const latest = this.ref(checkpoints);
      if (!saved || !latest) throw new Error('Nothing to redo.');
      const current = this.snapshot();
      if (current !== this.tree(latest)) throw new Error('Working tree changed since undo; redo would overwrite edits.');
      const [original, previousRedo] = this.value(['show', '-s', '--format=%P', saved]).split(' ');
      this.apply(current, this.tree(saved));
      this.setState(original!, previousRedo);
      return saved;
    });
  }

  restore(id: string): string {
    return this.locked(() => {
      const target = this.resolveCheckpoint(id);
      const latest = this.ref(checkpoints)!;
      return this.rewind(this.snapshot(), latest, target);
    });
  }

  list(): string {
    const latest = this.ref(checkpoints);
    return latest ? this.git(['log', '--first-parent', '--format=%h %ci %s', latest]).toString() : '';
  }

  diff(id?: string): Buffer {
    const target = id ? this.resolveCheckpoint(id) : this.ref(checkpoints);
    if (!target) throw new Error('No checkpoints. Run undoturn checkpoint first.');
    return this.git(['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv',
      this.tree(target), this.snapshot(), '--']);
  }

  status(): string {
    const latest = this.ref(checkpoints);
    return [
      `Repository: ${this.root}`,
      `Latest checkpoint: ${latest ?? 'none'}`,
      `Redo: ${this.ref(redoStack) ? 'available' : 'unavailable'}`,
    ].join('\n');
  }
}
