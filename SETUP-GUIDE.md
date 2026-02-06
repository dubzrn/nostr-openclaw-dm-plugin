# Setup Guide: Nostr DM Plugin for OpenClaw

This guide walks you through setting up the Nostr DM plugin as a drop-in replacement for the official Nostr channel plugin.

## What This Does

- **Replaces the official OpenClaw Nostr plugin** (which has broken outbound functionality)
- **Enables encrypted DM support** via NIP-04
- **Integrates with OpenClaw's config system** — use the web dashboard to manage keys, relays, and allowlist
- **Provides intelligent auto-reply** to trigger words with OpenClaw status checks

## Step 1: Install the Plugin

```bash
# Create service directory
mkdir -p ~/.openclaw/services
cd ~/.openclaw/services

# Clone the plugin
git clone https://github.com/dubzrn/nostr-openclaw-dm-plugin.git nostr-dm

# Install dependencies
cd nostr-dm
npm install nostr-tools
```

## Step 2: Configure OpenClaw

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
          "wss://nos.lol",
          "wss://relay.0xchat.com",
          "wss://nostr.wine",
          "wss://inbox.nostr.wine",
          "wss://auth.nostr1.com"
        ],
        "dmPolicy": "allowlist",
        "allowFrom": ["${OPENCLAW_NOSTR_PUBLIC_WHITELIST_KEY}"],
        "name": "0p3ncl4w",
        "profile": {
          "name": "0p3ncl4w",
          "displayName": "0p3ncl4w",
          "about": "AI assistant powered by OpenClaw. DM me for encrypted communication.",
          "picture": "https://github.com/openclaw/openclaw/raw/main/docs/assets/logo.png"
        }
      }
    }
  },
  "env": {
    "OPENCLAW_NOSTR_PRIVATE_KEY": "nsec1uc73g65nn0jxx59pnk5dcfq066wgnx8k8tsatkmujzgl6h0wjnqs3ewve0",
    "OPENCLAW_NOSTR_PUBLIC_WHITELIST_KEY": "npub1330qncw39qmyqh0g25uxh0d0ct03zvf2pkpzup0ltecsksaxerxq302nwf"
  }
}
```

### Important Notes

- **`privateKey`**: Your Nostr private key (nsec or hex format). Use environment variable for security.
- **`allowFrom`**: Array of pubkeys allowed to DM you. Use `["*"]` for anyone (not recommended for production).
- **`dmPolicy`**: `allowlist` (recommended), `open`, `pairing`, or `disabled`.
- **`relays`**: Array of WebSocket relay URLs. Use 3-5 for reliability.

## Step 3: Disable the Official Plugin

If you have the official Nostr plugin installed, disable it:

```json
{
  "skills": {
    "entries": {
      "nostr": {
        "enabled": false
      }
    }
  }
}
```

Or uninstall it:

```bash
openclaw plugins uninstall @openclaw/nostr
```

## Step 4: Start the Daemon

### Manual Start (for testing)

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
  My npub: npub1pxvsf79agywh4artvwmkwhvw8vz0jgd3dfz4wrap6fr2eq40jejsh5gxuc
Listening for DMs...
```

### macOS Background Service (recommended for production)

1. Copy the launch agent template:
```bash
cp com.nostr-dm.plist.template ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
```

2. Edit the plist and update paths:
```xml
<key>WorkingDirectory</key>
<string>/Users/kenny/.openclaw/services/nostr-dm</string>
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/Users/kenny/.openclaw/services/nostr-dm/auto-reply-daemon-openclaw.js</string>
</array>
<key>StandardOutPath</key>
<string>/tmp/nostr-dm-daemon.log</string>
<key>StandardErrorPath</key>
<string>/tmp/nostr-dm-daemon.err</string>
```

3. Load the service:
```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
```

4. Verify it's running:
```bash
launchctl list | grep nostr-dm
```

### Service Management

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# View logs
tail -f /tmp/nostr-dm-daemon.log
tail -f /tmp/nostr-dm-daemon.err
```

## Step 5: Test

From your Nostr client (Primal, Damus, 0xchat, etc.):

1. **Send a test DM**: `patch-in` or `test`
2. **You should receive**: An auto-reply with OpenClaw status

Example response:
```
Auto-reply from 0p3ncl4w: I received your DM! This is an auto-reply confirming that the Nostr patch-in feature is working.

✅ OpenClaw Status: Ready and waiting
```

3. **Verify allowlist works**:
   - Remove your pubkey from `allowFrom`
   - Restart the daemon
   - Send a DM — you should NOT receive a reply (blocked)

4. **Verify web dashboard integration**:
   - Open the OpenClaw web dashboard
   - Go to **Channels > Nostr**
   - Your configuration should appear here
   - Edit the configuration (add a pubkey to allowlist)
   - Restart the daemon
   - Test from the new pubkey

## Configuration via Web Dashboard

Once the daemon is running, you can manage your Nostr configuration from the OpenClaw web dashboard:

1. Open `http://localhost:18789` (or your OpenClaw dashboard URL)
2. Go to **Channels** > **Nostr**
3. Edit settings:
   - Toggle enable/disable
   - Update relays
   - Manage allowlist (add/remove pubkeys)
   - Update profile metadata

**Note:** After changing the configuration in the dashboard, restart the daemon to pick up changes:

```bash
# Restart the service
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist

# Check logs
tail -f /tmp/nostr-dm-daemon.log
```

## Troubleshooting

### Daemon won't start

```bash
# Check error logs
cat /tmp/nostr-dm-daemon.err

# Try running manually to see errors
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

### Config changes not picked up

The daemon reads config on startup only. Restart it after editing `openclaw.json`:

```bash
launchctl unload ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.nostr-dm.plist
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

## Support

- **Repository**: https://github.com/dubzrn/nostr-openclaw-dm-plugin
- **Issues**: Open a GitHub issue for bugs or feature requests
- **Logs**: Check `/tmp/nostr-dm-daemon.log` and `/tmp/nostr-dm-daemon.err`

## License

MIT
