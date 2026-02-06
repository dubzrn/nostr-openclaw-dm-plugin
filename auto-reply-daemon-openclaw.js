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
 * - Auto-reply triggers: patch-in, test, hello, hi, etc.
 */

const { getPublicKey, finalizeEvent, SimplePool, nip19 } = require('nostr-tools');
const nip04 = require('nostr-tools/nip04');
const nip59 = require('nostr-tools/nip59');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

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

    // Relays: channel config > defaults
    const relays = nostrChannel.relays || [
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://nos.lol',
      'wss://relay.0xchat.com',
      'wss://nostr.wine',
      'wss://inbox.nostr.wine',
      'wss://auth.nostr1.com'
    ];

    // DM Policy
    const dmPolicy = nostrChannel.dmPolicy || 'allowlist';

    // Allowed senders based on policy
    let allowedSenders = [];
    if (dmPolicy === 'allowlist' && nostrChannel.allowFrom) {
      allowedSenders = nostrChannel.allowFrom.map(key => {
        if (key.startsWith('npub1')) {
          const { data: hex } = nip19.decode(key);
          return hex;
        }
        return key;
      });
    } else if (dmPolicy === 'open' || dmPolicy === 'pairing') {
      allowedSenders = ['*']; // Allow anyone
    }

    return {
      privateKey,
      relays,
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
  newSession: 30 * 1000 // 30 seconds for new session
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
  console.log(`  Commands: 🦀status, 🦀current task, 🦀new session, 🦀restart`);

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

  // Main polling loop
  setInterval(async () => {
    try {
      // Fetch DMs (kind:4) from relays
      const events = await pool.list(
        RELAYS,
        [
          {
            kinds: [4],
            authors: ALLOWED_SENDERS.includes('*') ? undefined : ALLOWED_SENDERS,
            '#p': [myPubkey]
          }
        ]
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

        // Decrypt the DM
        let message;
        try {
          message = await nip04.decrypt(
            event.content,
            PRIVATE_KEY_HEX,
            senderPubkeyHex
          );
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
          const replyEvent = finalizeEvent({
            kind: 4,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', senderPubkeyHex]],
            content: await nip04.encrypt(PRIVATE_KEY_HEX, senderPubkeyHex, replyMessage)
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

// Start the daemon
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
