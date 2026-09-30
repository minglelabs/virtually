# Virtually PoC

A local proof of concept for putting a pre-rendered character over a live camera feed in OBS. The camera remains an ordinary OBS source. Virtually supplies a **separate transparent Browser Source** for the character and a controller with motion buttons, an OBS setup guide, and a large live preview. A button plays one motion once, then the overlay returns to the idle character.

You keep **characters** (a name plus photos) on the main page, pick one photo and put it **on air**: the overlay then shows that photo as the idle character and plays that photo's motions. New motions are made ahead of time for one photo on the **동작 만들기** page — generated from a driving video by an AI video API (see [Make motions](#make-motions-동작-만들기)), or a finished video you made yourself (see [Upload a finished motion](#upload-a-finished-motion-완성된-영상-올리기)) — or added through the HTTP API (see [Add clips](#add-clips)).

This is a small first step toward the broader [Virtually presentation](https://translator.minglelabs.xyz/xr-virtually). It does not generate animations during a stream.

## Run

Requires Node.js 20 or newer and pnpm. The controller and overlay need no external service. The **동작 만들기** page also needs `ffmpeg` and `ffprobe` with `libx264` on the `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`), and an API key for at least one provider to generate real motions.

```bash
pnpm start
```

By default, the server attempts to bind to port 8787 (or the port set by `PORT`). If the base port is occupied, it tries up to 100 consecutive ports and reports an error if none is available. The server prints the app URL and the OBS overlay URL upon starting:

- App (the character list): `http://127.0.0.1:8787/` (or rotated port)
- OBS overlay: `http://127.0.0.1:8787/overlay` (or rotated port)

Open the printed app URL in your browser. It works before you add any files: with no character on air, the broadcast page's buttons fall back to an original illustrated demo avatar. Characters, clips and the library index live in `data/`, which Git ignores. The server binds to `127.0.0.1` by default and is intended for local use; it has no authentication unless you turn on [Google login](#google-login-optional).

## Pages

