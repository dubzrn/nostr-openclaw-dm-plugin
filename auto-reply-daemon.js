#!/usr/bin/env node

const { getPublicKey, finalizeEvent, SimplePool, nip19 } = require('nostr-tools')
const nip04 = require('nostr-tools/nip04')
const nip59 = require('nostr-tools/nip59')

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// Configuration
const PRIVATE_KEY_HEX = 'YOUR_PRIVATE_KEY_HEX'
const SENDER_PUBKEY = 'all' // 'all' for any sender, or hex key for specific sender

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.0xchat.com',
  'wss://nostr.wine',
  'wss://inbox.nostr.wine',
  'wss://auth.nostr1.com'
]

const AUTO_REPLY_TRIGGERS = ['patch-in', 'test', 'hello', 'hi', 'howdy', 'ping', 'dm', 'check', 'verify']
const AUTO_REPLY_MESSAGE = 'Auto-reply: I received your DM! This is an auto-reply confirming that Nostr patch-in feature is working.'
const POLL_INTERVAL_SECONDS = 60

// Rate limiting and retry logic
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 30000

// Store processed event IDs to avoid duplicate replies
const processedEvents = new Set()

// Track rate limit state per relay
const relayRateLimits = new Map() // relay -> { lastErrorTime, backoffUntil, consecutiveFailures }

function getBackoffDelay(attempt) {
  // Exponential backoff with jitter to avoid thundering herd
  const exponentialDelay = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS)
  const jitter = Math.random() * 1000 // +/- 500ms jitter
  return exponentialDelay + jitter
}

async function publishWithRetry(pool, event, relays, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Filter out rate-limited relays
      const availableRelays = relays.filter(url => {
        const rateLimit = relayRateLimits.get(url)
        if (rateLimit && rateLimit.backoffUntil > Date.now()) {
          return false // Skip this relay
        }
        return true
      })

      if (availableRelays.length === 0) {
        console.log('⚠️  All relays rate-limited, waiting 30s...')
        await new Promise(resolve => setTimeout(resolve, 30000))
        continue // Retry with updated limits
      }

      const pub = await Promise.allSettled(
        availableRelays.map(url => pool.publish([url], event))
      )

      // Process results
      let successCount = 0
      let failureCount = 0

      pub.forEach((result, index) => {
        const url = availableRelays[index]
        if (result.status === 'fulfilled') {
          successCount++
          // Reset rate limit on success
          relayRateLimits.delete(url)
          console.log(`✓ Published to ${url}`)
        } else {
          failureCount++
          const reason = result.reason?.message || 'Unknown error'
          console.log(`✗ Failed to publish to ${url}: ${reason}`)

          // Check for rate limit
          if (reason.toLowerCase().includes('rate-limited') || reason.toLowerCase().includes('noting too much') || reason.toLowerCase().includes('you are noting too much')) {
            const current = relayRateLimits.get(url) || { consecutiveFailures: 0 }
            relayRateLimits.set(url, {
              lastErrorTime: Date.now(),
              backoffUntil: Date.now() + getBackoffDelay(current.consecutiveFailures),
              consecutiveFailures: current.consecutiveFailures + 1
            })
            console.log(`⏳  ${url} rate-limited, backoff until ${new Date(Date.now() + getBackoffDelay(current.consecutiveFailures)).toISOString()}`)
          } else if (reason.toLowerCase().includes('inbox') || reason.toLowerCase().includes('blocked') || reason.toLowerCase().includes('does not exist')) {
            // Hard error, don't retry this relay
            relayRateLimits.set(url, {
              lastErrorTime: Date.now(),
              backoffUntil: Infinity, // Never retry this relay
              consecutiveFailures: Infinity
            })
            console.log(`🚫  ${url} permanently blocked`)
          }
        }
      })

      console.log(`Published to ${successCount}/${availableRelays.length} available relays (${successCount}/${relays.length} total)`)

      return successCount > 0

    } catch (err) {
      console.error(`Publish attempt ${attempt + 1} failed:`, err.message)

      if (attempt < maxRetries - 1) {
        const backoff = getBackoffDelay(attempt)
        console.log(`Waiting ${Math.round(backoff / 1000)}s before retry...`)
        await new Promise(resolve => setTimeout(resolve, backoff))
      }
    }
  }

  console.error(`Failed to publish after ${maxRetries} attempts`)
  return false
}

