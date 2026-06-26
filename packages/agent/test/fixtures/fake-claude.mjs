#!/usr/bin/env node
// A stand-in for the real `claude` binary used ONLY by tierA.test.ts. It emits a
// few stream-json lines mimicking `claude -p --output-format stream-json`, so the
// TierARun harness can be exercised without the real CLI, auth, or network.
const args = process.argv.slice(2);
// Echo back the prompt so the test can assert it was passed through.
const prompt = args[args.length - 1];

const lines = [
  { type: 'system', subtype: 'init', session_id: 'fake' },
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `you said: ${prompt}` }] },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'list' } }],
    },
  },
  { type: 'result', subtype: 'success', result: 'done thinking' },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + '\n');
process.exit(0);
