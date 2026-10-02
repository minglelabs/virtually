'use strict';

// Driving-video margin: before a reference clip is sent, it is padded with
// black on the left, right and top (never the bottom, so the feet stay on the
// frame edge) by P = round(factor * max(w, h)) px. Wan 2.2 Animate 2 follows
// the driving framing, so the generated character keeps that margin inside
// the frame too. This module is the single source of the values, their UI
// labels and each route's default.

const MARGINS = [
  { value: 'none', label: '없음', factor: 0 },
  { value: 'normal', label: '보통', factor: 0.12 },
  { value: 'wide', label: '넓게', factor: 0.25 },
];
const BY_VALUE = new Map(MARGINS.map(entry => [entry.value, entry]));

function isMargin(value) {
  return typeof value === 'string' && BY_VALUE.has(value);
}

// The route's catalog `defaultMargin` when it is a known value, else 'none'.
function defaultMarginFor(route) {
  return route && isMargin(route.defaultMargin) ? route.defaultMargin : 'none';
}

// A stored job margin (jobs from before margins existed have none -> 'none').
function marginRecord(value) {
  return isMargin(value) ? value : 'none';
}

// Padding in px for a margin on a w x h source.
function marginPx(margin, width, height) {
  const entry = BY_VALUE.get(marginRecord(margin));
  return Math.round(entry.factor * Math.max(Number(width) || 0, Number(height) || 0));
}

// The factor of a margin (0 for 'none' or an unknown value).
function marginFactor(margin) {
  return BY_VALUE.get(marginRecord(margin)).factor;
}

// The `margins` list for the routes payload (value + Korean label).
function marginViews() {
  return MARGINS.map(({ value, label }) => ({ value, label }));
}

module.exports = { MARGINS, isMargin, defaultMarginFor, marginRecord, marginPx, marginFactor, marginViews };
