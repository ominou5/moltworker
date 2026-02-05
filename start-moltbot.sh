#!/bin/bash
# Startup script for OpenClaw/Moltbot in Cloudflare Sandbox
# This script:
# 1. Restores config from R2 backup if available
# 2. Configures OpenClaw from environment variables
# 3. Starts the gateway
#
# Updated for OpenClaw 2026.2.3+ with native Cloudflare AI Gateway support

set -e

# Check if clawdbot gateway is already running - bail early if so
# Note: CLI is still named "clawdbot" until upstream renames it
if pgrep -f "clawdbot gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

# Paths (clawdbot paths are used internally - upstream hasn't renamed yet)
CONFIG_DIR="/root/.clawdbot"
CONFIG_FILE="$CONFIG_DIR/clawdbot.json"
TEMPLATE_DIR="/root/.clawdbot-templates"
TEMPLATE_FILE="$TEMPLATE_DIR/moltbot.json.template"
BACKUP_DIR="/data/moltbot"

echo "Config directory: $CONFIG_DIR"
echo "Backup directory: $BACKUP_DIR"

# Create config directory
mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================
# Check if R2 backup exists by looking for clawdbot.json
# The BACKUP_DIR may exist but be empty if R2 was just mounted
# Note: backup structure is $BACKUP_DIR/clawdbot/ and $BACKUP_DIR/skills/

# Helper function to check if R2 backup is newer than local
should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$CONFIG_DIR/.last-sync"
    
    # If no R2 backup exists, don't restore
    if [ ! -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
        echo "No R2 backup found at $BACKUP_DIR/clawdbot/clawdbot.json"
        return 1
    fi
    
    # If no local config, restore from R2
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "No local config, will restore from R2"
        return 0
    fi
    
    # Compare sync timestamps if both exist
    if [ -f "$R2_SYNC_FILE" ] && [ -f "$LOCAL_SYNC_FILE" ]; then
        local R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null || echo "0")
        local LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null || echo "0")
        if [ "$R2_TIME" -gt "$LOCAL_TIME" ] 2>/dev/null; then
            echo "R2 backup is newer ($R2_TIME > $LOCAL_TIME)"
            return 0
        fi
    fi
    
    return 1
}

# Restore from R2 if appropriate
if should_restore_from_r2; then
    echo "Restoring configuration from R2 backup..."
    
    # Restore clawdbot config
    if [ -d "$BACKUP_DIR/clawdbot" ]; then
        cp -r "$BACKUP_DIR/clawdbot/"* "$CONFIG_DIR/" 2>/dev/null || true
        echo "Restored clawdbot config from R2"
    fi
    
    # Restore skills from R2 backup if available (only if R2 is newer)
    if [ -d "$BACKUP_DIR/skills" ] && [ "$(ls -A $BACKUP_DIR/skills 2>/dev/null)" ]; then
        mkdir -p "$CONFIG_DIR/skills"
        cp -r "$BACKUP_DIR/skills/"* "$CONFIG_DIR/skills/" 2>/dev/null || true
        echo "Restored skills from R2"
    fi
else
    echo "Using local config (no R2 restore needed)"
fi

# If config file still doesn't exist, create from template
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$TEMPLATE_FILE" ]; then
        echo "Creating config from template..."
        cp "$TEMPLATE_FILE" "$CONFIG_FILE"
    else
        echo "Creating minimal config..."
        echo '{}' > "$CONFIG_FILE"
    fi
fi

# ============================================================
# CONFIGURE FROM ENVIRONMENT VARIABLES
# ============================================================
# This runs on every startup to ensure env vars take precedence
# Uses OpenClaw 2026.2.3+ native Cloudflare AI Gateway provider

node << EOFNODE
const fs = require('fs');

const configPath = '/root/.clawdbot/clawdbot.json';
console.log('Updating config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};
config.models = config.models || {};
config.models.providers = config.models.providers || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided
if (process.env.CLAWDBOT_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.CLAWDBOT_GATEWAY_TOKEN;
}

// Allow insecure auth for dev mode
if (process.env.CLAWDBOT_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.channels.telegram.enabled = true;
    config.channels.telegram.dm = config.channels.telegram.dm || {};
    config.channels.telegram.dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
}

// Discord configuration
if (process.env.DISCORD_BOT_TOKEN) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.token = process.env.DISCORD_BOT_TOKEN;
    config.channels.discord.enabled = true;
    config.channels.discord.dm = config.channels.discord.dm || {};
    config.channels.discord.dm.policy = process.env.DISCORD_DM_POLICY || 'pairing';
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.botToken = process.env.SLACK_BOT_TOKEN;
    config.channels.slack.appToken = process.env.SLACK_APP_TOKEN;
    config.channels.slack.enabled = true;
}

