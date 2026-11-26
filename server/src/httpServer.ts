import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import { agentCreatedMessage } from './agentMessages.js';
import { createAgentState } from './agentState.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  USAGE_API_PREFIX,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import { applyReportedContext } from './contextUsage.js';
import { hookProviderById } from './providers/index.js';
import { registerTerminalRoutes } from './terminal/terminalRoutes.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';
import type { AgentState } from './types.js';
import {
  PRIVILEGED_BROADCAST_TYPES,
  recordUsageReport,
  usageLimitsMessage,
} from './usageLimits.js';
import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  privilegedHostnames,
  redactTokenQuery,
  standaloneHandshakeVerdict,
} from './wsAuth.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** PTY terminals for standalone-launched agents. Absent = terminal feature off
   *  (VS Code embedded mode, where the editor owns terminals). */
  ptyManager?: TerminalSessions;
  /** The package root holding dist/hooks/ (standalone), from which the Usage
   *  Bars toggle installs the status line bridge script. */
  packageRoot?: string;
  /** Extra Host names (beyond loopback and a specific bind address) a
   *  privileged standalone handshake may arrive under -- e.g. a reverse proxy's
   *  public name. See wsAuth.privilegedHostnames. */
  allowedHosts?: readonly string[];
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    // Standalone logs every request. The privilege token rides `/ws?token=`
    // and `/terminal/:id?token=` handshakes, so the url is redacted before it
    // is written -- otherwise every (re)connect would put the secret in stdout
    // and any log file (see wsAuth.redactTokenQuery).
    logger: options.embedded ? false : { serializers: { req: serializeRequestForLog } },
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  const host = options.host ?? '127.0.0.1';
  const allowedHostnames = privilegedHostnames(host, options.allowedHosts ?? []);

  registerHealthRoute(app);
  registerDevRoute(app, options);
  registerHookRoute(app, options);
  registerScreenRoute(app, options);
  registerSayRoute(app, options);
  registerUsageRoute(app, options);
  registerWebSocketRoute(app, options, allowedHostnames);
  registerTerminalRoutes(app, {
    token: options.token,
    allowedHostnames,
    ptyManager: options.ptyManager,
  });

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Dev-only synthetic agents (PIXEL_AGENTS_DEV=1) ───────────────
// Lets development/verification inject a character without a live Claude Code
// session: POST /api/dev/spawn {name?} creates an agent and animates it;
// POST /api/dev/despawn {id} removes it. Never registered in normal runs.
let devAgentCounter = 900000;

function registerDevRoute(app: FastifyInstance, options: HttpServerOptions): void {
  if (process.env['PIXEL_AGENTS_DEV'] !== '1') return;
  const store = options.store;

  app.post('/api/dev/spawn', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = devAgentCounter++;
    const name = typeof body['name'] === 'string' ? body['name'] : `Dev-${id}`;
    const agent = createAgentState({
      id,
      sessionId: `dev-${id}`,
      projectDir: '/dev',
      jsonlFile: '',
      isExternal: true,
      directoryName: name,
      hooksOnly: true,
    });
    store.set(id, agent);
    store.broadcast(agentCreatedMessage(id, agent));
    store.broadcast({ type: 'agentStatus', id, status: 'active' });
    store.broadcast({
      type: 'agentToolStart',
      id,
      toolId: `dev-${id}-t`,
      toolName: 'Edit',
      status: 'Editing dev.ts',
    });
    return { ok: true, id };
  });

  app.post('/api/dev/despawn', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = Number(body['id']);
    if (Number.isFinite(id) && store.has(id)) {
      store.delete(id);
      store.broadcast({ type: 'agentClosed', id });
    }
    return { ok: true };
  });
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── Live screen thumbnails ─────────────────────────────────────

/** Latest screen thumbnail per agent id, re-sent to each client on connect so a
 *  (re)connecting office shows the current screen immediately instead of waiting
 *  for the next push. In-memory only — never persisted (images would bloat the
 *  state file). */
const latestScreens = new Map<number, { image: string; app?: string }>();

/** A capture client (a friend's machine) posts a small active-window thumbnail
 *  here, keyed by its Claude session id; the server maps it to the agent and
 *  broadcasts it to every office so the character shows a live monitor. */
