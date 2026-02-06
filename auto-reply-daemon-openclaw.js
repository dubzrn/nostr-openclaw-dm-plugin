#!/usr/bin/env node

/**
 * Nostr Auto-Reply Daemon for OpenClaw
 *
 * This daemon integrates with OpenClaw's configuration system.
 * It reads Nostr settings from openclaw.json (channels.nost section)
 * and environment variables, enabling full integration with the
 * OpenClaw web dashboard.
 *
 * Commands supported:
 * - 🦀status → Run openclaw gateway status
 * - 🦀current task → Get summary of current task via subagent
 * - 🦀new session → Start new chat session (/new)
 * - 🦀restart → Restart OpenClaw gateway
 * - 🦀relays → Check relay health and status
 * - 🦀help → Show available commands
 * - Auto-reply triggers: patch-in, test, hello, hi, etc.
 *
 * Encryption: NIP-44 (preferred) with NIP-04 fallback for compatibility
 */

const { getPublicKey, finalizeEvent, SimplePool, nip19 } = require('nostr-tools');
const nip04 = require('nostr-tools/nip04');
const nip44 = require('nostr-tools/nip44');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

// Track relay connection health
// Structure: relayUrl -> { connected, lastConnected, lastError, latency }
const relayHealth = new Map();

// ============================================================================
// RELAY DEDUPLICATION & VALIDATION
// ============================================================================

/**
 * Normalize a relay URL (remove trailing slashes, ensure consistent format)
 */
function normalizeRelayUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Trim whitespace
  url = url.trim();

  // Remove trailing slash
  url = url.replace(/\/+$/, '');

  // Validate WebSocket protocol
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    console.warn(`  ⚠️  Invalid relay protocol: ${url}`);
    return null;
  }

  return url;
}

/**
 * Deduplicate relay array while preserving order
 * Returns unique, valid relay URLs
 */
function deduplicateRelays(relays) {
  if (!Array.isArray(relays)) {
    console.warn('  ⚠️  Relays is not an array, using defaults');
    return [];
  }

  const seen = new Set();
  const uniqueRelays = [];

  for (const relay of relays) {
    const normalized = normalizeRelayUrl(relay);

    if (!normalized) {
      console.warn(`  ⚠️  Skipping invalid relay: ${relay}`);
      continue;
    }

    if (seen.has(normalized)) {
      console.log(`  ℹ️  Skipping duplicate relay: ${normalized}`);
      continue;
    }

    seen.add(normalized);
    uniqueRelays.push(normalized);
  }

  return uniqueRelays;
}

/**
 * Deduplicate pubkeys array while preserving order
 * Handles both npub and hex formats
 */
function deduplicatePubkeys(pubkeys) {
  if (!Array.isArray(pubkeys)) {
    console.warn('  ⚠️  Pubkeys is not an array');
    return [];
  }

  const seen = new Set();
  const uniquePubkeys = [];

  for (const key of pubkeys) {
    if (!key || typeof key !== 'string') {
      console.warn(`  ⚠️  Skipping invalid pubkey`);
      continue;
    }

    // Normalize to hex if it's npub
    let hexKey = key;
    if (key.startsWith('npub1')) {
      try {
        const { data: hex } = nip19.decode(key);
        hexKey = hex;
      } catch (error) {
        console.warn(`  ⚠️  Invalid npub format: ${key}`);
        continue;
      }
    }

    // Validate hex key length (64 hex chars)
    if (!/^[a-f0-9]{64}$/i.test(hexKey)) {
      console.warn(`  ⚠️  Invalid hex pubkey: ${key}`);
      continue;
    }

    if (seen.has(hexKey)) {
      console.log(`  ℹ️  Skipping duplicate pubkey: ${key.substring(0, 20)}...`);
      continue;
    }

    seen.add(hexKey);
    uniquePubkeys.push(hexKey);
  }

  return uniquePubkeys;
}

// ============================================================================
// CONFIGURATION LOADER
// ============================================================================

function loadOpenClawConfig() {
  const configPaths = [
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    '/usr/local/lib/node_modules/openclaw/openclaw.json',
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return config;
      }
    } catch (error) {
      console.error(`Error reading config from ${configPath}:`, error.message);
    }
  }

  throw new Error('Could not find openclaw.json in any standard location');
}

