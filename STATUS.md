# Status

Updated 2026-11-25. Version 0.1.0, built in one night and **not yet used between two devices**.
How to use it, security and limits: [README.md](README.md).

## Where it stands

- Code complete for a first version; 13/13 unit tests pass (rerun 2026-11-25).
- The Chrome suite passed after the last code change. An earlier `--real-screen` run also passed, before the
  "own computer" scenario was added.
- Git: first commit made on `main`, 2026-11-25. No remote. Nothing is published.
- Never started for real: no `~/.og-desk` folder, so the password is created on first start. Nothing is running.
- No firewall, startup, service or Tailscale change was made. Windows has no firewall rule for node.exe, so other
  devices will probably be blocked until Node.js is allowed on private networks.

The README's "Tested and not tested" section is the one list of what has and hasn't been run. Update it there.

## Next steps

1. **Try it between two real devices** (needs the owner): run `start-host.cmd`, allow Node.js on private networks,
   open the host's address from a phone over Tailscale, press Yes on the prompt. Then `lan on` over Wi-Fi.
2. **Windows service**: start with Windows, lock and sign-in screens, UAC, Ctrl+Alt+Del. The biggest gap. It needs
   administrator rights, so agree it with the owner first. Design not started.
3. **Linux host**: never run. First check whether `xdotool -` acts on each line as it arrives; if it waits for the end of
   input, [platform-linux.js](src/host/platform-linux.js) needs another way. WSL may do for a first check.
4. **Real relay**: https on a public server, then STUN and the direct path across two routers. Needs a server and a domain.
5. Later: sound, wake-on-LAN, keyboard layouts, Wayland, macOS host.

## Decisions waiting for the owner

- Where the relay lives (VPS or home server, domain). Without it, internet access needs Tailscale.
- Whether to install the Windows service.
- Whether to publish the repository.

## Decisions made, and why

| Decision | Why |
|---|---|
| Node.js, no build step | Rust couldn't link here (no Windows SDK), and .NET and Go weren't installed |
| Browser viewer | Nothing to install on the connecting device, phones included |
| ffmpeg for capture | Hardware encoding; run as a separate program. H.264 in FLV gives exact packet sizes, so low delay |
| JPEG fallback | Browsers allow WebCodecs only on secure pages |
| Pure-JS crypto (@noble) | `crypto.subtle` is also missing on plain-http pages |
| Own relay plus optional direct path | The owner wants it to work without Tailscale |
| Approval prompt on, LAN off by default | Safe defaults for something that gives full control |
| MIT, no RustDesk code read or copied | RustDesk is AGPL; keep it that way |

## Code map

| Path | What it does |
|---|---|
| [bin/og-desk.js](bin/og-desk.js) | Commands |
| [src/shared/secure.js](src/shared/secure.js) | Encryption, used by host and browser |
| [src/shared/web.js](src/shared/web.js) | Page serving (fixed file list), CSP, Origin check |
| [src/host/index.js](src/host/index.js) | Listening, relay registration |
| [src/host/session.js](src/host/session.js) | One viewer: sign-in, approval, video, input, files |
| [src/host/capture.js](src/host/capture.js) | ffmpeg and encoder choice |
| [src/host/platform-win32.js](src/host/platform-win32.js), [platform-linux.js](src/host/platform-linux.js), [keys.js](src/host/keys.js) | Input, clipboard, prompt, key table |
| [src/host/files.js](src/host/files.js), [config.js](src/host/config.js) | Shared folder; settings in `~/.og-desk` |
| [src/relay/index.js](src/relay/index.js) | Relay |
| [web/](web/) | Viewer |
| [test/](test/), [e2e/](e2e/) | Unit tests; Chrome suite |
