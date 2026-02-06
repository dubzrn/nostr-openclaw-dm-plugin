# Nostr Auto-Reply Daemon for OpenClaw

**Drop-in replacement for the official OpenClaw Nostr channel plugin** — enables encrypted DMs and intelligent auto-reply functionality with full integration into OpenClaw's configuration system.

## Overview

This plugin acts as a complete replacement for the official OpenClaw Nostr channel plugin. It:
- Reads configuration directly from `openclaw.json` (Channels > Nostr section in the web dashboard)
- Enables encrypted DM support via NIP-04
- Provides intelligent auto-reply to trigger words
- Checks OpenClaw gateway status and includes it in replies
- Supports the full allowlist system from the dashboard

## Installation

### 1. Clone or download this plugin

```bash
cd ~/.openclaw/services
git clone https://github.com/dubzrn/nostr-openclaw-dm-plugin.git nostr-dm
```

### 2. Install dependencies

```bash
cd ~/.openclaw/services/nostr-dm
npm install nostr-tools
```

### 3. Configure OpenClaw

Edit `~/.openclaw/openclaw.json` and add/update the Nostr channel configuration:

```json
{
  "channels": {
    "entries": {
      "nost": {
        "enabled": true,
        "privateKey": "${OPENCLAW_NOSTR_PRIVATE_KEY}",
        "relays": [
          "wss://relay.damus.io",
          "wss://relay.primal.net",
          "wss://nos.lol"
        ],
        "dmPolicy": "allowlist",
        "allowFrom": ["npub1..."],
        "name": "0p3ncl4w",
        "profile": {
          "name": "0p3ncl4w",
          "displayName": "0p3ncl4w",
          "about": "AI assistant powered by OpenClaw."
        }
      }
    }
  },
  "env": {
    "OPENCLAW_NOSTR_PRIVATE_KEY": "nsec1...",
    "OPENCLAW_NOSTR_PUBLIC_WHITELIST_KEY": "npub1..."
  }
}
```

**Note:** The official Nostr plugin should be disabled or uninstalled. This plugin overrides it completely.

### 4. Start the daemon

```bash
cd ~/.openclaw/services/nostr-dm
node auto-reply-daemon-openclaw.js
```

You should see:

```
✓ Loaded Nostr configuration from openclaw.json
  Policy: allowlist
  Relays: 7 configured
  Allowed senders: 1 specific
  My npub: npub1...
Listening for DMs...
```

## Configuration

### OpenClaw Integration

The `auto-reply-daemon-openclaw.js` daemon reads its configuration from your OpenClaw config:

| Config Key | Source | Description |
|-----------|--------|-------------|
| `privateKey` | `channels.nost.privateKey` → `OPENCLAW_NOSTR_PRIVATE_KEY` env var | Your Nostr private key (nsec or hex) |
| `relays` | `channels.nost.relays` (defaults to 7 relays) | Array of WebSocket relay URLs |
| `dmPolicy` | `channels.nost.dmPolicy` | `allowlist`, `pairing`, `open`, or `disabled` |
| `allowFrom` | `channels.nost.allowFrom` | Array of allowed pubkeys (npub or hex) |
| `enabled` | `channels.nost.enabled` | Enable/disable the channel |
| `name` | `channels.nost.name` | Display name for auto-replies |

### DM Policies

- **allowlist**: Only senders in `allowFrom` can DM (recommended)
- **pairing**: Unknown senders get a pairing code (not implemented in this daemon yet)
- **open**: Anyone can DM (`allowFrom: ["*"]`)
- **disabled**: Ignore all DMs

### Managing Allowlist

Add or remove users from the allowlist in `openclaw.json`:

```json
{
  "channels": {
    "entries": {
      "nost": {
        "allowFrom": [
          "npub1330qncw39qmyqh0g25uxh0d0ct03zvf2pkpzup0ltecsksaxerxq302nwf",
          "npub1abc...your-friend-npub..."
        ]
      }
    }
  }
}
```

After editing, restart the daemon to pick up changes.

## Standalone Mode (No OpenClaw Integration)

If you want to run this daemon without OpenClaw's config system, use `auto-reply-daemon.js` instead:

1. Edit `auto-reply-daemon.js` and set the config at the top:
```javascript
const PRIVATE_KEY_HEX = 'your_hex_private_key_here';
const SENDER_PUBKEY = 'all'; // or specific npub
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];
```

2. Run:
```bash
node auto-reply-daemon.js
```

## System Commands

The daemon supports remote control commands that return real-time information and perform actions. Commands use the crab emoji 🦀 for easy recognition:

> **Security Note**: This plugin currently uses NIP-04 for DM encryption. **Future versions will migrate to NIP-44** for improved security (v2 XChaCha20-Poly1305 encryption). NIP-04 is functional but has known security limitations compared to NIP-44.

| Command | Description | Cooldown |
|---------|-------------|----------|
| `🦀status` | Run `openclaw gateway status` and return full output | 10 seconds |
| `🦀current task` | Get summary of current task/activity via OpenClaw API | 30 seconds |
| `🦀new session` | Start a new chat session (equivalent to `/new`) | 30 seconds |
| `🦀restart` | Restart the OpenClaw gateway | 1 minute |

### Example Usage

Send any of these commands via Nostr DM to get instant responses:

```
🦀status
🦀current task
🦀new session
🦀restart
```

### Command Responses

**🦀status** example:
```
📊 Gateway Status:
OpenClaw Gateway v2026.2.3
Mode: local
Node: WORKSTATION-af-a2 (192.168.0.236)
Status: Running
...
```

**🦀current task** example:
```
📋 Current Task Summary:

Active agents: 1
- Agent: main (zai/glm-4.7)
```

**🦀new session** example:
```
✅ New session started!

Session: abc123-def456-ghi789

You can now send commands to this fresh session.
```

**🦀restart** example:
```
🔄 Gateway restart initiated!

Restarting OpenClaw Gateway...
Done.

Note: It will take approximately 30 seconds for the gateway to come back online. Please wait before sending new commands.
```

### Safety Features

- **Global cooldowns**: Prevent command spam across all users (restart limited to once per minute globally)
- **Per-sender cooldowns**: Each user has their own rate limit per command
- **Error handling**: Natural language errors are returned via Nostr DM if commands fail
- **Timeout protection**: Commands timeout after 10-60 seconds depending on operation
- **Duplicate prevention**: The same command won't execute twice within cooldown period

## Auto-Reply Behavior

### Trigger Words

Default triggers: `patch-in`, `test`, `hello`, `hi`, `howdy`, `ping`, `dm`, `check`, `verify`

When a DM containing any trigger word is received:
- Checks if this is a new conversation or within 1 hour of last activity
- Sends auto-reply only once per conversation (prevents spam)
- Includes OpenClaw status check if a task is in progress
- Adds task status to reply message

### Conversation Tracking

The daemon maintains per-sender conversation state:

| State | Condition | Behavior |
|--------|-----------|----------|
| **New Conversation** | First message from sender or > 1 hour since last reply | Sends auto-reply, starts new conversation |
| **Active Conversation** | Within 1 hour of last message | Checks if task in progress, may reply |
| **Ended Conversation** | No activity for 1 hour | Does not reply (allows new conversation) |

This prevents spam when sending multiple "test" messages - you only get one auto-reply per conversation window.

### Task Verification

The daemon can check OpenClaw gateway status (optional, requires OpenClaw running):

- ✅ **OpenClaw Ready**: Task in progress, reply includes confirmation
- ⚠️ **OpenClaw Busy**: Task in progress, reply includes "please wait" notice
- ⚠️ **OpenClaw Offline**: Could not verify status, includes status note

Example auto-reply with task:
> Auto-reply: I received your DM! This is an auto-reply confirming that the Nostr patch-in feature is working.
>
🔍 Task Status: Checking OpenClaw...
✅ OpenClaw is ready and processing your request.

## macOS Background Service

To run the daemon as a background service that starts on boot:

1. Copy the template plist:
```bash
cp com.nostr-dm.plist.template ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
```

2. Edit the plist and update paths to match your installation location

3. Load the service:
```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
```

4. Check if it's running:
```bash
launchctl list | grep nostr-dm
```

5. View logs:
```bash
# Standard output (recommended)
tail -f /tmp/nostr-dm-daemon.log

# Error logs
tail -f /tmp/nostr-dm-daemon.err
```

### Service Management

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# View status
launchctl list | grep nostr-dm
```

## Configuration

### Required Settings

Edit `auto-reply-daemon.js` and set these values at the top:

```javascript
// REQUIRED: Your Nostr private key (hex format)
const PRIVATE_KEY = 'your_hex_private_key_here';

// OPTIONAL: Who can send DMs
const SENDER_PUBKEY = 'all';  // 'all' for anyone, or specific npub

// OPTIONAL: Auto-reply trigger words
const AUTO_REPLY_TRIGGERS = ['patch-in', 'test', 'hello', 'hi', 'howdy', 'ping', 'dm', 'check', 'verify'];