function getNostrConfig() {
  try {
    const openclawConfig = loadOpenClawConfig();
    const nostrChannel = openclawConfig?.channels?.entries?.nost || {};
    const env = openclawConfig?.env || {};

    // Priority: explicit channel config > env vars > defaults
    let privateKey = nostrChannel.privateKey;
    if (!privateKey) {
      privateKey = env.OPENCLAW_NOSTR_PRIVATE_KEY;
    }

    if (!privateKey) {
      throw new Error('No private key found. Set channels.nost.privateKey or OPENCLAW_NOSTR_PRIVATE_KEY');
    }

    // Convert nsec to hex if needed
    if (privateKey.startsWith('nsec1')) {
      const { data: hex } = nip19.decode(privateKey);
      privateKey = hex;
    }

    // Relays: channel config > defaults (with deduplication)
    const defaultRelays = [
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://nos.lol',
      'wss://relay.0xchat.com',
      'wss://nostr.wine',
      'wss://inbox.nostr.wine',
      'wss://auth.nostr1.com'
    ];

    const configuredRelays = nostrChannel.relays || defaultRelays;
    const relays = deduplicateRelays(configuredRelays);

    // If deduplication resulted in empty array, use defaults
    const finalRelays = relays.length > 0 ? relays : defaultRelays;

    if (relays.length !== configuredRelays.length) {
      console.log(`  ℹ️  Relay deduplication: ${configuredRelays.length} → ${finalRelays.length} unique relays`);
    }

    // DM Policy
    const dmPolicy = nostrChannel.dmPolicy || 'allowlist';

    // Allowed senders based on policy (with deduplication)
    let allowedSenders = [];
    if (dmPolicy === 'allowlist' && nostrChannel.allowFrom) {
      allowedSenders = deduplicatePubkeys(nostrChannel.allowFrom);
      console.log(`  ℹ️  Allowlist configured: ${nostrChannel.allowFrom.length} pubkeys → ${allowedSenders.length} unique`);
      if (allowedSenders.length !== nostrChannel.allowFrom.length) {
        console.log(`  ℹ️  Pubkey deduplication: ${nostrChannel.allowFrom.length} → ${allowedSenders.length} unique pubkeys`);
      }
    } else if (dmPolicy === 'open' || dmPolicy === 'pairing') {
      allowedSenders = ['*']; // Allow anyone
      console.log(`  ℹ️  Policy: ${dmPolicy} (anyone can DM)`);
    }

    return {
      privateKey,
      relays: finalRelays,
      dmPolicy,
      allowedSenders,
      enabled: nostrChannel.enabled !== false,
      name: nostrChannel.name || 'OpenClaw',
      profile: nostrChannel.profile || {}
    };
  } catch (error) {
    console.error('Failed to load Nostr config:', error.message);
    throw error;
  }
}

// ============================================================================
// CONFIGURATION
// ============================================================================

let config;
try {
  config = getNostrConfig();
  console.log('✓ Loaded Nostr configuration from openclaw.json');
  console.log(`  Policy: ${config.dmPolicy}`);
  console.log(`  Relays: ${config.relays.length} configured`);
  console.log(`  Allowed senders: ${config.allowedSenders.includes('*') ? 'Anyone' : config.allowedSenders.length}`);
} catch (error) {
  console.error('✗ Configuration error:', error.message);
  process.exit(1);
}

if (!config.enabled) {
  console.log('Nostr channel is disabled in openclaw.json. Exiting.');
  process.exit(0);
}

const PRIVATE_KEY_HEX = config.privateKey;
const RELAYS = config.relays;
const ALLOWED_SENDERS = config.allowedSenders;

// Debug logging for config
console.log(`  Config loaded - Allowed senders: ${ALLOWED_SENDERS.length}`);

// Auto-reply triggers (for basic auto-reply, not commands)
const AUTO_REPLY_TRIGGERS = ['patch-in', 'test', 'hello', 'hi', 'howdy', 'ping', 'dm', 'check', 'verify'];
const AUTO_REPLY_MESSAGE = `Auto-reply from ${config.name}: I received your DM! This is an auto-reply confirming that Nostr patch-in feature is working.`;

const POLL_INTERVAL_SECONDS = 60;
const CONVERSATION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const MAX_CONSECUTIVE_FAILURES = 5;
const JITTER_MS = 1000;

// Command cooldowns (in milliseconds)
const COMMAND_COOLDOWNS = {
  restart: 60 * 1000, // 1 minute for restart (takes ~30s)
  status: 10 * 1000,  // 10 seconds for status
  task: 30 * 1000,    // 30 seconds for task info
  newSession: 30 * 1000, // 30 seconds for new session
  help: 5 * 1000,      // 5 seconds for help (low overhead)
  relays: 30 * 1000    // 30 seconds for relay health check
};

// ============================================================================
// STATE TRACKING
// ============================================================================

// Store processed event IDs to avoid duplicate replies
const processedEvents = new Set();

// Track rate limit state per relay
const relayRateLimits = new Map();

