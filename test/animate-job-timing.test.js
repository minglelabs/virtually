'use strict';

// Job-card timing on the 동작 만들기 page: working time and result length.
const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../public/animate.js');

test('formatElapsed: seconds, minutes, hours', () => {
  assert.equal(H.formatElapsed(0), '0초');
  assert.equal(H.formatElapsed(44_600), '45초');
  assert.equal(H.formatElapsed(59_400), '59초');
  assert.equal(H.formatElapsed(60_000), '1분');
  assert.equal(H.formatElapsed(133_000), '2분 13초');
  assert.equal(H.formatElapsed(3_900_000), '1시간 5분');
  assert.equal(H.formatElapsed(7_200_000), '2시간');
  assert.equal(H.formatElapsed(-1), '');
  assert.equal(H.formatElapsed(Number.NaN), '');
});

test('jobTimingText: finished jobs show the working time, running jobs the elapsed time', () => {
  const createdAt = '2026-09-30T05:00:00.000Z';
  assert.equal(H.jobTimingText({ state: 'succeeded', createdAt, finishedAt: '2026-09-30T05:02:13.400Z' }), '작업 시간 2분 13초');
  assert.equal(H.jobTimingText({ state: 'running', createdAt }, Date.parse('2026-09-30T05:01:05Z')), '1분 5초 경과');
  assert.equal(H.jobTimingText({ state: 'keying', createdAt }, Date.parse('2026-09-30T05:00:30Z')), '30초 경과');
  // Unknown finish time (an old job without a result file): nothing, never a wrong number.
  assert.equal(H.jobTimingText({ state: 'succeeded', createdAt }), '');
  assert.equal(H.jobTimingText({ state: 'succeeded', finishedAt: createdAt }), '');
  assert.equal(H.jobTimingText(null), '');
});

test('resultLengthText: one decimal under 10 s, whole seconds above', () => {
  assert.equal(H.resultLengthText({ result: { duration: 2.966 } }), '영상 3초');
  assert.equal(H.resultLengthText({ result: { duration: 9.9 } }), '영상 9.9초');
  assert.equal(H.resultLengthText({ result: { duration: 12.4 } }), '영상 12초');
  assert.equal(H.resultLengthText({ result: { duration: null } }), '');
  assert.equal(H.resultLengthText({}), '');
});
