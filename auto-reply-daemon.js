#!/usr/bin/env node

const { getPublicKey, finalizeEvent, SimplePool, nip19 } = require('nostr-tools');
const nip04 = require('nostr-tools/nip04');
const nip59 = require('nostr-tools/nip59');

// Configuration
const PRIVATE_KEY_HEX = 'e63d146a939be46350a19da8dc240fd69c8998f63ae1d5db7c9091fd5dee94c1'
const SENDER_PUBKEY = 'all'; // 'all' for any sender, or hex key for specific sender

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.0xchat.com',
  'wss://nostr.wine',
  'wss://inbox.nostr.wine',
  'wss://auth.nostr1.com'
];

const AUTO_REPLY_TRIGGERS = ['patch-in', 'test', 'hello', 'hi', 'howdy', 'ping', 'dm', 'check', 'verify'];
const AUTO_REPLY_MESSAGE = 'Auto-reply: I received your DM! This is an auto-reply confirming that Nostr patch-in feature is working.';

const POLL_INTERVAL_SECONDS = 60;
const CONVERSATION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

// Store processed event IDs to avoid duplicate replies
const processedEvents = new Set();

// Track rate limit state per relay
const relayRateLimits = new Map();

// Store per-sender reply tracking and conversation state
// Structure: senderPubkeyHex -> { lastReplyTime, conversationStart, messageCount, taskStatus }
const senderConversations = new Map();
const repliedEvents = new Set();