// Helper: send reply DM with rate limit handling
async function sendReply(originalEvent, message) {
  try {
    const PRIVATE_KEY = hexToBytes(PRIVATE_KEY_HEX)
    const myPubkey = getPublicKey(PRIVATE_KEY)

    // Get original sender
    let senderPubkeyHex = originalEvent.pubkey
    if (senderPubkeyHex.startsWith('npub')) {
      const { data } = nip19.decode(senderPubkeyHex)
      senderPubkeyHex = data
    }
    const senderPubkeyBytes = hexToBytes(senderPubkeyHex)

    // Encrypt with NIP-04 (for compatibility with Primal/0xclient)
    const encrypted = nip04.encrypt(PRIVATE_KEY_HEX, senderPubkeyHex, message)

    const replyEvent = finalizeEvent({
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', originalEvent.id],  // Reference original event
        ['p', senderPubkeyHex],       // To sender
        ['p', myPubkey]            // Also to me
      ],
      content: encrypted
    }, PRIVATE_KEY)

    const pool = new SimplePool()

    try {
      console.log(`Sending auto-reply to ${nip19.npubEncode(originalEvent.pubkey)}...`)
      const success = await publishWithRetry(pool, replyEvent, RELAYS, MAX_RETRIES)
      return success
    } catch (err) {
      console.error('Error sending auto-reply:', err.message)
      return false
    } finally {
      try {
        pool.close()
      } catch (e) {
        // Ignore pool.close() errors
      }
    }
  } catch (err) {
    console.error('Reply error:', err.message)
    return false
  }
}

// Check if message is a trigger phrase
function isAutoReplyTrigger(message) {
  const lower = message.toLowerCase()
  return AUTO_REPLY_TRIGGERS.some(trigger => lower.includes(trigger))
}

// Deduplication for gift-wrapped events
function getInnerSenderPubkey(event, privateKeyBytes) {
  if (event.kind === 1059 || event.kind === 1060) {
    try {
      const unwrapped = nip59.unwrapEvent(event, privateKeyBytes)
      return unwrapped?.pubkey || event.pubkey
    } catch (e) {
      return event.pubkey
    }
  }
  return event.pubkey
}

// Decrypt DM (supports NIP-04, NIP-59 gift wrap)
async function decryptDM(event, privateKeyBytes, privateKeyHex) {
  // Check for duplicate processing
  if (processedEvents.has(event.id)) {
    return null
  }
  processedEvents.add(event.id)

  try {
    // Try NIP-59 gift wrap first
    if (event.kind === 1059 || event.kind === 1060) {
      try {
        const unwrapped = nip59.unwrapEvent(event, privateKeyBytes)

        if (unwrapped && unwrapped.kind === 4) {
          // The inner event is a kind 4 DM, decrypt it
          const decrypted = nip04.decrypt(PRIVATE_KEY_HEX, unwrapped.pubkey, unwrapped.content)
          return { content: decrypted, format: 'NIP-59 gift wrap (inner: NIP-04)', sender: unwrapped.pubkey }
        } else if (unwrapped) {
          // Gift-wrapped event but not a DM
          return { content: unwrapped.content || '[empty]', format: `NIP-59 gift wrap (kind ${unwrapped.kind})`, sender: unwrapped.pubkey }
        }
      } catch (nip59Error) {
        console.log(`  ❌ NIP-59 unwrapping failed: ${nip59Error.message}`)
        return null
      }
    }

    // Try NIP-04 (kind 4)
    if (event.kind === 4) {
      try {
        const decrypted = nip04.decrypt(PRIVATE_KEY_HEX, event.pubkey, event.content)
        return { content: decrypted, format: 'NIP-04', sender: event.pubkey }
      } catch (nip04Error) {
        console.log(`  ❌ NIP-04 decryption failed for ${event.id}`)
        return null
      }
    }

    // Unknown format
    return { content: `[unknown format, kind ${event.kind}]`, format: 'unknown', sender: event.pubkey }
  } catch (error) {
    console.log(`  ❌ Decryption error: ${error.message}`)
    return null
  }
}

