# Virtually PoC

A local proof of concept for putting a pre-rendered character over a live camera feed in OBS. The camera remains an ordinary OBS source. Virtually supplies a **separate transparent Browser Source** for the character and a controller with motion buttons, an OBS setup guide, and a large live preview. A button plays one motion once, then the overlay returns to the idle character.

This is a small first step toward the broader [Virtually presentation](https://translator.minglelabs.xyz/xr-virtually). It does not generate animations during a stream. New motions are made ahead of time on the **동작 만들기** page (a driving video + your character image, animated by an AI video API; see [Make motions](#make-motions-동작-만들기)) or prepared in another tool and added through the HTTP API (see [Add clips](#add-clips)).

## Run

Requires Node.js 20 or newer and pnpm. The controller and overlay need no external service. The **동작 만들기** page also needs `ffmpeg` and `ffprobe` with `libx264` on the `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`), and an API key for at least one provider to generate real motions.

```bash
pnpm start
```

By default, the server attempts to bind to port 8787 (or the port set by `PORT`). If the base port is occupied, it tries up to 100 consecutive ports and reports an error if none is available. The server prints the active controller and OBS overlay URLs upon starting:

- Controller: `http://127.0.0.1:8787/` (or rotated port)
- OBS overlay: `http://127.0.0.1:8787/overlay` (or rotated port)

Open the printed controller URL in your browser. It works before you add any files: every button falls back to an original illustrated demo avatar. Clips and the library index live in `data/`, which Git ignores. The server binds to `127.0.0.1` by default; it has no authentication and is intended for local use.

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

The card header, which stays visible at the top while the list scrolls, has a **대기로 돌아가기** (Back to idle) button. It stops the current motion and returns the overlay to the idle character (`POST /api/idle`).

The **+ 동작 추가하러 가기** button stays visible at the bottom of the list while it scrolls and rests under the last row at the end. It opens the **동작 만들기** page (`/animate`).

Motions can be transparent WebM clips (uploaded through the API) or MP4 results added from the 동작 만들기 page. The name decides the link: a motion named `wink` or `윙크` becomes the video of the **윙크** button, and any other name becomes a new button with that name.

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

## Make motions (동작 만들기)

Open `http://127.0.0.1:8787/animate` (or **+ 동작 추가하러 가기** on the controller):

1. **동작 영상** — pick an example driving video, or upload your own MP4/MOV/WebM (up to 200 MB) by clicking or dropping files on the first tile. The clips form a horizontal strip (mouse wheel scrolls it sideways) that loads 12 more cards as you near the right end.
2. **캐릭터** — drop PNG/JPEG/WebP images (up to 20 MB each) anywhere on the card, or click the drop zone. Every uploaded character stays in a horizontal strip; click a tile to use it. The most recently selected character comes first and stays selected after a reload; a new upload becomes the selected one. With no uploaded character, the library's PNG/WebP idle image is used. Transparent pixels are sent as a plain green background. Deleting a character does not affect jobs already started with it.
3. **모델** — pick a route: Wan 2.2 Animate, DreamActor V2 (M2.0) or Kling motion control, through WaveSpeed, fal.ai, Replicate, Higgsfield, Alibaba Model Studio or Kling directly. Routes marked "검증 전" have an endpoint or field name that was not confirmed against the vendor's docs; see [docs/animate-providers.md](docs/animate-providers.md). The page shows an estimated cost when the route has a known price and asks for confirmation before any paid request.
4. **결과** — jobs update live. A finished result plays on the page; **동작으로 추가하기** copies it into the motion list as an MP4 motion. Its default name is the preset label of the example (for example `인사 (Hi)`), so it lands on that preset button.

Background removal of results and fixing hard driving videos (several people, busy backgrounds) are not implemented yet.

### Example driving videos

`examples/driving.json` lists the example videos: label, preset, source page, author, license and trim. The videos themselves are **not** stored in this repository. They are downloaded from the sources listed in that file, trimmed and converted (H.264, height <= 720, no audio) into `data/animate/drivings/examples/`. The source's license applies to each video; see its `license` and `sourcePage`.

Download them with the page's **예시 영상 받기** button, or without the server:

```bash
pnpm run fetch-examples
```

Deleting an example on the page (×) hides it for this install: its downloaded files are removed, its id is kept in `data/animate/drivings/hidden-examples.json`, and neither the button nor `fetch-examples` downloads it again. **숨긴 예시 N개 되돌리기** under the strip clears that list; press **예시 영상 받기** afterwards to download them again.

Only the manifest's `https:` URLs are fetched (redirects must stay on `https:`), each file is limited to 100 MB and 60 seconds.

### API keys

Enter keys in the page's **API 키 설정** panel. They are saved in `data/animate/config.json` (file mode 0600, Git-ignored) and only a masked form is ever sent back. Environment variables work too and are used when no key is saved:

| Provider | Environment variables |
|---|---|
| WaveSpeed | `WAVESPEED_API_KEY` |
| fal.ai | `FAL_KEY` |
| Replicate | `REPLICATE_API_TOKEN` |
| Higgsfield | `HIGGSFIELD_API_KEY_ID` + `HIGGSFIELD_API_KEY_SECRET` |
| Alibaba Model Studio | `DASHSCOPE_API_KEY` |
| Kling AI (direct) | `KLING_ACCESS_KEY` + `KLING_SECRET_KEY`, or `KLING_API_KEY` |

