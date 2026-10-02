'use strict';

// Animate page (동작 관리): one character at a time, picked in the strip at
// the top (GET /api/characters). Shows that character's photos, motions (which
// one loops as the idle, delete) and results, and adds motions to the chosen
// photo: run an AI animate route with a driving video and add a result, or
// upload a finished video.
// All names and labels are user or provider data: the DOM is built with
// createElement/textContent only, never from HTML strings.

const AnimateHelpers = (() => {
  const motions = typeof window !== 'undefined' && window.VirtuallyMotions
    ? window.VirtuallyMotions
    : require('./motions.js');
  // The shared credit formula (credits.js, loaded before this script). Without it the
  // page cannot price anything in credits (prices then read 가격 정보 없음).
  const credits = typeof window !== 'undefined' ? window.VirtuallyCredits || null : require('./credits.js');

  const JOB_STATE_LABELS = Object.freeze({
    queued: '대기',
    preparing: '준비',
    submitting: '전송',
    running: '생성 중',
    downloading: '받는 중',
    keying: '배경 지우는 중',
    succeeded: '완료',
    failed: '실패',
    canceled: '취소',
  });
  const ACTIVE_STATES = new Set(['queued', 'preparing', 'submitting', 'running', 'downloading', 'keying']);

  // API error code -> short Korean text. Unknown codes fall back to the server message.
  const ERROR_TEXT = Object.freeze({
    unknown_route: '알 수 없는 모델입니다',
    route_unavailable: '지금 쓸 수 없는 모델입니다',
    no_credentials: '서버에 이 모델의 설정이 없습니다. 운영자에게 알려 주세요',
    no_media_relay: '서버에 영상 업로드 설정이 없습니다. 운영자에게 알려 주세요',
    character_missing: '캐릭터 이미지가 없습니다',
    driving_missing: '동작 영상이 없습니다',
    driving_unavailable: '예시 영상을 먼저 받아 주세요',
    driving_too_long: '영상이 모델 제한보다 깁니다',
    driving_too_short: '영상이 모델 최소 길이보다 짧습니다',
    ffmpeg_unavailable: 'ffmpeg가 필요합니다',
    not_confirmed: '확인이 필요합니다',
    fetch_in_progress: '이미 받는 중입니다',
    not_ready: '아직 완료되지 않았습니다',
    already_added: '이미 추가했습니다',
    interrupted: '서버 재시작으로 중단됐습니다',
    timeout: '시간 초과',
    canceled: '취소됐습니다',
    moderation: '콘텐츠 정책에 걸렸습니다',
    upload_failed: '파일 업로드 실패',
    submit_failed: '생성 요청 실패',
    generation_failed: 'AI 생성 실패',
    download_failed: '결과 받기 실패',
    not_refetchable: '다시 받을 수 없는 작업입니다',
    result_expired: '결과 보관 기간이 지나 받을 수 없습니다',
    insufficient_credits: '크레딧이 부족합니다',
    price_unknown: '이 모델은 가격 정보가 없어 크레딧으로 만들 수 없습니다',
    billing_misconfigured: '결제 설정에 문제가 있어 지금은 만들 수 없습니다',
  });

  /** Korean text for an API error `{ code, error|message, detail }`. */
  function errorText(error) {
    if (!error || typeof error !== 'object') return '알 수 없는 오류';
    const code = typeof error.code === 'string' ? error.code : null;
    if (code === 'route_unavailable' && error.detail && ERROR_TEXT[error.detail.unavailableCode]) {
      return ERROR_TEXT[error.detail.unavailableCode];
    }
    if (code === 'driving_too_short' && error.detail) {
      const text = tooShortText(error.detail.duration, error.detail.minSec);
      if (text) return text;
    }
    if (code === 'insufficient_credits' && error.detail) {
      const text = insufficientText(error.detail.needed, error.detail.balance);
      if (text) return text;
    }
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
    const message = typeof error.error === 'string' ? error.error : error.message;
    return typeof message === 'string' && message ? message : '알 수 없는 오류';
  }

  /**
   * The character API's error text: its own Korean `error` (every code it
   * sends has one, e.g. 캐릭터를 찾을 수 없습니다.), else errorText.
   */
  function serverErrorText(error) {
    const text = typeof error?.error === 'string' ? error.error.trim() : '';
    return text || errorText(error);
  }

  /** Options a route actually exposes as selects (fixed value lists only). */
  function selectableOptions(route) {
    return (Array.isArray(route?.options) ? route.options : [])
      .filter(o => o && typeof o.key === 'string' && Array.isArray(o.values) && o.values.length > 0);
  }

  /** The chosen option values for a route: `chosen` where valid, else each default. */
  function effectiveOptions(route, chosen = {}) {
    const out = {};
    for (const option of selectableOptions(route)) {
      const value = chosen[option.key];
      out[option.key] = option.values.includes(value)
        ? value
        : (option.values.includes(option.default) ? option.default : option.values[0]);
    }
    return out;
  }

  /** USD estimate for `seconds` of video, mirroring the server's registry.estimateUsd. Null if unknown. */
  function estimateUsd(route, seconds, options = {}) {
    const pricing = route?.pricing;
    if (!pricing || typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    let rate = pricing.usdPerSecond;
    if (pricing.byOption) {
      for (const [key, table] of Object.entries(pricing.byOption)) {
        const value = options[key];
        if (value != null && table && table[value] != null) rate = table[value];
      }
    }
    if (!Number.isFinite(rate)) return null;
    // Routes billed per started second round up before the floor (mirrors the server).
    const counted = pricing.roundUpSeconds ? Math.ceil(seconds - 1e-9) : seconds;
    const billed = Math.max(Number(pricing.minSeconds) || 0, counted);
    return Number((rate * billed).toFixed(4));
  }

  // ---- Credits (GET /api/billing, via window.VirtuallyBilling from auth.js) ----
  // Prices are credits in every billing mode (1 credit = 1 KRW); the dollar model cost is never shown.

  /** A credit count as every page shows it: '1,234', '-50'; '' when it is not a number. */
  function formatCredits(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR') : '';
  }

  /** True when paid jobs take credits from this account: billing on and working. */
  function billingActive(billing) {
    return Boolean(billing && typeof billing === 'object' && billing.enabled === true
      && billing.mode === 'enabled');
  }

  /**
   * Credits for a USD estimate at the payload's creditsPerUsd (credits.js falls back to
   * its default without one, e.g. before GET /api/billing answers); null when unknown.
   */
  function creditsForEstimate(usd, billing) {
    if (!credits) return null;
    return credits.creditsFor(usd, billing && typeof billing === 'object' ? billing.creditsPerUsd : undefined);
  }

  /** '약 600 크레딧'; '가격 정보 없음' when unknown. */
  function priceText(usd, billing) {
    const needed = creditsForEstimate(usd, billing);
    if (needed == null) return '가격 정보 없음';
    return `약 ${formatCredits(needed)} 크레딧`;
  }

  /** A route's price: '무료' for the free route, '' until the driving length is known, else priceText. */
  function routeCostText(route, seconds, options, billing) {
    if (isFreeRoute(route)) return '무료';
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
    return priceText(estimateUsd(route, seconds, options), billing);
  }

  /** Credits a job on this route takes from this account, or null (free route, unknown price, billing not active). */
  function jobCredits(route, seconds, options, billing) {
    if (isFreeRoute(route) || !billingActive(billing)) return null;
    return creditsForEstimate(estimateUsd(route, seconds, options), billing);
  }

  /** The paid confirmation's credit line, or '' without both numbers. */
  function confirmCreditsText(needed, balance) {
    if (!Number.isFinite(needed) || !Number.isFinite(balance)) return '';
    return `${formatCredits(needed)} 크레딧이 차감됩니다 (보유 ${formatCredits(balance)}).`;
  }

  /** "크레딧이 부족합니다 (필요 40, 보유 12)", or '' without both numbers. */
  function insufficientText(needed, balance) {
    if (!Number.isFinite(needed) || !Number.isFinite(balance)) return '';
    return `크레딧이 부족합니다 (필요 ${formatCredits(needed)}, 보유 ${formatCredits(balance)})`;
  }

  /** A job row's "40 크레딧" / "40 크레딧 돌려받음": only for a charged job (billing record, known credits). */
  function jobCreditsText(job) {
    const billing = job?.billing;
    if (!billing || typeof billing !== 'object') return '';
    if (typeof billing.credits !== 'number' || !Number.isFinite(billing.credits)) return '';
    const text = `${formatCredits(billing.credits)} 크레딧`;
    return billing.refunded === true ? `${text} 돌려받음` : text;
  }

  /** True when `next` (a job update) shows a refund that `previous` (the same job before, if any) did not. */
  function refundTurnedOn(previous, next) {
    return next?.billing?.refunded === true && previous?.billing?.refunded !== true;
  }

  /** True for a job that took credits from this account and has not given them back. */
  function jobCharged(job) {
    const billing = job?.billing;
    return Boolean(billing && typeof billing === 'object' && billing.refunded !== true
      && typeof billing.credits === 'number' && Number.isFinite(billing.credits) && billing.credits > 0);
  }

  /**
   * The question before canceling a charged job: the credits come back only while
   * no provider task exists (billing.cancelRefund). '' for any other job (no question).
   */
  function cancelConfirmText(job) {
    if (!jobCharged(job)) return '';
    return job.billing.cancelRefund === true
      ? `취소하면 ${formatCredits(job.billing.credits)} 크레딧을 돌려받습니다. 취소할까요?`
      : '이미 생성이 시작되어 취소해도 크레딧은 돌려받지 못합니다. 취소할까요?';
  }

  /**
   * Credits a 다시 받기 of this job takes from the viewer: billing.refetchCredits (the
   * job's charge was given back, and a delivered result is paid once), 0 for
   * nothing. An unknown account (no GET
   * /api/billing answer yet) counts as paying.
   */
  function refetchChargeCredits(job, billing) {
    const needed = job?.billing?.refetchCredits;
    if (typeof needed !== 'number' || !Number.isFinite(needed) || needed <= 0) return 0;
    return needed;
  }

  /**
   * The question before 다시 받기 when it takes credits again, worded like the paid
   * confirmation's credit line. '' for no question (refetchChargeCredits is 0).
   */
  function refetchConfirmText(job, billing) {
    const needed = refetchChargeCredits(job, billing);
    if (!needed) return '';
    const line = confirmCreditsText(needed, billing?.balance) || `${formatCredits(needed)} 크레딧이 차감됩니다.`;
    return `다시 받으면 ${line}`;
  }

  /** A refused 다시 받기 on its job row: a short balance reads as it does for a new job. */
  function refetchErrorText(error) {
    const message = typeof error?.message === 'string' && error.message ? error.message : '알 수 없는 오류';
    return error?.code === 'insufficient_credits' ? message : `다시 받기 실패: ${message}`;
  }

  /** "2.5초" below 10 s (one decimal, no trailing .0), "12초" from 10 s, '' when unknown. */
  function formatSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const value = seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds);
    return `${value}초`;
  }

  // Same slack the server's createJob allows on both length limits.
  const LENGTH_TOLERANCE_SEC = 0.05;

  /** Longest driving video a route accepts, in seconds, or null. */
  function routeMaxSeconds(route) {
    const max = Number(route?.limits?.videoMaxSec);
    return Number.isFinite(max) && max > 0 ? max : null;
  }

  /** Shortest driving video a route accepts, in seconds, or null when it has no minimum. */
  function routeMinSeconds(route) {
    const raw = route?.limits?.videoMinSec;
    if (raw == null) return null;
    const min = Number(raw);
    return Number.isFinite(min) && min > 0 ? min : null;
  }

  /** "영상(2.5초)이 이 모델의 최소 길이(3초)보다 짧습니다", or '' without both lengths. */
  function tooShortText(drivingSeconds, minSeconds) {
    const length = formatSeconds(Number(drivingSeconds));
    const min = formatSeconds(Number(minSeconds));
    return length && min ? `영상(${length})이 이 모델의 최소 길이(${min})보다 짧습니다` : '';
  }

  /**
   * The server's verdict on a route (route view `free`: only the local demo route): no
   * paid confirmation, no `confirmed`, no credits and the price '무료'. Every other
   * route is paid, mock-provider custom routes included, and so is a route without
   * the flag (a server from before it).
   */
  function isFreeRoute(route) {
    return route?.free === true;
  }

  /**
   * How a route row behaves: `selectable` (radio enabled), `tooLong` / `tooShort`
   * (driving is outside the route's length limits, with the server's tolerance).
   */
  function routeState(route, drivingSeconds) {
    const max = routeMaxSeconds(route);
    const min = routeMinSeconds(route);
    const known = Number.isFinite(drivingSeconds);
    const tooLong = max != null && known && drivingSeconds > max + LENGTH_TOLERANCE_SEC;
    const tooShort = min != null && known && drivingSeconds < min - LENGTH_TOLERANCE_SEC;
    return {
      selectable: Boolean(route?.available),
      tooLong,
      tooShort,
    };
  }

  /** Routes grouped by familyLabel, groups and routes in server order. */
  /** { main: the WaveSpeed routes, others: every other service's }, order kept. */
  function splitRoutes(routes) {
    const list = Array.isArray(routes) ? routes : [];
    return { main: list.filter(route => route?.provider === 'wavespeed'), others: list.filter(route => route?.provider !== 'wavespeed') };
  }

  function groupRoutes(routes) {
    const groups = [];
    const byLabel = new Map();
    for (const route of Array.isArray(routes) ? routes : []) {
      const label = String(route?.familyLabel ?? route?.family ?? '');
      let group = byLabel.get(label);
      if (!group) {
        group = { familyLabel: label, routes: [] };
        byLabel.set(label, group);
        groups.push(group);
      }
      group.routes.push(route);
    }
    return groups;
  }

  /** Default name for a result added as a motion: 기본 대기 동작 for an idle loop, the preset label, else the driving label. */
  function defaultMotionName(job) {
    if (job?.idle === true) return motions.IDLE_MOTION_NAME;
    return motions.presetLabel(job?.presetKey) || String(job?.drivingLabel ?? '');
  }

  function timeValue(value) {
    const t = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  /** Insert or replace `job` (by id) and keep the list newest first. Returns a new array. */
  function upsertJob(jobs, job) {
    if (!job || typeof job.id !== 'string') return jobs;
    const next = jobs.filter(j => j.id !== job.id);
    next.push(job);
    next.sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt));
    return next;
  }

  /**
   * Whether a succeeded job counts as already added. `libraryIds` is a Set of the
   * current library motion ids, or null before the first library snapshot (then
   * any recorded motionId counts as added).
   */
  function isAdded(job, libraryIds) {
    if (!job?.motionId) return false;
    return libraryIds == null || libraryIds.has(job.motionId);
  }

  /** Whether a failed or canceled job shows 다시 받기 (the server's canRefetch decides). */
  function offersRefetch(job) {
    return (job?.state === 'failed' || job?.state === 'canceled') && job.canRefetch === true;
  }

  /**
   * The 다시 받기 button's tooltip, naming the job's provider. When the re-fetch takes
   * the given-back credits again (refetchChargeCredits), it says so instead of
   * promising no new cost.
   */
  function refetchTitle(job, billing) {
    const provider = `${job?.providerLabel || 'AI 서비스'}에 남아 있는 결과를 다시 받아 옵니다.`;
    const needed = refetchChargeCredits(job, billing);
    return needed
      ? `${provider} 돌려받은 ${formatCredits(needed)} 크레딧이 다시 차감됩니다.`
      : `${provider} 새로 만들지 않아 요금이 더 나가지 않습니다.`;
  }

  /**
   * One short note when a succeeded result could not be keyed (the original MP4
   * is used instead), else ''.
   */
  function keyNote(job) {
    const result = job?.result;
    if (result?.keyAiFailed) return 'AI 배경 제거에 실패해서 무료 방식으로 처리했습니다';
    if (result?.keyedUrl && result.keyMethod === 'plain') {
      return '배경이 요청한 색으로 나오지 않아, 가장자리와 이어진 배경만 지웠습니다(캐릭터가 감싼 틈은 남을 수 있습니다)';
    }
    if (!result || result.keyedUrl) return '';
    if (result.keySkipped === 'not_requested') return '영상 투명배경화를 건너뛰었습니다. 배경 제거하기로 나중에 지울 수 있습니다';
    if (result.keySkipped) return '배경이 한 가지 색이 아니라서 원본 영상을 그대로 씁니다';
    if (result.keyFailed) return '배경을 지우지 못해 원본 영상을 그대로 씁니다';
    return '';
  }

  /**
   * One short note when the job's chroma-key background is not green (the
   * character's colours would be keyed or despilled with green), else ''. Jobs without keyColor are green.
   */
  function keyColorNote(job) {
    const parts = [];
    if (job?.characterCutout) parts.push('캐릭터 이미지의 배경을 지우고 보냈습니다');
    const name = job?.keyColor?.name;
    if (name === 'blue') parts.push('캐릭터 색과 겹치지 않게 파란 배경으로 만들었습니다');
    if (name === 'magenta') parts.push('캐릭터 색과 겹치지 않게 분홍 배경으로 만들었습니다');
    return parts.join(' · ');
  }

  /** The driving margin choices from the routes payload (`margins`), or [] when absent. */
  function marginOptions(payload) {
    return (Array.isArray(payload?.margins) ? payload.margins : [])
      .filter(m => m && typeof m.value === 'string' && m.value && typeof m.label === 'string');
  }

  /** A route's default margin when it is one of `margins`, else 'none' (or the first choice). */
  function routeDefaultMargin(route, margins) {
    const values = margins.map(m => m.value);
    if (values.includes(route?.defaultMargin)) return route.defaultMargin;
    if (values.includes('none')) return 'none';
    return values[0] ?? null;
  }

  /** "여백 보통" for a job made with a margin other than 'none', else ''. Labels come from `margins`. */
  function marginText(job, margins) {
    const value = job?.margin;
    if (typeof value !== 'string' || !value || value === 'none') return '';
    const label = (Array.isArray(margins) ? margins : []).find(m => m && m.value === value)?.label;
    return label ? `여백 ${label}` : '';
  }

  const FIT_CUT_BOTTOM = 0.99;

  /** One note from a succeeded job's result.fit: the character leaves the frame, or the bottom is cut; else ''. */
  function fitNote(job) {
    const fit = job?.result?.fit;
    if (!fit || typeof fit !== 'object') return '';
    const t = fit.touches || {};
    if (t.left || t.right || t.top) return '캐릭터가 영상 밖으로 나가 잘린 선이 보일 수 있습니다. 여백을 넓혀 다시 만들어 보세요.';
    if (Array.isArray(fit.first) && Number(fit.first[3]) >= FIT_CUT_BOTTOM) {
      return '영상 아래쪽이 잘려 있어 대기 캐릭터와 크기가 조금 다를 수 있습니다.';
    }
    return '';
  }

  // ---- The three steps of one motion (4. 작업 순서, and each result card) ----

  /**
   * Step 1 (사진 투명배경화) for the chosen photo: { needed, note }. Not needed for a
   * photo that is transparent already; a photo whose background is not one colour cannot be cut.
   */
  function cutStepView(photo, { ai = false } = {}) {
    if (!photo) return { needed: false, note: '캐릭터 사진을 먼저 골라 주세요.' };
    if (photo.transparent === 'own') return { needed: false, note: '이미 투명 배경인 사진이라 필요 없습니다.' };
    // Its background was cut out before (when it was uploaded, or by a button): nothing left to choose or pay.
    if (photo.transparent === 'cut') {
      return { needed: false, done: true, note: `이미 배경을 지운 사진${photo.cutoutMethod === 'ai' ? ' (AI)' : ''}이라 그대로 씁니다. 추가 비용이 없습니다. 원본으로 보내려면 위에서 '원본 사진으로'를 누르세요.` };
    }
    if (ai) {
      return photo.aiCutReady === true
        ? { needed: true, note: '이 사진은 이미 AI로 배경을 지운 적이 있어 그 결과를 씁니다 (추가 비용 없음).' }
        : { needed: true, note: 'AI가 배경을 지운 뒤 보냅니다. 지운 결과는 저장되어 이 사진에서는 다시 비용이 들지 않습니다.' };
    }
    if (photo.transparent === 'no' && (photo.cutoutReason === 'not_uniform' || photo.cutoutReason === 'no_subject')) {
      return { needed: false, note: '배경이 한 가지 색이 아니라서 무료 방식으로는 지울 수 없습니다. 사진을 배경째 보냅니다.' };
    }
    return { needed: true, note: '사진의 단색 배경을 지우고 보냅니다. 끄면 배경이 있는 사진 그대로 보냅니다.' };
  }

  /** What removing the background of `seconds` of video costs with the paid AI remover (mirrors background-ai.js). */
  function aiVideoUsd(seconds, ai) {
    const rate = Number(ai?.videoUsdPerSecond);
    if (!Number.isFinite(rate) || !Number.isFinite(seconds)) return null;
    const billed = Math.max(Number(ai.videoMinSeconds) || 0, Math.ceil(seconds - 1e-9));
    return Number((billed * rate).toFixed(4));
  }

  /**
   * The cost the paid AI steps add to a job: the photo's AI cut (once per photo) and the
   * result's AI background removal. 0 without them.
   */
  function stepsExtraUsd({ photo, cutAi, keyAi, seconds, ai }) {
    let usd = 0;
    if (cutAi && photo && photo.transparent !== 'own' && photo.aiCutReady !== true) usd += Number(ai?.imageUsd) || 0;
    if (keyAi) usd += aiVideoUsd(seconds, ai) || 0;
    return Number(usd.toFixed(4));
  }

  const STEP_CUT_TEXT = Object.freeze({
    done: ['완료', 'done'], own: ['필요 없음', 'done'], skipped: ['건너뜀', 'muted'], not_plain: ['지울 수 없는 배경', 'warn'],
  });

  /**
   * The three steps of a job as chips: [{ label, text, kind }], kind 'done' | 'active' |
   * 'muted' | 'warn' | 'error'. Jobs from before steps were recorded show what is known.
   */
  function jobSteps(job) {
    const state = job?.state;
    const steps = job?.steps && typeof job.steps === 'object' ? job.steps : null;
    let cut = steps ? STEP_CUT_TEXT[steps.cut] || ['', 'muted'] : (job?.characterCutout ? STEP_CUT_TEXT.done : ['기록 없음', 'muted']);
    if (steps && steps.cut === 'done' && steps.cutMethod === 'ai') cut = ['완료 (AI)', 'done'];
    let make;
    if (state === 'failed') make = ['실패', 'error'];
    else if (state === 'canceled') make = ['취소', 'muted'];
    else if (state === 'keying' || state === 'succeeded') make = ['완료', 'done'];
    else make = [JOB_STATE_LABELS[state] || '대기', 'active'];
    let key;
    if (steps && steps.key === false) key = ['건너뜀', 'muted'];
    else if (state === 'keying') key = ['진행 중', 'active'];
    else if (state === 'succeeded') key = job.result?.keyedUrl ? [job.result.keyMethod === 'ai' ? '완료 (AI)' : '완료', 'done'] : ['지우지 못함', 'warn'];
    else if (state === 'failed' || state === 'canceled') key = ['하지 않음', 'muted'];
    else key = ['대기', 'muted'];
    // Step 3 by the AI remover is its own charge: what it took, or that it came back.
    const taken = job?.keyCharge;
    if (taken && Number.isFinite(taken.credits) && taken.credits > 0) {
      key = [`${key[0]} · ${formatCredits(taken.credits)} 크레딧${taken.refunded ? ' 돌려받음' : ''}`, key[1]];
    }
    return [
      { label: '① 사진 투명배경화', text: cut[0], kind: cut[1] },
      { label: '② AI 동작 생성', text: make[0], kind: make[1] },
      { label: '③ 영상 투명배경화', text: key[0], kind: key[1] },
    ];
  }

  /**
   * The POST /api/animate/jobs body. `margin` is sent only when the server offers margins;
   * `confirmed` for every route but the free one (the page asked first). `cutPhoto` /
   * `keyResult` are sent (as false) only when step 1 / step 3 is left out.
   */
  function jobPayload({ drivingId, photoId, route, options, margin, margins, cutPhoto = true, keyResult = true }) {
    const payload = { drivingId, photoId, routeId: route?.id, options: options || {} };
    if (cutPhoto === false || cutPhoto === 'ai') payload.cutPhoto = cutPhoto;
    if (keyResult === false || keyResult === 'ai') payload.keyResult = keyResult;
    if (Array.isArray(margins) && margins.some(m => m.value === margin)) payload.margin = margin;
    if (!isFreeRoute(route)) payload.confirmed = true;
    return payload;
  }

  /** "12:34" today, "9/28 12:34" otherwise. */
  function formatTime(value, now = Date.now()) {
    const t = timeValue(value);
    if (!t) return '';
    const date = new Date(t);
    const pad = n => String(n).padStart(2, '0');
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const today = new Date(now);
    const sameDay = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
  }

  /** "상태 · 42%" from providerStatus and a 0..1 progress. */
  function progressText(job) {
    const parts = [];
    if (typeof job?.providerStatus === 'string' && job.providerStatus) parts.push(job.providerStatus);
    if (Number.isFinite(job?.progress)) {
      parts.push(`${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}%`);
    }
    return parts.join(' · ');
  }

  /** Elapsed time in Korean: "45초", "2분 13초", "2분", "1시간 5분". */
  function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const total = Math.round(ms / 1000);
    if (total < 60) return `${total}초`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
    return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`;
  }

  /**
   * How long a job took: "작업 시간 2분 13초" once it finished (createdAt ->
   * finishedAt), "1분 5초 경과" while it is still running, '' when unknown.
   */
  function jobTimingText(job, now = Date.now()) {
    const start = timeValue(job?.createdAt);
    if (!start) return '';
    if (ACTIVE_STATES.has(job.state)) return `${formatElapsed(now - start)} 경과`;
    const end = timeValue(job?.finishedAt);
    return end ? `작업 시간 ${formatElapsed(end - start)}` : '';
  }

  /** "영상 3초" / "영상 9.9초" for a job whose result length is known, else ''. */
  function resultLengthText(job) {
    const text = formatSeconds(Number(job?.result?.duration));
    return text ? `영상 ${text}` : '';
  }

  /** Content-Type for an uploaded driving video (browsers may leave file.type empty). */
  function videoContentType(name, type) {
    if (type === 'video/mp4' || type === 'video/quicktime' || type === 'video/webm') return type;
    const ext = /\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase();
    return { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext]
      || 'application/octet-stream';
  }

  const DRIVING_BATCH_SIZE = 12;

  /**
   * How many driving cards to render: one batch of 12 at first, one more batch
   * per sentinel hit (`grow`), never fewer than already shown, capped by the total.
   */
  function drivingRenderCount(shown, total, { grow = false } = {}) {
    return motions.motionRenderCount(shown, total, { grow, batchSize: DRIVING_BATCH_SIZE });
  }

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

  /** 'image' (PNG/JPEG/WebP), 'video' (MP4/MOV/WebM) or null, from the MIME type or, when empty, the extension. */
  function fileKind(name, type) {
    const mime = String(type ?? '').toLowerCase();
    if (IMAGE_TYPES.has(mime)) return 'image';
    if (VIDEO_TYPES.has(mime)) return 'video';
    if (mime) return null;
    const ext = /\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
    if (['mp4', 'm4v', 'mov', 'webm'].includes(ext)) return 'video';
    return null;
  }

  /**
   * Image files from a paste's clipboard data (ClipboardEvent.clipboardData),
   * added as photos of the chosen character. A copied screenshot arrives as an unnamed or
   * generic 'image.png' item, so each file gets a stable name with an extension
   * that matches its type. Files seen through both .files and .items count once.
   */
  function pastedImages(clipboardData, now = Date.now()) {
    if (!clipboardData) return [];
    const seen = new Set();
    const files = [];
    const add = (file) => {
      if (!file || seen.has(file)) return;
      seen.add(file);
      files.push(file);
    };
    for (const file of Array.from(clipboardData.files || [])) add(file);
    for (const item of Array.from(clipboardData.items || [])) {
      if (item && item.kind === 'file' && typeof item.getAsFile === 'function') add(item.getAsFile());
    }
    const images = files.filter(file => fileKind(file.name, file.type) === 'image');
    // The same image can surface as two distinct File objects (files + items) in some browsers.
    const unique = [];
    const keys = new Set();
    for (const file of images) {
      const key = `${file.name}|${file.type}|${file.size}`;
      if (keys.has(key)) continue;
      keys.add(key);
      unique.push(file);
    }
    return unique.map((file, index) => ({ file, name: pastedName(file, now, index) }));
  }

  function pastedName(file, now, index) {
    const name = String(file.name ?? '');
    if (name && name.toLowerCase() !== 'image.png' && /\.[a-z0-9]+$/i.test(name)) return name;
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[String(file.type ?? '').toLowerCase()] || 'png';
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    return `pasted-${stamp}${index ? `-${index + 1}` : ''}.${ext}`;
  }

  // ---- Characters (GET /api/characters) ----

  /** Every photo of a character list, in list order: [{ character, photo, index }] (index within its character). */
  function listPhotos(list) {
    const out = [];
    for (const character of Array.isArray(list?.characters) ? list.characters : []) {
      if (!character || typeof character.id !== 'string') continue;
      const photos = Array.isArray(character.photos) ? character.photos : [];
      photos.filter(photo => photo && typeof photo.id === 'string')
        .forEach((photo, index) => out.push({ character, photo, index }));
    }
    return out;
  }

  /** { character, photo, index } for a photo id, or null. */
  function findPhoto(list, photoId) {
    if (typeof photoId !== 'string' || !photoId) return null;
    return listPhotos(list).find(entry => entry.photo.id === photoId) || null;
  }

  /**
   * The photo to show as chosen: `wanted` (?photo=, or the current choice)
   * while it exists, else the on-air photo, else the first character's base
   * photo (else its first photo); null without photos.
   */
  function choosePhotoId(list, wanted) {
    if (findPhoto(list, wanted)) return wanted;
    if (findPhoto(list, list?.activePhotoId)) return list.activePhotoId;
    const first = listPhotos(list)[0];
    if (!first) return null;
    const base = findPhoto(list, first.character.basePhotoId);
    return base && base.character === first.character ? base.photo.id : first.photo.id;
  }

  /** The name of a character made from a paste when `count` characters exist: '캐릭터 N', N = count + 1. */
  function nextCharacterName(count) {
    return `캐릭터 ${Number.isInteger(count) && count > 0 ? count + 1 : 1}`;
  }

  /**
   * Where pasted images go: new photos of the chosen photo's character
   * ({ kind: 'photo', characterId }), or, with no character yet, a new one
   * ({ kind: 'character', name }).
   */
  function pasteTarget(list, photoId) {
    const chosen = findPhoto(list, photoId);
    if (chosen) return { kind: 'photo', characterId: chosen.character.id };
    const count = Array.isArray(list?.characters) ? list.characters.length : 0;
    return { kind: 'character', name: nextCharacterName(count) };
  }

  /** '캐릭터 1 사진 2': how a photo is named on the page (photos have no names of their own). */
  function photoLabel(character, index) {
    return `${String(character?.name ?? '')} 사진 ${Number.isInteger(index) && index >= 0 ? index + 1 : 1}`.trim();
  }

  /** A photo tile's caption: '기본 · 동작 2개', '동작 없음'. */
  function photoCaption(photo) {
    const count = Number.isInteger(photo?.motionCount) && photo.motionCount > 0 ? photo.motionCount : 0;
    const motionsText = count ? `동작 ${count}개` : '동작 없음';
    return photo?.isBase ? `기본 · ${motionsText}` : motionsText;
  }

  /** The chosen photo's line under the picker: '선택: 캐릭터 1 사진 2 · 1024×1536 · 방송 중'. */
  function photoSummary(entry) {
    if (!entry) return '';
    const { character, photo, index } = entry;
    const parts = [`선택: ${photoLabel(character, index)}`];
    if (Number.isFinite(photo.width) && Number.isFinite(photo.height)) parts.push(`${photo.width}×${photo.height}`);
    if (photo.cutout) parts.push('단색 배경을 지워서 보여 줍니다');
    if (photo.onAir) parts.push('방송 중');
    return parts.join(' · ');
  }

  /**
   * Every motion id the page knows about: the photos' motions from the
   * character list and the live library view's (motions without a photo).
   */
  function knownMotionIds(list, viewMotions) {
    const ids = new Set();
    for (const { photo } of listPhotos(list)) {
      for (const motion of Array.isArray(photo.motions) ? photo.motions : []) {
        if (motion && typeof motion.id === 'string') ids.add(motion.id);
      }
    }
    for (const motion of Array.isArray(viewMotions) ? viewMotions : []) {
      if (motion && typeof motion.id === 'string') ids.add(motion.id);
    }
    return ids;
  }

  // ---- One character at a time (동작 관리) ----

  const photosOf = character => (Array.isArray(character?.photos) ? character.photos : [])
    .filter(photo => photo && typeof photo.id === 'string');

  /** A character of the list by id, or null. */
  function findCharacter(list, characterId) {
    if (typeof characterId !== 'string' || !characterId) return null;
    return (Array.isArray(list?.characters) ? list.characters : []).find(character => character && character.id === characterId) || null;
  }

  /** The photo a character opens with: the on-air one when it is this character's, else its base photo, else its first. */
  function characterPhotoId(character, activePhotoId) {
    const photos = photosOf(character);
    if (photos.some(photo => photo.id === activePhotoId)) return activePhotoId;
    if (photos.some(photo => photo.id === character.basePhotoId)) return character.basePhotoId;
    return photos[0]?.id || null;
  }

  /** Every motion of a character, photos in list order: [{ motion, photo, index }]. */
  function characterMotions(character) {
    const out = [];
    photosOf(character).forEach((photo, index) => {
      for (const motion of Array.isArray(photo.motions) ? photo.motions : []) {
        if (motion && typeof motion.id === 'string') out.push({ motion, photo, index });
      }
    });
    return out;
  }

  /** The motions of one photo of the character ({ motion, photo, index }, as characterMotions). */
  function photoMotions(character, photoId) {
    return characterMotions(character).filter(item => item.photo.id === photoId);
  }

  /** The photo a job was made with (older jobs name it in characterId); null for none. */
  function jobPhotoId(job) {
    return (job && (job.photoId || job.characterId)) || null;
  }

  /** A motion belongs to one photo: only the results of the chosen photo can be added or changed. */
  function isJobOfPhoto(job, photoId) {
    return Boolean(photoId) && jobPhotoId(job) === photoId;
  }

  /** A switcher chip's second line: '사진 2장 · 동작 3개'. */
  function characterChipText(character) {
    return `사진 ${photosOf(character).length}장 · 동작 ${characterMotions(character).length}개`;
  }

  /**
   * The jobs made with one of a character's photos (older jobs name their photo
   * in characterId). Without a character every job is listed.
   */
  function jobsOfCharacter(jobs, character) {
    const all = Array.isArray(jobs) ? jobs : [];
    if (!character) return all;
    const ids = new Set(photosOf(character).map(photo => photo.id));
    ids.add(character.id);
    return all.filter(job => ids.has(job?.photoId) || ids.has(job?.characterId));
  }

  /**
   * What a photo shows on air while no motion plays (photo.idle: 'motion' with
   * idleMotionId / idleBy, 'upload', or 'photo'). `label` names the photo when its
   * character has several.
   */
  function idleSummary(photo, label = '') {
    if (!photo) return '';
    const lead = label ? `${label}의 대기 화면` : '대기 화면';
    if (photo.idle === 'motion') {
      const motion = (Array.isArray(photo.motions) ? photo.motions : []).find(item => item && item.id === photo.idleMotionId);
      const name = String(motion?.name ?? '').trim() || '동작';
      return `${lead}: '${name}' 영상이 반복 재생됩니다${photo.idleBy === 'choice' ? ' (직접 고름)' : ''}. 다른 동작의 '대기 동작으로'를 누르면 바뀝니다.`;
    }
    if (photo.idle === 'upload') return `${lead}: 따로 올린 대기 영상. 동작의 '대기 동작으로'를 누르면 그 동작으로 바뀝니다.`;
    return `${lead}: 사진. '기본 대기 동작' 영상을 만들면 사진 대신 그 영상이 반복 재생됩니다.`;
  }

  /**
   * The chosen photo's background (PhotoView.transparent / cutoutReason / cutoutMethod):
   * { tag, note, canCut, cut, own }. Only a plain one-colour background can be cut for free.
   */
  function photoBackground(photo) {
    if (!photo) return null;
    if (photo.transparent === 'own') return { tag: '투명 배경', note: '처음부터 배경이 투명한 사진입니다.', canCut: false, cut: false, own: true };
    if (photo.transparent === 'cut') {
      return { tag: '배경 지움', note: '올릴 때 단색 배경을 자동으로 지운 사진입니다.', canCut: false, cut: true, own: false };
    }
    const plain = !(photo.cutoutReason === 'not_uniform' || photo.cutoutReason === 'no_subject');
    return {
      tag: '배경 있음',
      note: plain ? '배경을 지운 사진이 새로 추가되고, 이 사진은 그대로 남습니다.' : '배경이 한 가지 색이 아니라서 무료 방식으로는 지울 수 없습니다. AI로 지우면 새 사진으로 추가됩니다.',
      canCut: plain, cut: false, own: false,
    };
  }

  /** `search` with ?photo= set to `photoId` (removed for none), other parameters kept: '' or '?...'. */
  function searchWithPhoto(search, photoId) {
    const params = new URLSearchParams(typeof search === 'string' ? search : '');
    if (typeof photoId === 'string' && photoId) params.set('photo', photoId);
    else params.delete('photo');
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  // ---- Finished motion upload (완성된 영상 올리기) ----

  // Mirrors the server: MAX_UPLOAD_BYTES and motion-upload.js MAX_SECONDS.
  const MOTION_MAX_BYTES = 500 * 1024 * 1024;
  const MOTION_MAX_SECONDS = 60;

  /** A file name without its folder and last extension: 'clips/wink.final.webm' -> 'wink.final'. */
  function fileBaseName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    return (dot > 0 ? base.slice(0, dot) : base).trim();
  }

  /** Why a file cannot be uploaded as a finished motion (Korean), or '' when it can. */
  function motionFileProblem(file) {
    if (!file) return '';
    if (fileKind(file.name, file.type) !== 'video') return 'WebM, MP4, MOV 영상만 올릴 수 있습니다';
    if (Number(file.size) > MOTION_MAX_BYTES) return '영상은 500MB까지 올릴 수 있습니다';
    return '';
  }

  /** The upload's path: POST /api/characters/<id>/photos/<photoId>/motions?name=&filename=. */
  function motionUploadPath(characterId, photoId, { name = '', filename = '' } = {}) {
    const params = new URLSearchParams({ name: String(name ?? '').trim(), filename: String(filename ?? '') });
    return `/api/characters/${encodeURIComponent(characterId)}/photos/${encodeURIComponent(photoId)}/motions?${params}`;
  }

  // Upload keyReason (motion-upload.js: key.js detection, or the keying step) -> plain Korean.
  const KEY_REASON_TEXT = Object.freeze({
    not_uniform: '가장자리 배경이 한 가지 색이 아니라서 지우지 않았습니다',
    not_key_color: '배경이 초록·파랑·분홍 단색이 아니라서 지우지 않았습니다',
    unreadable: '영상 화면을 읽지 못해 배경을 지우지 않았습니다',
    key_failed: '배경을 지우다가 실패했습니다',
  });

  function keyReasonText(reason) {
    return (typeof reason === 'string' && KEY_REASON_TEXT[reason]) || '';
  }

  /**
   * What happened to a finished motion's background, from the upload's 201
   * answer: { text, kind }. Keyed: '배경을 지웠습니다 (#00FF00)'; its own
   * alpha: '투명 배경 그대로 추가했습니다'; else '배경이 있는 채로 추가됨' and why.
   */
  function uploadResultText(answer) {
    const upload = answer?.motion?.source?.upload || {};
    const keyed = typeof answer?.keyed === 'boolean' ? answer.keyed : upload.keyed === true;
    if (keyed) {
      const color = typeof upload.keyColor === 'string' && /^#[0-9a-f]{6}$/i.test(upload.keyColor) ? upload.keyColor.toUpperCase() : '';
      return { text: color ? `배경을 지웠습니다 (${color})` : '배경을 지웠습니다', kind: 'success' };
    }
    if (upload.alpha === true) return { text: '투명 배경 그대로 추가했습니다', kind: 'success' };
    const why = keyReasonText(answer && 'keyReason' in answer ? answer.keyReason : upload.keyReason);
    return { text: why ? `배경이 있는 채로 추가됨 · ${why}` : '배경이 있는 채로 추가됨', kind: 'warn' };
  }

  /** The preset labels, for the upload name's suggestions (motions.js is the one catalog). */
  function presetNames() {
    return motions.PRESET_MOTIONS.map(preset => preset.label);
  }

  /**
   * Horizontal scroll delta for a wheel event over a strip, or 0 to leave the
   * event to the page: only mostly-vertical wheels, only when the strip can
   * scroll, and not past either end.
   */
  function stripWheelDelta({ deltaX = 0, deltaY = 0, deltaMode = 0, ctrlKey = false }, { scrollLeft, scrollWidth, clientWidth }) {
    if (ctrlKey || Math.abs(deltaY) <= Math.abs(deltaX)) return 0;
    const max = scrollWidth - clientWidth;
    if (!(max > 1)) return 0;
    const delta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * clientWidth : deltaY;
    // 1px tolerance: fractional layout and snapping can leave a strip a pixel off its end.
    if (delta > 0 && scrollLeft >= max - 1) return 0;
    if (delta < 0 && scrollLeft <= 1) return 0;
    return delta;
  }

  /** The 다운로드 link of a clip URL (?download=1 added). */
  function downloadUrl(src) {
    return `${src}${String(src).includes('?') ? '&' : '?'}download=1`;
  }

  return {
    downloadUrl,
    DRIVING_BATCH_SIZE,
    drivingRenderCount,
    fileKind,
    pastedImages,
    stripWheelDelta,
    listPhotos,
    findPhoto,
    choosePhotoId,
    nextCharacterName,
    pasteTarget,
    photoLabel,
    photoCaption,
    photoSummary,
    knownMotionIds,
    findCharacter,
    characterPhotoId,
    characterMotions,
    photoMotions,
    characterChipText,
    jobsOfCharacter,
    jobPhotoId,
    isJobOfPhoto,
    idleSummary,
    photoBackground,
    searchWithPhoto,
    MOTION_MAX_BYTES,
    MOTION_MAX_SECONDS,
    fileBaseName,
    motionFileProblem,
    motionUploadPath,
    keyReasonText,
    uploadResultText,
    presetNames,
    JOB_STATE_LABELS,
    ACTIVE_STATES,
    errorText,
    serverErrorText,
    selectableOptions,
    effectiveOptions,
    estimateUsd,
    formatCredits,
    billingActive,
    creditsForEstimate,
    priceText,
    routeCostText,
    jobCredits,
    confirmCreditsText,
    insufficientText,
    jobCreditsText,
    refundTurnedOn,
    jobCharged,
    cancelConfirmText,
    refetchChargeCredits,
    refetchConfirmText,
    refetchErrorText,
    formatSeconds,
    LENGTH_TOLERANCE_SEC,
    routeMaxSeconds,
    routeMinSeconds,
    tooShortText,
    isFreeRoute,
    routeState,
    groupRoutes,
    splitRoutes,
    defaultMotionName,
    upsertJob,
    isAdded,
    offersRefetch,
    refetchTitle,
    keyNote,
    keyColorNote,
    marginOptions,
    routeDefaultMargin,
    marginText,
    fitNote,
    cutStepView,
    aiVideoUsd,
    stepsExtraUsd,
    jobSteps,
    jobPayload,
    formatTime,
    formatElapsed,
    jobTimingText,
    resultLengthText,
    progressText,
    videoContentType,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AnimateHelpers;

if (typeof document !== 'undefined') (() => {
  const H = AnimateHelpers;
  const MAX_DRIVING_BYTES = 200 * 1024 * 1024;
  const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

  const $ = id => document.getElementById(id);
  const globalStatus = $('globalStatus');
  const exampleBar = $('exampleBar');
  const fetchExamplesBtn = $('fetchExamplesBtn');
  const restoreExamplesBtn = $('restoreExamplesBtn');
  const drivingList = $('drivingList');
  const drivingDrop = $('drivingDrop');
  const drivingDropTitle = $('drivingDropTitle');
  const drivingSentinel = $('drivingSentinel');
  const drivingInput = $('drivingInput');
  const drivingStatus = $('drivingStatus');
  const drivingPreview = $('drivingPreview');
  const switchCard = $('switchCard');
  const characterSwitch = $('characterSwitch');
  const motionsCard = $('motionsCard');
  const idleSummary = $('idleSummary');
  const motionTiles = $('motionTiles');
  const motionsEmpty = $('motionsEmpty');
  const motionsStatus = $('motionsStatus');
  const characterCard = $('characterCard');
  const characterEmpty = $('characterEmpty');
  const characterRows = $('characterRows');
  const characterMeta = $('characterMeta');
  const photoBg = $('photoBg');
  const photoBgTag = $('photoBgTag');
  const photoBgCut = $('photoBgCut');
  const photoBgAi = $('photoBgAi');
  const photoBgKeep = $('photoBgKeep');
  const photoBgNote = $('photoBgNote');
  const photoBgDelete = $('photoBgDelete');
  const characterInput = $('characterInput');
  const characterStatus = $('characterStatus');
  const photoDropTemplate = $('photoDropTemplate');
  const pathTabs = [$('pathAiTab'), $('pathUploadTab')];
  const aiPath = $('aiPath');
  const uploadPath = $('uploadPath');
  const motionUploadCard = $('motionUploadCard');
  const motionTarget = $('motionTarget');
  const motionDrop = $('motionDrop');
  const motionDropTitle = $('motionDropTitle');
  const motionInput = $('motionInput');
  const motionName = $('motionName');
  const presetNamesList = $('presetNames');
  const motionUploadBtn = $('motionUploadBtn');
  const motionProgress = $('motionProgress');
  const motionUploadStatus = $('motionUploadStatus');
  const motionResult = $('motionResult');
  const routeList = $('routeList');
  const routeOptions = $('routeOptions');
  const marginBox = $('marginBox');
  const marginSelect = $('marginSelect');
  const stepCut = $('stepCut');
  const stepCutMethod = $('stepCutMethod');
  const stepKeyMethod = $('stepKeyMethod');
  const stepCutNote = $('stepCutNote');
  const stepMakeNote = $('stepMakeNote');
  const stepKey = $('stepKey');
  const stepKeyNote = $('stepKeyNote');
  const createBtn = $('createBtn');
  const createStatus = $('createStatus');
  const jobsEmpty = $('jobsEmpty');
  const jobList = $('jobList');
  const confirmDialog = $('confirmDialog');
  const confirmCredits = $('confirmCredits');

  // ?photo=<photoId> (the list page's 동작 관리) picks the photo at first.
  const requestedPhotoId = new URLSearchParams(window.location.search).get('photo');

  const state = {
    ffmpeg: null,
    routes: [],
    list: null, // GET /api/characters: { characters, activePhotoId, activeCharacterId }; null until loaded
    photoId: null, // the chosen photo (every job and upload goes to it)
    viewMotions: [], // the live library view's motions (SSE), for motions without a photo
    drivings: [],
    hiddenExamples: 0,
    drivingShown: 0,
    drivingId: null,
    routeId: null,
    options: {}, // routeId -> { key: value }
    margins: [], // [{ value, label }] from the routes payload; [] hides the 여백 select
    margin: null, // chosen driving margin value
    marginRouteId: null, // the route `margin` was last reset for
    jobs: [],
    libraryIds: null,
    billing: null, // GET /api/billing payload (auth.js VirtuallyBilling); null until known
    // photo: the character id photos are being added to ('' while a new character is made), else null.
    // 4. 작업 순서: whether step 1 (when the photo needs it) and step 3 are wanted.
    // cutAi / keyAi: the paid AI remover for that step (only offered when the server has it).
    steps: { cut: true, key: true, cutAi: false, keyAi: false },
    backgroundAi: null, // { available, imageUsd, videoUsdPerSecond, videoMinSeconds } from the status payload
    busy: { fetch: false, restore: false, driving: false, photo: null, photoText: '', create: false },
  };

  // ---- Small DOM helpers ----
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  class ApiError extends Error {
    constructor(body, status, text = H.errorText) {
      super(text(body));
      this.code = body?.code || null;
      this.detail = body?.detail || null;
      this.status = status;
    }
  }

  // `errorText` turns an error body into the message (H.serverErrorText for the character API).
  async function api(method, path, { json, body, contentType, errorText = H.errorText } = {}) {
    const init = { method, headers: { Accept: 'application/json' } };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.headers['Content-Type'] = contentType || 'application/octet-stream';
      init.body = body;
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw new ApiError({ error: '서버에 연결할 수 없습니다' }, 0);
    }
    let data = null;
    try { data = await response.json(); } catch { /* empty or non-JSON */ }
    if (!response.ok) throw new ApiError(data || { error: `HTTP ${response.status}` }, response.status, errorText);
    return data;
  }

  const selectedDriving = () => state.drivings.find(d => d.id === state.drivingId) || null;
  const selectedRoute = () => state.routes.find(r => r.id === state.routeId) || null;

  // ---- Horizontal strips (the driving videos and each character's photos) ----
  // A strip is `.strip > .strip-scroller`; the scroller's first child is a
  // sticky lead tile (drop zone). This adds: vertical wheel -> horizontal
  // scroll, fade edges when there is more to see, and an optional sentinel
  // that asks for the next batch as it nears the right edge.
  function setupStrip(scroller, { sentinel = null, onMore = null } = {}) {
    const wrap = scroller.parentElement;
    const lead = scroller.querySelector('.strip-lead');
    let wheelTimer = null;

    function updateEdges() {
      const max = scroller.scrollWidth - scroller.clientWidth;
      wrap.style.setProperty('--strip-lead', `${lead ? lead.offsetWidth : 0}px`);
      wrap.toggleAttribute('data-more-left', scroller.scrollLeft > 1);
      wrap.toggleAttribute('data-more-right', max > 1 && scroller.scrollLeft < max - 1);
    }

    scroller.addEventListener('wheel', (event) => {
      const delta = H.stripWheelDelta(event, scroller);
      if (!delta) return;
      event.preventDefault();
      // Snapping would pull small wheel steps back; pause it while wheeling.
      scroller.classList.add('is-wheeling');
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => scroller.classList.remove('is-wheeling'), 180);
      scroller.scrollLeft += delta;
    }, { passive: false });
    scroller.addEventListener('scroll', updateEdges, { passive: true });
    const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateEdges) : null;
    if (resizer) resizer.observe(scroller);
    else window.addEventListener('resize', updateEdges);

    const observer = sentinel && onMore && typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.isIntersecting)) onMore();
      }, { root: scroller, rootMargin: '0px 300px 0px 0px' })
      : null;

    return {
      // Call after every render. `more` = whether unrendered items remain.
      refresh({ more = false } = {}) {
        if (sentinel) {
          sentinel.hidden = !more;
          if (observer) {
            observer.unobserve(sentinel);
            // Re-observing delivers a fresh entry, so a sentinel still in range
            // after a batch keeps loading until it leaves the range.
            if (more) observer.observe(sentinel);
          }
        }
        updateEdges();
      },
      // For a strip that leaves the page (a deleted character's row).
      destroy() {
        if (resizer) resizer.disconnect();
        else window.removeEventListener('resize', updateEdges);
        if (observer) observer.disconnect();
      },
    };
  }

  // Replace a strip's tiles, keeping its lead tile (and sentinel) in place so
  // a focused drop zone keeps focus.
  function setTiles(scroller, nodes, tail = null) {
    for (const child of [...scroller.children]) {
      if (child.classList.contains('strip-lead') || child === tail) continue;
      child.remove();
    }
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    scroller.insertBefore(fragment, tail);
  }

  // Drag-and-drop of files onto `target`, shown as the drag-over state on `zone`.
  function acceptDrops(target, zone, onFiles) {
    let depth = 0;
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const clear = () => { depth = 0; zone.classList.remove('is-dragover'); };
    target.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      zone.classList.add('is-dragover');
    });
    target.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-dragover');
    });
    target.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.classList.remove('is-dragover');
    });
    target.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clear();
      onFiles(Array.from(event.dataTransfer.files || []));
    });
  }

  // A file dropped outside a drop zone must not navigate away from the page.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
    });
  }

  // ---- 2. Driving videos (AI로 만들기) ----
  const drivingStrip = setupStrip(drivingList, {
    sentinel: drivingSentinel,
    onMore: () => {
      const next = H.drivingRenderCount(state.drivingShown, state.drivings.length, { grow: true });
      if (next <= state.drivingShown) return;
      state.drivingShown = next;
      renderDrivings();
    },
  });

  function renderDrivings() {
    const missing = state.drivings.some(d => d.kind === 'example' && !d.available);
    exampleBar.hidden = !missing;
    fetchExamplesBtn.disabled = state.busy.fetch;
    fetchExamplesBtn.textContent = state.busy.fetch ? '받는 중…' : '예시 영상 받기';
    // Deleted examples are hidden, not gone: offer to bring them back.
    restoreExamplesBtn.hidden = !(state.hiddenExamples > 0);
    restoreExamplesBtn.disabled = state.busy.restore;
    restoreExamplesBtn.textContent = `숨긴 예시 ${state.hiddenExamples}개 되돌리기`;

    // Keep a valid selection: the current one if still available, else the first available.
    if (!state.drivings.some(d => d.id === state.drivingId && d.available)) {
      state.drivingId = state.drivings.find(d => d.available)?.id || null;
    }
    // Live refreshes never shrink what is rendered; the selected card is always rendered.
    const selectedIndex = state.drivings.findIndex(d => d.id === state.drivingId);
    state.drivingShown = Math.max(
      H.drivingRenderCount(state.drivingShown, state.drivings.length),
      Math.min(state.drivings.length, selectedIndex + 1),
    );

    drivingDrop.setAttribute('aria-busy', String(state.busy.driving));

    const focusedId = drivingList.contains(document.activeElement) && document.activeElement.name === 'driving'
      ? document.activeElement.value : null;
    setTiles(drivingList, state.drivings.slice(0, state.drivingShown).map(drivingCard), drivingSentinel);
    if (focusedId) drivingList.querySelector(`input[value="${CSS.escape(focusedId)}"]`)?.focus();
    drivingStrip.refresh({ more: state.drivingShown < state.drivings.length });
    renderPreview();
  }

  function drivingCard(driving) {
    const checked = driving.id === state.drivingId;
    const radio = el('input', {
      type: 'radio',
      name: 'driving',
      className: 'visually-hidden',
      value: driving.id,
      checked,
      disabled: !driving.available,
      onchange: () => {
        state.drivingId = driving.id;
        for (const card of drivingList.querySelectorAll('.driving-card')) {
          card.classList.toggle('is-selected', card.dataset.id === driving.id);
        }
        renderPreview();
        renderRoutes();
      },
    });
    const poster = driving.posterUrl
      ? el('img', { className: 'driving-poster', src: driving.posterUrl, alt: '', loading: 'lazy' })
      : el('span', { className: 'driving-poster driving-poster-empty', text: driving.available ? '' : '없음' });
    const meta = [driving.label, H.formatSeconds(driving.duration)];
    const label = el('label', { className: 'driving-pick' }, [
      radio,
      poster,
      el('span', { className: 'driving-name', text: meta[0] }),
      meta[1] ? el('span', { className: 'driving-len', text: meta[1] }) : null,
    ]);
    const card = el('div', {
      className: 'driving-card' + (checked ? ' is-selected' : '') + (driving.available ? '' : ' is-unavailable'),
      dataset: { id: driving.id },
    }, [label]);

    const credit = driving.credit;
    if (credit && (credit.author || credit.license)) {
      const text = [credit.author, credit.license].filter(Boolean).join(' · ');
      const href = safeHttpUrl(credit.sourcePage);
      card.append(href
        ? el('a', { className: 'driving-credit', href, target: '_blank', rel: 'noopener noreferrer', text })
        : el('span', { className: 'driving-credit', text }));
    }
    // Uploads are deleted; examples are hidden (restorable from the strip).
    card.append(el('button', {
      type: 'button',
      className: 'driving-delete',
      'aria-label': `${driving.label} 삭제`,
      title: '삭제',
      text: '×',
      onclick: () => deleteDriving(driving),
    }));
    return card;
  }

  // Only http(s) links from the manifest are rendered as links.
  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function renderPreview() {
    const driving = selectedDriving();
    const url = driving?.url || null;
    drivingPreview.hidden = !url;
    if (!url) {
      if (drivingPreview.getAttribute('src')) {
        drivingPreview.removeAttribute('src');
        drivingPreview.load();
      }
      return;
    }
    if (drivingPreview.getAttribute('src') !== url) {
      drivingPreview.src = url;
      if (driving.posterUrl) drivingPreview.poster = driving.posterUrl;
      else drivingPreview.removeAttribute('poster');
      drivingPreview.play().catch(() => { /* autoplay may be blocked; controls remain */ });
    }
  }

  async function loadDrivings() {
    const data = await api('GET', '/api/animate/drivings');
    state.drivings = Array.isArray(data?.drivings) ? data.drivings : [];
    state.hiddenExamples = Number(data?.hiddenExamples) || 0;
    renderDrivings();
    renderRoutes();
  }

  restoreExamplesBtn.addEventListener('click', async () => {
    if (state.busy.restore) return;
    state.busy.restore = true;
    renderDrivings();
    setStatus(drivingStatus, '');
    try {
      await api('POST', '/api/animate/examples/restore', { json: {} });
    } catch (error) {
      setStatus(drivingStatus, `되돌리기 실패: ${error.message}`, 'error');
    } finally {
      state.busy.restore = false;
    }
    try { await loadDrivings(); } catch (error) { setStatus(drivingStatus, error.message, 'error'); }
  });

  fetchExamplesBtn.addEventListener('click', async () => {
    state.busy.fetch = true;
    renderDrivings();
    setStatus(drivingStatus, '');
    try {
      const data = await api('POST', '/api/animate/examples/fetch', { json: {} });
      if (Array.isArray(data?.drivings)) state.drivings = data.drivings;
      const failed = (data?.results || []).filter(r => !r.ok);
      if (failed.length) setStatus(drivingStatus, `${failed.length}개 받기 실패`, 'error');
    } catch (error) {
      setStatus(drivingStatus, error.message, 'error');
    } finally {
      state.busy.fetch = false;
    }
    try { await loadDrivings(); } catch (error) { setStatus(drivingStatus, error.message, 'error'); }
  });

  // Upload driving videos one by one; the last uploaded one becomes selected.
  async function uploadDrivings(files) {
    if (state.busy.driving || files.length === 0) return;
    const videos = files.filter(file => H.fileKind(file.name, file.type) === 'video');
    const errors = [];
    if (videos.length < files.length) errors.push('영상 파일만 올릴 수 있습니다');
    const fitting = videos.filter(file => file.size <= MAX_DRIVING_BYTES);
    if (fitting.length < videos.length) errors.push('200MB 이하만 올릴 수 있습니다');
    setStatus(drivingStatus, errors.join(' · '), errors.length ? 'error' : null);
    if (fitting.length === 0) return;
    state.busy.driving = true;
    renderDrivings();
    let lastId = null;
    try {
      for (const [index, file] of fitting.entries()) {
        drivingDropTitle.textContent = fitting.length > 1 ? `올리는 중… (${index + 1}/${fitting.length})` : '올리는 중…';
        try {
          const driving = await api('POST', '/api/animate/drivings?name=' + encodeURIComponent(file.name), {
            body: file,
            contentType: H.videoContentType(file.name, file.type),
          });
          if (driving?.id && driving.available !== false) lastId = driving.id;
        } catch (error) {
          errors.push(`올리기 실패: ${error.message}`);
          setStatus(drivingStatus, errors.join(' · '), 'error');
        }
      }
    } finally {
      state.busy.driving = false;
      drivingDropTitle.textContent = '+ 내 영상 올리기';
    }
    if (lastId) state.drivingId = lastId;
    try { await loadDrivings(); } catch (error) { setStatus(drivingStatus, error.message, 'error'); }
  }

  drivingDrop.addEventListener('click', () => { if (!state.busy.driving) drivingInput.click(); });
  drivingInput.addEventListener('change', () => {
    const files = Array.from(drivingInput.files || []);
    drivingInput.value = '';
    uploadDrivings(files);
  });
  acceptDrops(drivingDrop, drivingDrop, uploadDrivings);

  async function deleteDriving(driving) {
    if (!window.confirm(`'${driving.label}' 영상을 지울까요?`)) return;
    try {
      await api('DELETE', '/api/animate/drivings/' + encodeURIComponent(driving.id));
      await loadDrivings();
    } catch (error) {
      setStatus(drivingStatus, `삭제 실패: ${error.message}`, 'error');
    }
  }

  // ---- 1. Character photo ----
  // One row per character (server order): its name, then a strip of its
  // photos behind a '+ 사진 추가' lead tile. Rows and tiles are keyed by id and
  // patched in place, so a refresh keeps scroll positions and focus and never
  // reloads an unchanged image (media is served no-store).
  const charRows = new Map(); // character id -> row (see createCharacterRow)

  const chosenPhoto = () => H.findPhoto(state.list, state.photoId);

  function renderCharacters() {
    const characters = (Array.isArray(state.list?.characters) ? state.list.characters : [])
      .filter(character => character && typeof character.id === 'string');
    characterEmpty.hidden = state.list == null || characters.length > 0;
    renderSwitch(characters);
    renderMotions();
    // The page is about one character: only the chosen photo's character has a row.
    const chosenId = chosenPhoto()?.character.id;
    const seen = new Set();
    characters.filter(character => character.id === chosenId).forEach((character, index) => {
      seen.add(character.id);
      let row = charRows.get(character.id);
      if (!row) {
        row = createCharacterRow(character.id);
        charRows.set(character.id, row);
      }
      if (characterRows.children[index] !== row.node) characterRows.insertBefore(row.node, characterRows.children[index] || null);
      updateCharacterRow(row, character);
    });
    for (const [id, row] of charRows) {
      if (seen.has(id)) continue;
      row.strip.destroy();
      row.node.remove();
      charRows.delete(id);
    }
    characterMeta.textContent = state.list == null ? '캐릭터를 불러오는 중…' : H.photoSummary(chosenPhoto());
    renderPhotoBg();
  }

  // The chosen photo's background, on its own (no motion needs to be made for it).
  let photoBgBusy = false;
  function renderPhotoBg() {
    const entry = chosenPhoto();
    const background = H.photoBackground(entry?.photo);
    photoBg.hidden = !background;
    if (!background) return;
    photoBgTag.textContent = background.tag;
    photoBgNote.textContent = background.note;
    photoBgCut.hidden = background.own || background.cut;
    photoBgCut.disabled = photoBgBusy || !background.canCut;
    photoBgAi.hidden = background.own || state.backgroundAi?.available !== true;
    photoBgDelete.disabled = photoBgBusy;
    photoBgAi.disabled = photoBgBusy;
    // The price is on the button, not only in the question it asks.
    photoBgAi.textContent = `AI로 배경 지우기 (${entry.photo.aiCutReady === true ? '추가 비용 없음' : H.priceText(state.backgroundAi?.imageUsd, state.billing)})`;
    photoBgKeep.hidden = !background.cut;
    photoBgKeep.disabled = photoBgBusy;
  }

  async function changePhotoBg(method, body, doneText) {
    const entry = chosenPhoto();
    if (!entry || photoBgBusy) return;
    photoBgBusy = true;
    renderPhotoBg();
    setStatus(characterStatus, method === 'POST' ? '배경을 지우는 중…' : '');
    try {
      const path = `/api/characters/${encodeURIComponent(entry.character.id)}/photos/${encodeURIComponent(entry.photo.id)}/transparent`;
      const data = await api(method, path, { json: body, errorText: H.serverErrorText });
      applyList(data);
      // The photo without its background is a new photo: show it as the chosen one.
      if (data?.photo?.id && H.findPhoto(state.list, data.photo.id)) selectPhoto(data.photo.id, { byUser: true });
      setStatus(characterStatus, doneText, 'success');
    } catch (error) {
      setStatus(characterStatus, error.message, 'error');
      // A refused free cut tells the server the background is not plain: show the buttons as they now are.
      loadCharacters().catch(() => {});
    } finally {
      photoBgBusy = false;
      renderPhotoBg();
    }
  }
  photoBgCut.addEventListener('click', () => changePhotoBg('POST', {}, '배경을 지운 사진을 새로 추가했습니다. 원본 사진은 그대로 있습니다'));
  photoBgDelete.addEventListener('click', () => deletePhoto(chosenPhoto()));
  // Delete one photo (the button under the strip, or the × on a photo tile): asks first.
  async function deletePhoto(entry) {
    if (!entry || photoBgBusy) return;
    const label = H.photoLabel(entry.character, entry.index);
    const motions = Number(entry.photo.motionCount) || 0;
    if (!window.confirm(`'${label}'을(를) 지울까요?${motions ? ` 이 사진의 동작 ${motions}개도 함께 지워집니다.` : ''}`)) return;
    photoBgBusy = true;
    renderPhotoBg();
    try {
      applyList(await api('DELETE', `/api/characters/${encodeURIComponent(entry.character.id)}/photos/${encodeURIComponent(entry.photo.id)}`, { errorText: H.serverErrorText }));
      setStatus(characterStatus, '사진을 지웠습니다', 'success');
    } catch (error) {
      setStatus(characterStatus, error.message, 'error');
    } finally {
      photoBgBusy = false;
      renderPhotoBg();
    }
  }
  photoBgKeep.addEventListener('click', () => changePhotoBg('DELETE', {}, '원본 사진으로 되돌렸습니다'));
  photoBgAi.addEventListener('click', () => {
    const price = H.priceText(state.backgroundAi?.imageUsd, state.billing);
    if (chosenPhoto()?.photo.aiCutReady === true || window.confirm(`AI로 이 사진의 배경을 지워 새 사진으로 추가합니다. 단색이 아닌 배경도 지울 수 있습니다.\n비용: 사진 1장당 ${price}. 진행할까요?`)) {
      changePhotoBg('POST', { method: 'ai' }, 'AI로 배경을 지운 사진을 새로 추가했습니다. 원본 사진은 그대로 있습니다');
    }
  });

  // ---- Character switcher (top) ----
  // One chip per character (server order), keyed by id and patched in place.
  const switchChips = new Map(); // character id -> { node, img, name, sub, live }
  const switchStrip = setupStrip(characterSwitch);

  function renderSwitch(characters) {
    switchCard.hidden = characters.length === 0;
    const chosenId = chosenPhoto()?.character.id;
    const seen = new Set();
    characters.forEach((character, index) => {
      seen.add(character.id);
      let chip = switchChips.get(character.id);
      if (!chip) {
        const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
        const name = el('span', { className: 'char-chip-name' });
        const sub = el('span', { className: 'char-chip-sub' });
        const live = el('span', { className: 'badge badge-live', text: '방송 중' });
        const node = el('button', { type: 'button', className: 'char-chip', dataset: { id: character.id }, onclick: () => selectCharacter(character.id) }, [
          el('span', { className: 'char-chip-thumb checkerboard' }, [img]),
          el('span', { className: 'char-chip-text' }, [name, sub]),
          live,
        ]);
        chip = { node, img, name, sub, live };
        switchChips.set(character.id, chip);
      }
      const selected = character.id === chosenId;
      const base = (Array.isArray(character.photos) ? character.photos : []).find(photo => photo && photo.id === character.basePhotoId)
        || (Array.isArray(character.photos) ? character.photos[0] : null);
      const src = base ? base.displayUrl || base.url : '';
      if (src && chip.img.getAttribute('src') !== src) chip.img.src = src;
      chip.name.textContent = character.name;
      chip.name.title = character.name;
      chip.sub.textContent = H.characterChipText(character);
      chip.live.hidden = !character.onAir;
      chip.node.classList.toggle('is-selected', selected);
      chip.node.setAttribute('aria-pressed', String(selected));
      if (characterSwitch.children[index] !== chip.node) characterSwitch.insertBefore(chip.node, characterSwitch.children[index] || null);
    });
    for (const [id, chip] of switchChips) {
      if (seen.has(id)) continue;
      chip.node.remove();
      switchChips.delete(id);
    }
    switchStrip.refresh();
  }

  // Show another character: its on-air photo, else its base photo, becomes the chosen one.
  function selectCharacter(characterId) {
    const character = H.findCharacter(state.list, characterId);
    const photoId = character ? H.characterPhotoId(character, state.list.activePhotoId) : null;
    if (!photoId || chosenPhoto()?.character.id === characterId) return;
    setStatus(motionsStatus, '');
    selectPhoto(photoId, { byUser: true });
  }

  // Scroll the switcher (never the page) so the chosen character's chip is in view.
  function revealCharacter(characterId) {
    const chip = switchChips.get(characterId);
    if (!chip) return;
    const box = characterSwitch.getBoundingClientRect();
    const rect = chip.node.getBoundingClientRect();
    if (rect.left < box.left + 8) characterSwitch.scrollLeft -= box.left + 8 - rect.left;
    else if (rect.right > box.right - 8) characterSwitch.scrollLeft += rect.right - (box.right - 8);
  }

  // ---- The chosen character's motions ----
  // Tiles are keyed by motion id and patched in place, so a refresh does not reload the clips.
  const motionNodes = new Map(); // motion id -> { node, badge, name, sub, idleBtn }
  let motionBusy = false;

  function renderMotions() {
    const entry = chosenPhoto();
    motionsCard.hidden = !entry;
    if (!entry) return;
    const { character, photo, index } = entry;
    const several = (Array.isArray(character.photos) ? character.photos.length : 0) > 1;
    idleSummary.textContent = H.idleSummary(photo, several ? H.photoLabel(character, index) : '');
    // A motion belongs to the photo it was made from: only the chosen photo's are listed.
    const items = H.photoMotions(character, photo.id);
    motionsEmpty.hidden = items.length > 0;
    renderDefaultIdle(character, photo);
    const seen = new Set();
    items.forEach((item, at) => {
      at += defaultIdleTile.node.isConnected ? 1 : 0;
      const { motion } = item;
      seen.add(motion.id);
      let tile = motionNodes.get(motion.id);
      if (!tile) {
        tile = createMotionTile(motion);
        motionNodes.set(motion.id, tile);
      }
      updateMotionTile(tile, character, item, false);
      if (motionTiles.children[at] !== tile.node) motionTiles.insertBefore(tile.node, motionTiles.children[at] || null);
    });
    for (const [id, tile] of motionNodes) {
      if (seen.has(id)) continue;
      tile.node.remove();
      motionNodes.delete(id);
    }
  }

  // The default idle while the photo has no idle video: the still photo, as the first
  // tile, so it can be seen and picked again after another motion was chosen.
  const defaultIdleTile = (() => {
    const img = el('img', { alt: '', decoding: 'async', draggable: false });
    const badge = el('span', { className: 'badge badge-ok', text: '대기 동작' });
    const button = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '대기 동작으로' });
    const node = el('div', { className: 'motion-tile', role: 'listitem' }, [
      el('div', { className: 'motion-thumb checkerboard' }, [img, badge]),
      el('span', { className: 'motion-tile-name', text: '기본 대기 동작' }),
      el('span', { className: 'motion-tile-sub', text: '사진 그대로 · 대기 영상을 만들면 바뀝니다' }),
      el('div', { className: 'motion-tile-actions' }, [button]),
    ]);
    return { node, img, badge, button };
  })();

  function renderDefaultIdle(character, photo) {
    const tile = defaultIdleTile;
    // Only while the default is the photo itself (no idle video, no uploaded idle).
    const shown = (photo.idleDefault ?? 'photo') === 'photo' && !photo.defaultIdleMotionId;
    if (!shown) {
      tile.node.remove();
      return;
    }
    const src = photo.displayUrl || photo.url;
    if (tile.img.getAttribute('src') !== src) tile.img.src = src;
    const isIdle = photo.idle === 'photo';
    tile.node.classList.toggle('is-idle', isIdle);
    tile.badge.hidden = !isIdle;
    tile.button.hidden = isIdle;
    tile.button.disabled = motionBusy;
    tile.button.onclick = () => setIdleMotion(character, photo, null);
    if (motionTiles.firstElementChild !== tile.node) motionTiles.insertBefore(tile.node, motionTiles.firstElementChild);
    motionsEmpty.hidden = true;
  }

  function createMotionTile(motion) {
    const video = el('video', { src: `/api/media/${encodeURIComponent(motion.id)}`, muted: true, loop: true, playsInline: true, preload: 'metadata' });
    const badge = el('span', { className: 'badge badge-ok', text: '대기 동작' });
    const name = el('span', { className: 'motion-tile-name' });
    const sub = el('span', { className: 'motion-tile-sub' });
    const idleBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' });
    const removeBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '삭제' });
    const downloadBtn = el('a', {
      className: 'btn btn-ghost btn-sm', href: H.downloadUrl(`/api/media/${encodeURIComponent(motion.id)}`), download: '',
      text: motion.mime === 'video/webm' ? '다운로드 (MOV)' : '다운로드 (MP4)',
      title: motion.mime === 'video/webm' ? '투명 배경을 유지한 MOV(ProRes 4444)로 받습니다.' : '배경이 있는 그대로 MP4로 받습니다.',
    });
    // Only for a clip that still has its background (an uploaded video, a result added as it was).
    const keyBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '배경 제거' });
    const aiKeyBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: 'AI로 배경 제거 (유료)' });
    // Only for a clip whose background was removed here: the clip as it was is kept.
    const restoreBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '원본 영상으로' });
    // The picture is the play button: a click plays the clip once from the start
    // (the idle motion loops, as on air), another click stops it.
    const mark = el('span', { className: 'motion-play', 'aria-hidden': 'true', text: '▶' });
    const thumb = el('button', { type: 'button', className: 'motion-thumb checkerboard' }, [video, badge, mark]);
    const node = el('div', { className: 'motion-tile', role: 'listitem', dataset: { id: motion.id } }, [
      thumb,
      name,
      sub,
      el('div', { className: 'motion-tile-actions' }, [idleBtn, keyBtn, aiKeyBtn, restoreBtn, downloadBtn, removeBtn]),
    ]);
    const tile = { node, video, thumb, badge, name, sub, idleBtn, removeBtn, keyBtn, aiKeyBtn, restoreBtn, downloadBtn, isIdle: false, mime: motion.mime };
    const setPlaying = (playing) => {
      node.classList.toggle('is-playing', playing);
      mark.textContent = playing ? '■' : '▶';
      thumb.setAttribute('aria-pressed', String(playing));
    };
    const stop = () => {
      video.pause();
      video.currentTime = 0;
      setPlaying(false);
    };
    thumb.addEventListener('click', () => {
      if (!video.paused) return stop();
      // One clip at a time.
      for (const other of motionNodes.values()) if (other !== tile && !other.video.paused) other.thumb.click();
      video.loop = tile.isIdle;
      video.currentTime = 0;
      setPlaying(true);
      video.play().catch(() => setPlaying(false));
    });
    video.addEventListener('ended', stop);
    return tile;
  }

  function updateMotionTile(tile, character, { motion, photo, index }, several) {
    const isIdle = motion.isIdle === true;
    // Unsetting only makes sense for a choice: the default idle is not a setting.
    const chosen = isIdle && photo.idleBy === 'choice';
    tile.isIdle = isIdle;
    tile.node.classList.toggle('is-idle', isIdle);
    tile.badge.hidden = !isIdle;
    tile.thumb.setAttribute('aria-label', `${motion.name} 재생해 보기`);
    tile.thumb.title = '눌러서 재생해 보기';
    tile.name.textContent = motion.name;
    tile.name.title = motion.name;
    tile.sub.textContent = several ? H.photoLabel(character, index) : '';
    tile.idleBtn.hidden = isIdle && !chosen;
    tile.idleBtn.textContent = chosen ? '대기 해제' : '대기 동작으로';
    tile.idleBtn.title = chosen
      ? '직접 고른 대기 동작을 해제합니다 (기본 대기 동작이 있으면 그 영상, 없으면 사진으로 돌아갑니다)'
      : '방송 중 다른 동작이 재생되지 않을 때 이 영상을 반복 재생합니다';
    tile.idleBtn.disabled = motionBusy;
    tile.removeBtn.disabled = motionBusy;
    const background = motion.hasBackground === true;
    tile.keyBtn.hidden = !background;
    tile.keyBtn.disabled = motionBusy;
    tile.keyBtn.title = '초록·파랑·분홍 단색 배경이나, 가장자리와 이어진 단색 배경을 지웁니다 (무료)';
    tile.keyBtn.onclick = () => keyMotion(motion, null);
    tile.aiKeyBtn.hidden = !background || state.backgroundAi?.available !== true;
    tile.aiKeyBtn.disabled = motionBusy;
    if (state.backgroundAi) tile.aiKeyBtn.textContent = `AI로 배경 제거 (1초당 ${H.priceText(state.backgroundAi.videoUsdPerSecond, state.billing)})`;
    tile.aiKeyBtn.title = 'AI가 영상에서 배경을 알아보고 지웁니다. 단색이 아닌 배경도 됩니다';
    tile.aiKeyBtn.onclick = () => {
      const ai = state.backgroundAi;
      const price = `1초당 ${H.priceText(ai.videoUsdPerSecond, state.billing)}, 최소 ${ai.videoMinSeconds}초`;
      if (window.confirm(`AI로 '${motion.name}' 영상의 배경을 지웁니다. 비용: ${price}. 진행할까요?`)) keyMotion(motion, 'ai');
    };
    tile.restoreBtn.hidden = motion.hasOriginal !== true;
    tile.restoreBtn.disabled = motionBusy;
    tile.restoreBtn.title = '배경을 지우기 전의 영상으로 되돌립니다';
    tile.restoreBtn.onclick = () => restoreMotion(motion);
    // The file changed (its background is gone, or it is back): load it again.
    if (tile.mime !== motion.mime || tile.hadBackground !== background) {
      if (tile.hadBackground !== undefined) tile.video.src = `/api/media/${encodeURIComponent(motion.id)}?v=${Date.now()}`;
      tile.mime = motion.mime;
      tile.hadBackground = background;
      tile.downloadBtn.textContent = motion.mime === 'video/webm' ? '다운로드 (MOV)' : '다운로드 (MP4)';
      tile.downloadBtn.title = motion.mime === 'video/webm' ? '투명 배경을 유지한 MOV(ProRes 4444)로 받습니다.' : '배경이 있는 그대로 MP4로 받습니다.';
    }
    tile.idleBtn.onclick = () => setIdleMotion(character, photo, chosen ? null : motion);
    tile.removeBtn.onclick = () => deleteMotion(motion);
  }

  async function setIdleMotion(character, photo, motion) {
    if (motionBusy) return;
    motionBusy = true;
    renderMotions();
    setStatus(motionsStatus, '');
    try {
      const path = `/api/characters/${encodeURIComponent(character.id)}/photos/${encodeURIComponent(photo.id)}/idle`;
      applyList(await api('PUT', path, { json: { motionId: motion ? motion.id : null }, errorText: H.serverErrorText }));
      setStatus(motionsStatus, motion ? `'${motion.name}'을(를) 대기 동작으로 정했습니다` : '기본 대기 동작으로 돌아갔습니다', 'success');
    } catch (error) {
      setStatus(motionsStatus, `대기 동작 바꾸기 실패: ${error.message}`, 'error');
    } finally {
      motionBusy = false;
      renderMotions();
    }
  }

  // Remove the background of a motion in place (free, or the paid AI remover when asked).
  async function keyMotion(motion, method) {
    if (motionBusy) return;
    motionBusy = true;
    renderMotions();
    setStatus(motionsStatus, method === 'ai' ? `AI로 '${motion.name}'의 배경을 지우는 중… (영상 길이에 따라 1~2분 걸릴 수 있습니다)` : `'${motion.name}'의 배경을 지우는 중…`);
    try {
      applyList(await api('POST', `/api/media/${encodeURIComponent(motion.id)}/key`, { json: method ? { method } : {} }));
      setStatus(motionsStatus, `'${motion.name}'의 배경을 지웠습니다. 원본 영상은 보관되어 '원본 영상으로'로 되돌릴 수 있습니다`, 'success');
    } catch (error) {
      setStatus(motionsStatus, `배경 제거 실패: ${error.message}`, 'error');
    } finally {
      motionBusy = false;
      renderMotions();
    }
  }

  // Back to the clip as it was before its background was removed.
  async function restoreMotion(motion) {
    if (motionBusy || !window.confirm(`'${motion.name}'을(를) 배경을 지우기 전의 원본 영상으로 되돌릴까요? 배경을 지운 영상은 사라지고, AI로 다시 지우면 비용이 다시 듭니다.`)) return;
    motionBusy = true;
    renderMotions();
    setStatus(motionsStatus, '');
    try {
      applyList(await api('DELETE', `/api/media/${encodeURIComponent(motion.id)}/key`));
      setStatus(motionsStatus, `'${motion.name}'을(를) 원본 영상으로 되돌렸습니다`, 'success');
    } catch (error) {
      setStatus(motionsStatus, `원본으로 되돌리기 실패: ${error.message}`, 'error');
    } finally {
      motionBusy = false;
      renderMotions();
    }
  }

  async function deleteMotion(motion) {
    if (motionBusy || !window.confirm(`'${motion.name}' 동작을 지울까요?`)) return;
    motionBusy = true;
    renderMotions();
    setStatus(motionsStatus, '');
    try {
      await api('DELETE', `/api/media/${encodeURIComponent(motion.id)}`);
      await loadCharacters();
    } catch (error) {
      setStatus(motionsStatus, `삭제 실패: ${error.message}`, 'error');
    } finally {
      motionBusy = false;
      renderMotions();
    }
  }

  function createCharacterRow(characterId) {
    const nameId = `char-row-${characterId}`;
    const name = el('span', { className: 'char-row-name', id: nameId });
    const count = el('span', { className: 'char-row-count' });
    const live = el('span', { className: 'badge badge-live', text: '방송 중' });
    const drop = photoDropTemplate.content.firstElementChild.cloneNode(true);
    const scroller = el('div', { className: 'strip-scroller', role: 'list', 'aria-labelledby': nameId }, [
      el('div', { className: 'strip-lead' }, [drop]),
    ]);
    const node = el('div', { className: 'char-row', role: 'group', 'aria-labelledby': nameId, dataset: { id: characterId } }, [
      el('div', { className: 'char-row-head' }, [name, count, live]),
      el('div', { className: 'strip', dataset: { strip: '' } }, [scroller]),
    ]);
    const row = {
      node, name, count, live, drop, scroller,
      dropTitle: drop.querySelector('.dropzone-title'),
      dropSub: drop.querySelector('.dropzone-sub'),
      tiles: new Map(), // photo id -> tile (see createPhotoTile)
      strip: setupStrip(scroller),
    };
    drop.addEventListener('click', () => {
      if (state.busy.photo != null) return;
      photoInputTarget = characterId;
      characterInput.click();
    });
    acceptDrops(node, drop, files => addPhotos(characterId, files));
    return row;
  }

  function updateCharacterRow(row, character) {
    const chosen = chosenPhoto()?.character.id === character.id;
    const busy = state.busy.photo === character.id;
    const photos = (Array.isArray(character.photos) ? character.photos : []).filter(photo => photo && typeof photo.id === 'string');
    row.node.classList.toggle('is-chosen', chosen);
    row.name.textContent = character.name;
    row.name.title = character.name;
    row.count.textContent = `사진 ${photos.length}장`;
    row.live.hidden = !character.onAir;
    // Paste goes to the chosen photo's character, so only its row mentions it.
    row.dropTitle.textContent = busy ? state.busy.photoText || '올리는 중…' : '+ 사진 추가';
    row.dropSub.textContent = chosen ? '클릭 · 끌어다 놓기 · 붙여넣기(⌘V / Ctrl+V)' : '클릭 · 끌어다 놓기';
    row.drop.setAttribute('aria-label', `${character.name}에 사진 추가: 끌어다 놓거나 눌러서 고르기${chosen ? ', 붙여넣기' : ''}`);
    row.drop.setAttribute('aria-busy', String(busy));
    const seen = new Set();
    photos.forEach((photo, index) => {
      seen.add(photo.id);
      let tile = row.tiles.get(photo.id);
      if (!tile) {
        tile = createPhotoTile(photo.id);
        row.tiles.set(photo.id, tile);
      }
      updatePhotoTile(tile, character, photo, index);
      const at = row.scroller.children[index + 1] || null; // after the lead tile
      if (at !== tile.node) row.scroller.insertBefore(tile.node, at);
    });
    for (const [id, tile] of row.tiles) {
      if (seen.has(id)) continue;
      tile.node.remove();
      row.tiles.delete(id);
    }
    row.strip.refresh();
  }

  function createPhotoTile(photoId) {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
    const caption = el('span', { className: 'char-name' });
    const pick = el('button', { type: 'button', className: 'char-pick', onclick: () => selectPhoto(photoId, { byUser: true }) }, [
      el('span', { className: 'char-thumb checkerboard' }, [img]),
      caption,
    ]);
    const check = el('span', { className: 'char-check', 'aria-hidden': 'true', text: '✓' });
    const live = el('span', { className: 'char-tag char-tag-live', text: '방송 중' });
    // Shown while the pointer or the focus is on the tile.
    const remove = el('button', { type: 'button', className: 'char-delete', title: '사진 삭제', text: '×', onclick: () => deletePhoto(H.findPhoto(state.list, photoId)) });
    const node = el('div', { className: 'char-tile', role: 'listitem', dataset: { id: photoId } }, [pick, check, live, remove]);
    return { node, pick, img, caption, check, live, remove };
  }

  function updatePhotoTile(tile, character, photo, index) {
    const selected = photo.id === state.photoId;
    const label = H.photoLabel(character, index);
    tile.node.classList.toggle('is-selected', selected);
    // What OBS shows for the photo: its cutout when the plain background was cut out.
    const src = photo.displayUrl || photo.url;
    if (tile.img.getAttribute('src') !== src) tile.img.src = src;
    tile.caption.textContent = H.photoCaption(photo);
    tile.caption.title = label;
    tile.check.hidden = !selected;
    tile.live.hidden = !photo.onAir;
    tile.remove.setAttribute('aria-label', `${label} 삭제`);
    tile.pick.setAttribute('aria-pressed', String(selected));
    const notes = [photo.isBase ? '기본' : '', photo.onAir ? '방송 중' : ''].filter(Boolean).join(', ');
    tile.pick.setAttribute('aria-label', `${label}${notes ? ` (${notes})` : ''}${selected ? ', 선택됨' : ' 선택'}`);
  }

  // Scroll a photo's strip (never the page) so its tile is not under the lead tile or the edge.
  function revealPhoto(photoId) {
    for (const row of charRows.values()) {
      const tile = row.tiles.get(photoId);
      if (!tile) continue;
      const lead = row.scroller.querySelector('.strip-lead');
      const box = row.scroller.getBoundingClientRect();
      const rect = tile.node.getBoundingClientRect();
      const left = box.left + (lead ? lead.offsetWidth : 0) + 8;
      const right = box.right - 8;
      if (rect.left < left) row.scroller.scrollLeft -= left - rect.left;
      else if (rect.right > right) row.scroller.scrollLeft += rect.right - right;
      return;
    }
  }

  // Answers can arrive out of order: a list request started before a newer
  // answer was shown is dropped. Mutation answers count from when they arrive.
  let listClock = 0;
  let listShownAt = 0;
  let photoInputTarget = null; // the character the file picker adds photos to

  // Show a character list (GET /api/characters, or a mutation's answer).
  function applyList(data, at = ++listClock) {
    if (!data || !Array.isArray(data.characters) || at < listShownAt) return;
    listShownAt = at;
    state.list = {
      characters: data.characters,
      activePhotoId: typeof data.activePhotoId === 'string' ? data.activePhotoId : null,
      activeCharacterId: typeof data.activeCharacterId === 'string' ? data.activeCharacterId : null,
    };
    // Keep the choice while it exists (the first list starts from ?photo=).
    const first = state.photoId == null;
    const next = H.choosePhotoId(state.list, first ? requestedPhotoId : state.photoId);
    setPhoto(next);
    updateLibraryIds();
    renderCharacters();
    renderCreate();
    renderUpload();
    renderJobs();
    if (first && next) {
      requestAnimationFrame(() => {
        revealPhoto(next);
        revealCharacter(chosenPhoto()?.character.id);
      });
    }
  }

  async function loadCharacters() {
    const at = ++listClock;
    applyList(await api('GET', '/api/characters', { errorText: H.serverErrorText }), at);
  }

  // Refresh soon (the library view changed, or the tab came back): the other
  // pages may have added, deleted or put photos on air meanwhile.
  let listTimer = null;
  function scheduleCharacters() {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => loadCharacters().catch(() => {}), 150);
  }
  window.addEventListener('focus', scheduleCharacters);

  // The page URL names the chosen photo (?photo=), so a reload keeps it. It is
  // only rewritten for a choice the user made, or when it names a photo that is gone.
  function setPhoto(photoId, { byUser = false } = {}) {
    state.photoId = photoId || null;
    const url = new URL(window.location.href);
    const named = url.searchParams.get('photo');
    if ((byUser || (named && named !== state.photoId)) && named !== state.photoId) {
      history.replaceState(history.state, '', `${url.pathname}${H.searchWithPhoto(url.search, state.photoId)}${url.hash}`);
    }
  }

  function selectPhoto(photoId, { byUser = false } = {}) {
    if (!H.findPhoto(state.list, photoId)) return;
    setPhoto(photoId, { byUser });
    setStatus(characterStatus, '');
    renderCharacters();
    renderCreate();
    renderUpload();
    renderJobs(); // the results listed are the chosen character's
    revealPhoto(photoId);
    revealCharacter(chosenPhoto()?.character.id);
  }

  // Upload images one by one as photos of `characterId`; with `createName`
  // and no character, the first image makes a new character first. The last
  // photo added becomes the chosen one.
  async function uploadPhotoFiles(files, { characterId = null, createName = null } = {}) {
    if (files.length === 0) return;
    if (state.busy.photo != null) {
      setStatus(characterStatus, '올리는 중에는 더 올릴 수 없습니다. 끝난 뒤 다시 해 주세요', 'error');
      return;
    }
    const images = files.filter(file => H.fileKind(file.name, file.type) === 'image');
    const errors = [];
    if (images.length < files.length) errors.push('이미지 파일만 올릴 수 있습니다');
    const fitting = images.filter(file => file.size <= MAX_PHOTO_BYTES);
    if (fitting.length < images.length) errors.push('사진은 20MB까지 올릴 수 있습니다');
    setStatus(characterStatus, errors.join(' · '), errors.length ? 'error' : null);
    if (fitting.length === 0) return;
    let target = characterId;
    let lastId = null;
    let created = null;
    state.busy.photo = target || '';
    try {
      for (const [index, file] of fitting.entries()) {
        state.busy.photoText = fitting.length > 1 ? `올리는 중… (${index + 1}/${fitting.length})` : '올리는 중…';
        if (!target) setStatus(characterStatus, `'${createName}' 캐릭터를 만드는 중…`);
        renderCharacters();
        const contentType = file.type || 'application/octet-stream';
        try {
          if (target) {
            const data = await api('POST', `/api/characters/${encodeURIComponent(target)}/photos?filename=${encodeURIComponent(file.name)}`,
              { body: file, contentType, errorText: H.serverErrorText });
            applyList(data);
            if (data?.photo?.id) lastId = data.photo.id;
          } else {
            const query = `name=${encodeURIComponent(createName)}&filename=${encodeURIComponent(file.name)}`;
            const data = await api('POST', `/api/characters?${query}`, { body: file, contentType, errorText: H.serverErrorText });
            applyList(data);
            created = data?.character || null;
            target = created?.id || null;
            lastId = created?.basePhotoId || null;
            state.busy.photo = target;
            if (!target) break;
          }
        } catch (error) {
          errors.push(`${target ? '올리기' : '만들기'} 실패: ${error.message}`);
          setStatus(characterStatus, errors.join(' · '), 'error');
          if (!target) break; // no character to add the other images to
        }
      }
    } finally {
      state.busy.photo = null;
      state.busy.photoText = '';
    }
    if (lastId && H.findPhoto(state.list, lastId)) selectPhoto(lastId, { byUser: true });
    else renderCharacters();
    if (errors.length) {
      setStatus(characterStatus, errors.join(' · '), 'error');
    } else if (lastId) {
      setStatus(characterStatus, created
        ? `'${created.name}' 캐릭터를 만들었습니다. 이름은 캐릭터 목록에서 바꿀 수 있습니다`
        : '사진을 추가했습니다', 'success');
    }
  }

  function addPhotos(characterId, files) {
    return uploadPhotoFiles(files, { characterId });
  }

  characterInput.addEventListener('change', () => {
    const files = Array.from(characterInput.files || []);
    characterInput.value = '';
    if (photoInputTarget) addPhotos(photoInputTarget, files);
  });

  // Paste (Cmd+V / Ctrl+V) anywhere on the page adds copied images as new
  // photos of the chosen photo's character (no focus needed, since only the
  // character card takes images); with no character yet it makes '캐릭터 N'.
  // A paste with no image (plain text into a field) is left to the browser.
  document.addEventListener('paste', (event) => {
    const pasted = H.pastedImages(event.clipboardData);
    if (pasted.length === 0) return;
    event.preventDefault();
    if (state.list == null) {
      setStatus(characterStatus, '캐릭터를 불러온 뒤 다시 붙여넣어 주세요', 'error');
      return;
    }
    if (state.busy.photo != null) {
      setStatus(characterStatus, '올리는 중에는 붙여넣을 수 없습니다. 끝난 뒤 다시 붙여넣어 주세요', 'error');
      return;
    }
    const files = pasted.map(({ file, name }) =>
      name === file.name ? file : new File([file], name, { type: file.type || 'image/png' }));
    const target = H.pasteTarget(state.list, state.photoId);
    const zone = target.kind === 'photo' ? charRows.get(target.characterId)?.drop : null;
    if (zone) {
      zone.classList.add('is-dragover');
      setTimeout(() => zone.classList.remove('is-dragover'), 600);
    }
    characterCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (target.kind === 'photo') addPhotos(target.characterId, files);
    else uploadPhotoFiles(files, { createName: target.name });
  });

  // ---- How: AI로 만들기 | 완성된 영상 올리기 ----
  function showPath(path, { focus = false } = {}) {
    for (const tab of pathTabs) {
      const on = tab.dataset.path === path;
      tab.classList.toggle('is-selected', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    aiPath.hidden = path !== 'ai';
    uploadPath.hidden = path !== 'upload';
    // A strip measured while hidden has no size: measure it again.
    if (path === 'ai') drivingStrip.refresh({ more: state.drivingShown < state.drivings.length });
  }

  for (const tab of pathTabs) {
    tab.addEventListener('click', () => showPath(tab.dataset.path));
    // Arrow keys move between the two tabs (roving tabindex).
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = pathTabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? pathTabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + pathTabs.length) % pathTabs.length;
      showPath(pathTabs[next].dataset.path, { focus: true });
    });
  }

  // ---- 2. 완성된 영상 올리기 (the other path) ----
  // One video at a time: pick or drop it, name it (default: the file name),
  // upload it with progress. The server keys or converts it before answering.
  const upload = { file: null, defaultName: '', busy: false };
  presetNamesList.replaceChildren(...[window.VirtuallyMotions.IDLE_MOTION_NAME, ...H.presetNames()].map(label => el('option', { value: label })));

  function renderUpload() {
    const chosen = chosenPhoto();
    motionTarget.textContent = chosen
      ? `선택한 사진에 추가합니다: ${H.photoLabel(chosen.character, chosen.index)}`
      : '위에서 캐릭터 사진을 먼저 골라 주세요';
    motionDrop.setAttribute('aria-busy', String(upload.busy));
    motionDropTitle.textContent = upload.busy ? '올리는 중…' : upload.file ? upload.file.name : '영상을 끌어다 놓으세요';
    motionName.disabled = upload.busy;
    motionUploadBtn.disabled = upload.busy || !upload.file || !chosen;
    motionUploadBtn.textContent = upload.busy ? '올리는 중…' : '동작으로 추가하기';
  }

  function chooseMotionFile(files) {
    if (upload.busy || files.length === 0) return;
    const file = files.find(item => !H.motionFileProblem(item)) || null;
    if (!file) {
      setStatus(motionUploadStatus, H.motionFileProblem(files[0]), 'error');
      return;
    }
    // The name follows the chosen file until the user types a different one.
    const typed = motionName.value.trim();
    if (!typed || typed === upload.defaultName) motionName.value = H.fileBaseName(file.name);
    upload.file = file;
    upload.defaultName = H.fileBaseName(file.name);
    setStatus(motionUploadStatus, files.length > 1 ? '한 번에 영상 하나씩 올립니다. 첫 영상을 골랐습니다' : '');
    renderUpload();
  }

  motionDrop.addEventListener('click', () => { if (!upload.busy) motionInput.click(); });
  motionInput.addEventListener('change', () => {
    const files = Array.from(motionInput.files || []);
    motionInput.value = '';
    chooseMotionFile(files);
  });
  acceptDrops(motionUploadCard, motionDrop, chooseMotionFile);
  motionUploadBtn.addEventListener('click', () => uploadMotion());
  motionName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !motionUploadBtn.disabled) uploadMotion();
  });

  function uploadMotion() {
    const chosen = chosenPhoto();
    const file = upload.file;
    if (!chosen || !file || upload.busy) return;
    const path = H.motionUploadPath(chosen.character.id, chosen.photo.id, { name: motionName.value, filename: file.name });
    upload.busy = true;
    renderUpload();
    motionProgress.hidden = false;
    motionProgress.value = 0;
    setStatus(motionUploadStatus, '올리는 중… 0%');
    // XHR for upload progress. It bypasses auth.js's fetch guard, so a
    // refused login is sent to /login here.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('Content-Type', H.videoContentType(file.name, file.type));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || !event.total) return;
      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      motionProgress.value = percent;
      setStatus(motionUploadStatus, `올리는 중… ${percent}%`);
    });
    xhr.upload.addEventListener('load', () => {
      motionProgress.removeAttribute('value'); // indeterminate while the server works
      setStatus(motionUploadStatus, '영상을 확인하고 배경을 지우는 중…');
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 401 && String(xhr.getResponseHeader('X-Virtually-Auth') || '').toLowerCase() === 'required') {
        const auth = window.VirtuallyAuth;
        if (auth && typeof auth.loginUrlFor === 'function') {
          window.location.assign(auth.loginUrlFor(window.location.pathname, window.location.search));
        }
      }
      if (xhr.status === 201 && data?.motion) finishUpload(data);
      else failUpload(H.serverErrorText(data || { error: `HTTP ${xhr.status}` }));
    });
    xhr.addEventListener('error', () => failUpload('서버에 연결할 수 없습니다'));
    xhr.addEventListener('abort', () => failUpload('올리기를 멈췄습니다'));
    xhr.send(file);
  }

  function endUpload() {
    upload.busy = false;
    motionProgress.hidden = true;
    motionProgress.value = 0;
    renderUpload();
  }

  function finishUpload(data) {
    const motion = data.motion;
    const result = H.uploadResultText(data);
    upload.file = null;
    upload.defaultName = '';
    motionName.value = '';
    endUpload();
    setStatus(motionUploadStatus, `'${motion.name}' 동작을 추가했습니다 · ${result.text}`, result.kind);
    applyList(data);
    if (state.libraryIds && typeof motion.id === 'string') state.libraryIds.add(motion.id);
    // The stored clip as the overlay will play it: transparent ones over the checkerboard.
    const transparent = motion.mime === 'video/webm' && result.kind === 'success';
    const video = el('video', {
      className: 'job-video',
      src: motion.url,
      controls: true,
      muted: true,
      loop: true,
      autoplay: true,
      playsInline: true,
      preload: 'metadata',
    });
    motionResult.replaceChildren(el('div', { className: `job-frame${transparent ? ' checkerboard' : ''}` }, [video]));
    motionResult.hidden = false;
    video.play().catch(() => { /* autoplay may be blocked; controls remain */ });
  }

  function failUpload(message) {
    endUpload();
    setStatus(motionUploadStatus, `올리기 실패: ${message}`, 'error');
  }

  // ---- 3. Routes ----
  function routeOptionsFor(route) {
    return H.effectiveOptions(route, state.options[route.id] || {});
  }

  function routeCost(route) {
    return H.routeCostText(route, selectedDriving()?.duration, routeOptionsFor(route), state.billing);
  }

  let routesMoreOpen = false;

  function renderRoutes() {
    // Keep the selection if it is still available, else the first available route.
    if (!state.routes.some(r => r.id === state.routeId && r.available)) {
      state.routeId = state.routes.find(r => r.available)?.id || null;
    }
    const seconds = selectedDriving()?.duration;
    const focusedId = routeList.contains(document.activeElement) ? document.activeElement.value : null;
    const fragment = document.createDocumentFragment();
    if (state.routes.length === 0) fragment.append(el('p', { className: 'muted', text: '모델 없음' }));
    const groupNodes = routes => H.groupRoutes(routes).map(group => el('fieldset', { className: 'route-group' }, [
      el('legend', { text: group.familyLabel }),
      ...group.routes.map(route => routeRow(route, H.routeState(route, seconds))),
    ]));
    // WaveSpeed (the service whose key the server has) first; the other services in a
    // menu closed by default (kept open while it holds the selection or was opened).
    const { main, others } = H.splitRoutes(state.routes);
    fragment.append(...groupNodes(main));
    if (others.length) {
      const open = routesMoreOpen || others.some(route => route.id === state.routeId);
      const more = el('details', { className: 'route-more', open }, [
        el('summary', { text: `다른 서비스 모델 ${others.length}개` }),
        ...groupNodes(others),
      ]);
      more.addEventListener('toggle', () => { routesMoreOpen = more.open; });
      fragment.append(more);
    }
    routeList.replaceChildren(fragment);
    if (focusedId) routeList.querySelector(`input[value="${CSS.escape(focusedId)}"]`)?.focus();
    renderRouteOptions();
    renderMargin();
    renderCreate();
  }

  /** The 여백 select: choices from the payload, reset to the route's default whenever the route changes. */
  function renderMargin() {
    const margins = state.margins;
    const route = selectedRoute();
    const values = margins.map(m => m.value);
    if (state.routeId !== state.marginRouteId || !values.includes(state.margin)) {
      state.margin = H.routeDefaultMargin(route, margins);
      state.marginRouteId = state.routeId;
    }
    marginSelect.replaceChildren(...margins.map(m => el('option', { value: m.value, text: m.label })));
    if (state.margin != null) marginSelect.value = state.margin;
    marginBox.hidden = margins.length === 0;
  }

  marginSelect.addEventListener('change', () => {
    state.margin = marginSelect.value;
  });

  /** "최소 3초" / "최소 없음", or a warning when the selected driving is shorter. */
  function minLengthBadge(route, rs) {
    const min = H.routeMinSeconds(route);
    if (min == null) return el('span', { className: 'badge badge-min', text: '최소 없음' });
    const minText = H.formatSeconds(min);
    if (rs.tooShort) {
      return el('span', {
        className: 'badge badge-warn',
        text: `최소 ${minText}보다 짧음`,
        title: `이 모델은 ${minText} 이상 영상만 받습니다. 지금 영상: ${H.formatSeconds(selectedDriving()?.duration)}`,
      });
    }
    return el('span', { className: 'badge badge-min', text: `최소 ${minText}` });
  }

  function routeRow(route, rs) {
    const badges = [];
    if (!route.verified) badges.push(el('span', { className: 'badge', text: '검증 전' }));
    if (rs.tooLong) badges.push(el('span', { className: 'badge badge-warn', text: `최대 ${Math.floor(H.routeMaxSeconds(route))}초` }));
    badges.push(minLengthBadge(route, rs));
    if (!route.available) {
      badges.push(el('span', {
        className: 'badge badge-muted',
        text: '사용 불가',
        title: H.errorText({ code: route.unavailableCode }),
      }));
    }
    // '10초 · 약 1,600 크레딧': the length the price is for comes first (not for the free route).
    const price = route.available ? routeCost(route) : '';
    const length = H.formatSeconds(selectedDriving()?.duration);
    const cost = price && length && !H.isFreeRoute(route) ? `${length} · ${price}` : price;
    const label = el('label', { className: 'route-pick' }, [
      el('input', {
        type: 'radio',
        name: 'route',
        value: route.id,
        checked: route.id === state.routeId,
        disabled: !rs.selectable,
        onchange: () => {
          state.routeId = route.id;
          renderRoutes();
        },
      }),
      el('span', { className: 'route-name', text: route.label }),
      route.providerLabel && route.providerLabel !== route.label
        ? el('span', { className: 'route-provider', text: route.providerLabel })
        : null,
      ...badges,
      cost ? el('span', { className: 'route-cost', text: cost }) : null,
    ]);
    const row = el('div', {
      className: 'route-row' + (rs.selectable ? '' : ' is-disabled') + (route.id === state.routeId ? ' is-selected' : ''),
    }, [label]);
    return row;
  }

  function renderRouteOptions() {
    const route = selectedRoute();
    const options = route ? H.selectableOptions(route) : [];
    const chosen = route ? routeOptionsFor(route) : {};
    const seconds = Number.isFinite(selectedDriving()?.duration) ? selectedDriving().duration : null;
    routeOptions.replaceChildren(...options.map(option => {
      const id = `opt-${option.key}`;
      const select = el('select', {
        id,
        className: 'select-sm',
        onchange: () => {
          state.options[route.id] = { ...(state.options[route.id] || {}), [option.key]: select.value };
          renderRoutes();
        },
      }, option.values.map((value) => {
        // An option that changes the price says what it costs for this video ('480p · 약 240 크레딧').
        const priced = route.pricing?.byOption?.[option.key]?.[value] != null && seconds != null;
        const price = priced ? H.priceText(H.estimateUsd(route, seconds, { ...chosen, [option.key]: value }), state.billing) : '';
        return el('option', { value: String(value), text: price ? `${value} · ${price}` : String(value) });
      }));
      select.value = String(chosen[option.key]);
      const pricedOption = route.pricing?.byOption?.[option.key] != null;
      return el('div', { className: 'route-option' }, [
        el('label', { for: id, text: option.label || option.key }),
        select,
        pricedOption ? el('span', { className: 'route-option-note', text: '가격이 달라지는 선택입니다' }) : null,
      ]);
    }));
    routeOptions.hidden = options.length === 0;
  }

  function applyStatus(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.routes)) {
      state.routes = data.routes;
      state.margins = H.marginOptions(data);
      renderJobs(); // job cards show margin labels from the payload
    }
    if (data.backgroundAi && typeof data.backgroundAi === 'object') {
      state.backgroundAi = data.backgroundAi;
      renderPhotoBg();
      renderMotions();
    }
    if ('ffmpeg' in data) {
      state.ffmpeg = data.ffmpeg;
      const ok = data.ffmpeg?.available !== false;
      globalStatus.hidden = ok;
      globalStatus.textContent = ok ? '' : 'ffmpeg가 없어 영상을 처리할 수 없습니다';
    }
    renderRoutes();
  }

  // ---- Create ----
  function createBlocker() {
    const driving = selectedDriving();
    const route = selectedRoute();
    if (state.ffmpeg && state.ffmpeg.available === false) return 'ffmpeg가 필요합니다';
    if (!chosenPhoto()) return state.list && H.listPhotos(state.list).length === 0 ? '캐릭터를 먼저 만들어 주세요' : '캐릭터 사진을 고르세요';
    if (!driving) return '동작 영상을 고르세요';
    if (!route) return '모델을 고르세요';
    const rs = H.routeState(route, driving.duration);
    if (rs.tooLong) return '영상이 모델 제한보다 깁니다';
    if (rs.tooShort) return H.tooShortText(driving.duration, H.routeMinSeconds(route));
    return null;
  }

  // 4. 작업 순서: step 1 follows the chosen photo, step 2 the chosen model.
  const aiAvailable = () => state.backgroundAi?.available === true;
  // A photo the free cut cannot do, with an AI cutout kept from before: the checkbox alone
  // means that cutout (nothing runs, nothing is charged), without picking the AI button first.
  const keptAiOnly = (photo) => Boolean(photo) && photo.transparent === 'no' && photo.aiCutReady === true
    && (photo.cutoutReason === 'not_uniform' || photo.cutoutReason === 'no_subject');
  const cutAi = () => aiAvailable() && (state.steps.cutAi || keptAiOnly(chosenPhoto()?.photo));
  const keyAi = () => aiAvailable() && state.steps.keyAi;
  // The paid AI steps of the request as it stands, in USD.
  function extraUsd() {
    const photo = chosenPhoto()?.photo;
    return H.stepsExtraUsd({
      photo, seconds: selectedDriving()?.duration, ai: state.backgroundAi,
      cutAi: cutAi() && state.steps.cut && H.cutStepView(photo, { ai: true }).needed,
      keyAi: keyAi() && state.steps.key,
    });
  }

  function renderSteps() {
    const photo = chosenPhoto()?.photo;
    const ai = state.backgroundAi;
    const cut = H.cutStepView(photo, { ai: cutAi() });
    stepCut.disabled = !cut.needed;
    stepCut.checked = cut.done === true || (cut.needed && state.steps.cut);
    stepCutMethod.hidden = !aiAvailable() || !cut.needed && !(photo && photo.transparent === 'no');
    // The free cut only does a plain one-colour background: its button is off for any other photo.
    const freeCut = !(photo && photo.transparent === 'no' && (photo.cutoutReason === 'not_uniform' || photo.cutoutReason === 'no_subject'));
    if (aiAvailable()) {
      const keyUsd = H.aiVideoUsd(selectedDriving()?.duration, ai);
      setSeg(stepCutMethod, cutAi() ? 'ai' : 'free', {
        // Already cut out by the AI once: the kept cutout is used, nothing runs and nothing is charged.
        ai: photo?.aiCutReady === true
          ? 'AI로 지워 둔 사진 쓰기 (추가 비용 없음)'
          : `유료 · AI로 인식해서 지우기 (${H.priceText(ai.imageUsd, state.billing)})`,
      }, { free: !freeCut });
      setSeg(stepKeyMethod, keyAi() ? 'ai' : 'free', {
        ai: `유료 · AI로 인식해서 지우기 (${keyUsd == null ? `1초당 ${H.priceText(ai.videoUsdPerSecond, state.billing)}` : H.priceText(keyUsd, state.billing)})`,
      });
    }
    const cutCost = cutAi() && cut.needed && state.steps.cut && photo?.aiCutReady !== true ? ` 추가 비용: ${H.priceText(ai.imageUsd, state.billing)}.` : '';
    stepCutNote.textContent = cut.note + cutCost;
    stepKeyMethod.hidden = !aiAvailable();
    const route = selectedRoute();
    stepMakeNote.textContent = route
      ? `${route.label}${route.providerLabel && route.providerLabel !== route.label ? ` · ${route.providerLabel}` : ''}에 요청합니다. 비용이 드는 단계는 이것뿐입니다.`
      : '모델을 골라 주세요.';
    stepKey.checked = state.steps.key;
    if (!state.steps.key) stepKeyNote.textContent = '배경이 있는 영상 그대로 받습니다. 결과에서 배경 제거하기로 나중에 지울 수 있습니다.';
    else if (keyAi()) {
      const usd = H.aiVideoUsd(selectedDriving()?.duration, ai);
      stepKeyNote.textContent = `AI가 영상에서 배경을 알아보고 지웁니다. 배경이 단색으로 나오지 않아도 됩니다.${usd == null ? '' : ` 추가 비용: ${H.priceText(usd, state.billing)}.`}`;
    } else stepKeyNote.textContent = 'AI가 만든 영상의 단색 배경을 색으로 지워 투명 영상으로 만듭니다.';
  }
  stepCut.addEventListener('change', () => { state.steps.cut = stepCut.checked; renderCreate(); });
  stepKey.addEventListener('change', () => { state.steps.key = stepKey.checked; renderCreate(); });
  // A two-button choice: marks the chosen one, sets labels ({ value: text }) and which are off ({ value: true }).
  function setSeg(group, value, labels = {}, disabled = {}) {
    for (const button of group.querySelectorAll('button')) {
      const key = button.dataset.value;
      // The one that cannot be used is never shown as chosen.
      button.setAttribute('aria-pressed', String(key === value && disabled[key] !== true));
      button.disabled = disabled[key] === true;
      button.title = disabled[key] === true ? '단색 배경이 아니라서 무료 방식으로는 지울 수 없습니다' : '';
      if (labels[key]) button.textContent = labels[key];
    }
  }
  stepCutMethod.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button || button.disabled) return;
    state.steps.cutAi = button.dataset.value === 'ai';
    state.steps.cut = true;
    renderCreate();
  });
  stepKeyMethod.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button || button.disabled) return;
    state.steps.keyAi = button.dataset.value === 'ai';
    state.steps.key = true;
    renderCreate();
  });

  // What the request as it stands costs: '3초 · 약 540 크레딧' (the model's price plus the paid AI steps), '' when unknown.
  function totalCostText() {
    const route = selectedRoute();
    const driving = selectedDriving();
    if (!route || !driving) return '';
    const length = H.formatSeconds(driving.duration);
    const extra = extraUsd();
    if (H.isFreeRoute(route)) return extra > 0 ? `${length} · ${H.priceText(extra, state.billing)}` : '무료';
    const routeUsd = H.estimateUsd(route, driving.duration, routeOptionsFor(route));
    if (routeUsd == null) return '';
    return `${length} · ${H.priceText(routeUsd + extra, state.billing)}`;
  }

  function renderCreate() {
    renderSteps();
    const blocker = createBlocker();
    createBtn.disabled = Boolean(blocker) || state.busy.create;
    // The price is on the button: the model list above is long.
    const total = blocker ? '' : totalCostText();
    createBtn.textContent = state.busy.create ? '요청 중…' : total ? `동작 만들기 · ${total}` : '동작 만들기';
    createBtn.title = blocker || '';
    // Show why the button is disabled, without hiding a result or error message.
    if (blocker && (!createStatus.dataset.kind || createStatus.dataset.kind === 'hint')) {
      setStatus(createStatus, blocker, 'hint');
    } else if (!blocker && createStatus.dataset.kind === 'hint') {
      setStatus(createStatus, '');
    }
  }

  function confirmCreate(route, driving) {
    const chosen = chosenPhoto();
    $('confirmPhoto').textContent = chosen ? H.photoLabel(chosen.character, chosen.index) : '';
    $('confirmModel').textContent = `${route.label} · ${route.providerLabel}`;
    $('confirmLength').textContent = H.formatSeconds(driving.duration) || '알 수 없음';
    // The paid AI steps are part of the price.
    const extra = extraUsd();
    const routeUsd = H.estimateUsd(route, driving.duration, routeOptionsFor(route));
    const totalUsd = routeUsd == null ? null : routeUsd + extra;
    $('confirmCost').textContent = (extra > 0 ? H.priceText(totalUsd, state.billing) : routeCost(route)) || '알 수 없음';
    const needed = extra > 0 && H.billingActive(state.billing)
      ? H.creditsForEstimate(totalUsd, state.billing)
      : H.jobCredits(route, driving.duration, routeOptionsFor(route), state.billing);
    const creditLine = H.confirmCreditsText(needed, state.billing?.balance);
    confirmCredits.textContent = creditLine;
    confirmCredits.hidden = !creditLine;
    return new Promise((resolve) => {
      confirmDialog.returnValue = '';
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
      confirmDialog.showModal();
    });
  }

  // ---- Credits (auth.js fills the chip and shares the GET /api/billing payload) ----
  const sharedBilling = window.VirtuallyBilling || null;

  function applyBilling(billing) {
    // A failed request (null) keeps the last payload: the server still charges.
    if (!billing) return;
    state.billing = billing;
    // Before the routes arrive there is no price to redraw (their first render reads state.billing).
    if (state.routes.length > 0) renderRoutes();
    // The 다시 받기 tooltips depend on the account.
    if (state.jobs.length > 0) renderJobs();
  }

  /** Redraw the credits chip and the credit prices from a fresh GET /api/billing. */
  function refreshBilling() {
    if (!sharedBilling || typeof sharedBilling.refresh !== 'function') return;
    sharedBilling.refresh().then(applyBilling).catch(() => {});
  }

  createBtn.addEventListener('click', async () => {
    if (createBlocker()) return;
    const route = selectedRoute();
    const driving = selectedDriving();
    const photo = chosenPhoto()?.photo;
    // The server's verdict: only its free route skips the paid confirmation.
    const free = H.isFreeRoute(route);
    if (!free && !(await confirmCreate(route, driving))) return;
    state.busy.create = true;
    renderCreate();
    setStatus(createStatus, '');
    try {
      const payload = H.jobPayload({
        drivingId: driving.id,
        photoId: photo.id,
        route,
        options: routeOptionsFor(route),
        margin: state.margin,
        margins: state.margins,
        // A photo cut before goes as that cutout (its AI cutout is reused, not paid again).
        cutPhoto: photo.transparent === 'cut' ? (photo.cutoutMethod === 'ai' ? 'ai' : true)
          : H.cutStepView(photo, { ai: cutAi() }).needed && !state.steps.cut ? false : cutAi() ? 'ai' : true,
        keyResult: !state.steps.key ? false : keyAi() ? 'ai' : true,
      });
      const data = await api('POST', '/api/animate/jobs', { json: payload });
      if (data?.job) upsertJob(data.job);
      setStatus(createStatus, '요청했습니다', 'success');
      jobList.firstElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (error) {
      setStatus(createStatus, error.message, 'error');
      if (error.code === 'insufficient_credits') {
        createStatus.append(' ', el('a', { className: 'link', href: '/billing', text: '크레딧 충전' }));
      }
    } finally {
      state.busy.create = false;
      renderCreate();
      // A charge (or a refused one) changes what the chip should say.
      refreshBilling();
    }
  });

  // ---- 4. Jobs ----
  // Rows are keyed by job id and patched in place so a playing result video is
  // not reset by unrelated updates.
  const rows = new Map(); // id -> { li, head, body, media, actions, mediaKey, actionsKey }
  const nameDrafts = new Map(); // job id -> typed motion name
  const showOriginal = new Set(); // job ids viewing the original MP4 instead of the keyed WebM
  const addBusy = new Set();
  const addErrors = new Map();
  const keyBusy = new Set(); // job ids whose background removal is re-running
  const keyErrors = new Map();
  const refetchBusy = new Set(); // job ids whose 다시 받기 request is in flight
  const refetchErrors = new Map();

  function upsertJob(job) {
    state.jobs = H.upsertJob(state.jobs, job);
    renderJobs();
  }

  function removeJob(id) {
    state.jobs = state.jobs.filter(job => job.id !== id);
    renderJobs();
  }

  async function deleteJob(job) {
    if (!window.confirm('이 작업과 결과 영상을 지울까요? 이미 동작으로 추가한 영상은 그대로 남습니다.')) return;
    try {
      await api('DELETE', `/api/animate/jobs/${encodeURIComponent(job.id)}`);
      removeJob(job.id);
    } catch (error) {
      setStatus(createStatus, `삭제 실패: ${error.message}`, 'error');
    }
  }

  function renderJobs() {
    // Only the chosen character's results (every job while there is no character).
    const character = chosenPhoto()?.character || null;
    const jobs = H.jobsOfCharacter(state.jobs, character);
    jobsEmpty.hidden = jobs.length > 0;
    jobsEmpty.textContent = character && state.jobs.length > 0 ? '이 캐릭터로 만든 결과가 아직 없습니다' : '아직 없습니다';
    const seen = new Set();
    jobs.forEach((job, index) => {
      seen.add(job.id);
      let row = rows.get(job.id);
      if (!row) {
        row = createRow();
        rows.set(job.id, row);
      }
      updateRow(row, job);
      if (jobList.children[index] !== row.li) jobList.insertBefore(row.li, jobList.children[index] || null);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.li.remove();
        rows.delete(id);
      }
    }
  }

  function createRow() {
    const head = el('div', { className: 'job-head' });
    const info = el('p', { className: 'job-info' });
    const steps = el('ol', { className: 'job-steps' });
    const colorNote = el('p', { className: 'job-info job-key-color' });
    colorNote.hidden = true;
    const fitNote = el('p', { className: 'job-info job-fit' });
    fitNote.hidden = true;
    const media = el('div', { className: 'job-media' });
    const actions = el('div', { className: 'job-actions' });
    const li = el('li', { className: 'job' }, [head, steps, info, colorNote, fitNote, media, actions]);
    return { li, head, steps, info, colorNote, fitNote, media, actions, mediaKey: null, actionsKey: null, stepsKey: null };
  }

  function updateRow(row, job) {
    const stateLabel = H.JOB_STATE_LABELS[job.state] || String(job.state ?? '');
    row.li.dataset.state = String(job.state ?? '');
    const creditsLabel = H.jobCreditsText(job);
    // Jobs of every character are listed: the title names the job's character.
    const title = [job.characterLabel, job.routeLabel || job.routeId, job.drivingLabel].filter(Boolean).join(' · ');
    row.head.replaceChildren(...[
      el('span', { className: `badge badge-state state-${job.state}`, text: stateLabel }),
      el('span', { className: 'job-title', text: title }),
      creditsLabel
        ? el('span', { className: 'badge job-credits' + (job.billing.refunded === true ? ' is-refunded' : ''), text: creditsLabel })
        : null,
      el('time', { className: 'job-time', dateTime: String(job.createdAt ?? ''), text: H.formatTime(job.createdAt) }),
    ].filter(Boolean));

    const stepList = H.jobSteps(job);
    const stepsKey = JSON.stringify(stepList);
    if (stepsKey !== row.stepsKey) {
      row.stepsKey = stepsKey;
      row.steps.replaceChildren(...stepList.map(step => el('li', { dataset: { kind: step.kind }, text: `${step.label}: ${step.text}` })));
    }

    let info = '';
    let infoKind = null;
    if (H.ACTIVE_STATES.has(job.state)) info = [H.progressText(job), H.jobTimingText(job)].filter(Boolean).join(' · ');
    else if (job.state === 'failed') { info = H.errorText(job.error); infoKind = 'error'; }
    else if (job.state === 'succeeded') info = [H.jobTimingText(job), H.resultLengthText(job), H.keyNote(job)].filter(Boolean).join(' · ');
    info = [H.marginText(job, state.margins), info].filter(Boolean).join(' · ');
    row.info.textContent = info;
    row.info.hidden = !info;
    if (infoKind) row.info.dataset.kind = infoKind;
    else delete row.info.dataset.kind;

    const colorNote = H.keyColorNote(job);
    row.colorNote.textContent = colorNote;
    row.colorNote.hidden = !colorNote;

    const fitNote = job.state === 'succeeded' ? H.fitNote(job) : '';
    row.fitNote.textContent = fitNote;
    row.fitNote.hidden = !fitNote;

    // The keyed WebM plays over the checkerboard; a toggle shows the original MP4.
    const keyedUrl = job.state === 'succeeded' ? job.result?.keyedUrl || null : null;
    const original = !keyedUrl || showOriginal.has(job.id);
    const src = job.state === 'succeeded' && job.result?.url ? (original ? job.result.url : keyedUrl) : null;
    const mediaKey = src ? JSON.stringify([src, keyedUrl]) : null;
    if (mediaKey !== row.mediaKey) {
      row.mediaKey = mediaKey;
      const video = src
        ? el('video', {
          className: 'job-video',
          src,
          poster: original ? job.result.posterUrl || null : null,
          controls: true,
          // The browser's own download would save the WebM: the 다운로드 button gives the right file.
          controlsList: 'nodownload',
          playsInline: true,
          preload: 'metadata',
        })
        : null;
      const toggle = keyedUrl
        ? el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-sm job-toggle',
          text: original ? '배경 지운 영상 보기' : '원본 보기',
          onclick: () => {
            if (showOriginal.has(job.id)) showOriginal.delete(job.id);
            else showOriginal.add(job.id);
            updateRow(row, state.jobs.find(item => item.id === job.id) || job);
          },
        })
        : null;
      // The clip shown, as a file: a transparent one comes as a MOV (it keeps its alpha), the original as MP4.
      const download = src
        ? el('a', { className: 'btn btn-ghost btn-sm job-download', href: H.downloadUrl(src), download: '', text: original ? '다운로드 (MP4)' : '다운로드 (MOV · 투명)' })
        : null;
      row.media.replaceChildren(...(video
        ? [el('div', { className: `job-frame${original ? '' : ' checkerboard'}` }, [video]), el('div', { className: 'job-media-actions' }, [toggle, download].filter(Boolean))]
        : []));
      row.media.hidden = !src;
    }

    const added = H.isAdded(job, state.libraryIds);
    const actionsKey = JSON.stringify([job.state, added, H.isJobOfPhoto(job, state.photoId), addBusy.has(job.id), addErrors.get(job.id) || null,
      keyBusy.has(job.id), keyErrors.get(job.id) || null, aiAvailable(), state.billing?.creditsPerUsd ?? null, H.offersRefetch(job) ? H.refetchTitle(job, state.billing) : null,
      job.canRefetch === true, refetchBusy.has(job.id), refetchErrors.get(job.id) || null]);
    if (actionsKey !== row.actionsKey) {
      row.actionsKey = actionsKey;
      const actions = jobActions(job, added).filter(node => node != null);
      if (!H.ACTIVE_STATES.has(job.state)) {
        actions.push(el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => deleteJob(job) }));
      }
      row.actions.replaceChildren(...actions);
    }
  }

  function jobActions(job, added) {
    if (H.ACTIVE_STATES.has(job.state)) {
      const cancel = el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        text: '취소',
        onclick: async () => {
          // A charged job says whether its credits come back; read the newest view of it.
          const question = H.cancelConfirmText(state.jobs.find(item => item.id === job.id) || job);
          if (question && !window.confirm(question)) return;
          cancel.disabled = true;
          try {
            upsertJob(await api('POST', `/api/animate/jobs/${encodeURIComponent(job.id)}/cancel`, { json: {} }));
          } catch (error) {
            setStatus(createStatus, `취소 실패: ${error.message}`, 'error');
            cancel.disabled = false;
          }
        },
      });
      return [cancel];
    }
    if (job.state !== 'succeeded') {
      if (!H.offersRefetch(job)) return [];
      const refetchBusyNow = refetchBusy.has(job.id);
      const refetchError = refetchErrors.get(job.id);
      return [
        el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-sm',
          disabled: refetchBusyNow,
          text: refetchBusyNow ? '다시 받는 중…' : '다시 받기',
          title: H.refetchTitle(job, state.billing),
          onclick: () => {
            // Taking the credits again asks first; read the newest view of the job.
            const question = H.refetchConfirmText(state.jobs.find(item => item.id === job.id) || job, state.billing);
            if (question && !window.confirm(question)) return;
            refetch(job);
          },
        }),
        refetchError ? el('span', { className: 'status', dataset: { kind: 'error' }, text: refetchError }) : null,
      ];
    }
    // A result of another photo of this character is only shown: its motion goes to its own photo.
    if (!H.isJobOfPhoto(job, state.photoId)) {
      const own = H.findPhoto(state.list, H.jobPhotoId(job));
      return [
        el('span', { className: 'job-added', text: added ? '추가됨 · 다른 사진의 동작입니다' : own ? '다른 사진으로 만든 결과입니다. 해당 사진으로 변경하면 동작으로 추가할 수 있습니다.' : '사진이 지워진 결과라 동작으로 추가할 수 없습니다.' }),
        own ? el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '해당 사진으로 변경', onclick: () => selectPhoto(own.photo.id, { byUser: true }) }) : null,
      ];
    }
    const keyBusyNow = keyBusy.has(job.id);
    const keyError = keyErrors.get(job.id);
    const rekeyButton = el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      disabled: keyBusyNow,
      text: keyBusyNow ? '배경 지우는 중…' : '배경 제거하기',
      title: '이 결과의 배경 제거만 다시 실행합니다. 이미 추가한 동작도 새 투명 영상으로 바뀝니다.',
      onclick: () => rekey(job),
    });
    // The paid AI remover for this result, when the server has it: asks first, with the price.
    const aiUsd = aiAvailable() ? H.aiVideoUsd(Number(job.result?.duration), state.backgroundAi) : null;
    const aiKeyButton = aiUsd == null ? null : el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      disabled: keyBusyNow,
      text: `AI로 배경 제거 (${H.priceText(aiUsd, state.billing)})`,
      title: 'AI가 영상에서 배경을 알아보고 지웁니다. 머리카락 같은 가는 부분도 부드럽게 남고, 배경이 단색이 아니어도 됩니다.',
      onclick: () => {
        if (window.confirm(`AI로 이 영상의 배경을 지웁니다. 비용: ${H.priceText(aiUsd, state.billing)}. 진행할까요?`)) rekey(job, 'ai');
      },
    });
    const rekeyStatus = keyError ? el('span', { className: 'status', dataset: { kind: 'error' }, text: keyError }) : null;
    if (added) {
      return [el('span', { className: 'job-added' }, [
        '추가됨 · ',
        el('a', { className: 'link', href: '/', text: '캐릭터 목록에서 보기' }),
      ]), rekeyButton, aiKeyButton, rekeyStatus];
    }
    const inputId = `name-${job.id}`;
    const input = el('input', {
      id: inputId,
      type: 'text',
      className: 'name-input',
      maxLength: 100,
      value: nameDrafts.has(job.id) ? nameDrafts.get(job.id) : H.defaultMotionName(job),
      oninput: () => nameDrafts.set(job.id, input.value),
    });
    const busy = addBusy.has(job.id);
    const error = addErrors.get(job.id);
    return [
      el('label', { for: inputId, className: 'visually-hidden', text: '동작 이름' }),
      input,
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        disabled: busy,
        text: busy ? '추가 중…' : '동작으로 추가하기',
        onclick: () => addMotion(job, input.value),
      }),
      error ? el('span', { className: 'status', dataset: { kind: 'error' }, text: error }) : null,
      rekeyButton,
      aiKeyButton,
      rekeyStatus,
    ];
  }

  async function rekey(job, method = null) {
    keyBusy.add(job.id);
    keyErrors.delete(job.id);
    renderJobs();
    try {
      const data = await api('POST', `/api/animate/jobs/${encodeURIComponent(job.id)}/key`, { json: method ? { method } : {} });
      if (data?.job) upsertJob(data.job);
      if (!data?.keyed) keyErrors.set(job.id, H.keyNote(data?.job) || '배경을 지우지 못했습니다');
    } catch (error) {
      keyErrors.set(job.id, `배경 제거 실패: ${error.message}`);
    } finally {
      keyBusy.delete(job.id);
      renderJobs();
    }
  }

  // 다시 받기: the server polls the saved provider task again (no new submit). A job
  // whose credits were given back takes them again first.
  async function refetch(job) {
    refetchBusy.add(job.id);
    refetchErrors.delete(job.id);
    renderJobs();
    try {
      upsertJob(await api('POST', `/api/animate/jobs/${encodeURIComponent(job.id)}/refetch`, { json: {} }));
    } catch (error) {
      refetchErrors.set(job.id, H.refetchErrorText(error));
    } finally {
      refetchBusy.delete(job.id);
      renderJobs();
      // A charge (or a refused one) changes what the chip should say.
      refreshBilling();
    }
  }

  async function addMotion(job, rawName) {
    const name = String(rawName ?? '').trim();
    addBusy.add(job.id);
    addErrors.delete(job.id);
    renderJobs();
    try {
      const data = await api('POST', `/api/animate/jobs/${encodeURIComponent(job.id)}/motion`, {
        json: name ? { name } : {},
      });
      if (data?.motion?.id && state.libraryIds) state.libraryIds.add(data.motion.id);
      addBusy.delete(job.id);
      nameDrafts.delete(job.id);
      if (data?.job) upsertJob(data.job);
      scheduleCharacters(); // the photo's motion count changed
    } catch (error) {
      addBusy.delete(job.id);
      if (error.code === 'already_added') {
        // Our view was stale: fetch the job to pick up its motionId.
        if (error.detail?.motionId && state.libraryIds) state.libraryIds.add(error.detail.motionId);
        try { upsertJob(await api('GET', `/api/animate/jobs/${encodeURIComponent(job.id)}`)); } catch { /* keep */ }
      } else {
        addErrors.set(job.id, error.message);
      }
    } finally {
      addBusy.delete(job.id);
      renderJobs();
    }
  }

  async function loadJobs() {
    const data = await api('GET', '/api/animate/jobs');
    const before = new Map(state.jobs.map(job => [job.id, job]));
    // Replace wholesale (newest first) so jobs removed on the server disappear too.
    state.jobs = [];
    for (const job of Array.isArray(data?.jobs) ? data.jobs : []) state.jobs = H.upsertJob(state.jobs, job);
    renderJobs();
    // A reload after a reconnect may bring refunds made while disconnected.
    if (before.size > 0 && state.jobs.some(job => H.refundTurnedOn(before.get(job.id), job))) refreshBilling();
  }

  // ---- Live updates ----
  let everConnected = false;
  // Running jobs show their elapsed time ("1분 5초 경과"); refresh it every second.
  setInterval(() => {
    if (state.jobs.some(job => H.ACTIVE_STATES.has(job.state))) renderJobs();
  }, 1000);

  // Which motions exist, for the jobs' 추가됨 state: every photo's motions (the
  // character list) plus the live view's; null until the list is loaded (then
  // any recorded motionId counts as added).
  function updateLibraryIds() {
    state.libraryIds = state.list ? H.knownMotionIds(state.list, state.viewMotions) : null;
  }

  // While a job is working, its state is also asked for every few seconds: a result must
  // show up even when the live stream is down (a deploy in the middle of a job).
  setInterval(() => {
    if (state.jobs.some(job => H.ACTIVE_STATES.has(job.state))) loadJobs().catch(() => {});
  }, 5000);

  window.VirtuallyMotions.liveEvents('/api/events', { open: () => {
    // After a reconnect, refetch what may have changed while disconnected.
    if (everConnected) {
      loadJobs().catch(() => {});
      scheduleCharacters();
    }
    everConnected = true;
  }, message: (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === 'animate-job-removed' && typeof data.id === 'string') {
      removeJob(data.id);
      return;
    }
    if (data?.type === 'animate-job' && data.job) {
      const previous = state.jobs.find(job => job.id === data.job.id);
      upsertJob(data.job);
      // A failed or canceled job gave its credits back.
      if (H.refundTurnedOn(previous, data.job)) refreshBilling();
    } else if (data?.type === 'library') {
      state.viewMotions = Array.isArray(data.library?.motions) ? data.library.motions : [];
      updateLibraryIds();
      // A job whose motion was deleted from the library can be added again.
      renderJobs();
      // The on-air photo, its motions or its character's name changed: refresh the picker.
      if (state.list) scheduleCharacters();
    }
  } });

  // ---- Boot ----
  renderCharacters();
  renderDrivings();
  renderCreate();
  renderUpload();
  if (sharedBilling && sharedBilling.ready && typeof sharedBilling.ready.then === 'function') {
    sharedBilling.ready.then(applyBilling).catch(() => {});
  }
  (async () => {
    const results = await Promise.allSettled([
      api('GET', '/api/animate/status').then(applyStatus),
      loadDrivings(),
      loadCharacters(),
      loadJobs(),
    ]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) {
      globalStatus.hidden = false;
      globalStatus.textContent = `불러오기 실패: ${failed.reason?.message || ''}`;
    }
  })();
})();