// ============================================================
// CLOUDFLARE AI GATEWAY CONFIGURATION
// ============================================================
// Uses OpenClaw 2026.2.3+ native cloudflare-ai-gateway provider
//
// Required environment variables:
//   CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID - Your Cloudflare account ID
//   CLOUDFLARE_AI_GATEWAY_GATEWAY_ID - Your AI Gateway ID
//   CLOUDFLARE_AI_GATEWAY_API_KEY    - Your provider API key (e.g., Gemini key) 
//                                      stored in Cloudflare Provider Keys
//   CF_AIG_AUTHORIZATION             - (Optional) Cloudflare API token for 
//                                      authenticated gateways

const accountId = process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const gatewayId = process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID || 'moltbot-gateway';
const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY || process.env.AI_GATEWAY_API_KEY;
const cfAuthToken = process.env.CF_AIG_AUTHORIZATION;

// Debug logging
console.log('CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID:', accountId || '(not set)');
console.log('CLOUDFLARE_AI_GATEWAY_GATEWAY_ID:', gatewayId);
console.log('CLOUDFLARE_AI_GATEWAY_API_KEY:', apiKey ? apiKey.substring(0, 10) + '...' : '(not set)');
console.log('CF_AIG_AUTHORIZATION:', cfAuthToken ? 'set (hidden)' : '(not set)');

if (accountId && apiKey) {
    console.log('Configuring native Cloudflare AI Gateway provider...');
    
    // Clear any legacy provider configs to avoid conflicts
    delete config.models.providers.anthropic;
    delete config.models.providers.openai;
    
    // Configure the native cloudflare-ai-gateway provider
    config.models.providers['cloudflare-ai-gateway'] = {
        accountId: accountId,
        gatewayId: gatewayId,
        apiKey: apiKey,
    };
    
    // Add cf-aig-authorization header if provided (for authenticated gateways/BYOK)
    if (cfAuthToken) {
        config.models.providers['cloudflare-ai-gateway'].headers = {
            'cf-aig-authorization': cfAuthToken.startsWith('Bearer ') 
                ? cfAuthToken 
                : 'Bearer ' + cfAuthToken
        };
    }
    
    // Configure model aliases for Gemini via AI Gateway
    config.agents.defaults.models = config.agents.defaults.models || {};
    
    // Gemini models via Cloudflare AI Gateway
    config.agents.defaults.models['cloudflare-ai-gateway/google-ai-studio/gemini-2.0-flash'] = { alias: 'Gemini 2.0 Flash' };
    config.agents.defaults.models['cloudflare-ai-gateway/google-ai-studio/gemini-2.5-flash'] = { alias: 'Gemini 2.5 Flash' };
    config.agents.defaults.models['cloudflare-ai-gateway/google-ai-studio/gemini-2.5-pro'] = { alias: 'Gemini 2.5 Pro' };
    
    // Anthropic models via Cloudflare AI Gateway
    config.agents.defaults.models['cloudflare-ai-gateway/claude-opus-4-5'] = { alias: 'Claude Opus 4.5' };
    config.agents.defaults.models['cloudflare-ai-gateway/claude-sonnet-4-5'] = { alias: 'Claude Sonnet 4.5' };
    
    // OpenAI models via Cloudflare AI Gateway  
    config.agents.defaults.models['cloudflare-ai-gateway/gpt-4o'] = { alias: 'GPT-4o' };
    config.agents.defaults.models['cloudflare-ai-gateway/gpt-4o-mini'] = { alias: 'GPT-4o Mini' };
    
    // Set default primary model
    const defaultModel = process.env.DEFAULT_MODEL || 'cloudflare-ai-gateway/google-ai-studio/gemini-2.5-flash';
    config.agents.defaults.model.primary = defaultModel;
    console.log('Default model:', defaultModel);
    
} else if (process.env.ANTHROPIC_API_KEY) {
    // Fallback to direct Anthropic if no AI Gateway config
    console.log('No AI Gateway config, using direct Anthropic provider');
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['anthropic/claude-opus-4-5-20251101'] = { alias: 'Opus 4.5' };
    config.agents.defaults.models['anthropic/claude-sonnet-4-5-20250929'] = { alias: 'Sonnet 4.5' };
    config.agents.defaults.models['anthropic/claude-haiku-4-5-20251001'] = { alias: 'Haiku 4.5' };
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else {
    // Default provider (uses built-in pi-ai catalog)
    console.log('No API configuration found, using default provider');
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration updated successfully');
console.log('Final config:', JSON.stringify(config, null, 2));
EOFNODE

# ============================================================
# START GATEWAY
# ============================================================
# Note: R2 backup sync is handled by the Worker's cron trigger
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

# Clean up stale lock files
rm -f /tmp/clawdbot-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

BIND_MODE="lan"
echo "Dev mode: ${CLAWDBOT_DEV_MODE:-false}, Bind mode: $BIND_MODE"

if [ -n "$CLAWDBOT_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$CLAWDBOT_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