| Path | Page |
|---|---|
| `/` | **캐릭터 목록** (character list): your characters and their photos. Create characters, add photos, pick the photo to put on air (**이 캐릭터로 방송하기**, which then opens `/broadcast`). Every photo card has **동작 추가하러 가기**, which opens `/animate?photo=<photoId>`. |
| `/broadcast` | **방송 화면**: the controller (motion buttons, OBS guide) next to the true-scale canvas preview, for the photo on air. |
| `/animate?photo=<photoId>` | **동작 만들기**: make motions for one photo, with AI or by uploading a finished video. |
| `/overlay` | The OBS Browser Source. Its URL never changes: it follows the photo on air. |
| `/login` | Google login (only when [login](#google-login-optional) is on); afterwards it returns to the page you came from (default `/`). |

## Characters and photos

A **character** is a name (1–40 characters; duplicates are allowed) plus **photos** (PNG, JPEG or WebP, up to 20 MB each, recognised by their content, not their name). A character is created with one photo, its **base photo** (기본), and more can be added; there are at most 50 characters with 30 photos each. Deleting the base photo passes that role to the oldest remaining photo, and a character's only photo cannot be deleted (delete the character instead). Characters are shared by every allowed login, like the rest of the app.

**Every motion belongs to one photo.** At most one photo is **on air**: the overlay shows that photo as its idle image (instead of the demo avatar), and the controller's motion buttons play that photo's motions. Putting another photo on air switches the overlay and the controller live, over the same `/api/library` + `/api/events` they already use, so the OBS source never needs a new URL. An idle uploaded for a photo (`POST /api/upload?kind=idle` while it is on air) replaces the photo as its idle image. With nothing on air, the overlay shows the old library idle (or the demo avatar) and the motions that belong to no photo, which is how a fresh install without characters works.

**Opaque photos.** A photo without transparency, such as character art on a white background, must not show that background in OBS. When such a photo is added, the server cuts its plain background out with the same step the animate jobs use (`lib/animate/cutout.js`: the border colour is flood-filled from the image edges, so enclosed areas such as the eyes stay) into a PNG kept next to the photo. The overlay's idle image and the photo cards then use the cutout (`/api/media/<photoId>?variant=cutout`), while `/api/media/<photoId>` stays the original file. A photo or scene whose border is not one colour, or one where nothing would be left, is shown as it is. Photos stored before cutouts existed are decided in the background after startup.

The 방송 화면 shows the character on air at the top of the control pane — a small thumbnail of what the overlay shows, its name, **캐릭터 바꾸기** (back to `/`) and **동작 추가하러 가기** (`/animate?photo=<on-air photo>`). With nothing on air it says **방송할 캐릭터를 골라 주세요** and links to `/`.

## Motion buttons

The **동작** (Motions) card sits at the bottom of the controller on the 방송 화면 (`/broadcast`), below the **OBS에 연동하기!** section. It lists the motions of the photo on air (with nothing on air: the motions that belong to no photo). The whole control pane scrolls as one, and the list renders 30 buttons at a time, loading the next 30 as you scroll to the end (infinite scroll). It lists, in this order:

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

3. Every other motion of the photo on air, in library order, labelled by its name.

**Linking rule:** a preset is linked to the first of those motions whose name, trimmed and compared case-insensitively, equals the preset key or its label. A linked preset plays that clip ("영상"). An unlinked preset plays the demo avatar reaction ("영상 없음 · 데모 재생"). The list updates live when the library or the photo on air changes; no reload is needed.

A new trigger replaces a motion that is already playing. The OBS source and the controller's preview receive the same event. Only motions of the current view can be triggered (`POST /api/trigger` answers `404` for any other id).

The card header, which stays visible at the top while the list scrolls, has a **대기로 돌아가기** (Back to idle) button. It stops the current motion and returns the overlay to the idle character (`POST /api/idle`).

The **+ 동작 추가하러 가기** button stays visible at the bottom of the list while it scrolls and rests under the last row at the end. It opens the **동작 만들기** page for the photo on air (`/animate?photo=<photoId>`; `/animate` with nothing on air).

Motions are transparent WebM clips (keyed AI results, finished videos with a transparent or plain key-colour background, or uploads through the API) or MP4/WebM videos kept with their own background. The name decides the link: a motion named `wink` or `윙크` becomes the video of the **윙크** button, and any other name becomes a new button with that name.

## Google login (optional)

Login is off by default. It turns on when `data/auth/config.json` exists; from then on the character list, the 방송 화면, the 동작 만들기 page and the API need a Google account from your allowlist (open `http://127.0.0.1:8787/login`, or any page, to log in). The server re-reads the file when it changes (at most once a second), so no restart is needed; delete the file to turn login off again. A file that is present but unusable (broken JSON, a missing field) keeps everything locked until it is fixed: every page leads to `/login`, which names the problem. The server's startup output also says whether login is on.

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

The server never writes this file. Every allowed account shares one set of characters, one library and one 동작 만들기 setup: anyone on the list can put a photo on air, trigger and delete motions and start paid generations with the saved API keys. There are no per-user libraries or roles.

### What login protects

- **Public**: `/login`, the sign-in routes under `/auth/google/`, `POST /auth/logout`, `GET /api/auth/status` and the static `.css`/`.js` files (the source is public anyway).
- **Login or overlay key**: `/overlay` and the calls it makes — `GET /api/library`, `GET /api/events`, media files (`/api/media/<id>`, which includes the photos and their cutouts, so OBS reaches the photo on air with its key) and `GET`/`POST /api/obs-source` (the overlay reports its size).
- **Login**: everything else — the character list, the 방송 화면, the 동작 만들기 page and every other API call (triggers, uploads, deletes, `/api/characters*`, `/api/active-photo`, `/api/animate/*`). A page opened without a login goes to `/login` and comes back afterwards; an API call gets `401` with the header `X-Virtually-Auth: required`.

A login lasts 30 days and is extended while you use it. **로그아웃**, next to your name at the top of the pages, ends it in that browser.

### OBS with login on

OBS cannot log in to Google, so the overlay URL carries a secret key instead. With login on, the **OBS에 연동하기!** section of the 방송 화면 (`/broadcast`) shows the overlay URL with its key (`http://127.0.0.1:8787/overlay?key=...`); copy that URL into the OBS Browser Source (without the key, OBS shows only a one-line notice). Anyone with the URL can watch the overlay — not trigger motions or open the controller — so keep it off stream and do not share it.

**주소 새로 만들기** replaces the key after a confirmation. The old URL stops working at once (a running OBS source stops following the controller), so paste the new URL into the OBS source. The key is kept in `data/auth/state.json` and survives restarts. The controller's own preview needs no key; it uses your login.

### Remote use

Google accepts plain `http` redirect URIs only for `localhost` and loopback addresses such as `127.0.0.1`, so using Virtually from another machine needs HTTPS. Put an HTTPS reverse proxy or tunnel in front of the server that forwards to `127.0.0.1:8787` and passes the original `Host` header through, set `publicUrl` to its origin (for example `https://virtually.example.com`), and add `<publicUrl>/auth/google/callback` to the client's redirect URIs. For requests that arrive with that host, the server accepts the host, sends that redirect URI to Google and marks its cookies `Secure`. Never expose the server with login off: anyone who can reach it controls Virtually.

### Secrets

`data/auth/` holds secrets: the client secret in `config.json`, and the keys that sign logins and the overlay key in `state.json` (created by the server with file mode 0600). `data/` is ignored by Git — never commit it or copy it into the repository, which is public. Deleting `state.json` and restarting the server logs everyone out and replaces the overlay URL.

## Set up OBS

The collapsible **OBS에 연동하기!** section of the 방송 화면 (closed by default; click it to open) shows a short version of this guide with the actual overlay URL and a copy button. With [Google login](#google-login-optional) on, that URL includes the overlay key.

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

Open **동작 추가하러 가기** on a photo card of the character list or on the 방송 화면; it opens `http://127.0.0.1:8787/animate?photo=<photoId>`. The header links back to **캐릭터 목록** (`/`) and **방송 화면** (`/broadcast`).

1. **캐릭터 사진** — one row per character with its photos, shown the way OBS shows them (a cut-out photo as its cutout, on a checkerboard); each tile says **기본** for the base photo, **방송 중** for the photo on air and how many motions the photo has. The photo named by `?photo=` is chosen, else the photo on air, else the first character's base photo; click another tile to switch (the address follows, so a reload keeps the choice). Everything made on the page goes to the chosen photo. **+ 사진 추가** at the start of each row adds photos to that character (click it, or drop image files on the row). Pasting an image (⌘V / Ctrl+V) anywhere on the page adds it as a new photo of the chosen photo's character and chooses it; with no character yet, it creates one named `캐릭터 1` (N = the number of characters + 1). With no character at all, the card says **캐릭터를 먼저 만들어 주세요** and links to the list.

Then choose how to make the motion: **AI로 만들기** (steps 2–4) or **완성된 영상 올리기** (see [Upload a finished motion](#upload-a-finished-motion-완성된-영상-올리기)).

2. **동작 영상** — pick an example driving video, or upload your own MP4/MOV/WebM (up to 200 MB) by clicking or dropping files on the first tile. The clips form a horizontal strip (mouse wheel scrolls it sideways) that loads 12 more cards as you near the right end.
3. **모델** — pick a route: Wan 2.2 Animate 2 (WaveSpeed, the default), DreamActor V2 (M2.0) or Kling motion control, through WaveSpeed, fal.ai, Replicate, Higgsfield or Kling directly. The chosen photo is the character image (the job copies it, so deleting the photo later does not change a started job). Transparent pixels are sent as a plain key-colour background (green, or blue / magenta when green would key or despill the character's colours — see step 4). An opaque image (no alpha, such as generated art on white) first has its plain background cut out: the border colour is flood-filled from the image edges (so white enclosed by the character, like eyes, stays), then the key colour replaces it — without this the model kept the image's white background and the result could not be keyed. A photo or scene (the border is not one colour) is sent as it is; the job card says when a background was cut out. Wan 2.2 Animate 2 ignores the backgrounds of the character image and the driving video and generates the output background from its prompt; we ask for a plain solid chroma-key background (green `#00FF00` by default, see step 4) so it can be keyed later, and send the motion wording separately as `motion_prompt`. Routes marked "검증 전" have an endpoint or field name that was not confirmed against the vendor's docs; see [docs/animate-providers.md](docs/animate-providers.md). The page shows an estimated cost when the route has a known price and asks for confirmation (naming the character photo, the model, the length and the cost) before any paid request. **여백** (margin: 없음 / 보통 / 넓게) pads the driving video with black on the left, right and top (never the bottom) before it is sent, by 12 % (보통) or 25 % (넓게) of its long edge, so the performer — and the generated character, since Wan 2.2 Animate 2 follows the driving framing — keeps room inside the frame instead of being cut off. The default is 보통 for Wan 2.2 Animate 2 and 없음 for every other route. A margin makes the character smaller in the output (fewer pixels, less detail); its effect on DreamActor and Kling framing is unverified.
4. **결과** — the jobs of every character, newest first; each card names its character. Jobs update live. Each card shows the elapsed time while a job runs (`1분 5초 경과`), then its working time from start to finished result (`작업 시간 2분 13초`, from the job's `createdAt` and `finishedAt`) and the result length (`영상 3초`). When a result arrives, its solid key-colour background is removed automatically ("배경 지우는 중") into a transparent WebM (VP9 with alpha) by the local `ffmpeg` — no upload and no cost. The page plays the transparent clip over a checkerboard, with a toggle to view the original MP4. **동작으로 추가하기** copies the transparent WebM into the motions of the job's photo (older results are keyed at that moment; a photo deleted meanwhile answers `409 photo_missing`). Its default name is the preset label of the example (for example `인사 (Hi)`), so it lands on that preset button. The key colour is chosen automatically per job from the character image: green, else blue, else magenta — the first whose keying would not touch the character's colours (a colour near the key colour, or one the key colour's despill would shift, such as green or bright yellow for green); the job card says so when it is not green. Limits: character pixels close to the chosen key colour are removed too, and a background that is not one uniform key colour (the model painted a scene, a gradient or another colour) is skipped — the page says so and the original MP4 is added instead. Keying never fails a job. When the background is one plain colour that is not the key colour (a model that kept a white image background), a fallback removes the plain background connected to the frame edges instead (`lib/animate/plain-cut.js`: pixels within RGB distance 20 of the dominant border colour; areas the character encloses stay, and so does pale skin). **배경 제거하기** on a finished result runs the background removal again (colour key, then that fallback); if the result is already in the motion list, that motion is replaced by the new transparent WebM under the same name. See [docs/animate-providers.md](docs/animate-providers.md#background-keying) for the filter and the detection rule. The keyed clip's character box is measured from its alpha channel (`fit`, below) and travels with the motion, so the overlay can show the motion at the size and place of the idle character.

**다시 받기** on a failed or canceled job fetches its result again from the task the provider already has (poll, download, background removal) without submitting it again, so there is no new charge (`POST /api/animate/jobs/<id>/refetch`; `409 not_refetchable` when not offered). The job goes back to `running`, so a restart meanwhile resumes polling instead of submitting. It is not offered when the provider itself reported the job failed or canceled, when nothing was submitted, or after the provider deleted the result file (`result_expired`; WaveSpeed keeps outputs about 7 days).

**Overlay size fit.** When a keyed motion carries a `fit` record, the overlay scales and positions the motion video so that its first-frame character matches the idle character (the photo on air, its cutout, an uploaded idle, or the demo avatar): the same height, horizontally centred on the idle character, with the feet on the idle feet. The idle's own `fit` gives its character box; an idle without one (a JPEG, a photo that was not cut out) counts as a character filling the whole image. A motion whose frames reach the bottom edge of its video is lowered onto the bottom of the canvas so the cut stays hidden (the character then stands a little lower than the idle one). A motion whose first frame is already cut at the bottom (an upper-body clip) keeps the head at the idle head height and fills down to the bottom of the canvas, so its size can differ. The placement is recomputed whenever the OBS source is resized, and the controller's 캔버스 preview shows the same result. Motions without a `fit` (MP4, opaque video) keep the default bottom-centred layout. Parts of the character that left the generated video (see **여백**) cannot come back; the job card warns about them.

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

**사람 대기 (idle · 무표정)** (`human-idle-neutral`) and **사람 대기 (idle · 옅은 미소)** (`human-idle-smile`) are listed first, so once they are downloaded the page selects the neutral one by default (it picks the first available driving). Both are Pexels clips of a man standing still, framed head to thighs with both hands in view, cut to a near-seamless loop (5.0 s and 4.0 s at 30 fps): the last and first frames differ only in a few hair and hand pixels. They are downloaded like the other Pexels examples and are the references to use for animating a human-shaped character photo into an idle motion.

**기본 캐릭터 대기 (idle)** (`demo-idle`) is the idle loop of the overlay's demo avatar — 540x720 on white, 30 fps, a seamless 3.8 s loop. `scripts/render-demo-idle.js` renders it from the `#demo-avatar` markup of `public/overlay.html` and `public/overlay.css` with headless Chrome (`CHROME_PATH`, default: Google Chrome on macOS) and ffmpeg, and fails unless the loop closes pixel-exactly. After changing the demo avatar, re-render it and commit both files:

```bash
node scripts/render-demo-idle.js
```

The demo avatar is not human-shaped, so pose-based models may not track it; for a human-shaped character, use one of the human idle references above.

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
| `GET /api/animate/status` | ffmpeg availability, routes (each with `defaultMargin`), `margins` (`[{ value, label }]` for `none` / `normal` / `wide`), providers (masked keys), config |
| `PUT /api/animate/config` | Save provider keys/settings (`{ "providers": { "wavespeed": { "apiKey": "..." } } }`); `""` removes a key. Returns `{ providers, config, routes, margins }` |
| `POST /api/animate/providers/<id>/test` | Check a provider key (where the provider has a test call) |
| `GET /api/animate/drivings` | Visible examples (manifest order), then uploads (newest first); `hiddenExamples` is the number of hidden examples |
| `POST /api/animate/examples/fetch` | Download missing example videos, skipping hidden and bundled ones (`{}`) |
| `POST /api/animate/examples/restore` | Un-hide all deleted examples (`{}`); returns `{ drivings, hidden: [] }`. Downloaded ones stay unavailable until fetched again; bundled ones are available at once |
| `POST /api/animate/drivings?name=<file>` | Upload a driving video (raw body) |
| `DELETE /api/animate/drivings/<id>` | Delete an upload, or hide an example for this install (its downloaded files are removed; a bundled example's files are kept) |
| `GET /api/animate/drivings/<id>/video`, `/poster` | Driving video (byte ranges) and poster |
| `GET /api/animate/jobs`, `POST /api/animate/jobs` | List jobs; start one: `{ "drivingId", "photoId", "routeId", "options"?, "margin"?, "confirmed": true }`. `photoId` is the character photo to animate (required: `400 photo_missing` without an existing one); the job records it with `characterId` and `characterLabel` (the character's name). `margin` = `none` / `normal` / `wide` (default: the route's `defaultMargin`; anything else is `400 bad_margin`); the job view echoes it (older jobs: `none`) |
| `GET /api/animate/jobs/<id>`, `POST .../cancel` | One job; cancel it |
| `GET /api/animate/jobs/<id>/result`, `/poster` | Result MP4 (byte ranges) and poster |
| `GET /api/animate/jobs/<id>/result?variant=keyed` | The transparent WebM (byte ranges); the job's `result.keyedUrl` points here, or is `null` when there is none (`result.keySkipped` = `not_key_color` / `not_uniform` (older jobs: `not_green`), or `result.keyFailed`); `keyColor` = `{ name, hex }` of the job's chroma-key background; `result.fit` = the keyed clip's character box (`null` when not keyed) |
| `POST /api/animate/jobs/<id>/motion` | Add the result as a motion of the job's photo: `{ "name"? }`. Adds the WebM (`video/webm`) when keyed, else the MP4; returns `{ motion, job, keyed, keyReason }`. The motion record carries the job's `photoId` and `fit` (`null` for an MP4); `409 photo_missing` when the photo was deleted |

`fit` (v1) is the character box measured from the alpha channel (pixels with alpha >= 128), from frame 0 plus frames sampled every 0.25 s, at most 256 px on the long edge:

```json
{ "v": 1, "width": 800, "height": 1136,
  "first": [0.0722, 0.0508, 0.9167, 0.9219], "union": [0, 0, 1, 1],
  "touches": { "left": true, "right": true, "top": true, "bottom": true } }
```

`width` / `height` are the source frame size; `first` (first frame) and `union` (all sampled frames) are `[x0, y0, x1, y1]` normalized to 0..1 (x1/y1 exclusive); `touches` says which frame edges the union reaches (within max(2 px, 1 %)). `fit: null` means measured and not applicable (MP4, JPEG, an opaque WebM, nothing opaque); a record with no `fit` key has not been measured yet. It is stored on library motions, on `library.idle` and the photos' `idles`, on photos (and their cutouts), and on keyed jobs (`result.fit`).

The character photos are stored in `data/characters/` (see [Data layout](#data-layout)); the old single character library of `data/animate/characters/` is migrated once and no longer used. Jobs made before characters existed name their photo in `characterId`.

Job states: `queued`, `preparing`, `submitting`, `running`, `downloading`, `keying`, `succeeded`, `failed`, `canceled`. Every change is also sent on `/api/events` as `{ "type": "animate-job", "job": ... }`. Jobs are kept in `data/animate/jobs/` and survive a restart: a job that was generating resumes polling, and a job cut off while submitting is marked failed (`interrupted`) rather than submitted twice.

## Upload a finished motion (완성된 영상 올리기)

On the 동작 만들기 page, **완성된 영상 올리기** adds a video you made yourself as a motion of the chosen photo. Pick or drop one WebM, MP4 or MOV file (up to 500 MB and 60 seconds), name it — the default is the file name without its extension; the field suggests the preset labels, and a preset name such as `원영턴` puts the video on that preset's button on the 방송 화면 — and press **동작으로 추가하기**. The page shows the upload progress, then what happened to the background, and plays the stored clip.

The server processes the video before it answers (short clips take seconds) and always stores a file a browser can play (`lib/animate/motion-upload.js`):

1. ffprobe must find a video stream in WebM/Matroska or MP4/MOV, else `415 unsupported_video`; a video longer than 60 s is `400 too_long`.
2. A video with its own alpha channel (WebM VP8/VP9 flagged `alpha_mode=1`, or a `yuva`/`rgba`/`argb` pixel format such as ProRes 4444, QuickTime Animation or PNG in MOV) stays transparent: a WebM is kept as it is, anything else becomes a VP9 `yuva420p` WebM with the keyed job result's encoder settings. The page says **투명 배경 그대로 추가했습니다**.
3. Otherwise the background is keyed like a job result (`lib/animate/key.js` border detection), trying green, then blue, then magenta; the first uniform key colour wins. The page says **배경을 지웠습니다 (#RRGGBB)** with the detected colour.
4. Otherwise it stays opaque: an MP4 H.264 (yuv420p) or a WebM VP8/VP9 is kept as it is, anything else becomes an H.264 yuv420p MP4 (`+faststart`). The overlay shows it with its background; the page says **배경이 있는 채로 추가됨** and why, from `keyReason`: `not_uniform` (the border is not one colour), `not_key_color` (one colour, but not green, blue or magenta), `unreadable` or `key_failed`.

The motion's `fit` is measured from the stored file. The stored record is `{ id, name, kind: "motion", mime, url, createdAt, photoId, source: { upload: { filename, alpha, keyed, keyColor, keyReason } }, fit }`. Temporary files are always removed, and a failed upload leaves no record. The older `POST /api/upload` (see [Add clips](#add-clips)) still works for scripts; it adds to the photo on air.

## Character API

The pages use these routes; with login on they need a login, like every page. JSON bodies need `Content-Type: application/json`; photo and video uploads send the raw file as the request body. Errors are JSON `{ "error": "<Korean text>", "code" }`.

| Method and path | Purpose |
|---|---|
| `GET /api/characters` | `{ characters, activePhotoId, activeCharacterId }`. Characters oldest first: `{ id, name, createdAt, basePhotoId, onAir, photos }`. Photos base first, then oldest first: `{ id, url, displayUrl, cutout, width, height, hasAlpha, createdAt, isBase, onAir, idle, motionCount, motions: [{ id, name, mime, createdAt }] }` — `url` is the original file, `displayUrl` what OBS shows (the cutout when `cutout` is true), `idle` is `photo` or `upload` (an idle uploaded for it) |
| `POST /api/characters?name=<name>&filename=<file>` | Create a character with its base photo (raw body). `201 { character, ...list }` |
| `PATCH /api/characters/<id>` | Rename: `{ "name" }`. `200 { character, ...list }` |
| `DELETE /api/characters/<id>` | Delete it with its photos and every motion and idle of those photos, files included. `200 { ...list }` |
| `POST /api/characters/<id>/photos?filename=<file>` | Add a photo (raw body). `201 { photo, character, ...list }` |
| `DELETE /api/characters/<id>/photos/<photoId>` | Delete a photo with its motions and idle; the only photo is `409 last_photo`; a deleted base photo passes to the oldest remaining one. `200 { character, ...list }` |
| `PUT /api/characters/<id>/base` | Make a photo the base photo: `{ "photoId" }`. `200 { character, ...list }` |
| `POST /api/characters/<id>/photos/<photoId>/motions?name=<name>&filename=<file>` | Upload a finished motion (raw body, see [above](#upload-a-finished-motion-완성된-영상-올리기)). `201 { motion, keyed, keyReason, character, ...list }` |
| `PUT /api/active-photo` | Put a photo on air: `{ "photoId": "<photoId>" }`, or `{ "photoId": null }` for none. `200 { activePhotoId, activeCharacterId, library }` (the new library view) |

`...list` stands for `characters, activePhotoId, activeCharacterId`. Deleting the photo on air, or its character, takes it off air.

**Library view.** `GET /api/library` and the `{ "type": "library", "library" }` message on `/api/events` carry `{ idle, motions, character, photo }`: with a photo on air, `idle` is the idle uploaded for it, else the photo itself (`url` = its cutout or its file, `source: { photoId }`), `motions` are that photo's motions, `character` is `{ id, name }` and `photo` is `{ id, url, width, height, hasAlpha }`; with nothing on air, `idle` is the old library idle (`null`: the demo avatar), `motions` are the motions without a photo, and both others are `null`. It is broadcast whenever it may change: the photo on air changes, a motion is added or deleted, a photo or character is deleted, an idle is uploaded, or the character on air is renamed. `POST /api/trigger` accepts `demo` or a motion of the current view (else `404`). `GET /api/media/<id>` serves library items and, by photo id, the photos (`?variant=cutout` for a cut-out photo's PNG); `DELETE /api/media/<id>` removes motions and idles only (photos go through the character API).

| `code` | Status | `error` |
|---|---|---|
| `name_missing` | 400 | 캐릭터 이름을 입력해 주세요. |
| `name_too_long` | 400 | 캐릭터 이름은 40자까지 쓸 수 있습니다. |
| `photo_missing` | 404 (400 on `POST /api/animate/jobs` and for a `photoId` that is not a string, 409 when adding a job result) | 사진을 찾을 수 없습니다. |
| `character_missing` | 404 | 캐릭터를 찾을 수 없습니다. |
| `unsupported_image` | 415 | PNG, JPEG, WebP 사진만 올릴 수 있습니다. |
| `too_large` | 413 | 사진은 20MB까지 올릴 수 있습니다. |
| `last_photo` | 409 | 사진이 하나뿐인 캐릭터는 캐릭터를 삭제해 주세요. |
| `too_many_characters` | 409 | 캐릭터는 50개까지 만들 수 있습니다. |
| `too_many_photos` | 409 | 사진은 캐릭터마다 30장까지 올릴 수 있습니다. |
| `unsupported_video` | 415 | WebM, MP4, MOV 영상만 올릴 수 있습니다. |
| `too_long` | 400 | 영상은 60초까지 올릴 수 있습니다. |
| `too_large_video` | 413 | 영상은 500MB까지 올릴 수 있습니다. |

## Data layout

Everything lives in `data/` (Git-ignored):

- `data/characters/index.json` — `{ "v": 1, "activePhotoId", "characters" }`, written atomically (temporary file + rename). A character is `{ id: "c-<uuid>", name, createdAt, basePhotoId, photos }`; a photo is `{ id: "ph-<uuid>" (a migrated one keeps its "ch-<uuid>"), filename, mime, width, height, hasAlpha, createdAt, fit, cutout }`, where `cutout` is `{ "cut": true, "color", "fit" }` or `{ "cut": false, "reason": "has_alpha" | "not_uniform" | "no_subject" }` (absent: not decided yet, retried at startup).
- `data/characters/photos/` — `<photoId>.png` / `.jpg` / `.webp`, and `<photoId>.cutout.png` for a photo whose plain background was cut out.
- `data/library.json` — `{ idle, motions, idles }`. Every motion has a `photoId` (`null`: no photo, shown only while nothing is on air); `idles` maps a photo id to the idle uploaded for that photo; `idle` is the old library idle, shown only while nothing is on air.
- `data/media/` — the motion and idle files (`<id>.webm`, `.mp4`, `.png` or `.webp`).
- `data/animate/` — the 동작 만들기 settings, driving videos and jobs.

**One-time migration.** At the first start with characters (while `data/characters/index.json` does not exist), every photo of the old character library (`data/animate/characters/index.json`, its file present) becomes its own character named `캐릭터 1`, `캐릭터 2`, … (by creation time) with that photo as its base photo and the same id. The files are copied; the old folder is left untouched. The old selection, else the first photo, goes on air. Each motion gets the photo of the job it came from, else the photo on air, so nothing disappears (without photos, motions keep no photo), and the old idle becomes the idle of the photo on air. `index.json` is written last, so an interrupted migration runs again at the next start; the server logs `[characters] migrated N photo(s)`.

## Add clips

Motion clips and the idle asset can also be added with `POST /api/upload`, sending the raw file as the request body. An upload goes to the photo on air: a motion becomes one of its motions, and an idle replaces the photo as its idle image (a previous idle uploaded for it is deleted). With nothing on air, a motion belongs to no photo and an idle replaces the old library idle. The display name is the file name without its extension, so `wink.webm` becomes a motion named `wink`, which links to the **윙크** button. Each upload's `fit` (see [Animate API](#animate-api)) is measured before it is saved; records saved by an older version are measured in the background once the server is listening (startup is not delayed) and the library is broadcast once when they are done.

```bash
# Motion clip (transparent WebM)
curl -H 'Content-Type: video/webm' --data-binary @wink.webm \
  'http://127.0.0.1:8787/api/upload?kind=motion&name=wink.webm'

# Idle asset (looping WebM, or PNG/WebP image); replaces the idle of the photo on air
curl -H 'Content-Type: image/png' --data-binary @idle.png \
  'http://127.0.0.1:8787/api/upload?kind=idle&name=idle.png'

# The library view: the photo on air, its idle and its motions (with ids)
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

- **Idle:** usually the photo on air itself (see [Characters and photos](#characters-and-photos)). An uploaded idle is one transparent WebM video that loops, or a transparent PNG/WebP image.
- **Motions:** individually named transparent WebM clips, each played once per trigger. Finished videos uploaded on the 동작 만들기 page may also be MP4/MOV with a transparent or plain key-colour background (see [Upload a finished motion](#upload-a-finished-motion-완성된-영상-올리기)). MP4 motions without transparency play the same way, with their background.
- Use the same canvas size and character position across idle and motion clips for a clean transition. Put the character on a transparent background before encoding; changing the file extension to `.webm` does not create transparency.

For example, if `input.mov` already contains an alpha channel, FFmpeg can encode a transparent VP9 WebM:

```bash
ffmpeg -i input.mov -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -an output.webm
ffprobe -v error -select_streams v:0 -show_entries stream_tags=alpha_mode -of default=nw=1 output.webm
```

The second command should show `TAG:alpha_mode=1`. We verified this encoding path with a generated transparent clip; still check its actual appearance in your OBS setup.

## Scope and limitations

The PoC uses a local HTTP server and server-sent events to synchronize the controller, preview, and OBS Browser Source. It keeps one shared set of characters and motions; the optional Google login only admits allowlisted accounts, which all share them (no per-user libraries or roles). It does not include remote viewer triggers, live AI generation, background removal, or a broadcasting platform. Browser playback and the transparent page background were tested locally; OBS scene rendering and long-running performance with many clips still need live validation.

Run `pnpm test` for API, login, media-range, persistence, port rotation, and event-stream checks. The animate tests use the mock route, local fixture servers and ffmpeg-generated clips; they never call a provider. The login tests use a local fake Google; they never call Google.
