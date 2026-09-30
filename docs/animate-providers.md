# Animate provider adapters

The "동작 만들기" page (`/animate`) sends a driving video and a character image to one of the
routes below and shows the returned MP4. How the pipeline uses a route:

1. **preparing** — the character is placed on a plain key-colour canvas (transparent pixels take
   that colour; `#00FF00` unless the character has green in it, see
   [Background keying](#background-keying)) and fitted into the route's image limits; the driving video is re-encoded to H.264
   (long edge <= 1280, <= 30 fps, no audio) and trimmed to the route's maximum length.
2. **submitting** — both files are uploaded with the provider's own upload API (Kling direct
   relays the video through WaveSpeed/fal/Higgsfield, see below) and the job is submitted
   **once**; the provider task id is stored before polling starts.
3. **running** — the task is polled until it finishes. A server restart resumes polling.
4. **downloading** — the result MP4 is saved as the job result. It is **not** keyed: removing the
   background is a later feature. "동작으로 추가하기" copies the MP4 into the motion library.

Routes with a prompt field get the preset prompt for the driving video's `presetKey`
(`lib/animate/presets.js`), or a generic "same motion as the reference" prompt, plus the
configurable `promptSuffix`. Every non-mock route needs `confirmed: true` on
`POST /api/animate/jobs`; the page asks for it in a cost dialog.

Optional route fields for split-prompt models (used only by `wavespeed/wan-2.2-animate-2`; every
other route leaves them unset and its request body is unchanged):

- `fields.motionPrompt` — body path of a separate motion prompt. When set, the pipeline sends the
  preset prompt (or the generic one) plus `' Static camera, no zoom, no camera movement.'`
  (`presets.composeMotionPrompt`) there; the `promptSuffix` is not appended.
- `backgroundPrompt` — fixed text sent at `fields.prompt` instead of the composed preset prompt;
  `promptSuffix` is ignored. `{color}` / `{hex}` in it are replaced with the job's key colour.
  Animate 2 generates its output background from `prompt`, so it asks for a plain chroma-key
  background of that colour (`green (#00FF00)` by default).
- `pricing.roundUpSeconds` — bill the sent length rounded up to whole seconds before
  `minSeconds` applies (server `registry.estimateUsd` and the page's estimate both honour it).

`mock/local-demo` (provider `mock`, enabled with `VIRTUALLY_ANIMATE_MOCK=1` or
`createAppServer({ animateMock: true })`) is not AI and never uses the network: it renders the
prepared character bobbing over the job's key-colour canvas with ffmpeg for the driving video's length
(max 6 s).

Keys are stored in `data/animate/config.json` (mode 0600) or read from the environment variables
listed in the README. A test-only `baseUrl` can be written into that file by hand but never over
the API.

---

This document records, per provider, the protocol each adapter in `lib/animate/providers/`
implements, which endpoints and fields were **verified** against a primary source (with URLs),
and which are **unverified** — a route marked `verified: false` in `lib/animate/catalog.js`
carries at least one unconfirmed endpoint or field name.

All adapters share `lib/animate/http.js`:

- `ProviderError { message (English, secret-free), status, retryable, code }`. `429`/`5xx`/
  network/timeout are retryable; other `4xx` are not.
- `fetchRaw` / `fetchJson` bound every request with a timeout and honour `ctx.signal`. Error
  messages are scrubbed of URLs, `oss://` URIs, absolute paths, and any ≥16-char opaque token.
- `downloadToFile` streams to a `.part` tmp file then renames; **https-only unless
  `ctx.allowInsecure`**; enforces a **1 GB cap** on both `Content-Length` and streamed bytes; and
  attaches a provider auth header **only** when the URL host equals the provider's own API host.

Adapter `ctx = { credentials, settings, fetch, baseUrl, signal, log, allowInsecure }`. A test-only
`baseUrl` starting with `http://` sets `allowInsecure: true`. No npm dependencies are used
anywhere (global `fetch`/`FormData`/`Blob`, Node `crypto`/`fs`).

Verification used the vendors' public docs and the research notes from 2026-09-27.

**Removed 2026-09-30:** every Wan 2.2 Animate (v1) route — `wavespeed/wan-2.2-animate`,
`fal/wan-2.2-animate-move`, `replicate/wan-2.2-animate-animation` and
`dashscope/wan2.2-animate-move` — and the `wan-animate` family. DashScope (Alibaba Model Studio)
had no other route, so its adapter, key panel entry and `DASHSCOPE_API_KEY`/`DASHSCOPE_REGION`
variables were removed too. Wan 2.2 Animate 2 stays the default. A saved config that still names a
removed route or stores a DashScope key loads normally (the entry is ignored and the first
available route becomes the default), and old jobs on a removed route still list, view and serve
their result; one still polling a removed route ends as failed.

---

## WaveSpeed (`wavespeed.js`)

**Protocol.** Base `https://api.wavespeed.ai/api/v3`; auth `Authorization: Bearer <apiKey>`.
Upload is a two-step ticket: `POST /media/uploads {filename,size,content_type}` returns
`data.upload.{method,url,headers}` + `data.download_url`; PUT the bytes to the opaque signed URL
**with no Authorization header**, then use `download_url` as the model input. Submit is
`POST /{endpoint}` with the canonical body; poll `GET /predictions/{id}/result` →
`data.status` ∈ `created|processing|completed|failed|cancelled|timeout|deleted`, output at
`data.outputs[0]`. Outputs are public (`publicUploads: true`, ~7-day TTL). No documented cancel
endpoint → `cancel: null`.

**Status map:** created→queued, processing→running, completed→succeeded, failed/timeout/deleted→
failed, cancelled→canceled.

**Verified:** base/auth, upload API (endpoint, request/response, 200 MB / 7-day TTL), submit/poll
shape, output URL location; Wan 2.2 Animate 2 + DreamActor V2 input schemas &
pricing; Kling v3 std motion-control model path.

**Wan 2.2 Animate 2** (`wavespeed-ai/wan-2.2/animate-2`, the default route): body `image`, `video`,
`prompt` (character looks + output background), `motion_prompt`, `resolution` `480p|720p`
(API default 480p; we send 720p unless chosen), optional `seed`; **no `mode` field**. The image's
and the driving video's backgrounds are ignored — the background comes from `prompt`. Output is
30 fps and follows the driving video's duration and aspect ratio; driving up to 120 s, no input
minimum. Billing: duration rounded up to whole seconds, clamped 3-120 s; 480p $0.04/s, 720p
$0.08/s.
Sources: <https://wavespeed.ai/docs/submit-task>, <https://wavespeed.ai/docs/upload-files-api>,
<https://wavespeed.ai/docs/what-are-predictions>,
<https://wavespeed.ai/docs/docs-api/wavespeed-ai/wan-2.2-animate-2>,
<https://wavespeed.ai/docs/docs-api/bytedance/bytedance-dreamactor-v2>,
<https://wavespeed.ai/kling-3-motion-control-api>.

**Unverified:** the Kling **pro** WaveSpeed path (only the std path was confirmed → the pro route
is omitted, not shipped as verified:false); Kling route full field defaults; exact output
codec/container; watermark behaviour.

---

## Replicate (`replicate.js`)

**Protocol.** Base `https://api.replicate.com/v1`; auth `Authorization: Bearer <apiToken>`.
Upload `POST /files` (multipart field `content`) → a hosted file URL (`urls.get`). Submit resolves
the community version with `GET /models/{owner}/{name}` → `latest_version.id`, then
`POST /predictions {version:"owner/name:VERSION", input}`; if the model has no version it falls back
to the official-model route `POST /models/{owner}/{name}/predictions {input}`. Poll
`GET /predictions/{id}` → `status` ∈ `starting|processing|succeeded|failed|canceled`, `output`
(single URI string or array → first). Cancel `POST /predictions/{id}/cancel`. Output files are
served from `replicate.delivery` and **need the Authorization header** — `download()` scopes the
token to that host only. Prediction data is auto-removed ~1 h after an API run.

**Status map:** starting→queued, processing→running, succeeded→succeeded, failed→failed,
canceled→canceled.

**Verified:** base/auth; create (both community + official paths), `Prefer: wait`,
`Cancel-After`, poll, cancel; 1-hour data retention; rate limits; delivery-host auth requirement;
Kling v3 motion-control and DreamActor M2.0 input schemas.
Sources: <https://replicate.com/docs/reference/http>,
<https://replicate.com/docs/topics/predictions/input-files>,
<https://replicate.com/kwaivgi/kling-v3-motion-control>,
<https://replicate.com/bytedance/dreamactor-m2.0>.

**Unverified:**
- **Files API exact request/response/TTL.** `POST /v1/files` is not on the public HTTP-API
  reference page (it is wrapped by the SDK); the multipart field name `content` and the
  `urls.get` response field are taken from the SDK's documented behaviour, not a primary HTTP doc.
  The adapter also accepts `url` / `download_url` response shapes defensively.

---

## fal.ai (`fal.js`)

**Protocol.** Queue base `https://queue.fal.run/{model-id}`; auth `Authorization: Key <apiKey>`.
Upload without the SDK: `POST https://api.fal.ai/v1/serverless/files/file/upload-local`
(multipart field `file_upload`) → a public `fal.media` URL. Submit `POST {queue}/{model-id}` →
`{request_id,status_url,response_url,cancel_url}`; poll `GET {status_url}` →
`status` ∈ `IN_QUEUE|IN_PROGRESS|COMPLETED` (+ `error`/`error_type` on a completed-but-failed run);
on success `GET {response_url}` → `video.url`. Cancel `PUT {cancel_url}`. Outputs are public.

**Status map:** IN_QUEUE→queued, IN_PROGRESS→running, COMPLETED→succeeded (or failed when the
completed payload carries `error`/`error_type`; `nsfw`/safety `error_type` → `moderated`).

**Verified:** queue base/auth, submit/poll/result/cancel lifecycle, `fal.media` output;
DreamActor V2, Kling v3 std/pro + v2.6 pro motion-control endpoint ids and their
`image_url`/`video_url`/`character_orientation`/`keep_original_sound` fields.
Sources: <https://docs.fal.ai/model-endpoints/queue>,
<https://fal.ai/models/fal-ai/bytedance/dreamactor/v2/api>,
<https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control/api>,
<https://fal.ai/docs/platform-apis/v1/serverless/files/file/upload-local>.

**Unverified:** the exact success-response field of the REST `upload-local` endpoint (the adapter
accepts `access_url`/`url`/`file_url`/`data.url`); per-model pricing; concurrency limits; output
codec/fps.

---

## Higgsfield (`higgsfield.js`)

**Protocol.** Base `https://api.higgsfield.ai`; auth `Authorization: Key <apiKeyId>:<apiKeySecret>`.
Presigned upload: `POST /files/generate-upload-url {content_type}` →
`{public_url, upload_url, upload_headers}`; PUT the bytes to `upload_url` **sending every header in
`upload_headers`** (e.g. `x-amz-tagging: retention=temporary`) and no Higgsfield credentials; use
`public_url` as the model input. Submit `POST /{endpoint}` →
`{status:"queued", request_id, status_url, cancel_url}`; poll `GET {status_url}` → terminal
`completed|failed|nsfw|canceled`, `completed` → `video.url`. Cancel `POST {cancel_url}`.

**Status map:** queued→queued, in_progress/processing→running, completed→succeeded,
failed/nsfw→failed (nsfw → `moderated`), canceled→canceled.

**Verified:** base/auth (two-part key), presigned upload flow + `upload_headers` requirement,
submit/poll lifecycle + terminal states, Kling v3 motion-control std/pro endpoint ids and their
`image_url`/`video_url`/`character_orientation`/`keep_original_sound` ("yes"/"no") fields, input
limits, error envelope.
Sources: <https://docs.higgsfield.ai/docs/authentication>,
<https://docs.higgsfield.ai/docs/concepts/file-uploads.md>,
<https://docs.higgsfield.ai/docs/models/kling-3-motion-control/pro.md>,
<https://docs.higgsfield.ai/docs/concepts/polling.md>,
<https://docs.higgsfield.ai/docs/concepts/errors.md>.

**Unverified:** the exact **Kling v2.6** motion-control path on Higgsfield (family page confirms
Pro+Std exist; the precise path segment was not confirmed → no v2.6 Higgsfield route is shipped);
DreamActor is **absent** from Higgsfield's catalog (use fal); fixed pricing (Higgsfield exposes an
`/estimate` endpoint instead); output codec/fps; watermark behaviour.

---

## Kling direct (`kling.js`)

**Protocol.** Region base: `global` → `https://api-singapore.klingai.com`, `cn` →
`https://api-beijing.klingai.com`. **Two auth regimes are supported:** the classic Access/Secret
JWT (HS256 over `{ iss: accessKey, exp: now+1800, nbf: now-5 }`, header `{alg:HS256, typ:JWT}`,
sent as `Authorization: Bearer <jwt>`) and a newer static API key (`Authorization: Bearer <apiKey>`).
The adapter prefers the API key when configured, else mints a JWT. There is **no video upload API**:
`upload()` returns a base64 data URI for images (≤10 MB) and throws
`ProviderError{ code:'needs_public_url' }` for videos, so the pipeline routes the reference video
through the media relay. Submit `POST /v1/videos/motion-control` (JSON with `model_name`, `image`,
`video`, `mode`, `character_orientation`, `keep_original_sound`); Kling wraps business errors in a
non-zero `code` even on HTTP 200. Poll `GET /v1/videos/motion-control/{task_id}` →
`data.task_status` ∈ `submitted|processing|succeed|failed`, output at
`data.task_result.videos[0].url` (~30-day TTL).

**Status map:** submitted→queued, processing→running, succeed/succeeded→succeeded, failed→failed;
poll `code != 0` → failed unless the code is transient (`1302`, `5000–5099`) which maps to running.

**Verified:** JWT signing mechanics (HS256, `iss`/`exp`/`nbf`); region base URLs; the
motion-control body params (`character_orientation`, `mode`, `keep_original_sound`); video-URL-only
/ no-upload-API; input limits; per-second unit pricing & `NCon` concurrency; 30-day URL retention;
poll envelope; the `1002`/`1201`/`1302`/`1303` error codes.
Sources: <https://github.com/aself101/kling-api>,
<https://github.com/199-mcp/mcp-kling/blob/main/kling-api-docs.md>,
<https://docs.aimlapi.com/api-references/video-models/kling-ai/video-v2.6-pro-motion-control>,
<https://blogs.novita.ai/kling-v3-0-motion-control-novita-ai/>.

**Unverified (both `kling/*` routes are `verified: false`):**
- The **exact create path segment** for motion-control (`/v1/videos/motion-control` vs
  `/v1/videos/motion2video` vs the new `path-per-model` shape) and **which auth regime the live
  endpoint uses today** — the classic API accepts AK/SK JWT, but the newer path-per-model standard
  is reported to reject it with `1002 "The current API does not support AK/SK"` and require a
  static API key. Supporting both is why the adapter accepts either credential set. Confirm against
  the `app.klingai.com` console with a real key before shipping.
- Native body key names (`image` vs `image_url`); video max-size hard cap; whether a flat green
  background survives generation; fps; watermark default.

---

## Route verification summary (`lib/animate/catalog.js`)

| Route id | verified |
|---|---|
| `wavespeed/wan-2.2-animate-2` | true |
| `wavespeed/dreamactor-v2` | true |
| `fal/dreamactor-v2` | true |
| `replicate/dreamactor-m2.0` | true |
| `wavespeed/kling-v3-motion-control-std` | true |
| `fal/kling-v3-standard-motion-control` | true |
| `fal/kling-v3-pro-motion-control` | true |
| `fal/kling-v2.6-pro-motion-control` | true |
| `replicate/kling-v3-motion-control` | true |
| `higgsfield/kling-v3-motion-control-std` | true |
| `higgsfield/kling-v3-motion-control-pro` | true |
| `kling/v3-motion-control` | **false** (path + auth regime unconfirmed) |
| `kling/v2.6-motion-control` | **false** (path + auth regime unconfirmed) |

`keepsImageBackground` is `false` for Wan 2.2 Animate 2 (it generates the background from its
prompt) and `true` for all DreamActor and all Kling motion-control routes (docs claim the image
background is kept). In every case pixel-exact #00FF00 survival under motion is unverified; it matters for the later
background-removal feature, not for viewing or adding results today.

## Background keying

After `downloading`, the pipeline enters `keying` (`lib/animate/key.js`) and turns `result.mp4`
into a transparent `result.webm` in the job directory. It never fails a job: on a skip or an
ffmpeg error the MP4 stays the result and `job.result.keyed = null` with `keySkipped` (reason) or
`keyError` (message). A cancel during keying kills ffmpeg and cancels the job as usual; a restart
during keying re-runs only the keying.

The key colour is chosen automatically per job (`lib/animate/key-color.js`), when the job is
created, from the source character image: green `#00FF00`, else blue `#0000FF`, else magenta
`#FF00FF`. The image is decoded to RGBA at most 128 px; pixels with alpha >= 128 count (all
pixels when none do). A pixel conflicts with a candidate when (a) its RGB distance to the pure
candidate is < 200 — colorkey 0.30 / 0.12 is fully opaque only from
`(0.30 + 0.12) * sqrt(3) * 255` = 185.5 (measured: alpha 0 up to ~132, 42 at 141, 178 at 170,
253 at 185), plus a margin for a rendered key colour that is not exactly pure — or (b) the
candidate's despill would change it by more than 40 (green lowers G by `g - (r + b) / 2`, blue
lowers B by `b - (r + g) / 2`; magenta has no despill), which catches e.g. bright yellow, far from
green but turned orange by green despill. The first candidate whose conflict share is below 0.5 %
wins; otherwise the smallest share. It is stored as `job.keyColor = { name, hex }` (jobs without it are green)
and used for the character canvas, the mock canvas, Animate 2's background prompt, the default
`promptSuffix` wording (only while the config still holds the default) and keying. With green,
every request body and keyed output is the same as before the colour was chosen. The page notes
a blue / magenta background on the job card.

