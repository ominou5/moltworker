import type { Sandbox } from '@cloudflare/sandbox';

/**
 * Environment bindings for the OpenClaw/Moltbot Worker
 * 
 * Updated for OpenClaw 2026.2.3+ native Cloudflare AI Gateway support
 */
export interface MoltbotEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher; // Assets binding for admin UI static files
  MOLTBOT_BUCKET: R2Bucket; // R2 bucket for persistent storage
  
  // ============================================================
  // CLOUDFLARE AI GATEWAY (Native OpenClaw 2026.2.3+ support)
  // ============================================================
  // These are the preferred settings for Cloudflare AI Gateway
  
  CF_ACCOUNT_ID?: string; // Cloudflare account ID (used for AI Gateway + R2)
  AI_GATEWAY_ID?: string; // AI Gateway ID (defaults to 'moltbot-gateway')
  AI_GATEWAY_API_KEY?: string; // Provider API key stored in Cloudflare Provider Keys (e.g., Gemini key)
  CF_AIG_AUTHORIZATION?: string; // Cloudflare API token for authenticated gateways (BYOK mode)
  DEFAULT_MODEL?: string; // Override default model (e.g., 'cloudflare-ai-gateway/google-ai-studio/gemini-2.5-flash')
  
  // ============================================================
  // LEGACY AI GATEWAY CONFIGURATION (backwards compatibility)
  // ============================================================
  // These work with older OpenClaw versions using the /compat or /openai endpoints
  
  AI_GATEWAY_BASE_URL?: string; // AI Gateway URL (e.g., https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat)
  
  // ============================================================
  // DIRECT PROVIDER KEYS (fallback when not using AI Gateway)
  // ============================================================
  
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  
  // ============================================================
  // GATEWAY CONFIGURATION
  // ============================================================
  
  MOLTBOT_GATEWAY_TOKEN?: string; // Gateway token (mapped to CLAWDBOT_GATEWAY_TOKEN for container)
  CLAWDBOT_BIND_MODE?: string;
  DEV_MODE?: string; // Set to 'true' for local dev (skips CF Access auth + device pairing)
  DEBUG_ROUTES?: string; // Set to 'true' to enable /debug/* routes
  SANDBOX_SLEEP_AFTER?: string; // How long before sandbox sleeps: 'never' (default), or duration like '10m', '1h'
  
  // ============================================================
  // CHANNEL CONFIGURATION (Telegram, Discord, Slack)
  // ============================================================
  
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  
  // ============================================================
  // CLOUDFLARE ACCESS CONFIGURATION
  // ============================================================
  
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g., 'myteam.cloudflareaccess.com'
  CF_ACCESS_AUD?: string; // Application Audience (AUD) tag
  
  // ============================================================
  // R2 STORAGE CONFIGURATION
  // ============================================================
  
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  
  // ============================================================
  // BROWSER RENDERING / CDP
  // ============================================================
  
  BROWSER?: Fetcher;
  CDP_SECRET?: string; // Shared secret for CDP endpoint authentication
  WORKER_URL?: string; // Public URL of the worker (for CDP endpoint)
}

/**
 * Authenticated user from Cloudflare Access
 */
export interface AccessUser {
  email: string;
  name?: string;
}

/**
 * Hono app environment type
 */
export type AppEnv = {
  Bindings: MoltbotEnv;
  Variables: {
    sandbox: Sandbox;
    accessUser?: AccessUser;
  };
};

/**
 * JWT payload from Cloudflare Access
 */
export interface JWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  name?: string;
  sub: string;
  type: string;
}
