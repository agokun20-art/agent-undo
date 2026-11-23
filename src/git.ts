import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const namespace = 'refs/worktree/undoturn';
const checkpoints = `${namespace}/checkpoints`;
const redoStack = `${namespace}/redo`;
const safety = `${namespace}/safety`;
const identity = { GIT_AUTHOR_NAME: 'undoturn', GIT_AUTHOR_EMAIL: 'undoturn@localhost',
  GIT_COMMITTER_NAME: 'undoturn', GIT_COMMITTER_EMAIL: 'undoturn@localhost' };

type GitOptions = { env?: NodeJS.ProcessEnv; input?: string | Buffer; missing?: boolean; check?: boolean };

const defaultRetention = 100;
const maxRetention = 10_000;

export function retention(value = process.env.UNDOTURN_KEEP): number {
  if (value === undefined) return defaultRetention;
  const keep = Number(value);
  if (!/^\d+$/.test(value) || keep < 1 || keep > maxRetention) {
    throw new Error(`Checkpoint retention must be an integer between 1 and ${maxRetention}.`);
  }
  return keep;
}

type PruneResult = { removed: number; retained: number; tip?: string };

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
  return options.check ? Buffer.from('ok') : result.stdout;
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
    this.git(['-c', 'core.logAllRefUpdates=false', 'update-ref', '--stdin'], { input:
      `update ${checkpoints} ${checkpoint}\n${redo ? `update ${redoStack} ${redo}` : `delete ${redoStack}`}\n` });
  }

  checkpoint(message: string): string | undefined {
    return this.locked(() => {
      const previous = this.ref(checkpoints);
      const tree = this.snapshot();
      if (previous && this.tree(previous) === tree) return undefined;
      const id = this.commit(tree, message, previous ? [previous] : []);
      this.setState(id);
      try {
        return this.pruneHistory(retention(), false, id).tip ?? id;
      } catch {
        // Retention must not fail an already-saved checkpoint.
        try { return this.ref(checkpoints) ?? id; } catch { return id; }
      }
    });
  }

  private history(): string[] {
    const tip = this.ref(checkpoints);
    return tip ? this.value(['rev-list', '--first-parent', tip]).split('\n') : [];
  }

  prune(keep: number, dryRun: boolean): PruneResult {
    return this.locked(() => this.pruneHistory(keep, dryRun));
  }

  private pruneHistory(keep: number, dryRun: boolean, newTip?: string): PruneResult {
    const tip = newTip ?? this.ref(checkpoints);
    if (!tip) return { removed: 0, retained: 0 };

    const redoFrames: { id: string; original: string }[] = [];
    if (!newTip) {
      for (let id = this.ref(redoStack); id;) {
        const [original, next] = this.value(['show', '-s', '--format=%P', id]).split(' ');
        if (!original) throw new Error('Invalid redo checkpoint.');
        redoFrames.push({ id, original });
        id = next;
      }
    }
    const newest = redoFrames.at(-1)?.original ?? tip;
    const history = this.value(['rev-list', '--first-parent',
      ...(newTip ? [`--max-count=${keep + 1}`] : []), newest]).split('\n');
    const position = history.indexOf(tip);
    if (position < 0 || redoFrames.some(({ original }) => !history.includes(original))) {
      throw new Error('Redo checkpoints are not on the current timeline.');
    }
    const retained = Math.min(history.length, Math.max(keep, position + 1));
    const removed = history.length - retained;
    if (!removed || dryRun) return { removed, retained, tip };

    const entries: { id: string; parents: string[] }[] = history.slice(0, retained).reverse()
      .map((id, index, ids) => ({ id, parents: index ? [ids[index - 1]!] : [] }));
    for (let i = redoFrames.length - 1; i >= 0; i--) {
      const { id, original } = redoFrames[i]!;
      const next = redoFrames[i + 1];
      entries.push({ id, parents: next ? [original, next.id] : [original] });
    }
    const backup = this.ref(safety);
    if (backup && !entries.some(({ id }) => id === backup)) entries.push({ id: backup, parents: [] });
    const rewritten = this.rewriteCommits(entries);
    const rewrittenTip = rewritten.get(tip)!;
    const redo = redoFrames[0]?.id;
    const updates = [
      `update ${checkpoints} ${rewrittenTip} ${tip}`,
      ...(redo ? [`update ${redoStack} ${rewritten.get(redo)} ${redo}`] : []),
      ...(backup ? [`update ${safety} ${rewritten.get(backup)} ${backup}`] : []),
    ];
    const logs = [checkpoints, redoStack, safety].filter((ref) =>
      this.value(['reflog', 'exists', ref], { missing: true, check: true }));
    this.git(['-c', 'core.logAllRefUpdates=false', 'update-ref', '--stdin'],
      { input: updates.join('\n') + '\n' });
    if (logs.length) this.git(['reflog', 'expire', '--expire=all', '--expire-unreachable=all', ...logs]);
    return { removed, retained, tip: rewrittenTip };
  }

  private rewriteCommits(entries: { id: string; parents: string[] }[]): Map<string, string> {
    // Batch object reads and writes so trimming doesn't spawn Git once per checkpoint.
    const ids = entries.map(({ id }) => id);
    const objects = this.git(['cat-file', '--batch'], { input: ids.join('\n') + '\n' });
    const dir = mkdtempSync(join(tmpdir(), 'undoturn-prune-'));
    const algorithm = ids[0]!.length === 64 ? 'sha256' : 'sha1';
    const rewritten = new Map<string, string>();
    let offset = 0;
    try {
      const paths = entries.map(({ id, parents }, index) => {
        const end = objects.indexOf(10, offset);
        const [hash, type, size] = objects.toString('ascii', offset, end).split(' ');
        if (hash !== id || type !== 'commit' || !size) throw new Error('Invalid checkpoint object.');
        const raw = objects.subarray(end + 1, end + 1 + Number(size));
        offset = end + 2 + Number(size);
        const treeEnd = raw.indexOf(10) + 1;
        let parentEnd = treeEnd;
        while (raw.subarray(parentEnd, parentEnd + 7).toString() === 'parent ') {
          parentEnd = raw.indexOf(10, parentEnd) + 1;
        }
        const commit = Buffer.concat([raw.subarray(0, treeEnd), Buffer.from(
          parents.map((parent) => {
            const oid = rewritten.get(parent);
            if (!oid) throw new Error('Missing retained checkpoint parent.');
            return `parent ${oid}\n`;
          }).join('')), raw.subarray(parentEnd)]);
        const oid = createHash(algorithm).update(`commit ${commit.length}\0`).update(commit).digest('hex');
        rewritten.set(id, oid);
        const path = join(dir, String(index));
        writeFileSync(path, commit);
        return JSON.stringify(path);
      });
      const written = this.value(['hash-object', '-w', '-t', 'commit', '--stdin-paths'],
        { input: paths.join('\n') + '\n' }).split('\n');
      if (written.some((id, index) => rewritten.get(ids[index]!) !== id) || written.length !== ids.length) {
        throw new Error('Git did not write the expected checkpoint objects.');
      }
      return rewritten;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const backup = this.commit(current, 'Safety checkpoint before restore', []);
    this.git(['-c', 'core.logAllRefUpdates=false', 'update-ref', safety, backup]);
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