Kling direct has no video upload API, so it also needs a WaveSpeed, fal.ai or Higgsfield key to relay the driving video. Generation is billed by the provider.

For a free local try-out, start the server with `VIRTUALLY_ANIMATE_MOCK=1 pnpm start`. It adds the **로컬 테스트 (AI 아님)** route, which only animates the character image with ffmpeg and never uses the network.

### Animate API

All errors are JSON `{ "error", "code"?, "detail"? }`. JSON bodies need `Content-Type: application/json`.

| Method and path | Purpose |
|---|---|
| `GET /api/animate/status` | ffmpeg availability, routes, providers (masked keys), config, current character |
| `PUT /api/animate/config` | Save provider keys/settings (`{ "providers": { "wavespeed": { "apiKey": "..." } } }`); `""` removes a key |
| `POST /api/animate/providers/<id>/test` | Check a provider key (where the provider has a test call) |
| `GET /api/animate/characters` | `{ characters, selectedId }`, most recently selected first |
| `POST /api/animate/characters?name=<file>` | Upload a character image (raw body); it becomes selected. `201 { character, characters, selectedId }` |
| `POST /api/animate/characters/<id>/select` | Select one (`{}`) |
| `DELETE /api/animate/characters/<id>` | Delete one; deleting the selected one selects the next most recently selected |
| `GET /api/animate/characters/<id>/image` | One character image |
| `POST`, `DELETE /api/animate/character`, `GET /api/animate/character/image` | Legacy aliases: upload, delete the selected one, the image in use (selected or idle) |
| `GET /api/animate/drivings` | Visible examples (manifest order), then uploads (newest first); `hiddenExamples` is the number of hidden examples |
| `POST /api/animate/examples/fetch` | Download missing example videos, skipping hidden ones (`{}`) |
| `POST /api/animate/examples/restore` | Un-hide all deleted examples (`{}`); returns `{ drivings, hidden: [] }`. They stay unavailable until fetched again |
| `POST /api/animate/drivings?name=<file>` | Upload a driving video (raw body) |
| `DELETE /api/animate/drivings/<id>` | Delete an upload, or hide an example for this install (its downloaded files are removed) |
| `GET /api/animate/drivings/<id>/video`, `/poster` | Driving video (byte ranges) and poster |
| `GET /api/animate/jobs`, `POST /api/animate/jobs` | List jobs; start one: `{ "drivingId", "routeId", "options"?, "confirmed": true }` |
| `GET /api/animate/jobs/<id>`, `POST .../cancel` | One job; cancel it |
| `GET /api/animate/jobs/<id>/result`, `/poster` | Result MP4 (byte ranges) and poster |
| `POST /api/animate/jobs/<id>/motion` | Add the result to the motion list: `{ "name"? }` |

Characters are stored in `data/animate/characters/` (`<id>.<ext>` plus `index.json`). A single character saved by an older version (`data/animate/character.json`) is imported into the library on startup. Jobs record `characterId` and `characterLabel`.

Job states: `queued`, `preparing`, `submitting`, `running`, `downloading`, `succeeded`, `failed`, `canceled`. Every change is also sent on `/api/events` as `{ "type": "animate-job", "job": ... }`. Jobs are kept in `data/animate/jobs/` and survive a restart: a job that was generating resumes polling, and a job cut off while submitting is marked failed (`interrupted`) rather than submitted twice.

## Add clips

Motion clips and the idle asset can also be added with `POST /api/upload`, sending the raw file as the request body. The display name is the file name without its extension, so `wink.webm` becomes a motion named `wink`, which links to the **윙크** button.

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

# Stop the current motion and return to idle
curl -H 'Content-Type: application/json' -d '{}' 'http://127.0.0.1:8787/api/idle'

# Remove a motion or the idle asset
curl -X DELETE 'http://127.0.0.1:8787/api/media/<id>'
```

Use your server's actual port. The `Content-Type` header is required: without it curl sends `application/x-www-form-urlencoded` and the server answers `415`. Use `video/webm`, `image/png`, `image/webp`, or `application/octet-stream`. The server also checks the file signature, so a file renamed to `.webm` is rejected with `415`. Each upload is limited to 500 MB.

## Prepare media

- **Idle:** one transparent WebM video that loops, or a transparent PNG/WebP image.
- **Motions:** individually named transparent WebM clips, each played once per trigger. MP4 motions added from the 동작 만들기 page play the same way but have no transparency (the provider's background is kept).
- Use the same canvas size and character position across idle and motion clips for a clean transition. Put the character on a transparent background before encoding; changing the file extension to `.webm` does not create transparency.

For example, if `input.mov` already contains an alpha channel, FFmpeg can encode a transparent VP9 WebM:

```bash
ffmpeg -i input.mov -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -an output.webm
ffprobe -v error -select_streams v:0 -show_entries stream_tags=alpha_mode -of default=nw=1 output.webm
```

The second command should show `TAG:alpha_mode=1`. We verified this encoding path with a generated transparent clip; still check its actual appearance in your OBS setup.

## Scope and limitations

The PoC uses a local HTTP server and server-sent events to synchronize the controller, preview, and OBS Browser Source. It supports a single local library and does not include accounts, remote viewer triggers, live AI generation, background removal, or a broadcasting platform. Browser playback and the transparent page background were tested locally; OBS scene rendering and long-running performance with many clips still need live validation.

Run `pnpm test` for API, media-range, persistence, port rotation, and event-stream checks. The animate tests use the mock route, local fixture servers and ffmpeg-generated clips; they never call a provider.
