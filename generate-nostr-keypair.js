#!/usr/bin/env node

const { generateSecretKey, getPublicKey, nip19 } = require('nostr-tools')

// Generate new key pair
const sk = generateSecretKey()
const pk = getPublicKey(sk)
const skHex = Buffer.from(sk).toString('hex')
const npub = nip19.npubEncode(pk)

console.log('=== New Nostr Key Pair ===')
console.log('Private Key (hex):', skHex)
console.log('Public Key (hex):', pk)
console.log('npub:', npub)
console.log('')
console.log('Update openclaw.json with:')
console.log(`  "privateKey": "${skHex}",`)
console.log(`  "profile": { "name": "0p3ncl4wd", "displayName": "0p3ncl4wd" }`)
