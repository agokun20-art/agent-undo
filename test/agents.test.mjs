import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { agents } from '../dist/agents/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const cases = [
  ['claude', '.claude/settings.json', 'UserPromptSubmit', 10],
  ['codex', '.codex/hooks.json', 'UserPromptSubmit', 10],
  ['cursor', '.cursor/hooks.json', 'beforeSubmitPrompt', 10],
  ['gemini', '.gemini/settings.json', 'BeforeAgent', 10_000],
];

for (const [name, path, event, timeout] of cases) {
  test(`${name} merges, detects, idempotently installs and narrowly uninstalls`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'undoturn-hook-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, path);
    const agent = agents[name];
    const grouped = name !== 'cursor';
    const old = grouped ? { matcher: 'old', hooks: [{ type: 'command', command: 'existing-hook' }] }
      : { command: 'existing-hook' };
    const original = { ...(grouped ? {} : { version: 1 }), unrelated: { enabled: true },
      hooks: { [event]: [old], AnotherEvent: [old] } };
    mkdirSync(dirname(file));
    writeFileSync(file, JSON.stringify(original));
    assert.equal(agent.detect(root), false);
    assert.match(agent.install(root), /Installed/);
    assert.equal(agent.detect(root), true);
    const installed = readFileSync(file, 'utf8');
    const command = `undoturn checkpoint --hook ${name}`;
    const row = grouped ? { hooks: [{ type: 'command', command, timeout }] } : { command, timeout };
    assert.deepEqual(JSON.parse(installed), {
      ...original,
      hooks: { ...original.hooks, [event]: [old, row] },
    });
    assert.match(agent.install(root), /already installed/);
    assert.equal(readFileSync(file, 'utf8'), installed);
    agent.uninstall(root);
    assert.equal(agent.detect(root), false);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
    assert.match(agent.uninstall(root), /No undoturn hook/);
    writeFileSync(file, '{malformed');
    assert.throws(() => agent.install(root), /Cannot read/);
    assert.equal(readFileSync(file, 'utf8'), '{malformed');
  });
}

test('hook reads cwd from stdin and stays successful on invalid payload/repo', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'undoturn-payload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'file'), 'before');
  const run = (name, input) => spawnSync(process.execPath, [cli, 'checkpoint', '--hook', name],
    { cwd: root, input, encoding: 'utf8' });
  const result = run('codex', JSON.stringify({ cwd, hook_event_name: 'UserPromptSubmit' }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{}');
  assert.equal(result.stderr, '');
  assert.match(execFileSync(process.execPath, [cli, 'list'], { cwd, encoding: 'utf8' }), /Before codex turn/);
  const ignored = run('cursor', 'not JSON');
  assert.equal(ignored.status, 0);
  assert.equal(ignored.stdout.trim(), '{"continue":true}');
  assert.equal(ignored.stderr, '');
});
