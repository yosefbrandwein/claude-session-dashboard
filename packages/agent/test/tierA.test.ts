// Tier A messaging tests. normalizeEvent + buildTierAArgs are pure; TierARun is
// exercised against a fake `claude` binary (fixtures/fake-claude.mjs) run via
// node, so no real CLI / auth / network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TierARun, normalizeEvent, buildTierAArgs } from '../src/messaging/tierA-cli';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-claude.mjs',
);

test('buildTierAArgs assembles the verified Tier A flags with prompt last', () => {
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
    'hello world',
  ]);
  // prompt must be the final positional arg
  assert.equal(args[args.length - 1], 'hello world');
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