Detection (the colour is measured, never hardcoded):

- 8 border patches — 4 corners and 4 edge midpoints, 16x16 px (smaller on tiny frames) — at 5
  timestamps spread over the clip, each averaged to one RGB value: 40 samples.
- The per-channel median is the key colour when at least 75 % of the samples lie within RGB
  distance 40 of it and it lies within RGB distance 100 of the job's key colour. Otherwise the
  clip is skipped with `not_uniform` or `not_key_color` (older jobs may carry `not_green`).

Keying (measured on a real Animate 2 result, 800x1136, 2.97 s: clean edges, 1.1 MB, ~4.9 s):

```
-vf "format=rgba,colorkey=0x<RRGGBB>:0.30:0.12,despill=type=green:mix=0.5:expand=0,format=yuva420p"
-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 -row-mt 1 -an
```

`despill=type=blue:mix=0.5:expand=0:green=0:blue=-1` for a blue key colour (despill's `green` /
`blue` options default to -1 / 0 for either type, so `type=blue` alone would subtract the spill
from the green channel: `[100,150,200]` -> `[100,75,200]` instead of `[100,150,125]`); no despill for magenta (ffmpeg's despill only has green
and blue). Only the green filter was measured on a real result; blue and magenta were checked on
the mock route only.

Written to a tmp file and renamed; timeout `max(120 s, 10 x duration)`. `chromakey` without
despill was rejected (green/teal fringe on every edge). The alpha plane only decodes with the
libvpx decoder (`ffmpeg -c:v libvpx-vp9 -i x.webm`); ffmpeg's native vp9 decoder drops it.
Browsers and OBS play it with alpha.

## Contract notes / open risks

- **Stub metas kept as seeded.** No provider id, credential key, env-var name, `credentialSets`,
  `needsPublicVideoUrl`, or `publicUploads` value was changed from the seeded stubs.
- **`buildRequest` applies `sound.off` whenever a route defines a `sound` field**, because every
  animate preset is a silent overlay. The spec lists sound as "if set"; there is no code path that
  keeps audio, which matches the product intent. If a future caller needs to keep audio, add a
  `sound` argument to `buildRequest`.
- **Kling media relay dependency.** The `kling/*` routes have `needsPublicVideoUrl: true`; without a
  configured relay (WaveSpeed/fal/Higgsfield) the route is listed as unavailable with
  `unavailableCode: "no_media_relay"`.
- **Replicate Files API** is the remaining Replicate primary-source gap; it is marked and handled
  defensively in code.
