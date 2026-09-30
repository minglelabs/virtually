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

Open the printed controller URL in your browser. It works before you add any files: every button falls back to an original illustrated demo avatar. Clips and the library index live in `data/`, which Git ignores. The server binds to `127.0.0.1` by default and is intended for local use; it has no authentication unless you turn on [Google login](#google-login-optional).

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

## Google login (optional)

Login is off by default. It turns on when `data/auth/config.json` exists; from then on the controller, the 동작 만들기 page and the API need a Google account from your allowlist (open `http://127.0.0.1:8787/login`, or any page, to log in). The server re-reads the file when it changes (at most once a second), so no restart is needed; delete the file to turn login off again. A file that is present but unusable (broken JSON, a missing field) keeps everything locked until it is fixed: every page leads to `/login`, which names the problem. The server's startup output also says whether login is on.

### Create the Google OAuth client

In the [Google Cloud Console](https://console.cloud.google.com/), select or create a project and open **Google Auth Platform**:

1. **Branding**: enter an app name and a user support email.
2. **Audience**: choose user type **External**, keep the publishing status **Testing**, and add every account that should be able to log in under **Test users**.
3. **Clients** → **Create client** → application type **Web application**. Add these **Authorized redirect URIs**:
   - `http://127.0.0.1:8787/auth/google/callback`
   - `http://localhost:8787/auth/google/callback`
   - `<publicUrl>/auth/google/callback`, when you use `publicUrl` (see [Remote use](#remote-use))

   Use the port your server actually runs on. While login is off, `/login` shows the redirect URI for the address you opened it with.
4. Copy the client ID and the client secret. The secret is shown only once, when the client is created, so download the JSON then.

Virtually asks only for `openid email profile`, so no extra scopes are needed.

### config.json

```json
{
  "google": { "clientId": "1234567890-abc.apps.googleusercontent.com", "clientSecret": "GOCSPX-..." },
  "allowedEmails": ["you@gmail.com", "@example.com"],
  "publicUrl": "https://virtually.example.com"
}
```

- `google.clientId`, `google.clientSecret` (required): from the client above.
- `allowedEmails` (required, at least one entry): the accounts that may log in, compared case-insensitively. An entry that starts with `@`, such as `@example.com`, allows every address at that domain. Google must report the address as verified. The list is checked on every request, so removing an address logs that account out at once.
- `publicUrl` (optional): the origin the server is reached at from other machines, such as `https://virtually.example.com` — no path, query or hash (a trailing `/` is fine). Leave it out for local use.

The server never writes this file. Every allowed account shares one library and one 동작 만들기 setup: anyone on the list can trigger and delete motions and start paid generations with the saved API keys. There are no per-user libraries or roles.

### What login protects

- **Public**: `/login`, the sign-in routes under `/auth/google/`, `POST /auth/logout`, `GET /api/auth/status` and the static `.css`/`.js` files (the source is public anyway).
- **Login or overlay key**: `/overlay` and the calls it makes — `GET /api/library`, `GET /api/events`, media files (`/api/media/<id>`) and `GET`/`POST /api/obs-source` (the overlay reports its size).
- **Login**: everything else — the controller, the 동작 만들기 page and every other API call (triggers, uploads, deletes, `/api/animate/*`). A page opened without a login goes to `/login` and comes back afterwards; an API call gets `401` with the header `X-Virtually-Auth: required`.

A login lasts 30 days and is extended while you use it. **로그아웃**, next to your name on the controller and the 동작 만들기 page, ends it in that browser.

### OBS with login on

OBS cannot log in to Google, so the overlay URL carries a secret key instead. With login on, the controller's **OBS에 연동하기!** section shows the overlay URL with its key (`http://127.0.0.1:8787/overlay?key=...`); copy that URL into the OBS Browser Source (without the key, OBS shows only a one-line notice). Anyone with the URL can watch the overlay — not trigger motions or open the controller — so keep it off stream and do not share it.

**주소 새로 만들기** replaces the key after a confirmation. The old URL stops working at once (a running OBS source stops following the controller), so paste the new URL into the OBS source. The key is kept in `data/auth/state.json` and survives restarts. The controller's own preview needs no key; it uses your login.

### Remote use

Google accepts plain `http` redirect URIs only for `localhost` and loopback addresses such as `127.0.0.1`, so using Virtually from another machine needs HTTPS. Put an HTTPS reverse proxy or tunnel in front of the server that forwards to `127.0.0.1:8787` and passes the original `Host` header through, set `publicUrl` to its origin (for example `https://virtually.example.com`), and add `<publicUrl>/auth/google/callback` to the client's redirect URIs. For requests that arrive with that host, the server accepts the host, sends that redirect URI to Google and marks its cookies `Secure`. Never expose the server with login off: anyone who can reach it controls Virtually.

### Secrets

`data/auth/` holds secrets: the client secret in `config.json`, and the keys that sign logins and the overlay key in `state.json` (created by the server with file mode 0600). `data/` is ignored by Git — never commit it or copy it into the repository, which is public. Deleting `state.json` and restarting the server logs everyone out and replaces the overlay URL.

## Set up OBS

The controller's collapsible **OBS에 연동하기!** section (closed by default; click it to open) shows a short version of this guide with the actual overlay URL and a copy button. With [Google login](#google-login-optional) on, that URL includes the overlay key.

1. In the **Sources** dock, click **+** (Add Source).
2. Under Source Type, choose **Browser**.
3. In **Add a new Browser**, enter a name (for example `Virtually`), keep **Make source visible** checked, and click **Create New**.
4. In the properties window, apply the settings below and click **OK**.
5. In **Sources**, place this source above your camera source. Sources higher in the list are drawn in front.
6. Right-click the source and choose **Transform → Fit to screen**.

Recommended properties, in OBS order:

- **Local file**: off.
- **URL**: the overlay URL printed by the server (default `http://127.0.0.1:8787/overlay`). With Google login on, copy the URL with its key from the controller instead (see [OBS with login on](#obs-with-login-on)).
- **Width** / **Height**: the same as your OBS canvas (**Settings → Video → Base (Canvas) Resolution**; the source defaults to 800 / 600). The overlay reports this size to the controller, whose 캔버스 preview then shows the same size (800 × 600, the OBS default, until the first report).
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
2. **캐릭터** — drop PNG/JPEG/WebP images (up to 20 MB each) anywhere on the card, or click the drop zone. Every uploaded character stays in a horizontal strip; click a tile to use it. The most recently selected character comes first and stays selected after a reload; a new upload becomes the selected one. With no uploaded character, the library's PNG/WebP idle image is used. Transparent pixels are sent as a plain key-colour background (green, or blue / magenta when green would key or despill the character's colours — see step 4). Deleting a character does not affect jobs already started with it.
3. **모델** — pick a route: Wan 2.2 Animate 2 (WaveSpeed, the default), DreamActor V2 (M2.0) or Kling motion control, through WaveSpeed, fal.ai, Replicate, Higgsfield or Kling directly. Wan 2.2 Animate 2 ignores the backgrounds of the character image and the driving video and generates the output background from its prompt; we ask for a plain solid chroma-key background (green `#00FF00` by default, see step 4) so it can be keyed later, and send the motion wording separately as `motion_prompt`. Routes marked "검증 전" have an endpoint or field name that was not confirmed against the vendor's docs; see [docs/animate-providers.md](docs/animate-providers.md). The page shows an estimated cost when the route has a known price and asks for confirmation before any paid request. **여백** (margin: 없음 / 보통 / 넓게) pads the driving video with black on the left, right and top (never the bottom) before it is sent, by 12 % (보통) or 25 % (넓게) of its long edge, so the performer — and the generated character, since Wan 2.2 Animate 2 follows the driving framing — keeps room inside the frame instead of being cut off. The default is 보통 for Wan 2.2 Animate 2 and 없음 for every other route. A margin makes the character smaller in the output (fewer pixels, less detail); its effect on DreamActor and Kling framing is unverified.
4. **결과** — jobs update live. Each card shows the elapsed time while a job runs (`1분 5초 경과`), then its working time from start to finished result (`작업 시간 2분 13초`, from the job's `createdAt` and `finishedAt`) and the result length (`영상 3초`). When a result arrives, its solid key-colour background is removed automatically ("배경 지우는 중") into a transparent WebM (VP9 with alpha) by the local `ffmpeg` — no upload and no cost. The page plays the transparent clip over a checkerboard, with a toggle to view the original MP4. **동작으로 추가하기** copies the transparent WebM into the motion list (older results are keyed at that moment). Its default name is the preset label of the example (for example `인사 (Hi)`), so it lands on that preset button. The key colour is chosen automatically per job from the character image: green, else blue, else magenta — the first whose keying would not touch the character's colours (a colour near the key colour, or one the key colour's despill would shift, such as green or bright yellow for green); the job card says so when it is not green. Limits: character pixels close to the chosen key colour are removed too, and a background that is not one uniform key colour (the model painted a scene, a gradient or another colour) is skipped — the page says so and the original MP4 is added instead. Keying never fails a job. See [docs/animate-providers.md](docs/animate-providers.md#background-keying) for the filter and the detection rule. The keyed clip's character box is measured from its alpha channel (`fit`, below) and travels with the motion, so the overlay can show the motion at the size and place of the idle character.

**Overlay size fit.** When a keyed motion carries a `fit` record, the overlay scales and positions the motion video so that its first-frame character matches the idle character (the demo avatar or the idle asset): the same height, horizontally centred on the idle character, with the feet on the idle feet. A motion whose frames reach the bottom edge of its video is lowered onto the bottom of the canvas so the cut stays hidden (the character then stands a little lower than the idle one). A motion whose first frame is already cut at the bottom (an upper-body clip) keeps the head at the idle head height and fills down to the bottom of the canvas, so its size can differ. The placement is recomputed whenever the OBS source is resized, and the controller's 캔버스 preview shows the same result. Motions without a `fit` (MP4, opaque video) keep the default bottom-centred layout. Parts of the character that left the generated video (see **여백**) cannot come back; the job card warns about them.

Fixing hard driving videos (several people, busy backgrounds) is not implemented yet.

### Example driving videos

`examples/driving.json` lists the example videos: label, preset, credit and one source, either a `downloadUrl` (with `trim`) or a bundled `file`.

- **Downloaded** examples (third-party stock clips) are **not** stored in this repository. They are downloaded from the sources listed in that file, trimmed and converted (H.264, height <= 720, no audio) into `data/animate/drivings/examples/`. The source's license applies to each video; see its `license` and `sourcePage`.
- **Bundled** examples are our own videos, committed in `assets/drivings/` (the `file` plus a poster with the same name and `.jpg`) and served from there as they are: available at once, never downloaded or converted.

Download the downloaded ones with the page's **예시 영상 받기** button, or without the server:

```bash
pnpm run fetch-examples
```

Deleting an example on the page (×) hides it for this install: its id is kept in `data/animate/drivings/hidden-examples.json`, a downloaded example's files are removed (a bundled example's files stay in the repository), and neither the button nor `fetch-examples` downloads it again. **숨긴 예시 N개 되돌리기** under the strip clears that list; bundled examples are back at once, press **예시 영상 받기** to download the others again.

Only the manifest's `https:` URLs are fetched (redirects must stay on `https:`), each file is limited to 100 MB and 60 seconds.

**기본 캐릭터 대기 (idle)** (`demo-idle`, listed first) is the idle loop of the overlay's demo avatar — 540x720 on white, 30 fps, a seamless 3.8 s loop — for animating a new character photo into an idle motion. `scripts/render-demo-idle.js` renders it from the `#demo-avatar` markup of `public/overlay.html` and `public/overlay.css` with headless Chrome (`CHROME_PATH`, default: Google Chrome on macOS) and ffmpeg, and fails unless the loop closes pixel-exactly. After changing the demo avatar, re-render it and commit both files:

```bash
node scripts/render-demo-idle.js
```

The demo avatar is not human-shaped, so pose-based models may not track it; for a human-shaped character, a human idle reference works better.

### API keys

Enter keys in the page's **API 키 설정** panel. They are saved in `data/animate/config.json` (file mode 0600, Git-ignored) and only a masked form is ever sent back. Environment variables work too and are used when no key is saved:

| Provider | Environment variables |
|---|---|
| WaveSpeed | `WAVESPEED_API_KEY` |
| fal.ai | `FAL_KEY` |
| Replicate | `REPLICATE_API_TOKEN` |
| Higgsfield | `HIGGSFIELD_API_KEY_ID` + `HIGGSFIELD_API_KEY_SECRET` |
| Kling AI (direct) | `KLING_ACCESS_KEY` + `KLING_SECRET_KEY`, or `KLING_API_KEY` |

Kling direct has no video upload API, so it also needs a WaveSpeed, fal.ai or Higgsfield key to relay the driving video. Generation is billed by the provider.

For a free local try-out, start the server with `VIRTUALLY_ANIMATE_MOCK=1 pnpm start`. It adds the **로컬 테스트 (AI 아님)** route, which only animates the character image with ffmpeg and never uses the network.

### Animate API

All errors are JSON `{ "error", "code"?, "detail"? }`. JSON bodies need `Content-Type: application/json`.

| Method and path | Purpose |
|---|---|
| `GET /api/animate/status` | ffmpeg availability, routes (each with `defaultMargin`), `margins` (`[{ value, label }]` for `none` / `normal` / `wide`), providers (masked keys), config, current character |
| `PUT /api/animate/config` | Save provider keys/settings (`{ "providers": { "wavespeed": { "apiKey": "..." } } }`); `""` removes a key. Returns `{ providers, config, routes, margins }` |
| `POST /api/animate/providers/<id>/test` | Check a provider key (where the provider has a test call) |
| `GET /api/animate/characters` | `{ characters, selectedId }`, most recently selected first |
| `POST /api/animate/characters?name=<file>` | Upload a character image (raw body); it becomes selected. `201 { character, characters, selectedId }` |
| `POST /api/animate/characters/<id>/select` | Select one (`{}`) |
| `DELETE /api/animate/characters/<id>` | Delete one; deleting the selected one selects the next most recently selected |
| `GET /api/animate/characters/<id>/image` | One character image |
| `POST`, `DELETE /api/animate/character`, `GET /api/animate/character/image` | Legacy aliases: upload, delete the selected one, the image in use (selected or idle) |
| `GET /api/animate/drivings` | Visible examples (manifest order), then uploads (newest first); `hiddenExamples` is the number of hidden examples |
| `POST /api/animate/examples/fetch` | Download missing example videos, skipping hidden and bundled ones (`{}`) |
| `POST /api/animate/examples/restore` | Un-hide all deleted examples (`{}`); returns `{ drivings, hidden: [] }`. Downloaded ones stay unavailable until fetched again; bundled ones are available at once |
| `POST /api/animate/drivings?name=<file>` | Upload a driving video (raw body) |
| `DELETE /api/animate/drivings/<id>` | Delete an upload, or hide an example for this install (its downloaded files are removed; a bundled example's files are kept) |
| `GET /api/animate/drivings/<id>/video`, `/poster` | Driving video (byte ranges) and poster |
| `GET /api/animate/jobs`, `POST /api/animate/jobs` | List jobs; start one: `{ "drivingId", "routeId", "options"?, "margin"?, "confirmed": true }`. `margin` = `none` / `normal` / `wide` (default: the route's `defaultMargin`; anything else is `400 bad_margin`); the job view echoes it (older jobs: `none`) |
| `GET /api/animate/jobs/<id>`, `POST .../cancel` | One job; cancel it |
| `GET /api/animate/jobs/<id>/result`, `/poster` | Result MP4 (byte ranges) and poster |
| `GET /api/animate/jobs/<id>/result?variant=keyed` | The transparent WebM (byte ranges); the job's `result.keyedUrl` points here, or is `null` when there is none (`result.keySkipped` = `not_key_color` / `not_uniform` (older jobs: `not_green`), or `result.keyFailed`); `keyColor` = `{ name, hex }` of the job's chroma-key background; `result.fit` = the keyed clip's character box (`null` when not keyed) |
| `POST /api/animate/jobs/<id>/motion` | Add the result to the motion list: `{ "name"? }`. Adds the WebM (`video/webm`) when keyed, else the MP4; returns `{ motion, job, keyed, keyReason }`. The motion record carries the job's `fit` (`null` for an MP4) |

`fit` (v1) is the character box measured from the alpha channel (pixels with alpha >= 128), from frame 0 plus frames sampled every 0.25 s, at most 256 px on the long edge:

```json
{ "v": 1, "width": 800, "height": 1136,
  "first": [0.0722, 0.0508, 0.9167, 0.9219], "union": [0, 0, 1, 1],
  "touches": { "left": true, "right": true, "top": true, "bottom": true } }
```

`width` / `height` are the source frame size; `first` (first frame) and `union` (all sampled frames) are `[x0, y0, x1, y1]` normalized to 0..1 (x1/y1 exclusive); `touches` says which frame edges the union reaches (within max(2 px, 1 %)). `fit: null` means measured and not applicable (MP4, JPEG, an opaque WebM, nothing opaque); a record with no `fit` key has not been measured yet. It is stored on library motions, on `library.idle`, and on keyed jobs (`result.fit`).

Characters are stored in `data/animate/characters/` (`<id>.<ext>` plus `index.json`). A single character saved by an older version (`data/animate/character.json`) is imported into the library on startup. Jobs record `characterId` and `characterLabel`.

Job states: `queued`, `preparing`, `submitting`, `running`, `downloading`, `keying`, `succeeded`, `failed`, `canceled`. Every change is also sent on `/api/events` as `{ "type": "animate-job", "job": ... }`. Jobs are kept in `data/animate/jobs/` and survive a restart: a job that was generating resumes polling, and a job cut off while submitting is marked failed (`interrupted`) rather than submitted twice.

## Add clips

Motion clips and the idle asset can also be added with `POST /api/upload`, sending the raw file as the request body. The display name is the file name without its extension, so `wink.webm` becomes a motion named `wink`, which links to the **윙크** button. Each upload's `fit` (see [Animate API](#animate-api)) is measured before it is saved; records saved by an older version are measured in the background once the server is listening (startup is not delayed) and the library is broadcast once when they are done.

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

The PoC uses a local HTTP server and server-sent events to synchronize the controller, preview, and OBS Browser Source. It supports a single library; the optional Google login only admits allowlisted accounts, which all share it (no per-user libraries or roles). It does not include remote viewer triggers, live AI generation, background removal, or a broadcasting platform. Browser playback and the transparent page background were tested locally; OBS scene rendering and long-running performance with many clips still need live validation.

Run `pnpm test` for API, login, media-range, persistence, port rotation, and event-stream checks. The animate tests use the mock route, local fixture servers and ffmpeg-generated clips; they never call a provider. The login tests use a local fake Google; they never call Google.
