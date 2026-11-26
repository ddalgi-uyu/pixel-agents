import * as fs from 'fs';

import { HOOK_API_PREFIX } from '../../../../constants.js';
import * as os from 'os';

import { liveServers, postToServer, remoteServers } from './serverRegistry.js';

/** Per-server POST timeout. */
const HOOK_POST_TIMEOUT_MS = 2000;

/**
 * CI / e2e diagnostic: when PIXEL_AGENTS_DEBUG_LOG is set, record the hook
 * script's outcome at every exit point. The hook delivery chain (spawn
 * claude-hook.js -> read the registry -> POST to every live server) is
 * otherwise 100% silent: every failure path resolves quietly, so a dropped
 * hook is invisible in CI. Logging here lets a failing run show exactly
 * where delivery dies (bad-stdin, no-server-json, per-server POST
 * error/timeout/status). Zero cost when the env var is unset.
 */
// Env var is the primary source, but it doesn't reliably reach this spawned
// process across platforms (macOS VS Code terminal profiles with
// inheritEnv:false, etc.). After reading the registry we fall back to a
// live server's `debugLog` field, which the server populated from the same
// env var.
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} HOOKSCRIPT ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  // Multi-server fan-out (D4): deliver to every live server in the registry,
  // or the single legacy server.json when the registry has no live entries.
  const label = `event=${eventName} sid=${sid}`;
  // Deliver to local registry servers AND any remote office set via env
  // (PIXEL_AGENTS_OFFICE[_TOKEN]) so a friend's events reach the shared host.
  const local = liveServers(hookDebug, label);
  const servers = [...(local ?? []), ...remoteServers(hookDebug)];
  if (servers.length === 0) process.exit(0);

  // Adopt the first live server's debug-log path if the env var didn't reach
  // us (diagnostic-only; harmless if more than one server has it set).
  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => s.debugLog);
    if (withDebugLog?.debugLog) debugLogPath = withDebugLog.debugLog;
  }

  // Tag the event with this machine so a remote office can label the character
  // by hostname (ignored by a local server, which labels by directory).
  if (data['hostname'] === undefined) data['hostname'] = os.hostname();
  const body = JSON.stringify(data);
  await Promise.all(
    servers.map((server) =>
      postToServer(server, {
        path: `${HOOK_API_PREFIX}/claude`,
        body,
        label,
        debug: hookDebug,
        timeoutMs: HOOK_POST_TIMEOUT_MS,
      }),
    ),
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
