# Nostr DM Patch-In Service

Auto-reply daemon for Nostr DMs with "patch-in" functionality. Allows remote control of your Mac via encrypted Nostr DMs while traveling.

## Features

- **NIP-04/NIP-44/NIP-59**: Supports all major Nostr encryption formats
- **Auto-Reply**: Responds to trigger words (patch-in, test, hello, ping, etc.)
- **Rate Limiting**: Exponential backoff with jitter (2s→4s→8s→16s, capped at 30s)
- **Per-Relay Tracking**: Auto-blacklists failing relays after 5 consecutive failures
- **Robust Connections**: Handles relay disconnections gracefully

## Files

- `auto-reply-daemon.js` - Main service with auto-reply functionality
- `robust-dm-listener.js` - DM listener without auto-reply (for monitoring)
- `send-nostr-dm-nip04.js` - Send DMs manually
- `start.sh` - Launcher script

## Service Management

```bash
# Start service
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# Check status
launchctl list | grep nostr-dm

# View logs
tail -f /tmp/nostr-dm-daemon.log
tail -f /tmp/nostr-dm-daemon.err
```

## Configuration

Edit `auto-reply-daemon.js` to customize:

- `PRIVATE_KEY` - Your Nostr private key (hex format)
- `SENDER_PUBKEY` - Set to 'all' to accept DMs from anyone, or a specific npub
- `AUTO_REPLY_TRIGGERS` - Words that trigger auto-replies
- `RELAYS` - List of relay URLs

## Trigger Words

Default triggers: `patch-in`, `test`, `hello`, `hi`, `howdy`, `ping`, `dm`, `check`, `verify`

## Relays

Default configuration uses 7 relays for redundancy:
- wss://relay.damus.io
- wss://relay.primal.net
- wss://nos.lol
- wss://relay.0xchat.com
- wss://nostr.wine
- wss://inbox.nostr.wine
- wss://auth.nostr1.com

## Dependencies

Requires `nostr-tools` from workspace:
```bash
export NODE_PATH=~/.openclaw/workspace/node_modules
```
