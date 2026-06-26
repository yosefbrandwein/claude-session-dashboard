#!/usr/bin/env node
// ============================================================================
// OPT-IN hooks installer — YOU run this, the agent NEVER does.
//
// Adds SessionStart / UserPromptSubmit / Stop / Notification / PreToolUse hooks
// to your ~/.claude/settings.json so the dashboard gets PRECISE status and
// permission signals. Without these hooks the agent still works — it derives
// status by parsing transcripts (coarser; see README "Status without hooks").
//
// SAFETY:
//   • Refuses to do anything unless you pass --yes (or --uninstall --yes).
//   • Backs up settings.json to settings.json.bak.<timestamp> BEFORE editing.
//   • --uninstall removes ONLY the hooks this script added (tagged via _csd).
//   • Honors CLAUDE_HOME (defaults to ~/.claude) so you can dry-run against a copy.
//
// Usage:
//   node scripts/install-hooks.mjs --yes               # install
//   node scripts/install-hooks.mjs --uninstall --yes   # remove
//   CLAUDE_HOME=/tmp/claude-copy node scripts/install-hooks.mjs --yes  # safe test
// ============================================================================
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = new Set(process.argv.slice(2));
const DO_IT = argv.has('--yes');
const UNINSTALL = argv.has('--uninstall');

// Tag every hook block we add so --uninstall can find exactly ours.
const TAG = 'csd-agent';

function claudeHome() {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
}

function settingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function backup(p) {
  try {
    await fs.access(p);
  } catch {
    return null; // nothing to back up
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${p}.bak.${stamp}`;
  await fs.copyFile(p, dest);
  return dest;
}

/** Load the example hooks and tag each hook block with _csd so we can remove it. */
async function loadTaggedHooks() {
  const example = await readJson(path.join(HERE, 'hooks.config.example.json'), {});
  const hooks = example.hooks ?? {};
  const tagged = {};
  for (const [event, blocks] of Object.entries(hooks)) {
    tagged[event] = blocks.map((b) => ({ ...b, _csd: TAG }));
  }
  return tagged;
}

function mergeHooks(existing, tagged) {
  const out = { ...(existing ?? {}) };
  for (const [event, blocks] of Object.entries(tagged)) {
    const prior = (out[event] ?? []).filter((b) => b._csd !== TAG); // drop our old ones
    out[event] = [...prior, ...blocks];
  }
  return out;
}

function stripOurHooks(existing) {
  const out = {};
  for (const [event, blocks] of Object.entries(existing ?? {})) {
    const kept = (blocks ?? []).filter((b) => b._csd !== TAG);
    if (kept.length) out[event] = kept;
  }
  return out;
}

async function main() {
  const sp = settingsPath();
  console.log(`Target settings file: ${sp}`);

  if (!DO_IT) {
    console.log(
      '\nDRY RUN — nothing was changed. This script edits your ~/.claude/settings.json.\n' +
        'Re-run with --yes to install, or --uninstall --yes to remove.\n' +
        'Tip: CLAUDE_HOME=/path/to/copy lets you try it against a copy first.',
    );
    return;
  }

  const settings = await readJson(sp, {});
  const bak = await backup(sp);
  if (bak) console.log(`Backed up existing settings → ${bak}`);

  if (UNINSTALL) {
    settings.hooks = stripOurHooks(settings.hooks);
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    await fs.writeFile(sp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log('Removed csd-agent hooks. Done.');
    return;
  }

  const tagged = await loadTaggedHooks();
  settings.hooks = mergeHooks(settings.hooks, tagged);
  await fs.writeFile(sp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(
    `Installed ${Object.keys(tagged).length} hook events (${TAG}). ` +
      'Restart Claude Code sessions for them to take effect.',
  );
}

main().catch((e) => {
  console.error('install-hooks failed:', e);
  process.exit(1);
});