function registerScreenRoute(app: FastifyInstance, options: HttpServerOptions): void {
  const store = options.store;
  app.post<{ Body: { sessionId?: string; image?: string; app?: string } }>(
    '/api/screen',
    {
      preHandler: bearerAuth(options.token),
      bodyLimit: 512 * 1024, // thumbnails are a few KB; allow headroom
    },
    async (request, reply) => {
      const { sessionId, image, app: appLabel } = request.body ?? {};
      if (typeof sessionId !== 'string' || typeof image !== 'string') {
        reply.code(400).send({ ok: false, msg: 'sessionId and image required' });
        return;
      }
      for (const agent of store.values()) {
        if (agent.sessionId === sessionId) {
          const hasApp = typeof appLabel === 'string' && appLabel;
          if (image) latestScreens.set(agent.id, { image, ...(hasApp ? { app: appLabel } : {}) });
          else latestScreens.delete(agent.id);
          store.broadcast({
            type: 'agentScreenThumbnail',
            id: agent.id,
            image,
            ...(hasApp ? { app: appLabel } : {}),
          });
          break;
        }
      }
      reply.send('ok');
    },
  );
}

// ── Custom speech ──────────────────────────────────────────────

/** Make a character say something: POST /api/say {sessionId, text} maps the
 *  session to its agent and broadcasts a speech bubble to every office. */
function registerSayRoute(app: FastifyInstance, options: HttpServerOptions): void {
  const store = options.store;
  app.post<{ Body: { sessionId?: string; text?: string } }>(
    '/api/say',
    { preHandler: bearerAuth(options.token) },
    async (request, reply) => {
      const { sessionId, text } = request.body ?? {};
      if (typeof sessionId !== 'string' || typeof text !== 'string') {
        reply.code(400).send({ ok: false, msg: 'sessionId and text required' });
        return;
      }
      for (const agent of store.values()) {
        if (agent.sessionId === sessionId) {
          store.broadcast({ type: 'agentSpeech', id: agent.id, text: text.slice(0, 200) });
          break;
        }
      }
      reply.send('ok');
    },
  );
}

// ── Usage reports ──────────────────────────────────────────────

/** A provider's usage bridge reports the account's plan limits here. Stored,
 *  and passed on to the office when they moved (recordUsageReport). */
function registerUsageRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{ Params: { providerId: string }; Body: unknown }>(
    `${USAGE_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: { providerId: { type: 'string', pattern: '^[a-z0-9-]+$' } },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const provider = hookProviderById(request.params.providerId);
      if (provider && recordUsageReport(provider, request.body)) {
        options.store.broadcast({ ...usageLimitsMessage(provider.id) });
      }
      const context = provider?.usageBridge?.normalizeContext(request.body);
      if (context) applyReportedContext(options.store, context);
      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office. What
    // may be DONE over an accepted connection is a separate question, decided
    // below.
    if (options.embedded) {
      if (!bearerTokenValid(request.headers.authorization, options.token)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake, and it must arrive under an allowed Host
    // -- the same verdict the terminal socket applies. A network POSITION
    // never grants privilege, because every position is reproducible by a
    // forwarder; the Host allowlist can only take it away.
    let privileged = options.embedded;
    if (!options.embedded) {
      const verdict = standaloneHandshakeVerdict(
        request.url,
        request.headers.host,
        options.token,
        allowedHostnames,
      );
      privileged = verdict === 'privileged';
      if (verdict === 'untrusted-host') {
        // The operator has the right URL but reached us under a name they never
        // listed (typically a reverse proxy). Say how to fix it, or the session
        // silently stays watch-only.
        console.warn(
          `[Pixel Agents] Tokened connection via Host "${request.headers.host ?? ''}" is read-only: restart with --allowed-host <that name> to allow changes from it.`,
        );
      }
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, agentCreatedMessage(id, agent));
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      // The operator's account usage is not for read-only viewers.
      if (!privileged && PRIVILEGED_BROADCAST_TYPES.has(String(message.type))) return;
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          packageRoot: options.packageRoot,
          privileged,
          ptyManager: options.ptyManager,
        });
        // Replay the latest cached screen thumbnails to a (re)connecting office,
        // after its existingAgents snapshot has rebuilt the characters.
        if (msg.type === 'webviewReady') {
          for (const [id, scr] of latestScreens) {
            if (store.has(id)) {
              safeSend(socket, {
                type: 'agentScreenThumbnail',
                id,
                image: scr.image,
                ...(scr.app ? { app: scr.app } : {}),
              });
            }
          }
        }
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerTokenValid(request.headers.authorization, expectedToken)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Logging ────────────────────────────────────────────────────

/** Fastify's default request serializer, minus the token query. Exported so a
 *  test can pin that the secret never reaches the log line. */
export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactTokenQuery(request.url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
