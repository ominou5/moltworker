import type { MoltbotEnv } from '../types';

/**
 * Build environment variables to pass to the OpenClaw container process
 * 
 * Updated for OpenClaw 2026.2.3+ native Cloudflare AI Gateway support
 * 
 * @param env - Worker environment bindings
 * @returns Environment variables record
 */
export function buildEnvVars(env: MoltbotEnv): Record<string, string> {
  const envVars: Record<string, string> = {};

  // ============================================================
  // CLOUDFLARE AI GATEWAY (Native OpenClaw 2026.2.3+ support)
  // ============================================================
  // Pass the new cloudflare-ai-gateway provider environment variables
  // These take precedence over legacy AI_GATEWAY_BASE_URL approach
  
  // Account ID for AI Gateway (also used for other Cloudflare services)
  if (env.CF_ACCOUNT_ID) {
    envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
    envVars.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID = env.CF_ACCOUNT_ID;
  }
  
  // AI Gateway ID (defaults to 'moltbot-gateway' in start-moltbot.sh)
  if (env.AI_GATEWAY_ID) {
    envVars.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID = env.AI_GATEWAY_ID;
  }
  
  // Provider API key (e.g., Gemini key stored in Cloudflare Provider Keys)
  // This is different from the legacy approach - it's the actual provider key
  if (env.AI_GATEWAY_API_KEY) {
    envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = env.AI_GATEWAY_API_KEY;
    // Also pass as legacy names for backwards compatibility
    envVars.AI_GATEWAY_API_KEY = env.AI_GATEWAY_API_KEY;
  }
  
  // Cloudflare API token for authenticated gateways (BYOK mode)
  if (env.CF_AIG_AUTHORIZATION) {
    envVars.CF_AIG_AUTHORIZATION = env.CF_AIG_AUTHORIZATION;
  }
  
  // Default model override
  if (env.DEFAULT_MODEL) {
    envVars.DEFAULT_MODEL = env.DEFAULT_MODEL;
  }

  // ============================================================
  // LEGACY AI GATEWAY SUPPORT (for backwards compatibility)
  // ============================================================
  // These are kept for users on older OpenClaw versions
  
  const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL?.replace(/\/+$/, '');
  const isOpenAIGateway = normalizedBaseUrl?.endsWith('/openai') || normalizedBaseUrl?.endsWith('/compat');

  if (normalizedBaseUrl) {
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    if (isOpenAIGateway) {
      envVars.OPENAI_BASE_URL = normalizedBaseUrl;
      if (env.AI_GATEWAY_API_KEY) envVars.OPENAI_API_KEY = env.AI_GATEWAY_API_KEY;
    } else {
      envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
      if (env.AI_GATEWAY_API_KEY) envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
    }
  }

  // ============================================================
  // DIRECT PROVIDER KEYS (fallback when not using AI Gateway)
  // ============================================================
  
  if (!envVars.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY) {
    envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  }
  if (!envVars.OPENAI_API_KEY && env.OPENAI_API_KEY) {
    envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }
  if (env.ANTHROPIC_BASE_URL && !envVars.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }

  // ============================================================
  // GATEWAY & CHANNEL CONFIGURATION
  // ============================================================
  
  // Map MOLTBOT_GATEWAY_TOKEN to CLAWDBOT_GATEWAY_TOKEN (container expects this name)
  if (env.MOLTBOT_GATEWAY_TOKEN) envVars.CLAWDBOT_GATEWAY_TOKEN = env.MOLTBOT_GATEWAY_TOKEN;
  if (env.DEV_MODE) envVars.CLAWDBOT_DEV_MODE = env.DEV_MODE;
  if (env.CLAWDBOT_BIND_MODE) envVars.CLAWDBOT_BIND_MODE = env.CLAWDBOT_BIND_MODE;
  
  // Telegram
  if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  
  // Discord
  if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  
  // Slack
  if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  
  // Browser/CDP
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  
  // Worker URL for callbacks
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;

  return envVars;
}
