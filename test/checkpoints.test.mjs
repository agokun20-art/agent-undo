import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const options = { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } };
delete options.env.UNDOTURN_KEEP;
const checkpointRef = 'refs/worktree/undoturn/checkpoints';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'undoturn-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { ...options, cwd }).trim();
  const undo = (...args) => execFileSync(process.execPath, [cli, ...args], { ...options, cwd }).trim();
  const fails = (...args) => spawnSync(process.execPath, [cli, ...args], { ...options, cwd });
  const file = (name) => join(cwd, name);
  const put = (name, data) => writeFileSync(file(name), data);
  const read = (name) => readFileSync(file(name), 'utf8');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@localhost');
  return { cwd, git, undo, fails, file, put, read };
}

test('undo and redo restore the full working tree without changing HEAD, index or stash', (t) => {
  const { git, undo, file, put, read } = fixture(t);
  put('.gitignore', '*.ignored\n');
  put('tracked', 'committed');
  put('deleted', 'restore me');
  put('binary', Buffer.from([0, 255, 2]));
  git('add', '.');
  git('commit', '-qm', 'initial');
  put('tracked', 'staged');
  put('staged-new.ignored', 'staged-add');
  git('add', 'tracked');
  git('add', '-f', 'staged-new.ignored');
  put('tracked', 'before');
  put('staged-new.ignored', 'working staged-add');
  put('untracked', 'keep untracked');
  put('local.ignored', 'local before');
  const head = git('rev-parse', 'HEAD');
  const index = readFileSync(file('.git/index'));
  const refs = git('for-each-ref', 'refs/heads', 'refs/stash');

  assert.match(undo('checkpoint', '-m', 'before turn'), /^Checkpoint [a-f0-9]+$/);
  assert.match(git('show', '-s', '--format=%an <%ae> %s', 'refs/worktree/undoturn/checkpoints'),
    /^undoturn <undoturn@localhost> before turn$/);
  assert.equal(undo('checkpoint'), 'Working tree unchanged; no new checkpoint.');
  put('tracked', 'after');
  rmSync(file('deleted'));
  rmSync(file('untracked'));
  rmSync(file('staged-new.ignored'));
  put('binary', Buffer.from([1, 254, 0]));
  mkdirSync(file('new/nested'), { recursive: true });
  put('new/nested/created', 'created during turn');
  put('new/local.ignored', 'keep nested local');
  put('local.ignored', 'local after');
  assert.match(undo('diff'), /GIT binary patch/);
  assert.match(undo('diff'), /new\/nested\/created/);
  assert.equal(undo('list').split('\n').length, 1);

  undo('undo');
  assert.equal(read('tracked'), 'before');
  assert.equal(read('deleted'), 'restore me');
  assert.equal(read('untracked'), 'keep untracked');
  assert.equal(read('staged-new.ignored'), 'working staged-add');
  assert.deepEqual(readFileSync(file('binary')), Buffer.from([0, 255, 2]));
  assert.equal(existsSync(file('new/nested/created')), false);
  assert.equal(read('new/local.ignored'), 'keep nested local');
  assert.equal(read('local.ignored'), 'local after');
  assert.deepEqual(readFileSync(file('.git/index')), index);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('for-each-ref', 'refs/heads', 'refs/stash'), refs);

  undo('redo');
  assert.equal(read('tracked'), 'after');
  assert.equal(read('new/nested/created'), 'created during turn');
  assert.deepEqual(readFileSync(file('binary')), Buffer.from([1, 254, 0]));
  assert.equal(existsSync(file('deleted')), false);
  assert.equal(existsSync(file('untracked')), false);
  assert.equal(existsSync(file('staged-new.ignored')), false);
  assert.equal(read('local.ignored'), 'local after');
  assert.deepEqual(readFileSync(file('.git/index')), index);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('multi-step undo, restore by ID and redo work before the first Git commit', (t) => {
  const { undo, put, read, fails } = fixture(t);
  put('file', 'one');
  const first = undo('checkpoint', '-m', 'first').split(' ')[1];
  put('file', 'two');
  undo('checkpoint');
  put('file', 'three');
  undo('checkpoint');
  put('file', 'four');
  undo('undo', '2');
  assert.equal(read('file'), 'two');
  undo('undo');
  assert.equal(read('file'), 'one');
  undo('redo');
  assert.equal(read('file'), 'two');
  undo('redo');
  assert.equal(read('file'), 'four');
  assert.match(undo('diff', first.slice(0, 7)), /\+four/);
  undo('restore', first.slice(0, 7));
  assert.equal(read('file'), 'one');
  put('file', 'diverged');
  assert.match(fails('redo').stderr, /redo would overwrite edits/);
  assert.equal(read('file'), 'diverged');
});

test('undo refuses to overwrite ignored files or directories', (t) => {
  const { put, undo, fails, file, read } = fixture(t);
  put('collision', 'old');
  undo('checkpoint');
  rmSync(file('collision'));
  put('.gitignore', 'collision\n');
  mkdirSync(file('collision'));
  put('collision/data', 'ignored');
  assert.match(fails('undo').stderr, /overwrite an ignored path/);
  assert.equal(read('collision/data'), 'ignored');
  assert.equal(read('.gitignore'), 'collision\n');
});

test('linked worktrees have independent histories', (t) => {
  const { cwd, git, undo, put } = fixture(t);
  put('file', 'main');
  git('add', '.');
  git('commit', '-qm', 'initial');
  undo('checkpoint', '-m', 'main checkpoint');
  const linked = join(cwd, 'linked');
  git('worktree', 'add', '-qb', 'linked', linked);
  const other = (...args) => execFileSync(process.execPath, [cli, ...args], { ...options, cwd: linked }).trim();
  assert.equal(other('list'), 'No checkpoints.');
  other('checkpoint', '-m', 'linked checkpoint');
  assert.match(other('list'), /linked checkpoint/);
  assert.match(undo('list'), /main checkpoint/);
});

test('recording a checkpoint automatically retains the newest 100', (t) => {
  const { git, undo, put } = fixture(t);
  const tree = git('write-tree');
  let tip;
  let oldest;
  for (let i = 1; i <= 100; i++) {
    tip = git('commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', `checkpoint ${i}`);
    oldest ??= tip;
  }
  git('update-ref', checkpointRef, tip);
  put('file', 'new snapshot');
  const saved = undo('checkpoint').split(' ')[1];
  const timeline = undo('list').split('\n');
  assert.equal(timeline.length, 100);
  assert.match(timeline.at(-1), /checkpoint 2$/);
  assert.equal(git('rev-parse', checkpointRef), saved);
  assert.match(git('fsck', '--unreachable', '--no-progress'), new RegExp(`unreachable commit ${oldest}`));
});

test('manual prune previews changes, honors the keep override, and expires only its own reflogs', (t) => {
  const { git, undo, fails, put, read } = fixture(t);
  git('commit', '-qm', 'initial', '--allow-empty');
  git('commit', '-qm', 'second', '--allow-empty');
  put('file', 'first');
  const oldest = undo('checkpoint', '-m', 'first').split(' ')[1];
  put('file', 'second');
  const second = undo('checkpoint', '-m', 'second').split(' ')[1];
  git('update-ref', '--create-reflog', checkpointRef, oldest);
  git('update-ref', checkpointRef, second);
  put('file', 'third');
  undo('checkpoint', '-m', 'third');
  const before = undo('list');
  const reflog = git('reflog', 'show', checkpointRef);
  const headLog = git('reflog', 'show', 'HEAD');
  assert.ok(reflog);
  assert.match(fails('prune', '--keep', '0').stderr, /retention must be an integer/);
  assert.equal(undo('prune', '--dry-run', '--keep', '2'), 'Would prune 1 checkpoint(s); 2 retained.');
  assert.equal(undo('list'), before);
  assert.equal(git('reflog', 'show', checkpointRef), reflog);

  assert.equal(undo('prune', '--keep', '2'), 'Pruned 1 checkpoint(s); 2 retained.');
  assert.equal(undo('prune', '--keep', '2'), 'Pruned 0 checkpoint(s); 2 retained.');
  assert.equal(read('file'), 'third');
  assert.deepEqual(undo('list').split('\n').map((line) => line.split(' ').at(-1)), ['third', 'second']);
  assert.equal(git('reflog', 'show', checkpointRef), '');
  assert.equal(git('reflog', 'show', 'HEAD'), headLog);
  assert.match(git('fsck', '--unreachable', '--no-progress'), new RegExp(`unreachable commit ${oldest}`));
  assert.match(fails('restore', oldest).stderr, /Unknown or ambiguous checkpoint/);
});

test('configured retention applies to hooks, and redo survives pruning at an older position', (t) => {
  const { cwd, git, undo, put, read } = fixture(t);
  for (const value of ['one', 'two', 'three', 'four', 'five']) {
    put('file', value);
    undo('checkpoint', '-m', value);
  }
  const oldest = git('rev-list', '--max-parents=0', checkpointRef);
  put('file', 'six');
  undo('undo');
  undo('undo');
  undo('undo');
  assert.equal(read('file'), 'three');
  assert.equal(undo('prune', '--keep', '2'), 'Pruned 2 checkpoint(s); 3 retained.');
  assert.match(git('fsck', '--unreachable', '--no-progress'), new RegExp(`unreachable commit ${oldest}`));
  assert.equal(git('show', '-s', '--format=%P', 'refs/worktree/undoturn/safety'), '');
  assert.match(undo('list'), /three$/);
  for (const value of ['four', 'five', 'six']) {
    undo('redo');
    assert.equal(read('file'), value);
  }
  undo('undo', '2');
  assert.equal(read('file'), 'four');
  undo('redo');
  assert.equal(read('file'), 'six');

  const configured = (keep, ...args) => execFileSync(process.execPath, [cli, ...args],
    { ...options, cwd, env: { ...options.env, UNDOTURN_KEEP: keep }, input: '{}' }).trim();
  assert.equal(configured('bad', 'checkpoint', '--hook', 'codex'), '{}');
  assert.match(undo('list'), /Before codex turn/);
  assert.equal(configured('2', 'prune', '--dry-run'), 'Would prune 2 checkpoint(s); 2 retained.');
  put('file', 'seven');
  assert.equal(configured('2', 'checkpoint', '--hook', 'codex'), '{}');
  assert.equal(undo('list').split('\n').length, 2);
});
