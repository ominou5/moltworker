/**
 * Moltbot + Cloudflare Sandbox
 *
 * This Worker runs Moltbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Moltbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - AI_GATEWAY_API_KEY: Provider API key for Cloudflare AI Gateway (e.g., Gemini key)
 *   OR ANTHROPIC_API_KEY: Direct Anthropic API key (legacy)
 *
 * For Cloudflare AI Gateway (recommended):
 * - CF_ACCOUNT_ID: Your Cloudflare account ID
 * - AI_GATEWAY_ID: Your AI Gateway ID (e.g., 'moltbot-gateway')
 * - AI_GATEWAY_API_KEY: Your provider API key (e.g., Gemini key)
 *
 * Optional secrets:
 * - MOLTBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv } from './types';
import { MOLTBOT_PORT } from './config';
import { createAccessMiddleware } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, syncToR2 } from './gateway';
import { publicRoutes, api, adminUi, debug, cdp } from './routes';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

export { Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 * 
 * Updated for OpenClaw 2026.2.3+ native Cloudflare AI Gateway support.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];

  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }

  if (!env.CF_ACCESS_TEAM_DOMAIN) {
    missing.push('CF_ACCESS_TEAM_DOMAIN');
  }

  if (!env.CF_ACCESS_AUD) {
    missing.push('CF_ACCESS_AUD');
  }

  // Check for AI provider configuration
  // Priority: Native AI Gateway > Legacy AI Gateway > Direct Anthropic
  const hasNativeAIGateway = env.CF_ACCOUNT_ID && (env.AI_GATEWAY_ID || env.AI_GATEWAY_API_KEY);
  const hasLegacyAIGateway = env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL;
  const hasDirectAnthropic = !!env.ANTHROPIC_API_KEY;

  if (!hasNativeAIGateway && !hasLegacyAIGateway && !hasDirectAnthropic) {
    missing.push('AI provider configuration: Set CF_ACCOUNT_ID + AI_GATEWAY_API_KEY (recommended), or AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY (legacy), or ANTHROPIC_API_KEY (direct)');
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 * 
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 * 
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${url.search}`);
  // Updated logging for native AI Gateway support
  const hasNativeGateway = !!(c.env.CF_ACCOUNT_ID && (c.env.AI_GATEWAY_ID || c.env.AI_GATEWAY_API_KEY));
  const hasLegacyGateway = !!(c.env.AI_GATEWAY_API_KEY && c.env.AI_GATEWAY_BASE_URL);
  const hasDirectAnthropic = !!c.env.ANTHROPIC_API_KEY;
  console.log(`[REQ] AI Config: native=${hasNativeGateway}, legacy=${hasLegacyGateway}, anthropic=${hasDirectAnthropic}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

// Middleware: Initialize sandbox for all requests
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);
  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    // Return JSON error for API requests
    return c.json({
      error: 'Configuration error',
      message: 'Required environment variables are not configured',
      missing: missingVars,
      hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
    }, 503);
  }

  return next();
});

// Middleware: Cloudflare Access authentication for protected routes
app.use('*', async (c, next) => {
  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAccessMiddleware({ 
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml 
  });

  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      })
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Provide helpful hints based on configuration
    let hint = 'Check worker logs with: wrangler tail';
    const hasAnyApiKey = c.env.AI_GATEWAY_API_KEY || c.env.ANTHROPIC_API_KEY;
    if (!hasAnyApiKey) {
      hint = 'No API key set. Run: wrangler secret put AI_GATEWAY_API_KEY (or ANTHROPIC_API_KEY)';
    }

    if (acceptsHtml) {
      const originalHtml = configErrorHtml.replace('{{MISSING_VARS}}', errorMessage);
      return c.html(originalHtml, 500);
    }
    return c.json({ error: 'Failed to start Moltbot', details: errorMessage, hint }, 500);
  }

  // Handle WebSocket upgrades
  if (isWebSocketRequest) {
    console.log('[WS] Intercepting WebSocket for transformation');
    
    // Create WebSocket pair for client
    const { 0: clientWs, 1: serverWs } = new WebSocketPair();
    serverWs.accept();
    
    // Connect to container WebSocket
    const containerWsResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
    if (!containerWsResponse.webSocket) {
      console.error('[WS] Container did not return WebSocket');
      serverWs.close(1011, 'Container WebSocket connection failed');
      return new Response('WebSocket connection failed', { status: 500 });
    }
    
    const containerWs = containerWsResponse.webSocket;
    containerWs.accept();
    
    // Forward messages from container to client (with transformation)
    containerWs.addEventListener('message', (event) => {
      try {
        // Try to parse and transform error messages
        const data = event.data;
        if (typeof data === 'string' && data.includes('"error"')) {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error && typeof parsed.error === 'string') {
              parsed.error = transformErrorMessage(parsed.error, new URL(request.url).host);
              serverWs.send(JSON.stringify(parsed));
              return;
            }
          } catch {
            // Not JSON, forward as-is
          }
        }
        serverWs.send(data);
      } catch (e) {
        console.error('[WS] Error forwarding to client:', e);
      }
    });
    
    // Forward messages from client to container
    serverWs.addEventListener('message', (event) => {
      try {
        containerWs.send(event.data);
      } catch (e) {
        console.error('[WS] Error forwarding to container:', e);
      }
    });
    
    // Handle close events
    serverWs.addEventListener('close', (event) => {
      console.log('[WS] Client closed:', event.code, event.reason);
      containerWs.close(event.code, event.reason);
    });
    
    containerWs.addEventListener('close', (event) => {
      console.log('[WS] Container closed:', event.code, event.reason);
      serverWs.close(event.code, event.reason);
    });
    
    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });
    
    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });
    
    console.log('[WS] Returning intercepted WebSocket response');
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);
  
  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);
  
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

/**
 * Scheduled handler for cron triggers.
 * Syncs moltbot config/state from container to R2 for persistence.
 */
async function scheduled(
  _event: ScheduledEvent,
  env: MoltbotEnv,
  _ctx: ExecutionContext
): Promise<void> {
  const options = buildSandboxOptions(env);
  const sandbox = getSandbox(env.Sandbox, 'moltbot', options);

  console.log('[cron] Starting backup sync to R2...');
  const result = await syncToR2(sandbox, env);
  
  if (result.success) {
    console.log('[cron] Backup sync completed successfully at', result.lastSync);
  } else {
    console.error('[cron] Backup sync failed:', result.error, result.details || '');
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