// OPTIONAL: Conversation timeout in milliseconds (1 hour = 3600000)
const CONVERSATION_TIMEOUT_MS = 60 * 60 * 1000;

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

### Security Notes

- Private key is stored in hex format in the script file
- Keys are NOT in environment variables for better security
- Consider using a separate keypair for this daemon vs your personal Nostr account
- Daemon does not have access to your OpenClaw configuration or files

## Rate Limiting

The daemon implements intelligent rate limiting to avoid relay bans:

| Parameter | Value | Description |
|-----------|-------|-------------|
| MAX_RETRIES | 3 | Max retry attempts for failed sends |
| BASE_BACKOFF_MS | 2000 | Starting backoff (2 seconds) |
| MAX_BACKOFF_MS | 30000 | Maximum backoff (30 seconds) |
| MAX_CONSECUTIVE_FAILURES | 5 | Failures before relay is blacklisted |
| JITTER_MS | 1000 | Random delay to prevent "thundering herd" |

### Backoff Formula

```javascript
delay = min(BASE_BACKOFF_MS * 2^attempt, MAX_BACKOFF_MS) + random(-JITTER_MS, JITTER_MS)
```

Example delays per retry attempt:
- Attempt 0: 2000ms ± 1000ms
- Attempt 1: 4000ms ± 1000ms
- Attempt 2: 8000ms ± 1000ms (or 16000ms capped)

## Testing

### Verify Auto-Reply Works

From your Nostr client (Primal, Damus, 0xchat, etc.):

1. Send: `patch-in` or `test`
2. You should receive: "Auto-reply: I received your DM! This is an auto-reply confirming that the Nostr patch-in feature is working."

3. Send multiple "test" messages: You should receive **only one** auto-reply (spam prevention). Wait 1 hour between "test" messages to receive a new auto-reply.

### Verify Conversation Timeout

1. Send a trigger word to start a new conversation
2. Wait 1+ hours (conversation inactive)
3. Send another trigger word
4. You should receive a **new** auto-reply (conversation tracker was reset)

### Monitor Daemon Status

```bash
# Check if process is running
ps aux | grep auto-reply-daemon

# View live logs
tail -f /tmp/nostr-dm-daemon.log

# Check stats (printed every 60 seconds)
tail -f /tmp/nostr-dm-daemon.log | grep "=== STATS"
```

## Troubleshooting

### Daemon Not Starting

```bash
# Check for errors in logs
cat /tmp/nostr-dm-daemon.err

# Try running manually to see error
cd ~/.openclaw/services/nostr-dm
node auto-reply-daemon.js
```

### Not Receiving DMs

1. Verify private key is correct (hex format, not nsec)
2. Check `SENDER_PUBKEY` is set to `'all'` or your sender's npub
3. Verify relays are accessible (try opening URLs in browser)
4. Check firewall allows WebSocket connections (wss:// on port 443)
5. Verify daemon is running: `ps aux | grep auto-reply-daemon`

### Not Getting Auto-Replies

1. Verify received message contains a trigger word (case-sensitive matching)
2. Check daemon logs for errors: `tail -f /tmp/nostr-dm-daemon.log`
3. Ensure daemon has permission to send messages to relays
4. Check if message was already replied to: logs show "Already auto-replied to this event"

## Output Format

The daemon provides clear console output:

```
=== AUTO-REPLY DAEMON ===
Listening for DMs to auto-reply...
Auto-reply triggers: patch-in, test, hello, hi, howdy, ping, dm, check, verify
Conversation timeout: 60 minutes (resets after inactivity)
My npub: npub1pxvsf79agywh4artvwmkwhvw8vz0jgd3dfz4wrap6fr2eq40jejsh5gxuc
Listening for DMs from: all
Connecting to 7 relays...

---
📨 DM Received
From: [sender_npub]
Format: NIP-04
Time: [timestamp]
Event ID: [event_id]
Message: [content]

🔄 Trigger detected, preparing auto-reply...

📤 Sending auto-reply to [sender_npub]...
✓ Published to [relay_url]
...
✅ Auto-reply sent successfully!
```

## Supported Clients

Tested and confirmed working with:
- Primal (iOS/Web)
- Damus (iOS/Mac)
- 0xchat (Web)

## License

MIT

## Related

- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) - Nostr protocol implementation
- [NIP-04](https://github.com/nostr-protocol/nips/blob/master/04.md) - Encrypted Direct Messages
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) - Versioned Encryption
- [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) - Gift Wrap