// Auto-reply daemon
async function autoReplyDaemon() {
  console.log('=== AUTO-REPLY DAEMON ===')
  console.log('Listening for DMs to auto-reply...')
  console.log(`Auto-reply triggers: ${AUTO_REPLY_TRIGGERS.join(', ')}`)
  console.log('')

  const PRIVATE_KEY = hexToBytes(PRIVATE_KEY_HEX)
  const myPubkey = getPublicKey(PRIVATE_KEY)

  console.log(`My npub: ${nip19.npubEncode(myPubkey)}`)
  console.log(`Listening for DMs from: ${SENDER_PUBKEY}`)
  console.log(`Connecting to ${RELAYS.length} relays...`)
  console.log('')

  // Use SimplePool with reconnection and ping enabled
  const pool = new SimplePool({
    enablePing: true,
    enableReconnect: true
  })

  const stats = {
    totalDMs: 0,
    decryptedDMs: 0,
    autoReplies: 0,
    autoReplyErrors: 0,
    startTime: Date.now()
  }

  try {
    // Subscribe to both kind 4 (DMs) and kind 1059/1060 (gift wrap)
    const sub = pool.subscribe(
      RELAYS,
      {
        kinds: [4, 1059, 1060],
        '#p': [myPubkey],
        // No time limit - get all DMs
      },
      {
        onevent: async (event) => {
          try {
            // Skip DMs sent by me (outbound), only process incoming
            if (event.pubkey === myPubkey) {
              return
            }

            const decrypted = await decryptDM(event, PRIVATE_KEY, PRIVATE_KEY_HEX)

            if (!decrypted) {
              return
            }

            stats.totalDMs++
            stats.decryptedDMs++

            console.log('')
            console.log('---')
            console.log('📨 DM Received')
            console.log(`From: ${nip19.npubEncode(decrypted.sender)}`)
            console.log(`Format: ${decrypted.format}`)
            console.log(`Time: ${new Date(event.created_at * 1000).toISOString()}`)
            console.log(`Event ID: ${event.id}`)
            console.log(`Message: ${decrypted.content}`)
            console.log('')

            // Check for auto-reply triggers
            if (isAutoReplyTrigger(decrypted.content)) {
              // Check if we already replied to this event
              if (processedEvents.has(`replied-${event.id}`)) {
                console.log('⏭️  Already auto-replied to this event, skipping...')
                return
              }
              processedEvents.add(`replied-${event.id}`)

              console.log('🔄 Trigger detected, sending auto-reply...')

              // Wait a moment before replying (to avoid flooding)
              await new Promise(resolve => setTimeout(resolve, 1000))

              const replySuccess = await sendReply(event, AUTO_REPLY_MESSAGE)

              if (replySuccess) {
                stats.autoReplies++
                console.log('✅ Auto-reply sent successfully!')
                console.log('')
              } else {
                stats.autoReplyErrors++
                console.log('❌ Auto-reply failed to send')
              }
            } else {
              console.log('ℹ️  No auto-reply trigger detected')
            }
          } catch (err) {
            console.error('Error processing event:', err.message)
          }
        },
        oneose() {
          console.log('(end of stored events, now listening for new events...)')
          console.log('')
        },
        onclose() {
          console.log('Subscription closed')
        }
      }
    )

    // Keep running - poll for stats every POLL_INTERVAL_SECONDS
    const statsInterval = setInterval(() => {
      const runtime = Math.floor((Date.now() - stats.startTime) / 1000)
      console.log('')
      console.log('=== STATS ===')
      console.log(`Runtime: ${Math.floor(runtime / 60)}m ${runtime % 60}s`)
      console.log(`Total DMs: ${stats.totalDMs}`)
      console.log(`Decrypted: ${stats.decryptedDMs}`)
      console.log(`Auto-replies: ${stats.autoReplies}`)
      console.log(`Auto-reply errors: ${stats.autoReplyErrors}`)
      console.log(`Rate-limited relays: ${relayRateLimits.size}`)
      console.log('')
    }, POLL_INTERVAL_SECONDS * 1000)

    // Keep running forever
    await new Promise(resolve => {
      // Never resolve - run forever
    })

  } catch (err) {
    console.error('Error:', err.message)
  } finally {
    clearInterval(statsInterval)
    try {
      pool.close()
    } catch (e) {
      // Ignore pool.close() errors
    }
  }
}

// Run daemon
;(async () => {
  await autoReplyDaemon()
})()