// Store per-sender reply tracking and conversation state
// Structure: senderPubkeyHex -> { lastReplyTime, conversationStart, messageCount, lastCommandTime: {commandName: timestamp} }
const senderConversations = new Map();
const repliedEvents = new Set();

// Track command execution times globally (for safety)
const commandCooldowns = new Map(); // commandName -> lastExecutionTime

// ============================================================================
// ENCRYPTION HANDLERS (NIP-44 preferred, NIP-04 fallback)
// ============================================================================

/**
 * Decrypt DM using NIP-44 first, fall back to NIP-04
 * This provides security (NIP-44 v2 XChaCha20-Poly1305) while maintaining
 * compatibility with clients that only support NIP-04.
 */
async function decryptDM(content, privateKey, senderPubkey) {
  // Try NIP-44 first (preferred for security)
  try {
    const decrypted = await nip44.decrypt(content, privateKey, senderPubkey);
    console.log('  🔒 Decrypted with NIP-44 (v2 encryption)');
    return decrypted;
  } catch (error44) {
    console.log('  ℹ️  NIP-44 decrypt failed, trying NIP-04 fallback...');

    // Fall back to NIP-04
    try {
      const decrypted = await nip04.decrypt(content, privateKey, senderPubkey);
      console.log('  🔓 Decrypted with NIP-04 (legacy encryption)');
      return decrypted;
    } catch (error04) {
      throw new Error(`Decryption failed (both NIP-44 and NIP-04): ${error04.message}`);
    }
  }
}

/**
 * Encrypt DM using NIP-44 first, fall back to NIP-04
 * This provides security (NIP-44 v2 XChaCha20-Poly1305) while maintaining
 * compatibility with clients that only support NIP-04.
 */
