# Changelog

All notable changes to nostr-openclaw-dm-plugin.

## [Unreleased] - v1.1.0 (Production Ready)

### Added
- **NIP-44 Encryption**: Migrated to NIP-44 (v2 XChaCha20-Poly1305) with NIP-04 fallback for compatibility
- **🦀relays command**: Check health status of all configured relays with latency and error reporting
- **Relay health tracking**: Real-time monitoring of relay connection status and latency
- **Encryption wrapper**: Automatic NIP-44 detection with graceful NIP-04 fallback

### Enhanced
- **Security**: NIP-44 provides message authentication and forward secrecy (NIP-04 lacks these)
- **Compatibility**: Supports both NIP-44 and NIP-04 for interoperability
- **Health monitoring**: 🦀relays shows detailed relay health with actionable insights

### Fixed
- **NIP-04 limitations**: Addressed security concerns with NIP-44 migration
- **Relay visibility**: No more guesswork about relay status — 🦀relays provides real-time data

### Production Ready
- **Comprehensive error handling**: All failure modes covered with graceful degradation
- **Logging**: Clear console output for debugging and monitoring
- **Documentation**: Updated with NIP-44 migration details and relay health guide
- **Testing**: All new commands validated and syntax-checked

## [v1.0.0] - Initial Stable Release

### Added

### Added
- **🦀help command**: Lists all available crab commands with descriptions and cooldowns
- **Memory management**: Periodic cleanup of old state (processed events, conversations, cooldowns)
- **Config reload**: SIGHUP handler for configuration reload without restart
- **Relay deduplication**: Automatic deduplication of relay URLs (normalizes, validates, removes duplicates)
- **Pubkey deduplication**: Automatic deduplication of allowlist pubkeys (handles npub and hex)

### Commands
- `🦀status`: Run `openclaw gateway status` and return full output (10s cooldown)
- `🦀current task`: Get summary of current task/activity via OpenClaw API (30s cooldown)
- `🦀new session`: Start a new chat session equivalent to `/new` (30s cooldown)
- `🦀restart`: Restart the OpenClaw gateway (1 min cooldown)
- `🦀help`: Show available commands with descriptions (5s cooldown)

### Fixed
- **Duplicate auto-replies**: Event deduplication prevents same event from multiple relays triggering multiple replies
- **Memory leaks**: Periodic cleanup prevents unbounded growth of state tracking
- **Invalid config**: Graceful handling of invalid relay URLs and pubkeys
- **Relay rate limits**: Automatic cleanup of expired rate limit entries

### Security
- **Cooldows**: Global and per-sender rate limiting on all commands
- **Allowlist enforcement**: Only configured pubkeys can send DMs (when using allowlist policy)
- **NIP-04 encryption**: Current implementation uses NIP-04 for DM encryption

### Performance
- **Event deduplication**: Same event from multiple relays processed only once
- **Exponential backoff**: Smart retry with jitter for relay publish failures
- **Connection pooling**: Efficient relay connection management via nostr-tools SimplePool
- **Memory cleanup**: Automatic garbage collection every 5 minutes

### Configuration
- **OpenClaw integration**: Reads from `openclaw.json` (channels.nost section)
- **Web dashboard compatible**: Use Channels > Nostr in OpenClaw dashboard to configure
- **Environment variables**: Supports `OPENCLAW_NOSTR_PRIVATE_KEY` and `OPENCLAW_NOSTR_PUBLIC_WHITELIST_KEY`

### Known Limitations (Future Enhancements)
- **NIP-04 security**: Will migrate to NIP-44 for improved encryption (see Future Enhancements)
- **Public posts**: Currently DMs only, public posts not supported
- **Relay health**: No automatic detection/removal of failing relays
- **Config reload**: SIGHUP works but relay pool doesn't fully update without restart

## [0.9.0] - Initial Release

### Added
- Nostr DM listener with auto-reply functionality
- OpenClaw configuration integration
- Allowlist support
- Multiple relay support
- Conversation timeout tracking
- Auto-reply trigger words
