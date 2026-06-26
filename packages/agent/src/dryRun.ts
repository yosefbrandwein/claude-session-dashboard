// READ-ONLY proof: run the collector against the real ~/.claude and print the
// derived sessions/status. Uploads NOTHING. No Firebase, no credentials needed.
//
//   npx tsx src/dryRun.ts
//
// This is the "prove the collector output matches reality" check from the spec.
import { collectOnce } from './collector/collect';
import { findTranscriptPath, readTranscriptEntriesFrom } from './collector/io';
import {
  parseTranscriptEntry,
  parsePermissionDenial,
} from './collector/parse';
import { gitBranch, deviceId } from './device';

async function main() {
  const now = Date.now();
  const snap = await collectOnce({ now });
  console.log(`deviceId: ${deviceId()}`);
  console.log(`collected ${snap.sessions.length} session file(s) at ${new Date(now).toISOString()}\n`);

  for (const c of snap.sessions) {
    const branch = await gitBranch(c.parsed.cwd);
    console.log('────────────────────────────────────────────────────────');
    console.log(`session   ${c.parsed.sessionId}`);
    console.log(`pid       ${c.parsed.pid}`);
    console.log(`status    ${c.status}        controllableHint=${c.controllableHint}`);
    console.log(`project   ${c.project}   branch=${branch ?? '(none)'}`);
    console.log(`cwd       ${c.parsed.cwd}`);
    console.log(`version   ${c.parsed.version}   entrypoint=${c.parsed.entrypoint}   kind=${c.parsed.kind}`);
    console.log(
      `activity  lines=${c.signal?.lineCount ?? 0}  lastEntry=${
        c.signal?.lastEntryTs ? new Date(c.signal.lastEntryTs).toISOString() : '(none)'
      }  mtime=${c.signal?.mtimeMs ? new Date(c.signal.mtimeMs).toISOString() : '(none)'}`,
    );
    console.log(`transcript ${c.transcriptPath ?? '(not found)'}`);

    // Sample the last few transcript entries → metadata (no raw text printed
    // beyond short, non-sensitive summaries).
    if (c.transcriptPath) {
      const path = await findTranscriptPath(c.parsed.sessionId);
      if (path) {
        const { entries, totalLines } = await readTranscriptEntriesFrom(path, 0);
        const tail = entries.slice(-3);
        let denials = 0;
        for (const e of entries) if (parsePermissionDenial(e.entry, now)) denials++;
        console.log(`metadata  ${totalLines} lines, ${denials} detected denial(s). Last 3 messages:`);
        for (const e of tail) {
          const m = parseTranscriptEntry(e.entry, now);
          if (!m) continue;
          const tools = m.toolCalls?.map((t) => t.name).join(',') ?? '';
          console.log(
            `   [${m.role}] ${m.kind}${tools ? ` tools=${tools}` : ''}${
              m.summary ? ` :: ${m.summary}` : ''
            }`,
          );
        }
      }
    }
  }
  console.log('────────────────────────────────────────────────────────');
  const active = snap.sessions.filter((s) => s.status === 'working' || s.status === 'idle');
  console.log(`\nACTIVE (working|idle): ${active.length}   STALE: ${snap.sessions.length - active.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
