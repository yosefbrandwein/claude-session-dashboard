// Tier A messaging tests. normalizeEvent + buildTierAArgs are pure; TierARun is
// exercised against a fake `claude` binary (fixtures/fake-claude.mjs) run via
// node, so no real CLI / auth / network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TierARun, normalizeEvent, buildTierAArgs, resolveClaudeBin } from '../src/messaging/tierA-cli';

test('resolveClaudeBin honors CSD_CLAUDE_BIN override (so the .cmd shim / shell:true is never needed)', () => {
  const prev = process.env.CSD_CLAUDE_BIN;
  process.env.CSD_CLAUDE_BIN = '/custom/path/to/claude.exe';
  try {
    assert.equal(resolveClaudeBin(), '/custom/path/to/claude.exe');
  } finally {
    if (prev === undefined) delete process.env.CSD_CLAUDE_BIN;
    else process.env.CSD_CLAUDE_BIN = prev;
  }
});

test('resolveClaudeBin resolves a concrete executable, never a bare .cmd-prone name on win32', () => {
  const prev = process.env.CSD_CLAUDE_BIN;
  delete process.env.CSD_CLAUDE_BIN;
  try {
    const bin = resolveClaudeBin();
    if (process.platform === 'win32') assert.ok(/claude\.exe$/i.test(bin), `expected a claude.exe path, got ${bin}`);
    else assert.equal(bin, 'claude');
  } finally {
    if (prev !== undefined) process.env.CSD_CLAUDE_BIN = prev;
  }
});

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-claude.mjs',
);

test('buildTierAArgs (default=safe) sandboxes the run: denies dangerous tools, prompt last + shielded', () => {
  const args = buildTierAArgs({ sessionId: 'S', text: 'hello world', model: 'claude-opus-4-8' });
  assert.deepEqual(args, [
    '--print',
    '--resume',
    'S',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'claude-opus-4-8',
    '--disallowedTools',
    'Bash,BashOutput,KillShell,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task',
    '--permission-mode',
    'default',
    'hello world',
  ]);
  // prompt must be the final positional arg
  assert.equal(args[args.length - 1], 'hello world');
  // CRITICAL: the variadic --disallowedTools must be followed by a NON-variadic
  // flag (--permission-mode) so it can't swallow the prompt. Assert that order.
  assert.ok(args.indexOf('--disallowedTools') < args.indexOf('--permission-mode'));
  assert.equal(args[args.indexOf('--disallowedTools') + 2], '--permission-mode');
  // deny list covers shell execution + file mutation + network
  const deny = args[args.indexOf('--disallowedTools') + 1];
  for (const t of ['Bash', 'Write', 'Edit', 'WebFetch']) assert.ok(deny.includes(t));
  // and must NOT contain the non-existent tool names that triggered warnings
  for (const bad of ['MultiEdit', 'SlashCommand']) assert.ok(!deny.includes(bad));
});

test('buildTierAArgs sandbox=full omits the restriction flags (explicit opt-in)', () => {
  const args = buildTierAArgs({ sessionId: 'S', text: 'go', sandbox: 'full' });
  assert.ok(!args.includes('--disallowedTools'), 'full mode must not deny tools');
  assert.ok(!args.includes('--permission-mode'), 'full mode must not pin permission mode');
  assert.equal(args[args.length - 1], 'go');
});

test('normalizeEvent extracts assistant text', () => {
  const ev = normalizeEvent({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  });
  assert.equal(ev.role, 'assistant');
  assert.equal(ev.text, 'hello');
});

test('normalizeEvent extracts tool calls with input summary', () => {
  const ev = normalizeEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b' } }],
    },
  });
  assert.deepEqual(ev.toolCalls, [{ name: 'Read', inputSummary: 'file_path=/a/b' }]);
});

test('normalizeEvent surfaces the terminal result event text', () => {
  const ev = normalizeEvent({ type: 'result', result: 'final answer' });
  assert.equal(ev.type, 'result');
  assert.equal(ev.text, 'final answer');
});

test('TierARun streams events from the fake CLI and reports the final result', async () => {
  const events: string[] = [];
  let result: string | null = null;

  // bin=node, prependArgs=[fakeScript] → runs `node fake-claude.mjs <flags> <prompt>`.
  const run = new TierARun({
    sessionId: 'sess-1',
    text: 'ping',
    bin: process.execPath,
    prependArgs: [FAKE],
  });

  await new Promise<void>((resolve, reject) => {
    run.on('event', (ev) => events.push(ev.type));
    run.on('result', (r) => (result = r));
    run.on('error', reject);
    run.on('close', () => resolve());
    run.start();
  });

  assert.ok(events.includes('assistant'), 'saw assistant events');
  assert.ok(events.includes('result'), 'saw the terminal result event');
  assert.equal(result, 'done thinking');
  assert.equal(run.finalResult, 'done thinking');
});

test('TierARun.interrupt marks the run killed', async () => {
  const run = new TierARun({
    sessionId: 'sess-2',
    text: 'ping',
    bin: process.execPath,
    prependArgs: [FAKE],
  });
  await new Promise<void>((resolve) => {
    run.on('close', () => resolve());
    run.on('error', () => resolve());
    run.start();
    run.interrupt();
  });
  assert.equal(run.killed, true);
});
