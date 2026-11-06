# SyncSpeaker

Turn every phone, laptop and Bluetooth speaker on your Wi-Fi into one synchronized sound system.
Android and iOS devices join from the browser, so nothing needs to be installed on them. One **host**
device controls the music, and every other device plays it in sync.

## Features
- **Synchronized playback.** NTP-style clock sync over WebSocket uses the fastest round trips over a
  2-minute window and tracks clock drift. Playback is scheduled sample-accurately with the Web Audio
  API, and small inaudible speed changes keep devices aligned.
- **Acoustic auto-sync.** Every speaker plays a short chirp, the host's microphone hears them, and each
  device's delay is corrected, Bluetooth lag included. It can re-run automatically between songs.
- **YouTube.** Search inside the app, or paste video and playlist links. Songs are queued, downloaded in
  the background, and played back to back. Autoplay adds similar songs when the queue runs out.
- **Library.** Played songs stay on the desktop, so replaying one is instant.
- **Long tracks.** Audio is served in 20-second chunks, so a 3-hour mix uses as little phone memory as a
  3-minute song.
- **Host mode.** Only the host can control playback, and the server enforces it.
- **Devices panel.** The host sees each device's Wi-Fi quality, audio delay and drift, so you can tell
  whether a lagging device has a Wi-Fi problem or a Bluetooth problem.
- **Fallback calibration.** Tap-along Bluetooth calibration and a beep sync test, per device.

## Requirements (on the desktop running the server)
- Node.js 18+
- `ffmpeg`
- `openssl` (to create the self-signed certificate for the host's microphone)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), only for YouTube:
  ```
  mkdir -p bin && curl -L -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x bin/yt-dlp
  ```

## Run
```
npm install
npm run serve        # builds the React app, then starts the server
```
Open the firewall ports if needed: `sudo ufw allow 8080/tcp && sudo ufw allow 8443/tcp`

- **Speakers:** open `http://<desktop-ip>:8080` on every device on the same Wi-Fi and tap Join.
- **Host:** open `http://localhost:8080` on the desktop and scan the **host QR** with your phone. It is an
  HTTPS link on port 8443, because browsers only allow the microphone on secure pages. Accept the
  certificate warning once.
- On the host, tap **🎯 Auto-sync all speakers**, then search for a song.

Environment variables: `PORT` (8080), `HTTPS_PORT` (8443), `LIBRARY_GB` (6), `YTDLP` (path to yt-dlp).

## How it works
| Piece | File |
|---|---|
| Server: HTTP and WebSocket, host auth, queue, playback state, auto-sync coordination | `server.js` |
| yt-dlp and ffmpeg pipeline, track library | `media.js` |
| Clock sync with drift estimation | `src/clock.js` |
| Chunked, gapless, drift-corrected player | `src/player.js` |
| Chirp generation, mic recorder and matched-filter detection | `src/autosync.js` |
| UI | `src/App.jsx`, `src/Music.jsx`, `src/Devices.jsx` |

Downloading from YouTube may be against YouTube's Terms of Service. Use it for personal use only.