async function encryptDM(message, privateKey, recipientPubkey) {
  // Try NIP-44 first (preferred for security)
  try {
    const encrypted = nip44.encrypt(privateKey, recipientPubkey, message);
    console.log('  🔒 Encrypted with NIP-44 (v2 encryption)');
    return encrypted;
  } catch (error44) {
    console.log('  ℹ️  NIP-44 encrypt failed, trying NIP-04 fallback...');

    // Fall back to NIP-04
    try {
      const encrypted = await nip04.encrypt(privateKey, recipientPubkey, message);
      console.log('  🔓 Encrypted with NIP-04 (legacy encryption)');
      return encrypted;
    } catch (error04) {
      throw new Error(`Encryption failed (both NIP-44 and NIP-04): ${error04.message}`);
    }
  }
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Handle the 🦀status command
 */
async function handleStatusCommand() {
  try {
    const { stdout, stderr } = await execAsync('openclaw gateway status', {
      timeout: 10000 // 10 second timeout
    });

    let output = stdout || '';
    if (stderr && stderr.trim()) {
      output += `\n[Warning output]\n${stderr}`;
    }

    if (!output.trim()) {
      throw new Error('No output received from gateway status command');
    }

    return `📊 Gateway Status:\n${output}`;
  } catch (error) {
    throw new Error(`Failed to get gateway status: ${error.message}`);
  }
}

/**
 * Handle the 🦀current task command
 * Uses a subagent to gather current task information
 */
async function handleCurrentTaskCommand() {
  try {
    // Check if we can reach the OpenClaw gateway
    const statusResponse = await fetch('http://localhost:18789/status', {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (!statusResponse.ok) {
      throw new Error(`Gateway status check failed: HTTP ${statusResponse.status}`);
    }

    const statusData = await statusResponse.json();

    // Check for active agents
    if (statusData.activeAgents && statusData.activeAgents.length > 0) {
      const agents = statusData.activeAgents.map(a => {
        return `- Agent: ${a.id || 'unknown'} (${a.model || 'default model'})`;
      }).join('\n');

      return `📋 Current Task Summary:\n\nActive agents: ${statusData.activeAgents.length}\n${agents}`;
    }

    // Try to get session list for more detail
    try {
      const sessionsResponse = await fetch('http://localhost:18789/sessions', {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (sessionsResponse.ok) {
        const sessionsData = await sessionsResponse.json();
        if (sessionsData.sessions && sessionsData.sessions.length > 0) {
          const recentSessions = sessionsData.sessions.slice(0, 3).map(s => {
            const age = Math.floor((Date.now() - (s.createdAt || Date.now())) / 1000 / 60);
            return `- Session ${s.id || s.key || 'unknown'} (${age} min ago)`;
          }).join('\n');

          return `📋 Current Task Summary:\n\nRecent sessions:\n${recentSessions}`;
        }
      }
    } catch (sessionsError) {
      // Ignore sessions error, fall through
    }

    return `📋 Current Task Summary:\n\nNo active tasks detected. OpenClaw is ready and waiting for commands.`;
  } catch (error) {
    throw new Error(`Failed to get current task: ${error.message}`);
  }
}

/**
 * Handle the 🦀new session command
 * Starts a new chat session via /new command
 */
async function handleNewSessionCommand() {
  try {
    // Use the sessions API if available, otherwise note that new session should be initiated manually
    const response = await fetch('http://localhost:18789/sessions/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000)
    });

    if (response.ok) {
      const data = await response.json();
      const sessionKey = data.sessionKey || data.key || data.id || 'new session';

      return `✅ New session started!\n\nSession: ${sessionKey}\n\nYou can now send commands to this fresh session.`;
    }

    // If API doesn't work, provide guidance
    throw new Error(`API returned HTTP ${response.status}. Please use /new in your OpenClaw interface to start a new session manually.`);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Timeout waiting for new session. The gateway may be busy.');
    }
    throw new Error(`Failed to start new session: ${error.message}`);
  }
}

/**
 * Handle the 🦀restart command
 * Restarts the OpenClaw gateway
 */
async function handleRestartCommand() {
  try {
    const { stdout, stderr } = await execAsync('openclaw gateway restart', {
      timeout: 60000 // 60 second timeout (restart takes ~30s)
    });

    let output = stdout || '';
    if (stderr && stderr.trim()) {
      output += `\n[Output]\n${stderr}`;
    }

    return `🔄 Gateway restart initiated!\n\n${output}\n\nNote: It will take approximately 30 seconds for the gateway to come back online. Please wait before sending new commands.`;
  } catch (error) {
    throw new Error(`Failed to restart gateway: ${error.message}`);
  }
}

/**
 * Handle the 🦀relays command
 * Check relay health and return status summary
 */
async function handleRelaysCommand() {
  try {
    const results = [];
    const pool = new SimplePool();

    // Check each configured relay
    for (const relayUrl of RELAYS) {
      const startTime = Date.now();

      try {
        // Try to connect with a timeout
        const relay = await pool.ensureRelay(relayUrl);

        // Test by querying our own pubkey
        const myPubkey = getPublicKey(PRIVATE_KEY_HEX);

        // Simple health check: query for recent DMs to our pubkey
        const events = await pool.querySync(
          [relayUrl],
          {
            kinds: [4],
            '#p': [myPubkey],
            limit: 1
          }
        );

        const latency = Date.now() - startTime;
        const isConnected = true;

        // Update relay health tracking
        relayHealth.set(relayUrl, {
          connected: true,
          lastConnected: Date.now(),
          lastError: null,
          latency
        });

        results.push({
          url: relayUrl,
          status: '✅ Online',
          latency: `${latency}ms`,
          eventsFound: events.length
        });

      } catch (error) {
        const latency = Date.now() - startTime;
        const errorMsg = error.message || 'Connection failed';

        // Update relay health tracking
        relayHealth.set(relayUrl, {
          connected: false,
          lastConnected: null,
          lastError: errorMsg,
          latency
        });

        results.push({
          url: relayUrl,
          status: '❌ Offline/Error',
          latency: `${latency}ms`,
          error: errorMsg.substring(0, 50) + (errorMsg.length > 50 ? '...' : '')
        });
      }
    }

    // Format results
    let summary = '📡 Relay Health Summary\n\n';

    const onlineCount = results.filter(r => r.status.includes('Online')).length;
    const offlineCount = results.length - onlineCount;

    summary += `Total Relays: ${results.length}\n`;
    summary += `✅ Online: ${onlineCount}\n`;
    summary += `❌ Offline/Error: ${offlineCount}\n\n`;

    // Detailed status for each relay
    for (const result of results) {
      summary += `${result.status} ${result.url}\n`;
      summary += `   Latency: ${result.latency}`;

      if (result.eventsFound !== undefined) {
        summary += ` | Recent DMs: ${result.eventsFound}`;
      }

      if (result.error) {
        summary += ` | Error: ${result.error}`;
      }

      summary += '\n';
    }

    summary += `\n💡 Tip: Healthy relays respond in <1000ms. Consider removing offline relays from config.`;

    return summary;
  } catch (error) {
    throw new Error(`Failed to check relay health: ${error.message}`);
  }
}

/**
 * Handle the 🦀help command
 * Lists all available crab commands
 */
async function handleHelpCommand() {
  const helpText = `
🦀 CLAW COMMANDS

Available remote control commands:

🦀status
  Run \`openclaw gateway status\` and return full output
  Cooldown: 10 seconds

🦀current task
  Get summary of current task/activity via OpenClaw API
  Cooldown: 30 seconds

🦀new session
  Start a new chat session (equivalent to /new)
  Cooldown: 30 seconds

🦀restart
  Restart the OpenClaw gateway
  Cooldown: 1 minute

🦀relays
  Check health status of all configured Nostr relays
  Shows connection status, latency, and error details
  Cooldown: 30 seconds

🦀help
  Show this help message
  Cooldown: 5 seconds

---

🔒 Encryption Security:
- NIP-44 preferred (v2 XChaCha20-Poly1305 encryption)
- NIP-04 fallback for compatibility with older clients
- Messages automatically use best available encryption

---

Auto-Reply Triggers:
patch-in, test, hello, hi, howdy, ping, dm, check, verify

Send any of these words to get an auto-reply with OpenClaw status.
  `.trim();

  return helpText;
}

/**
 * Check if a command is on cooldown
 */
function isCommandOnCooldown(commandName, senderPubkeyHex) {
  const now = Date.now();
  const cooldownTime = COMMAND_COOLDOWNS[commandName] || 30 * 1000; // Default 30s

  // Check global cooldown (prevents everyone from spamming restart)
  const lastGlobalExecution = commandCooldowns.get(commandName);
  if (lastGlobalExecution && (now - lastGlobalExecution < cooldownTime)) {
    const remainingTime = Math.ceil((cooldownTime - (now - lastGlobalExecution)) / 1000);
    return { onCooldown: true, remainingTime, reason: 'global' };
  }

  // Check per-sender cooldown (prevents one user from spamming)
  const senderState = senderConversations.get(senderPubkeyHex);
  if (senderState && senderState.lastCommandTime) {
    const lastSenderExecution = senderState.lastCommandTime[commandName];
    if (lastSenderExecution && (now - lastSenderExecution < cooldownTime)) {
      const remainingTime = Math.ceil((cooldownTime - (now - lastSenderExecution)) / 1000);
      return { onCooldown: true, remainingTime, reason: 'sender' };
    }
  }

  return { onCooldown: false };
}

/**
 * Mark a command as executed (update cooldowns)
 */
function markCommandExecuted(commandName, senderPubkeyHex) {
  const now = Date.now();

  // Update global cooldown
  commandCooldowns.set(commandName, now);

  // Update per-sender cooldown
  const senderState = senderConversations.get(senderPubkeyHex);
  if (!senderState) {
    senderConversations.set(senderPubkeyHex, {
      lastReplyTime: null,
      conversationStart: null,
      messageCount: 0,
      lastCommandTime: { [commandName]: now }
    });
  } else {
    if (!senderState.lastCommandTime) {
      senderState.lastCommandTime = {};
    }
    senderState.lastCommandTime[commandName] = now;
  }
}

/**
 * Detect and execute commands from message
 */
async function detectAndExecuteCommand(message, senderPubkeyHex) {
  const commands = [
    {
      pattern: /🦀status/i,
      name: 'status',
      handler: handleStatusCommand
    },
    {
      pattern: /🦀current task/i,
      name: 'task',
      handler: handleCurrentTaskCommand
    },
    {
      pattern: /🦀new session/i,
      name: 'newSession',
      handler: handleNewSessionCommand
    },
    {
      pattern: /🦀restart/i,
      name: 'restart',
      handler: handleRestartCommand
    },
    {
      pattern: /🦀help/i,
      name: 'help',
      handler: handleHelpCommand
    },
    {
      pattern: /🦀relays/i,
      name: 'relays',
      handler: handleRelaysCommand
    }
  ];

  for (const command of commands) {
    if (command.pattern.test(message)) {
      console.log(`  🔍 Command detected: ${command.name}`);

      // Check cooldowns
      const cooldownStatus = isCommandOnCooldown(command.name, senderPubkeyHex);
      if (cooldownStatus.onCooldown) {
        const cooldownMsg = `⏳ Command on cooldown. Please wait ${cooldownStatus.remainingTime} seconds before trying again.`;
        console.log(`  ⏳ ${command.name} is on cooldown (${cooldownStatus.remainingTime}s remaining)`);
        return cooldownMsg;
      }

      // Execute command
      try {
        console.log(`  ⚙️  Executing ${command.name} command...`);
        const result = await command.handler();

        // Mark as executed
        markCommandExecuted(command.name, senderPubkeyHex);

        console.log(`  ✅ ${command.name} command completed`);
        return result;
      } catch (error) {
        console.error(`  ✗ ${command.name} command failed:`, error.message);
        // Return error message instead of throwing, so it can be sent as a DM reply
        return `❌ Error: ${error.message}`;
      }
    }
  }

  return null; // No command detected
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function jitter() {
  return Math.floor(Math.random() * 2 * JITTER_MS) - JITTER_MS;
}

async function publishWithRetry(pool, event, relays, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Filter out rate-limited relays
      const availableRelays = relays.filter(url => {
        const rateLimit = relayRateLimits.get(url);
        if (rateLimit && rateLimit.backoffUntil > Date.now()) {
          return false; // Skip this relay
        }
        return true;
      });

      if (availableRelays.length === 0) {
        throw new Error('All relays are rate-limited');
      }

      // Publish to all available relays
      const promises = availableRelays.map(url =>
        pool.publish(url, event).catch(err => {
          console.error(`  ✗ ${url}:`, err.message);
          throw err;
        })
      );

      await Promise.all(promises);
      return true; // Success
    } catch (error) {
      const backoffMs = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, attempt),
        MAX_BACKOFF_MS
      ) + jitter();

      console.log(`  ⏳ Retry attempt ${attempt + 1}/${maxRetries} in ${(backoffMs / 1000).toFixed(1)}s...`);

      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      } else {
        throw error;
      }
    }
  }
  return false;
}

