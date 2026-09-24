# Virtually PoC

A local proof of concept for putting a pre-rendered character over a live camera feed in OBS. The camera remains an ordinary OBS source. Virtually supplies a **separate transparent Browser Source** for the character, a controller for uploading clips, and buttons that play one motion before returning to the idle character.

This is a small first step toward the broader [Virtually presentation](https://translator.minglelabs.xyz/xr-virtually). It does not generate animations from an image during a stream. Prepare the character and clips in a separate tool, then import them here.

## Run

Requires Node.js 20 or newer. No package installation or external service is required.

```bash
npm start
```

Open `http://127.0.0.1:8787/`. The controller includes an original illustrated demo avatar, so you can click **Demo motion** before uploading files. Uploaded files and the library index live in `data/`, which Git ignores. The server binds to `127.0.0.1` by default; the controller has no authentication and is intended for local use.

## Set up OBS

1. Add a **Video Capture Device** (or your existing camera source) to the scene.
2. Add a **Browser Source** above the camera. Use `http://127.0.0.1:8787/overlay` as its URL. Start with a 1920 × 1080 source and position or scale it in OBS to fit your layout.
3. Leave **Shutdown source when not visible** off if you want the overlay ready for immediate triggers.
4. Keep the controller open in another browser tab. Click a motion button there; the OBS source and the controller's preview receive the same event.

The overlay page has a transparent background. Do not add a camera feed to it. Audio remains with your regular microphone and OBS sources; reaction video audio is not part of this PoC.

## Prepare media

- **Idle:** one transparent WebM video that loops, or a transparent PNG/WebP image. Uploading another idle file replaces it.
- **Motions:** multiple individually named transparent WebM clips. A click plays one clip once and returns to idle. A new trigger replaces a motion already playing.
- Use the same canvas size and character position across idle and motion clips for a clean transition. Put the character on a transparent background before encoding; changing the file extension to `.webm` does not create transparency.

For example, if `input.mov` already contains an alpha channel, FFmpeg can encode a transparent VP9 WebM:

```bash
ffmpeg -i input.mov -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -an output.webm
ffprobe -v error -select_streams v:0 -show_entries stream_tags=alpha_mode -of default=nw=1 output.webm
```

The second command should show `TAG:alpha_mode=1`. We verified this encoding path with a generated transparent clip; still check its actual appearance in your OBS setup. Each upload is limited to 500 MB. The controller supports searching a library of clips and shows 60 at a time.

## Scope and limitations

The PoC uses a local HTTP server and server-sent events to synchronize the controller, preview, and OBS Browser Source. It supports a single local library and does not include accounts, remote viewer triggers, AI generation, background removal, or a broadcasting platform. Browser playback and the transparent page background were tested locally; OBS scene rendering and long-running performance with hundreds of clips still need live validation.

Run `npm test` for API, media-range, persistence, and event-stream checks.
