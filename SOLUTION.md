# Nostr DM "Patch-In" Solution

Complete working solution for encrypted Nostr DMs with auto-reply "patch-in" functionality. Control your Mac remotely via Nostr DMs while traveling.

## 🎯 What This Does

- **Auto-Replies** to DMs containing trigger words (patch-in, test, hello, ping, etc.)
- **NIP-04/NIP-44/NIP-59**: Supports all major Nostr encryption formats
- **Rate Limiting**: Intelligent exponential backoff with jitter (2s→4s→8s→16s, capped at 30s)
- **Per-Relay Tracking**: Auto-blacklists failing relays after 5 consecutive failures
- **7-Relay Redundancy**: Uses multiple relays for reliability

## ⚡ Quick Start

### Option 1: Standalone Daemon (Recommended)

The daemon runs independently of OpenClaw and won't be affected by plugin updates.

```bash
# 1. Install dependencies
cd ~/.openclaw/workspace
npm install nostr-tools

# 2. Generate keypair (optional - if you already have one, skip)
node generate-nostr-keypair.js

# 3. Edit the daemon and set your private key
nano ~/.openclaw/services/nostr-dm/auto-reply-daemon.js
# Change: const PRIVATE_KEY = 'your_hex_private_key_here';

# 4. Start the daemon
cd ~/.openclaw/services/nostr-dm
node auto-reply-daemon.js
```

### Option 2: As Background Service (macOS)

Run automatically on boot via launchd:

```bash
# 1. Configure daemon (edit PRIVATE_KEY in auto-reply-daemon.js)

# 2. Load launchd service
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# 3. Check status
launchctl list | grep nostr-dm

# 4. View logs
tail -f /tmp/nostr-dm-daemon.log
```

## 📂 File Structure

```
~/.openclaw/
├── services/
│   └── nostr-dm/              # Standalone daemon
│       ├── auto-reply-daemon.js   # Main daemon with auto-reply
│       ├── robust-dm-listener.js  # Monitor only (no auto-reply)
│       ├── send-nostr-dm-nip04.js # Manual DM sender
│       ├── start.sh                # Launcher script
│       └── README.md              # Service docs
└── extensions/
    ├── nostr/                # OpenClaw plugin (if needed)
    │   ├── index.ts
    │   ├── src/
    │   │   ├── channel.ts
    │   │   ├── runtime.ts
    │   │   └── ...
    │   └── package.json
    └── nostr-v2026.2.2-backup/  # Official plugin backup
```

## 🔧 Configuration

### Auto-Reply Daemon Settings

Edit `~/.openclaw/services/nostr-dm/auto-reply-daemon.js`:

```javascript
// REQUIRED: Your Nostr private key (hex format, NOT nsec)
const PRIVATE_KEY = 'e63d146a939be46350a19da8dc240fd69c8998f63ae1d5db7c9091fd5dee94c1';

// OPTIONAL: Who can send DMs
const SENDER_PUBKEY = 'all';  // 'all' for anyone, or specific npub

// OPTIONAL: Auto-reply trigger words
const AUTO_REPLY_TRIGGERS = ['patch-in', 'test', 'hello', 'hi', 'howdy', 'ping', 'dm', 'check', 'verify'];

// OPTIONAL: Relays to connect to
const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.0xchat.com',
  'wss://nostr.wine',
  'wss://inbox.nostr.wine',
  'wss://auth.nostr1.com'
];
```

### OpenClaw Plugin Settings

If using the OpenClaw plugin (`~/.openclaw/extensions/nostr/`):

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "nostr": {
        "enabled": true
      }
    }
  },
  "channels": {
    "nostr": {
      "enabled": true,
      "privateKey": "e63d146a939be46350a19da8dc240fd69c8998f63ae1d5db7c9091fd5dee94c1",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net"],
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1330qncw39qmyqh0g25uxh0d0ct03zvf2pkpzup0ltecsksaxerxq302nwf"]
    }
  }
}
```

## 🚀 Testing

### Test Auto-Reply

From your Nostr client (Primal/Damus/0xchat):

1. Send: `patch-in` or `test`
2. You should receive an auto-reply: "Auto-reply: I received your DM! This is an auto-reply confirming that Nostr channel is working."

### Check Logs

```bash
tail -f /tmp/nostr-dm-daemon.log
```

## 📊 Rate Limiting Details

The daemon implements intelligent rate limiting:

| Parameter | Value | Description |
|-----------|-------|-------------|
| MAX_RETRIES | 3 | Max retry attempts for failed sends |
| BASE_BACKOFF_MS | 2000 | Starting backoff (2 seconds) |
| MAX_BACKOFF_MS | 30000 | Maximum backoff (30 seconds) |
| MAX_CONSECUTIVE_FAILURES | 5 | Failures before relay blacklisting |
| JITTER_MS | 500 | Random jitter to prevent thundering herd |

### Backoff Formula

```
delay = min(BASE_BACKOFF_MS * 2^attempt, MAX_BACKOFF_MS) + random(-JITTER_MS, JITTER_MS)
```

Example delays:
- Attempt 0: 2000ms ± 250ms
- Attempt 1: 4000ms ± 250ms
- Attempt 2: 8000ms ± 250ms (or 16000ms capped)

## 🔐 Security Notes

- **Private Key**: Stored in hex format in the script file
- **No Environment Variables**: Keys are not in environment for better security
- **DM Policy**: Set `SENDER_PUBKEY = 'all'` to accept from anyone, or specific npub for allowlist
- **Encryption**: Uses NIP-04 by default, falls back to NIP-44, supports NIP-59 gift wrap

## 📝 License

MIT

## 🔗 Related

- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) - Nostr protocol implementation
- [NIP-04](https://github.com/nostr-protocol/nips/blob/master/04.md) - Encrypted Direct Messages
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) - Versioned Encryption
- [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) - Gift Wrap