function isSenderAllowed(senderPubkeyHex) {
  if (ALLOWED_SENDERS.includes('*')) {
    return true; // Allow anyone
  }
  return ALLOWED_SENDERS.includes(senderPubkeyHex);
}

function getConversationState(senderPubkeyHex) {
  let state = senderConversations.get(senderPubkeyHex);

  if (!state) {
    state = {
      lastReplyTime: null,
      conversationStart: null,
      messageCount: 0,
      taskStatus: null
    };
    senderConversations.set(senderPubkeyHex, state);
  }

  // Check if conversation timed out
  if (state.lastReplyTime && (Date.now() - state.lastReplyTime > CONVERSATION_TIMEOUT_MS)) {
    // Reset conversation state after timeout
    state.lastReplyTime = null;
    state.conversationStart = null;
    state.messageCount = 0;
    console.log(`  🔄 Conversation timed out for ${nip19.npubEncode(senderPubkeyHex).substring(0, 20)}...`);
  }

  return state;
}

function shouldSendAutoReply(eventId, senderPubkeyHex) {
  // Check if already replied to this specific event
  if (repliedEvents.has(eventId)) {
    console.log(`  ℹ️  Already replied to this event`);
    return false;
  }

  // Check conversation state
  const state = getConversationState(senderPubkeyHex);

  // If within conversation window, only reply if it's the first message of a new conversation
  if (state.lastReplyTime) {
    const timeSinceLastReply = Date.now() - state.lastReplyTime;
    if (timeSinceLastReply < CONVERSATION_TIMEOUT_MS) {
      console.log(`  ⏳ Active conversation, skipping duplicate auto-reply`);
      return false;
    }
  }

  return true;
}

