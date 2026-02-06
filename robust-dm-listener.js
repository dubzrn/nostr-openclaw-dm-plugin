#!/usr/bin/env node

const { getPublicKey, SimplePool, nip19 } = require('nostr-tools')
const nip04 = require('nostr-tools/nip04')
const nip44 = require('nostr-tools/nip44')
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

// Event deduplication to handle same event from multiple relays
const seenEvents = new Set()

// Decryption result structure
class DMResult {
  constructor(event, decrypted, format) {
    this.event = event
    this.decrypted = decrypted
    this.format = format
  }
}

// Try to decrypt an event using multiple formats
async function decryptEvent(event, privateKeyBytes, privateKeyHex) {
  // Check for duplicates
  if (seenEvents.has(event.id)) {
    return null
  }
  seenEvents.add(event.id)

  try {
    // Try NIP-59 gift wrap first (kind 1059)
    if (event.kind === 1059 || event.kind === 1060) {
      try {
        const unwrapped = nip59.unwrapEvent(event, privateKeyBytes)

        if (unwrapped && unwrapped.kind === 4) {
          // The inner event is a kind 4 DM, decrypt it
          try {
            const senderBytes = hexToBytes(unwrapped.pubkey)
            const decrypted = nip04.decrypt(PRIVATE_KEY_HEX, unwrapped.pubkey, unwrapped.content)
            return new DMResult(event, decrypted, `NIP-59 gift wrap (inner: NIP-04)`)
          } catch (nip04Error) {
            // Try NIP-44 on the inner event
            try {
              const senderBytes = hexToBytes(unwrapped.pubkey)
              const decrypted = nip44.decrypt(unwrapped.content, privateKeyBytes, senderBytes)
              return new DMResult(event, decrypted, `NIP-59 gift wrap (inner: NIP-44)`)
            } catch (nip44Error) {
              return new DMResult(event, unwrapped.content, `NIP-59 gift wrap (plain content)`)
            }
          }
        } else if (unwrapped) {
          // Gift-wrapped event but not a DM
          return new DMResult(event, unwrapped.content || '[empty]', `NIP-59 gift wrap (kind ${unwrapped.kind})`)
        }
      } catch (nip59Error) {
        console.log(`  ❌ NIP-59 unwrapping failed: ${nip59Error.message}`)
      }
    }

    // Try NIP-04 (kind 4)
    if (event.kind === 4) {
      try {
        const decrypted = nip04.decrypt(PRIVATE_KEY_HEX, event.pubkey, event.content)
        return new DMResult(event, decrypted, 'NIP-04')
      } catch (nip04Error) {
        // Try NIP-44 as fallback (some clients use NIP-44 in kind 4)
        try {
          const senderBytes = hexToBytes(event.pubkey)
          const decrypted = nip44.decrypt(event.content, privateKeyBytes, senderBytes)
          return new DMResult(event, decrypted, 'NIP-44 (in kind 4)')
        } catch (nip44Error) {
          console.log(`  ❌ NIP-04 and NIP-44 decryption failed for ${event.id}`)
          return null // Don't return anything if decryption fails
        }
      }
    }

    // Unknown format
    return new DMResult(event, `[unknown format, kind ${event.kind}]`, 'unknown')
  } catch (error) {
    console.log(`  ❌ Decryption error: ${error.message}`)
    return new DMResult(event, `[decryption error: ${error.message}]`, 'error')
  }
}

async function listenForDMs() {
  console.log('=== ROBUST NOSTR DM LISTENER ===')
  console.log('Supports: NIP-04, NIP-44, NIP-59 (gift wrap)')
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

  const receivedDMs = []

  try {
    // Subscribe to both kind 4 (DMs) and kind 1059/1060 (gift wrap)
    console.log('Subscribing to events...')
    const sub = pool.subscribe(
      RELAYS,
      {
        kinds: [4, 1059, 1060],
        '#p': [myPubkey],
        // No time limit - get all DMs, not just recent ones
      },
      {
        onevent: async (event) => {
          try {
            // Skip DMs sent by me (outbound), only process incoming
            if (event.pubkey === myPubkey) {
              console.log(`⏭️  Skipping outbound DM from me (kind ${event.kind})`)
              return
            }

            // Check if DM is from the specified sender (or any sender if SENDER_PUBKEY is 'all')
            if (SENDER_PUBKEY !== 'all' && event.pubkey !== SENDER_PUBKEY) {
              // For gift wraps, we need to unwrap first to check sender
              if (event.kind === 1059 || event.kind === 1060) {
                try {
                  const unwrapped = nip59.unwrapEvent(event, PRIVATE_KEY)
                  if (unwrapped && unwrapped.pubkey !== SENDER_PUBKEY) {
                    console.log(`⏭️  Skipping gift wrap from other sender: ${nip19.npubEncode(unwrapped.pubkey)}`)
                    return
                  }
                } catch (e) {
                  console.log(`⏭️  Skipping gift wrap (couldn't unwrap)`)
                  return
                }
              } else {
                console.log(`⏭️  Skipping DM from other sender: ${nip19.npubEncode(event.pubkey)}`)
                return
              }
            }

            const result = await decryptEvent(event, PRIVATE_KEY, PRIVATE_KEY_HEX)
            console.log(`   decryptEvent returned: ${result ? 'YES' : 'NO'}, format: ${result?.format}`)

            if (result) {
              receivedDMs.push(result)

              console.log('---')
              console.log(`📨 DM Received`)
              console.log(`From: ${nip19.npubEncode(event.pubkey)}`)
              console.log(`Format: ${result.format}`)
              console.log(`Time: ${new Date(event.created_at * 1000).toISOString()}`)
              console.log(`Event ID: ${event.id}`)
              console.log(`Message: ${result.decrypted}`)
              console.log('')
            }
          } catch (err) {
            console.log(`❌ Error processing event: ${err.message}`)
            console.log(`   Event ID: ${event.id}`)
            console.log(`   Event kind: ${event.kind}`)
            console.log(`   Event pubkey: ${event.pubkey}`)
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

    console.log('Listening for 30 seconds (press Ctrl+C to stop early)...')
    console.log('')

    // Listen for events
    await new Promise(resolve => setTimeout(resolve, 30000))

    // Close subscription
    sub.close()

    // Summary
    console.log('')
    console.log('=== SUMMARY ===')
    console.log(`Total DMs received: ${receivedDMs.length}`)
    console.log(`Unique events: ${seenEvents.size}`)

    if (receivedDMs.length > 0) {
      console.log('')
      console.log('Formats received:')
      const formatCounts = {}
      receivedDMs.forEach(dm => {
        formatCounts[dm.format] = (formatCounts[dm.format] || 0) + 1
      })
      Object.entries(formatCounts).forEach(([format, count]) => {
        console.log(`  ${format}: ${count}`)
      })
      console.log('')
      console.log('✅ DM system is working!')
    } else {
      console.log('')
      console.log('❌ No DMs received.')
      console.log('Possible reasons:')
      console.log('  - No DMs sent to this account yet')
      console.log('  - DMs sent to a different npub')
      console.log('  - Using encryption format not yet supported')
      console.log('')
    }

  } catch (err) {
    console.error('Error:', err.message)
  } finally {
    try {
      pool.close()
    } catch (e) {
      // Ignore pool.close() errors
    }
  }
}

// Run listener
;(async () => {
  await listenForDMs()
})()
