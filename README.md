# Virtually PoC

A local proof of concept for putting a pre-rendered character over a live camera feed in OBS. The camera remains an ordinary OBS source. Virtually supplies a **separate transparent Browser Source** for the character, a controller for uploading clips, and buttons that play one motion before returning to the idle character.

This is a small first step toward the broader [Virtually presentation](https://translator.minglelabs.xyz/xr-virtually). It does not generate animations from an image during a stream. Prepare the character and clips in a separate tool, then import them here.

## Run

Requires Node.js 20 or newer and pnpm. No external service is required.

```bash
pnpm start
```

By default, the server attempts to bind to port 8787 (or the port set by `PORT`). If the base port is occupied, it tries up to 100 consecutive ports and reports an error if none is available. The server prints the active controller and OBS overlay URLs upon starting:

- Controller: `http://127.0.0.1:8787/` (or rotated port)
- OBS overlay: `http://127.0.0.1:8787/overlay` (or rotated port)

Open the printed controller URL in your browser. The controller includes an original illustrated demo avatar, so you can click **Demo motion** before uploading files. Uploaded files and the library index live in `data/`, which Git ignores. The server binds to `127.0.0.1` by default; the controller has no authentication and is intended for local use.

## Set up OBS

1. Add a **Video Capture Device** (or your existing camera source) to the scene.
2. Add a **Browser Source** above the camera. Use the OBS overlay URL printed by the server (default `http://127.0.0.1:8787/overlay`, or the assigned port if 8787 was occupied). Start with a 1920 × 1080 source and position or scale it in OBS to fit your layout.
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

## Remove a solid background

If your clip has a solid color background (a green screen, for example) rather than a real alpha channel, the controller can key it out into a transparent WebM for you. Open **배경 제거 변환** from the header, then follow the workflow in the card:

1. **Upload the source video** (`.mp4`, `.mov`, `.m4v`, `.webm`, or `.mkv`, up to 500 MB). The server probes its resolution, duration, fps, and codec.
2. **Pick the key color.** Use the color picker or hex field, click the built-in swatches (green `#00FF00`, blue `#0000FF`, magenta `#FF00FF`), press **자동 감지** to sample the frame border, or use the eyedropper on the original frame.
3. **Tune 유사도 (similarity) and 가장자리 부드러움 (blend).** Similarity widens the range of colors treated as background; blend controls the soft, semi-transparent width at the edges. Enable **색 번짐 제거 (despill)** to reduce green/blue spill at the edges (available only for green or blue keys).
4. **Check the checkerboard preview.** The preview frame uses the same key filter as the final conversion; the WebM then adds VP9 compression, so still check the converted clip itself before registering it. Watch hair and clothing edges for a colored fringe.
5. **Convert.** One encode runs at a time. When it finishes you get a transparent WebM you can **register as a motion or idle** avatar, or **download**.

Requirements: `ffmpeg` built with the `libvpx-vp9` encoder and the `chromakey` filter (macOS: `brew install ffmpeg`). If ffmpeg is missing, the tool shows a notice and stays disabled; server startup is never affected. The exact command the server runs is:

```bash
ffmpeg -i input.mp4 -vf "chromakey=0x00FF00:0.12:0.06,format=yuva420p" -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -row-mt 1 -an output.webm
```

Tips:

- Use `#00FF00` unless the character wears green — then key a different solid color (blue or magenta) and shoot against that instead.
- Inspect hair and clothing edges in the preview; lower similarity if parts of the character disappear, raise blend for softer edges.
- Turn on despill when a green or blue rim remains after keying.
- This keys a **solid, even** background only. An uneven or textured background (a real room, gradient lighting) needs AI video background removal or rotoscoping, which this PoC does not provide.

Generate a local green-screen test clip with `pnpm sample:greenscreen` (writes `data/samples/greenscreen-sample.mp4`). Conversion intermediates live in `data/work`, which is **cleared every time the server starts**.

## Scope and limitations

The PoC uses a local HTTP server and server-sent events to synchronize the controller, preview, and OBS Browser Source. It supports a single local library and does not include accounts, remote viewer triggers, AI generation, or a broadcasting platform. It can key out a **solid color** background into a transparent WebM (via a local ffmpeg with `libvpx-vp9`), but it does not remove uneven or textured backgrounds — that needs AI background removal or rotoscoping done elsewhere. Browser playback and the transparent page background were tested locally; OBS scene rendering and long-running performance with hundreds of clips still need live validation.

Run `pnpm test` for API, media-range, persistence, port rotation, event-stream, and chroma-key conversion checks (the chroma-key tests are skipped automatically when a suitable ffmpeg is not installed).
