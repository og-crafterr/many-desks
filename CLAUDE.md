# Many Desks by OGCraft

Self-hosted remote desktop. Read [STATUS.md](STATUS.md) first (state, next steps, decisions), then [README.md](README.md).
When you finish work, update STATUS.md, and the README's "Tested and not tested" section with only what was really run.

- `npm test` (about 25 s) and `npm run e2e` (installed Chrome) must pass. Keep browser tests in `e2e/`: `npm test` runs everything in `test/`.
- Set `MANY_DESKS_DATA` to a temporary folder when running a host by hand, so the real `~/.many-desks` stays untouched.
- The e2e suite records input instead of performing it. Anything that moves the real mouse or types needs a scratch window; restore the clipboard.
- Stop any host or relay you start. Firewall, service, autostart, Tailscale and other-device changes need the owner's OK.
- Plain JavaScript modules, no build step. `src/shared/secure.js` also runs in the browser, so no Node imports there.
- A new web file must be added to the list in `src/shared/web.js`.
- Don't read or copy RustDesk code (AGPL); this project is MIT.
- Keep device names, addresses, passwords and tokens out of the repository.
