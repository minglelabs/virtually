# Virtually PoC

A local proof of concept for putting a pre-rendered character over a live camera feed in OBS. The camera remains an ordinary OBS source. Virtually supplies a **separate transparent Browser Source** for the character and a controller with motion buttons, an OBS setup guide, and a large live preview. A button plays one motion once, then the overlay returns to the idle character.

This is a small first step toward the broader [Virtually presentation](https://translator.minglelabs.xyz/xr-virtually). It does not generate animations from an image during a stream. Prepare the character and clips in a separate tool, then add them through the HTTP API (see [Add clips](#add-clips)).

## Run

Requires Node.js 20 or newer and pnpm. No external service is required.

```bash
pnpm start
```

By default, the server attempts to bind to port 8787 (or the port set by `PORT`). If the base port is occupied, it tries up to 100 consecutive ports and reports an error if none is available. The server prints the active controller and OBS overlay URLs upon starting:

- Controller: `http://127.0.0.1:8787/` (or rotated port)
- OBS overlay: `http://127.0.0.1:8787/overlay` (or rotated port)

Open the printed controller URL in your browser. It works before you add any files: every button falls back to an original illustrated demo avatar. The controller has no upload UI; clips and the library index live in `data/`, which Git ignores. The server binds to `127.0.0.1` by default; it has no authentication and is intended for local use.

## Motion buttons

The **동작** (Motions) card sits at the bottom of the controller, below the **OBS에 연동하기!** section. The whole control pane scrolls as one, and the list renders 30 buttons at a time, loading the next 30 as you scroll to the end (infinite scroll). It lists, in this order:

1. **데모 동작** — always plays the built-in demo avatar reaction.
2. Nine preset buttons:

   | key | label |
   |---|---|
   | `hi` | 인사 (Hi) |
   | `wink` | 윙크 |
   | `cheek-heart` | 볼하트 |
   | `finger-heart` | 손하트 |
   | `kpop-heart` | K-pop 하트 |
   | `clap-laugh` | 박수치며 웃음 |
   | `dont-know` | I don't know 포즈 |
   | `wonyoung-turn` | 원영턴 |
   | `bad-challenge` | BAD 챌린지 춤 |

3. Every other library motion, in library order, labelled by its name.

**Linking rule:** a preset is linked to the first library motion whose name, trimmed and compared case-insensitively, equals the preset key or its label. A linked preset plays that clip ("영상"). An unlinked preset plays the demo avatar reaction ("영상 없음 · 데모 재생"). The list updates live when the library changes; no reload is needed.

A new trigger replaces a motion that is already playing. The OBS source and the controller's preview receive the same event.

## Set up OBS

The controller's collapsible **OBS에 연동하기!** section (closed by default; click it to open) shows a short version of this guide with the actual overlay URL and a copy button.

1. In the **Sources** dock, click **+** (Add Source).
2. Under Source Type, choose **Browser**.
3. In **Add a new Browser**, enter a name (for example `Virtually`), keep **Make source visible** checked, and click **Create New**.
4. In the properties window, apply the settings below and click **OK**.
5. In **Sources**, place this source above your camera source. Sources higher in the list are drawn in front.
6. If your OBS canvas is not 1920 × 1080, right-click the source and choose **Transform → Fit to screen**.

Recommended properties, in OBS order:

- **Local file**: off.
- **URL**: the overlay URL printed by the server (default `http://127.0.0.1:8787/overlay`).
- **Width** / **Height**: 1920 / 1080 (defaults are 800 / 600).
- **Control audio via OBS**: off — motion clips have no audio.
- **Use custom frame rate**: off — follow the OBS output frame rate.
- **Custom CSS**: leave the default — it is what makes the background transparent.
- **Shutdown source when not visible**: off — otherwise the overlay unloads whenever the source is hidden and reloads when shown.
- **Refresh browser when scene becomes active**: off — the overlay updates live without reloading.
- **Page permissions**: **No access to OBS** — the overlay uses no OBS features (the default also works).
- **Refresh cache of current page** (button): not needed normally — press it if the OBS view still looks old after updating Virtually.

Do not add a camera feed to the overlay page. Audio stays with your regular microphone and OBS sources.

## Add clips

Clips are added with `POST /api/upload`, sending the raw file as the request body. The display name is the file name without its extension, so `wink.webm` becomes a motion named `wink`, which links to the **윙크** button.

```bash
# Motion clip (transparent WebM)
curl -H 'Content-Type: video/webm' --data-binary @wink.webm \
  'http://127.0.0.1:8787/api/upload?kind=motion&name=wink.webm'

# Idle asset (looping WebM, or PNG/WebP image); replaces the current idle asset
curl -H 'Content-Type: image/png' --data-binary @idle.png \
  'http://127.0.0.1:8787/api/upload?kind=idle&name=idle.png'

# List the library, including motion ids
curl 'http://127.0.0.1:8787/api/library'

# Trigger a motion by id (or "demo") without the controller
curl -H 'Content-Type: application/json' -d '{"id":"demo"}' \
  'http://127.0.0.1:8787/api/trigger'

# Remove a motion or the idle asset
curl -X DELETE 'http://127.0.0.1:8787/api/media/<id>'
```

Use your server's actual port. The `Content-Type` header is required: without it curl sends `application/x-www-form-urlencoded` and the server answers `415`. Use `video/webm`, `image/png`, `image/webp`, or `application/octet-stream`. The server also checks the file signature, so a file renamed to `.webm` is rejected with `415`. Each upload is limited to 500 MB.

## Prepare media

- **Idle:** one transparent WebM video that loops, or a transparent PNG/WebP image.
- **Motions:** individually named transparent WebM clips, each played once per trigger.
- Use the same canvas size and character position across idle and motion clips for a clean transition. Put the character on a transparent background before encoding; changing the file extension to `.webm` does not create transparency.

For example, if `input.mov` already contains an alpha channel, FFmpeg can encode a transparent VP9 WebM:

```bash
ffmpeg -i input.mov -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -an output.webm
ffprobe -v error -select_streams v:0 -show_entries stream_tags=alpha_mode -of default=nw=1 output.webm
```

The second command should show `TAG:alpha_mode=1`. We verified this encoding path with a generated transparent clip; still check its actual appearance in your OBS setup.

## Scope and limitations

The PoC uses a local HTTP server and server-sent events to synchronize the controller, preview, and OBS Browser Source. It supports a single local library and does not include accounts, remote viewer triggers, AI generation, background removal, or a broadcasting platform. Browser playback and the transparent page background were tested locally; OBS scene rendering and long-running performance with many clips still need live validation.

Run `pnpm test` for API, media-range, persistence, port rotation, and event-stream checks.