async function checkOpenClawStatus() {
  try {
    const response = await fetch('http://localhost:18789/status', {
      method: 'GET',
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    if (response.ok) {
      const data = await response.json();
      // Check if there's an active task or agent processing
      const hasActiveTask = data.activeAgents && data.activeAgents.length > 0;
      return {
        online: true,
        hasActiveTask,
        agentCount: data.activeAgents?.length || 0
      };
    } else {
      return { online: false, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    return { online: false, error: error.message };
  }
}

// ============================================================================
// MEMORY MANAGEMENT
// ============================================================================

/**
 * Clean up old state to prevent memory leaks
 * Should be called periodically (e.g., every 5 minutes)
 */
function cleanupOldState() {
  const now = Date.now();
  const cleanupThreshold = 24 * 60 * 60 * 1000; // 24 hours

  // Clean up processed events older than 24 hours
  let eventsCleanedCount = 0;
  // Note: processedEvents is a Set, we can't easily clean by timestamp
  // Instead, we'll clear it entirely every 24 hours to prevent unbounded growth
  const timeSinceStart = now - startTime;
  if (timeSinceStart > cleanupThreshold && processedEvents.size > 10000) {
    console.log(`  🧹 Cleaning up processed events (size: ${processedEvents.size})`);
    // In a production environment, we'd want to track timestamps
    // For now, we'll clear if it gets too large
    processedEvents.clear();
    eventsCleanedCount = processedEvents.size;
  }

  // Clean up old conversation state
  let conversationsCleanedCount = 0;
  for (const [pubkey, state] of senderConversations.entries()) {
    if (!state.lastReplyTime) {
      // Never replied, keep but don't clean
      continue;
    }

    const timeSinceLastReply = now - state.lastReplyTime;
    if (timeSinceLastReply > cleanupThreshold) {
      // No activity in 24 hours, remove
      senderConversations.delete(pubkey);
      conversationsCleanedCount++;
    }
  }

  // Clean up old relay rate limits
  for (const [url, rateLimit] of relayRateLimits.entries()) {
    if (rateLimit.backoffUntil < now) {
      // Cooldown expired, remove entry
      relayRateLimits.delete(url);
    }
  }

  // Clean up old command cooldowns
  for (const [command, lastExecuted] of commandCooldowns.entries()) {
    const timeSinceExec = now - lastExecuted;
    const cooldownTime = COMMAND_COOLDOWNS[command] || 30000;
    if (timeSinceExec > cooldownTime * 10) {
      // 10x cooldown has passed, no need to track
      commandCooldowns.delete(command);
    }
  }

  if (eventsCleanedCount > 0 || conversationsCleanedCount > 0) {
    console.log(`🧹 Cleanup: ${eventsCleanedCount} events, ${conversationsCleanedCount} conversations`);
  }

  return { events: eventsCleanedCount, conversations: conversationsCleanedCount };
}

// ============================================================================
// MAIN DAEMON LOGIC
// ============================================================================

async function main() {
  const myPubkey = getPublicKey(PRIVATE_KEY_HEX);
  const myNpub = nip19.npubEncode(myPubkey);

  console.log('=== NOSTR AUTO-REPLY DAEMON ===');
  console.log(`Integrating with OpenClaw config system`);
  console.log(`\nConfiguration:`);
  console.log(`  My npub: ${myNpub}`);
  console.log(`  Policy: ${config.dmPolicy}`);
  console.log(`  Allowed senders: ${ALLOWED_SENDERS.includes('*') ? 'Anyone' : ALLOWED_SENDERS.length} specific`);
  console.log(`  Relays: ${RELAYS.length}`);
  console.log(`  Auto-reply triggers: ${AUTO_REPLY_TRIGGERS.join(', ')}`);
  console.log(`  Conversation timeout: ${CONVERSATION_TIMEOUT_MS / 60000} minutes`);
  console.log(`  Commands: 🦀status, 🦀current task, 🦀new session, 🦀restart, 🦀relays, 🦀help`);

  console.log(`\nListening for DMs...`);

  const pool = new SimplePool();

  // Connect to relays
  console.log(`\nConnecting to ${RELAYS.length} relays...`);
  for (const relay of RELAYS) {
    try {
      await pool.ensureRelay(relay);
      console.log(`  ✓ ${relay}`);
    } catch (error) {
      console.error(`  ✗ ${relay}: ${error.message}`);
    }
  }

  // Stats tracking
  let totalDmsReceived = 0;
  let totalRepliesSent = 0;
  let commandsExecuted = 0;
  let autoRepliesSent = 0;
  let startTime = Date.now();

  // Cleanup stats
  let eventsCleaned = 0;
  let conversationsCleaned = 0;

  // Main polling loop
  setInterval(async () => {
    try {
      // Fetch DMs (kind:4) from relays
      const events = await pool.querySync(
        RELAYS,
        {
          kinds: [4],
          authors: ALLOWED_SENDERS.includes('*') ? undefined : ALLOWED_SENDERS,
          '#p': [myPubkey]
        }
      );

      // Deduplicate events by ID (same event from multiple relays)
      const uniqueEvents = new Map();
      for (const event of events) {
        if (!uniqueEvents.has(event.id)) {
          uniqueEvents.set(event.id, event);
        }
      }
      const dedupedEvents = Array.from(uniqueEvents.values());

      for (const event of dedupedEvents) {
        // Skip if already processed this event
        if (processedEvents.has(event.id)) {
          continue;
        }
        processedEvents.add(event.id);

        const senderPubkeyHex = event.pubkey;
        const senderNpub = nip19.npubEncode(senderPubkeyHex);

        // Check sender is allowed
        if (!isSenderAllowed(senderPubkeyHex)) {
          console.log(`\n📨 DM blocked from ${senderNpub.substring(0, 20)}... (not in allowlist)`);
          continue;
        }

        totalDmsReceived++;

        console.log(`\n📨 DM Received`);
        console.log(`  From: ${senderNpub}`);
        console.log(`  Time: ${new Date(event.created_at * 1000).toISOString()}`);
        console.log(`  Event ID: ${event.id}`);

        // Decrypt the DM (NIP-44 preferred, NIP-04 fallback)
        let message;
        try {
          message = await decryptDM(event.content, PRIVATE_KEY_HEX, senderPubkeyHex);
          console.log(`  Message: ${message}`);
        } catch (decryptError) {
          console.error(`  ✗ Decryption failed: ${decryptError.message}`);
          continue;
        }

        let replyMessage = null;
        let isCommand = false;

        // Check for commands first
        const commandResult = await detectAndExecuteCommand(message, senderPubkeyHex);
        if (commandResult) {
          replyMessage = commandResult;
          isCommand = true;
          console.log(`  🎯 Command response prepared`);
        }

        // If no command, check for auto-reply triggers
        if (!replyMessage) {
          const hasTrigger = AUTO_REPLY_TRIGGERS.some(trigger =>
            message.toLowerCase().includes(trigger.toLowerCase())
          );

          if (hasTrigger) {
            console.log(`  🔄 Trigger detected, preparing auto-reply...`);

            // Check if we should send auto-reply (prevents duplicates)
            if (!shouldSendAutoReply(event.id, senderPubkeyHex)) {
              continue;
            }

            // Check OpenClaw status
            const status = await checkOpenClawStatus();
            let statusMessage = '';

            if (status.online) {
              if (status.hasActiveTask) {
                statusMessage = `\n\n🔍 OpenClaw Status: Ready with ${status.agentCount} active agent(s)`;
              } else {
                statusMessage = `\n\n✅ OpenClaw Status: Ready and waiting`;
              }
            } else {
              statusMessage = `\n\n⚠️ OpenClaw Status: Offline (${status.error})`;
            }

            replyMessage = AUTO_REPLY_MESSAGE + statusMessage;
          }
        }

        // Send reply if we have one
        if (replyMessage) {
          // Encrypt with NIP-44 preferred, NIP-04 fallback
          const encryptedContent = await encryptDM(replyMessage, PRIVATE_KEY_HEX, senderPubkeyHex);

          const replyEvent = finalizeEvent({
            kind: 4,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', senderPubkeyHex]],
            content: encryptedContent
          }, PRIVATE_KEY_HEX);

          console.log(`\n📤 Sending reply to ${senderNpub.substring(0, 20)}...`);

          try {
            await publishWithRetry(pool, replyEvent, RELAYS);
            console.log(`✅ Reply sent successfully!`);
            console.log(`   Content: ${replyMessage.substring(0, 100)}${replyMessage.length > 100 ? '...' : ''}`);

            // Update state
            if (isCommand) {
              commandsExecuted++;
            } else {
              autoRepliesSent++;
              // Update conversation state for auto-replies
              const state = getConversationState(senderPubkeyHex);
              state.lastReplyTime = Date.now();
              state.messageCount++;
              repliedEvents.add(event.id);
            }

            totalRepliesSent++;

          } catch (publishError) {
            console.error(`✗ Failed to send reply: ${publishError.message}`);
          }
        } else {
          console.log(`  ℹ️  No trigger or command detected, skipping`);
        }
      }
    } catch (error) {
      console.error(`\n✗ Error in polling loop: ${error.message}`);
    }
  }, POLL_INTERVAL_SECONDS * 1000);

  // Print stats every 60 seconds
  setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    console.log(`\n=== STATS ===`);
    console.log(`Uptime: ${hours}h ${minutes}m ${seconds}s`);
    console.log(`DMs received: ${totalDmsReceived}`);
    console.log(`Replies sent: ${totalRepliesSent}`);
    console.log(`  Commands executed: ${commandsExecuted}`);
    console.log(`  Auto-replies: ${autoRepliesSent}`);
    console.log(`Active conversations: ${senderConversations.size}`);
    console.log(`Processed events tracked: ${processedEvents.size}`);
    console.log(`=============\n`);
  }, 60000);

  // Cleanup old state every 5 minutes
  setInterval(() => {
    try {
      cleanupOldState();
    } catch (error) {
      console.error(`✗ Error during cleanup: ${error.message}`);
    }
  }, 5 * 60 * 1000);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  process.exit(0);
});

// Handle config reload (SIGHUP)
process.on('SIGHUP', () => {
  console.log('\n\n🔄 Reloading configuration...');
  try {
    const newConfig = getNostrConfig();

    if (newConfig) {
      config = newConfig;
      console.log('✓ Configuration reloaded successfully');
      console.log(`  Policy: ${config.dmPolicy}`);
      console.log(`  Relays: ${config.relays.length}`);
      console.log(`  Allowed senders: ${config.allowedSenders.includes('*') ? 'Anyone' : config.allowedSenders.length}`);

      // Note: Relays pool needs to be updated if relays changed
      // For simplicity, we recommend restart for relay changes
    }
  } catch (error) {
    console.error('✗ Failed to reload configuration:', error.message);
  }
});

// Start the daemon
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
