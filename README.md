# Nostr Auto-Reply Daemon for OpenClaw

**Production-ready drop-in replacement for official OpenClaw Nostr channel plugin** — enables encrypted DMs, intelligent auto-reply, and remote control with full integration into OpenClaw's configuration system.

## 🚀 v1.1.0 Production Ready

**New Features:**
- ✅ **NIP-44 Encryption**: Migrated to NIP-44 (v2 XChaCha20-Poly1305) with NIP-04 fallback
- ✅ **🦀relays Command**: Real-time relay health monitoring with latency tracking
- ✅ **Enhanced Security**: Message authentication and forward secrecy via NIP-44
- ✅ **100% Production Ready**: Comprehensive error handling, graceful degradation

## Overview

This plugin acts as a complete replacement for the official OpenClaw Nostr channel plugin. It:
- Reads configuration directly from `openclaw.json` (Channels > Nostr section in the web dashboard)
- Enables encrypted DM support via **NIP-44** (preferred) with **NIP-04** fallback
- Provides intelligent auto-reply to trigger words
- Checks OpenClaw gateway status and includes it in replies
- Supports the full allowlist system from the dashboard
- Monitors relay health with the `🦀relays` command

## Security

### NIP-44 vs NIP-04

**NIP-44 (Preferred):**
- v2 XChaCha20-Poly1305 encryption (modern, secure)
- Message authentication (prevents tampering)
- Forward secrecy (compromise of long-term keys doesn't expose past messages)
- Better performance

**NIP-04 (Fallback):**
- AES-256-CBC encryption (legacy)
- No message authentication
- No forward secrecy
- Compatibility with older clients

**How It Works:**
1. Daemon tries NIP-44 encryption/decryption first
2. If NIP-44 fails, automatically falls back to NIP-04
3. Messages are encrypted with the best available method

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

## Commands

The daemon supports remote control commands that return real-time information and perform actions. Commands use crab emoji 🦀 for easy recognition:

| Command | Description | Cooldown |
|---------|-------------|----------|
| `🦀status` | Run `openclaw gateway status` and return full output | 10 seconds |
| `🦀current task` | Get summary of current task/activity via OpenClaw API | 30 seconds |
| `🦀new session` | Start a new chat session (equivalent to `/new`) | 30 seconds |
| `🦀restart` | Restart OpenClaw gateway | 1 minute |
| `🦀relays` | Check health status of all configured Nostr relays | 30 seconds |
| `🦀help` | Show this help message | 5 seconds |

### Example Usage

Send any of these commands via Nostr DM to get instant responses:

```
🦀status
🦀current task
🦀new session
🦀restart
🦀relays
🦀help
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

**🦀relays** example:
```
📡 Relay Health Summary

Total Relays: 7
✅ Online: 5
❌ Offline/Error: 2

✅ Online wss://relay.damus.io
   Latency: 245ms | Recent DMs: 3

✅ Online wss://relay.primal.net
   Latency: 312ms | Recent DMs: 1

❌ Offline/Error wss://relay.nostr.band
   Latency: 5432ms | Error: Connection timeout...

💡 Tip: Healthy relays respond in <1000ms. Consider removing offline relays from config.
```

**🦀help** example:
```
🦀 CLAW COMMANDS

Available remote control commands:

🦀status
  Run `openclaw gateway status` and return full output
  Cooldown: 10 seconds

[...]
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
- Includes OpenClaw status information
- Uses NIP-44 encryption for reply

### Conversation Tracking

The daemon maintains per-sender conversation state:

| State | Condition | Behavior |
|--------|-----------|----------|
| **New Conversation** | First message from sender or > 1 hour since last reply | Sends auto-reply, starts new conversation |
| **Active Conversation** | Within 1 hour of last message | Checks if task in progress, may reply |
| **Ended Conversation** | No activity for 1 hour | Does not reply (allows new conversation) |

This prevents spam when sending multiple "test" messages — you only get one auto-reply per conversation window.

### Task Verification

The daemon can check OpenClaw gateway status (optional, requires OpenClaw running):

- ✅ **OpenClaw Ready**: Task in progress, reply includes confirmation
- ⚠️ **OpenClaw Busy**: Task in progress, reply includes "please wait" notice
- ⚠️ **OpenClaw Offline**: Could not verify status, includes status note

Example auto-reply with task:
> Auto-reply from 0p3ncl4w: I received your DM! This is an auto-reply confirming that the Nostr patch-in feature is working.
>
🔍 OpenClaw Status: Ready and waiting

## macOS Background Service

To run the daemon as a background service that starts on boot:

1. Copy the launch agent template:
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
| `profile` | `channels.nost.profile` | NIP-01 profile metadata |

### DM Policies

- **allowlist**: Only senders in `allowFrom` can DM (recommended)
- **pairing**: Unknown senders get a pairing code (not implemented yet)
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

## Production Ready Features

### ✅ Reliability
- **Event deduplication**: Same event from multiple relays processed only once
- **Exponential backoff**: Smart retry with jitter for relay failures
- **Connection pooling**: Efficient relay management via nostr-tools SimplePool
- **Memory cleanup**: Automatic garbage collection every 5 minutes

### ✅ Security
- **NIP-44 encryption**: Modern v2 XChaCha20-Poly1305 encryption
- **NIP-04 fallback**: Compatibility with older clients
- **Cooldowns**: Global and per-sender rate limiting
- **Allowlist enforcement**: Only authorized pubkeys can DM (when configured)

### ✅ Observability
- **Clear logging**: Detailed console output for debugging
- **Stats reporting**: Real-time statistics every 60 seconds
- **Relay health**: 🦀relays command for monitoring
- **Error messages**: Natural language errors sent via Nostr DM

### ✅ Error Handling
- **Timeout protection**: All commands have appropriate timeouts
- **Graceful degradation**: Features fail safely without crashing
- **Retry logic**: Automatic retry with exponential backoff
- **Natural language errors**: User-friendly error messages

## Troubleshooting

### Daemon won't start

```bash
# Check for errors in logs
cat /tmp/nostr-dm-daemon.err

# Try running manually to see error
cd ~/.openclaw/services/nostr-dm
node auto-reply-daemon-openclaw.js
```

### Not receiving DMs

1. **Check private key format**: Ensure `OPENCLAW_NOSTR_PRIVATE_KEY` is a valid nsec or hex key
2. **Verify allowlist**: Ensure your pubkey is in `allowFrom` (if using `allowlist` policy)
3. **Check relay connectivity**: Verify relays are accessible (try opening relay URLs in a browser)
4. **Check daemon is running**:
   ```bash
   ps aux | grep auto-reply-daemon
   ```
5. **Check 🦀relays command**: Send `🦀relays` to verify relay health

### Not getting auto-replies

1. **Check message contains trigger word**: Default triggers: `patch-in`, `test`, `hello`, `hi`, `howdy`, `ping`, `dm`, `check`, `verify`
2. **Check logs for errors**:
   ```bash
   tail -f /tmp/nostr-dm-daemon.log
   ```
3. **Verify OpenClaw gateway is running** (for status checks):
   ```bash
   curl http://localhost:18789/status
   ```
4. **Check if already replied**: Logs show "Already replied to this event"

### NIP-44/NIP-04 Issues

If you see encryption/decryption errors:

1. **Check your client**: Ensure your Nostr client supports NIP-44
2. **Check relay compatibility**: Some relays may have NIP-44 issues
3. **Check logs**: Look for "NIP-44 encrypt failed" or "NIP-44 decrypt failed" messages
4. **Fallback**: The daemon will automatically try NIP-04 if NIP-44 fails

## Config changes not picked up

The daemon reads config on startup only. Restart it after editing `openclaw.json`:

```bash
# Restart the service
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# Or send SIGHUP for partial reload (experimental)
kill -HUP $(pgrep -f auto-reply-daemon-openclaw)

# Check logs
tail -f /tmp/nostr-dm-daemon.log
```

## Security Notes

- **Never commit private keys** to version control
- **Use environment variables** for sensitive data (`OPENCLAW_NOSTR_PRIVATE_KEY`)
- **Use `allowlist` policy** in production — only allow specific pubkeys to DM
- **Consider a separate Nostr identity** for the daemon vs your personal Nostr account
- **Rotate keys periodically** if you suspect compromise

## Advanced: Post Functionality

This plugin focuses on DMs. For public posts, you can use the official Nostr plugin's posting features (if outbound works) or use a separate tool like `nak`:

```bash
# Install nak
brew install nak

# Post a note
nak post "Hello from the command line!"
```

To avoid duplicate functionality:
- Use this plugin for **DMs only**
- Use `nak` or other tools for **public posts**
- Or wait for this plugin to add posting support (future enhancement)

## License

MIT
