# Many Desks

By OGCraft.

Remote desktop for your own devices. Free, open source, self-hosted, no session limits.

A computer you want to reach runs the **host** (Windows; Linux with X11 is written but untested). It must be on, awake, signed in and unlocked. You connect from any recent
browser: another PC, a Mac, a phone or a tablet. Nothing is installed on the device you connect from.

Features: H.264 video (GPU-encoded when possible) with JPEG as a fallback, mouse, keyboard and touch, several screens,
text clipboard, file transfer, view-only mode, quality presets, an approval prompt or unattended access.

## Start

You need [Node.js 22+](https://nodejs.org) and [ffmpeg](https://ffmpeg.org) on the PATH.
On Linux also: `xdotool xclip zenity x11-xserver-utils`, in an X11 (not Wayland) session.

```sh
npm install
node bin/many-desks.js host
```

It prints this computer's password. On Windows you can double-click `start-host.cmd`.
To connect **to** another computer, open http://127.0.0.1:7878 and enter its address and password.

By default someone at the computer must allow each connection. For computers you reach when nobody is there:

```sh
node bin/many-desks.js unattended on
```

Anyone with the password then has full control of that computer, so keep it private.

## Three ways to connect

| | Set up | Address to enter |
|---|---|---|
| Same home network | `many-desks lan on` on the host, and allow Node.js through its firewall for private networks | `192.168.1.20` |
| Over the internet | run a relay once, then `many-desks use-relay <url> <token>` on each host | the 12-digit address |
| Tailscale (optional) | nothing: used automatically | `100.x.y.z` |

(`many-desks` is short for `node bin/many-desks.js`; `npm link` gives you the short command.)

H.264 and the clipboard need a secure page, which is a browser rule: open the viewer from
`http://127.0.0.1:7878` on a computer running Many Desks, or from an https relay. On a plain `http://192.168…` page the
viewer uses JPEG, which needs more bandwidth (about 23 Mb/s was measured at 1080p), and the clipboard isn't shared.

With Tailscale, `tailscale serve 7878` on the host gives the page an https address for your own devices, which phones need
for H.264 (this changes your Tailscale settings, and hasn't been tried here).

## Running a relay

Routers stop computers on different networks from reaching each other, so connecting over the internet needs one
machine both sides can reach: a small VPS, or a home server with a domain. It must have https.

```sh
export MANY_DESKS_RELAY_TOKEN=...   # make one up, or run without it and it suggests one
docker build -t many-desks-relay .
docker run -d --restart unless-stopped -p 127.0.0.1:7879:7879 -e MANY_DESKS_RELAY_TOKEN -e MANY_DESKS_TRUST_PROXY=1 many-desks-relay
```

Put it behind a web server with https, for example Caddy:

```
desk.example.com {
    reverse_proxy 127.0.0.1:7879 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

Then, on each computer: `many-desks use-relay https://desk.example.com <token>`. Open https://desk.example.com anywhere to connect.

The token only lets hosts register. Viewers need the 12-digit address and the password.
Set `MANY_DESKS_TRUST_PROXY=1` only behind a proxy that overwrites `X-Forwarded-For`.

When both routers allow it, video takes a direct path instead of going through the relay. Across the internet that
usually needs a STUN server, which learns your public address: `many-desks stun stun:your.server:3478`. None is set by default.

## Security

- Traffic is encrypted end to end (X25519, ChaCha20-Poly1305) with keys that also depend on the password (scrypt).
  A relay, or anyone else in the middle, can't read or change it without the password. Both sides prove they know it.
- **The page itself is the limit of that.** Whoever serves the viewer page could change it to steal the password. Use a
  relay you run over https, or open the viewer from your own computer. Plain http on a network you don't trust isn't safe.
- Generated passwords have about 84 bits. Choose your own only if it's long and random; a guessable one can be attacked offline by a fake host.
- The host listens on 127.0.0.1 and Tailscale only, until you run `many-desks lan on`. Don't forward its port on your router.
- Five wrong passwords block that source for a while. Through a relay this is per viewer address.
- The password and identity key are stored unencrypted in `~/.many-desks/config.json`. "Remember the password" stores it in that browser.
- File transfer reaches only `~/Many-Desks` and never overwrites. A connected viewer can do anything else with the mouse and keyboard, though.

This hasn't had an independent security review.

## Tested and not tested

Tested on one Windows 11 computer (GTX 1660 Ti): real screen capture, mouse, keyboard, clipboard, the approval prompt
timing out, H.264 and JPEG in Chrome, file transfer, a relay on the same machine, the direct path on the same machine.

Not run yet: Linux as a host, the Docker image, an https relay behind Caddy, STUN or a direct path across routers, a
second physical device, a real phone, several screens, `lan on`, pressing Yes on the approval prompt, `start-host.cmd`,
Intel and AMD encoders.

## What it can't do

- Show or control the Windows lock screen, sign-in screen, administrator (UAC) prompts or windows running as
  administrator, or send Ctrl+Alt+Del. That needs a Windows service. Locking the computer remotely therefore ends your control of it.
- Start before you sign in, or with Windows, on its own.
- Sound, remote printing, waking a sleeping computer, session recording.
- Control a phone, a Mac or a Wayland session (you can connect *from* them).
- Keyboard layouts: keys are sent by position, so the remote computer's layout decides the letter.

## Development

Current state, next steps and a code map: [STATUS.md](STATUS.md).

```sh
npm test                                   # engine, encryption, relay, files
npm run e2e                                # the viewer in installed Chrome, with a test picture
node e2e/browser.e2e.js --real-screen     # the same with the real screen (input is still recorded, not performed)
```

MIT licence. Dependencies keep their own: ws, koffi and @noble/* (MIT), node-datachannel (MPL-2.0). ffmpeg is run as a separate program.