// Helper: send reply DM with rate limit handling
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
        console.log('⚠️  All relays rate-limited, waiting 30s...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        continue; // Retry with updated limits
      }

      const pub = await Promise.allSettled(
        availableRelays.map(url => pool.publish([url], event))
      );

      // Process results
      let successCount = 0;
      let failureCount = 0;

      pub.forEach((result, index) => {
        const url = availableRelays[index];
        if (result.status === 'fulfilled') {
          successCount++;
          // Reset rate limit on success
          relayRateLimits.delete(url);
          console.log(`✓ Published to ${url}`);
        } else {
          failureCount++;
          const reason = result.reason?.message || 'Unknown error';
          console.log(`✗ Failed to publish to ${url}: ${reason}`);

          // Check for rate limit
          if (reason.toLowerCase().includes('rate-limited') || reason.toLowerCase().includes('noting too much')) {
            const current = relayRateLimits.get(url) || { consecutiveFailures: 0 };
            relayRateLimits.set(url, {
              lastErrorTime: Date.now(),
              backoffUntil: Date.now() + getBackoffDelay(current.consecutiveFailures),
              consecutiveFailures: current.consecutiveFailures + 1
            });
            console.log(`⏳ ${url} rate-limited, backoff until ${new Date(Date.now() + getBackoffDelay(current.consecutiveFailures)).toISOString()}`);
          } else if (reason.toLowerCase().includes('inbox') || reason.toLowerCase().includes('blocked') || reason.toLowerCase().includes('does not exist')) {
            // Hard error, don't retry this relay
            relayRateLimits.set(url, {
              lastErrorTime: Date.now(),
              backoffUntil: Infinity, // Never retry this relay
              consecutiveFailures: Infinity
            });
            console.log(`🚫 ${url} permanently blocked`);
          }
        }
      });

      console.log(`Published to ${successCount}/${availableRelays.length} available relays (${successCount}/${relays.length} total)`);

      return successCount > 0;

    } catch (err) {
      console.error(`Publish attempt ${attempt + 1} failed:`, err.message);

      if (attempt < maxRetries - 1) {
        const backoff = getBackoffDelay(attempt);
        console.log(`Waiting ${Math.round(backoff / 1000)}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }

  console.error(`Failed to publish after ${maxRetries} attempts`);
  return false;
}

// Helper: send reply DM with rate limit handling
async function sendReply(originalEvent, message) {
  try {
    const PRIVATE_KEY = hexToBytes(PRIVATE_KEY_HEX);
    const myPubkey = getPublicKey(PRIVATE_KEY);

    const senderPubkeyHex = originalEvent.pubkey;
    const senderPubkeyBytes = hexToBytes(senderPubkeyHex);
    const senderNpub = nip19.npubEncode(senderPubkeyBytes);

    const encrypted = nip04.encrypt(PRIVATE_KEY_HEX, senderPubkeyHex, message);

    const replyEvent = finalizeEvent({
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', originalEvent.id],
        ['p', senderPubkeyHex],
        ['p', myPubkey]
      ],
      content: encrypted
    }, PRIVATE_KEY);

    const pool = new SimplePool();

    try {
      console.log(`📤 Sending auto-reply to ${senderNpub}...`);
      const success = await publishWithRetry(pool, replyEvent, RELAYS, MAX_RETRIES);
      return success;
    } catch (err) {
      console.error('Error sending auto-reply:', err.message);
      return false;
    } finally {
      try {
        pool.close();
      } catch (e) {
        // Ignore pool.close() errors;
      }
    }
  } catch (err) {
    console.error('Reply error:', err.message);
    return false;
  }
}

function isAutoReplyTrigger(message) {
  const lower = message.toLowerCase();
  return AUTO_REPLY_TRIGGERS.some(trigger => lower.includes(trigger));
}

function getInnerSenderPubkey(event, privateKeyBytes) {
  if (event.kind === 1059 || event.kind === 1060) {
    try {
      const unwrapped = nip59.unwrapEvent(event, privateKeyBytes);
      return unwrapped?.pubkey || event.pubkey;
    } catch (e) {
      return event.pubkey;
    }
  }
  return event.pubkey;
}

async function decryptDM(event, privateKeyBytes, privateKeyHex) {
  if (processedEvents.has(event.id)) {
    return null;
  }
  processedEvents.add(event.id);

  try {
    if (event.kind === 1059 || event.kind === 1060) {
      try {
        const unwrapped = nip59.unwrapEvent(event, privateKeyBytes);
        if (unwrapped && unwrapped.kind === 4) {
          const decrypted = nip04.decrypt(PRIVATE_KEY_HEX, unwrapped.pubkey, unwrapped.content);
          return { content: decrypted, format: 'NIP-59 gift wrap (inner: NIP-04)', sender: unwrapped.pubkey, taskStatus: 'received' };
        } else if (unwrapped) {
          return { content: unwrapped.content || '[empty]', format: `NIP-59 gift wrap (kind ${unwrapped.kind})`, sender: unwrapped.pubkey, taskStatus: 'received' };
        }
      } catch (nip59Error) {
        console.log(`❌ NIP-59 unwrapping failed: ${nip59Error.message}`);
        return null;
      }
    }

    if (event.kind === 4) {
      try {
        const decrypted = nip04.decrypt(PRIVATE_KEY_HEX, event.pubkey, event.content);
        return { content: decrypted, format: 'NIP-04', sender: event.pubkey, taskStatus: 'received' };
      } catch (nip04Error) {
        return null;
      }
    }

    return { content: `[unknown format, kind ${event.kind}]`, format: 'unknown', sender: event.pubkey, taskStatus: 'received' };
  } catch (error) {
    console.log(`❌ Decryption error: ${error.message}`);
    return null;
  }
}

async function autoReplyDaemon() {
  console.log('=== AUTO-REPLY DAEMON ===');
  console.log('Listening for DMs to auto-reply...');
  console.log(`Auto-reply triggers: ${AUTO_REPLY_TRIGGERS.join(', ')}`);
  console.log('');

  const PRIVATE_KEY = hexToBytes(PRIVATE_KEY_HEX);
  const myPubkey = getPublicKey(PRIVATE_KEY);

  console.log(`My npub: ${nip19.npubEncode(myPubkey)}`);
  console.log(`Listening for DMs from: ${SENDER_PUBKEY}`);
  console.log(`Connecting to ${RELAYS.length} relays...`);
  console.log(`Conversation timeout: ${Math.floor(CONVERSATION_TIMEOUT_MS / 60000)} minutes (resets after inactivity)`);
  console.log('');

  const pool = new SimplePool({
    enablePing: true,
    enableReconnect: true
  });

  const stats = {
    totalDMs: 0,
    decryptedDMs: 0,
    autoReplies: 0,
    autoReplyErrors: 0,
    startTime: Date.now()
  };

  try {
    const sub = pool.subscribe(
      RELAYS,
      {
        kinds: [4, 1059, 1060],
        '#p': [myPubkey],
      },
      {
        onevent: async (event) => {
          try {
            if (event.pubkey === myPubkey) {
              return;
            }

            const decrypted = await decryptDM(event, PRIVATE_KEY, PRIVATE_KEY_HEX);

            if (!decrypted) {
              return;
            }

            stats.totalDMs++;
            stats.decryptedDMs++;

            const senderPubkeyBytes = hexToBytes(decrypted.sender);
            const senderPubkeyHex = Buffer.from(senderPubkeyBytes).toString('hex');

            console.log('');
            console.log('---');
            console.log('📨 DM Received');
            console.log(`From: ${nip19.npubEncode(decrypted.sender)}`);
            console.log(`Format: ${decrypted.format}`);
            console.log(`Time: ${new Date(event.created_at * 1000).toISOString()}`);
            console.log(`Event ID: ${event.id}`);
            console.log(`Message: ${decrypted.content}`);
            console.log('');

            if (isAutoReplyTrigger(decrypted.content)) {
              const senderPubkeyHex = decrypted.sender;
              const state = senderConversations.get(senderPubkeyHex);

              // Check if we already replied to this event or conversation expired
              const now = Date.now();
              const shouldReply = !processedEvents.has(`replied-${event.id}`) &&
                                      (!state || now - state.lastReplyTime > CONVERSATION_TIMEOUT_MS);

              if (!shouldReply) {
                if (processedEvents.has(`replied-${event.id}`)) {
                  console.log('⏭️  Already auto-replied to this event, skipping...');
                  return;
                }
                if (state && now - state.lastReplyTime <= CONVERSATION_TIMEOUT_MS) {
                  console.log('⏭️  Already replied to this sender recently (within 1h), skipping...');
                  return;
                }
              }

              processedEvents.add(`replied-${event.id}`);

              console.log('🔄 Trigger detected, preparing auto-reply...');

              const taskInProgress = state && state.messageCount > 0;

              let replyText = AUTO_REPLY_MESSAGE;

              replyText += '\n\n✅ Patch-in daemon running and ready to process your request!';

              const replySuccess = await sendReply(event, replyText);

              if (replySuccess) {
                stats.autoReplies++;
                senderConversations.set(senderPubkeyHex, {
                  lastReplyTime: Date.now(),
                  conversationStart: state ? state.conversationStart : Date.now(),
                  messageCount: state ? state.messageCount : 0) + 1,
                  taskStatus: taskInProgress ? 'completed' : 'in-progress'
                });
                console.log('✅ Auto-reply sent successfully!');
                console.log('');
              } else {
                stats.autoReplyErrors++;
                console.log('❌ Auto-reply failed to send');
              }
            } else {
              console.log('ℹ️  No auto-reply trigger detected');
            }
          } catch (err) {
            console.error('Error processing event:', err.message);
          }
        },
        oneose() {
          console.log('(end of stored events, now listening for new events...)');
          console.log('');
        },
        onclose() {
          console.log('Subscription closed');
        }
      }
    );

    // Periodically reset conversation trackers for inactive conversations
    setInterval(() => {
      const now = Date.now();
      for (const [senderPubkeyHex, state] of senderConversations.entries()) {
        if (state && (now - state.lastReplyTime > CONVERSATION_TIMEOUT_MS)) {
          console.log(`🔄 Reset conversation tracker for inactive: ${nip19.npubEncode(hexToBytes(senderPubkeyHex))}`);
          senderConversations.delete(senderPubkeyHex);
        }
      }
    }, CONVERSATION_TIMEOUT_MS / 2); // Check every 30 minutes

    // Keep running - poll for stats every POLL_INTERVAL_SECONDS
    const statsInterval = setInterval(() => {
      const runtime = Math.floor((Date.now() - stats.startTime) / 1000);
      console.log('');
      console.log('=== STATS ===');
      console.log(`Runtime: ${Math.floor(runtime / 60)}m ${runtime % 60}s`);
      console.log(`Total DMs: ${stats.totalDMs}`);
      console.log(`Decrypted: ${stats.decryptedDMs}`);
      console.log(`Auto-replies: ${stats.autoReplies}`);
      console.log(`Auto-reply errors: ${stats.autoReplyErrors}`);
      console.log(`Active conversations: ${senderConversations.size}`);
      console.log(`Rate-limited relays: ${relayRateLimits.size}`);
      console.log('');
    }, POLL_INTERVAL_SECONDS * 1000);

    await new Promise(resolve => {
      // Never resolve - run forever
    });

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    clearInterval(statsInterval);
    try {
      pool.close();
    } catch (e) {
      // Ignore pool.close() errors;
    }
  }
}

;(async () => {
  await autoReplyDaemon();
})()
