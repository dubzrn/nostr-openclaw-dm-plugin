#!/usr/bin/env node

const { getPublicKey, finalizeEvent, SimplePool, nip19, nip04 } = require('nostr-tools')

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// Configuration from openclaw.json
const PRIVATE_KEY_HEX = 'YOUR_PRIVATE_KEY_HEX'
const TARGET_PUBKEY = 'YOUR_NPUB'

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.0xchat.com',
  'wss://nostr.wine',
  'wss://inbox.nostr.wine',
  'wss://auth.nostr1.com'
]

async function sendDM(message) {
  console.log(`Sending DM to: ${TARGET_PUBKEY}`)
  console.log(`Message: ${message}`)
  console.log(`Via relays: ${RELAYS.join(', ')}`)

  const PRIVATE_KEY = hexToBytes(PRIVATE_KEY_HEX)
  const myPubkey = getPublicKey(PRIVATE_KEY)

  console.log(`From: ${nip19.npubEncode(myPubkey)}`)

  // Decode target npub to hex
  let targetPubkeyHex = TARGET_PUBKEY
  if (TARGET_PUBKEY.startsWith('npub')) {
    const { data } = nip19.decode(TARGET_PUBKEY)
    targetPubkeyHex = data
  }

  console.log(`To (hex): ${targetPubkeyHex}`)
  console.log('')

  try {
    // Use NIP-04 for compatibility with 0xclient/Primal
    console.log('Encrypting with NIP-04 (for Primal/0xclient compatibility)...')
    const encrypted = nip04.encrypt(PRIVATE_KEY_HEX, targetPubkeyHex, message)
    console.log(`Encrypted (first 50): ${encrypted.substring(0, 50)}...`)

    const event = finalizeEvent({
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', targetPubkeyHex]],
      content: encrypted
    }, PRIVATE_KEY)

    console.log(`Event ID: ${event.id}`)

    const pool = new SimplePool()

    try {
      const pubs = await Promise.allSettled(
        RELAYS.map(url => pool.publish([url], event))
      )

      console.log('\n--- Results ---')
      const successCount = pubs.filter(r => r.status === 'fulfilled').length
      console.log(`Published to ${successCount}/${RELAYS.length} relays`)

      pubs.forEach((result, i) => {
        const url = RELAYS[i]
        if (result.status === 'fulfilled') {
          console.log(`✓ ${url}`)
        } else {
          console.log(`✗ ${url}: ${result.reason.message}`)
        }
      })
    } catch (err) {
      console.error('Error during publish:', err.message)
    } finally {
      pool.close()
    }

    return successCount > 0

  } catch (err) {
    console.error('Encryption error:', err.message)
    return false
  }
}

const message = process.argv[2] || 'Hello from 0p3ncl4wd! This is a test DM sent via nostr-tools with NIP-04 encryption for compatibility with Primal/0xclient.'

sendDM(message)
  .then(success => {
    process.exit(success ? 0 : 1)
  })
  .catch(err => {
    console.error('Error:', err)
    process.exit(1)
  })
