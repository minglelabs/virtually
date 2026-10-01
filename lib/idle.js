'use strict';

// Which of a photo's motions the overlay shows while nothing plays (its idle).
//
//   1. the motion the user chose for the photo (library.idleChoice[photoId]);
//   2. an idle asset uploaded for the photo (library.idles[photoId], the older way);
//   3. the photo's newest idle motion: one made from an idle loop (source.idle),
//      or named like one ('기본 대기 동작', anything with 대기 or idle in it);
//   4. the photo itself.
// So making the 기본 대기 동작 video is enough: it replaces the still photo at once,
// and the user can pick any other motion of the photo instead.

// The name a result made from an idle loop gets when it is added as a motion.
const IDLE_MOTION_NAME = '기본 대기 동작';

function isIdleMotion(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.source && item.source.idle === true) return true;
  return /대기|idle/i.test(String(item.name ?? ''));
}

// library.json `idleChoice`: { <photoId>: <motionId> }.
function parseIdleChoice(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [photoId, motionId] of Object.entries(value)) {
    if (typeof motionId === 'string' && motionId) out[photoId] = motionId;
  }
  return out;
}

// -> { kind: 'motion', motion, by: 'choice' | 'default' } | { kind: 'upload', item } | { kind: 'photo' }
function resolveIdle(library, photoId) {
  const motions = (library.motions || []).filter(item => item && item.photoId === photoId);
  const chosenId = library.idleChoice ? library.idleChoice[photoId] : null;
  const chosen = chosenId ? motions.find(item => item.id === chosenId) : null;
  if (chosen) return { kind: 'motion', motion: chosen, by: 'choice' };
  if (library.idles && library.idles[photoId]) return { kind: 'upload', item: library.idles[photoId] };
  const defaults = motions.filter(isIdleMotion)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (defaults.length) return { kind: 'motion', motion: defaults[0], by: 'default' };
  return { kind: 'photo' };
}

module.exports = { IDLE_MOTION_NAME, isIdleMotion, parseIdleChoice, resolveIdle };
