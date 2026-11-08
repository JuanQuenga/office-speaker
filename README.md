# Office Speaker

Turns a Mac or Windows computer into a Spotify Connect speaker. Anyone on the same network opens Spotify on their phone, taps the devices icon, and picks the computer. Nobody signs in to Spotify on the computer. Audio plays through the computer's sound output, so a Bluetooth speaker paired to the computer works.

It works the same way as Music Assistant, raspotify, and spotifyd: it runs [librespot](https://github.com/librespot-org/librespot), the open-source Spotify Connect implementation, wrapped in a menu bar / tray app.

## Using it

1. Install it on the computer connected to the speaker (see below) and give the speaker a name.
2. Leave it running. It lives in the menu bar (Mac) or system tray (Windows) and starts at login.
3. On a phone on the same Wi-Fi: Spotify → devices icon → pick the speaker.

When someone else picks the speaker, they take over, like a normal Connect speaker. The tray menu and window show what's playing and who's playing it, and include **Disconnect listener**. Credentials sent by a phone are kept in memory only. Nobody stays signed in after the app restarts.

### Requirements and limits

- **Spotify Premium** is required for the person playing. Spotify enforces this for all Connect speakers.
- **Same network.** Discovery uses mDNS/Bonjour. Corporate Wi-Fi with client isolation or blocked multicast hides the speaker from phones, and so would a Sonos or Chromecast. A guest network that's separate from the computer's network won't work either.
- **Windows:** the installer asks for admin rights, so it can add a firewall rule for the speaker engine.
- **Unofficial client.** librespot isn't made or endorsed by Spotify, and Spotify can change its servers and break it until librespot catches up. It's meant for personal and internal use.

## Installing builds

GitHub Actions builds the installers: a universal DMG for macOS and an NSIS installer for Windows. Every push uploads them as workflow artifacts. Pushing a `v*` tag also attaches them to a GitHub release.

The builds aren't code-signed yet, so the OS warns on first launch:

- **macOS:** open the app, dismiss the warning, then go to System Settings → Privacy & Security → **Open Anyway**. Allow **Local Network** access when asked.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info** → **Run anyway**.

Signing with an Apple Developer ID and notarizing removes the macOS warning. electron-builder supports both through the `CSC_LINK` / `APPLE_API_KEY` environment variables.

## Development

Requirements: Node 24 and Rust (stable). Linux also needs the ALSA headers.

```sh
npm install
npm start          # builds engine/ with cargo, then launches the app
```

Layout:

- `engine/` is a Rust program built on librespot. It announces the speaker, plays audio, writes JSON events on stdout, and takes commands on stdin (`play`, `pause`, `next`, `prev`, `disconnect`, `volume <0-100>`). It exits when stdin closes. Run `speaker-engine --list-outputs` to list audio devices.
- `src/main.js` is the Electron main process: tray menu, settings, and engine supervision (restart with backoff, restart after sleep).
- `src/renderer/` is the window.
- `build/installer.nsh` adds and removes the Windows firewall rule.
