'use strict';

// A process-wide mutex that lets exactly one video encode run at a time, shared
// by the chroma-key converter (/api/chroma/jobs/:id/convert) and the animate
// pipeline's keying stage. Encoding is CPU/GPU heavy, so serialising avoids
// thrashing the host when a user converts a clip while a motion is being keyed.
//
// Two ways to take the slot:
//   tryAcquire(owner)        -> release | null   (non-blocking; the chroma route
//                                                 uses this so it can answer 409)
//   acquire(owner, signal)   -> Promise<release>  (waits in FIFO order; the
//                                                 pipeline uses this and passes
//                                                 an AbortSignal so a canceled
//                                                 job stops waiting)
// The returned `release` is idempotent. `isBusy()` reports the current holder.

class EncoderSlot {
  constructor() {
    this._owner = null;
    this._waiters = []; // { owner, resolve, reject, signal, onAbort }
  }

  isBusy() {
    return this._owner !== null;
  }

  owner() {
    return this._owner;
  }

  // Take the slot immediately or return null when it is busy. Never waits.
  tryAcquire(owner = 'anonymous') {
    if (this._owner !== null) return null;
    this._owner = owner;
    return this._makeRelease();
  }

  // Wait for the slot in FIFO order. Rejects with an AbortError when `signal`
  // fires before the slot is granted.
  acquire(owner = 'anonymous', signal = null) {
    if (signal && signal.aborted) {
      return Promise.reject(abortError());
    }
    if (this._owner === null) {
      this._owner = owner;
      return Promise.resolve(this._makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = { owner, resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = this._waiters.indexOf(waiter);
          if (index !== -1) this._waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this._waiters.push(waiter);
    });
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._owner = null;
      this._grantNext();
    };
  }

  _grantNext() {
    const waiter = this._waiters.shift();
    if (!waiter) return;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    this._owner = waiter.owner;
    waiter.resolve(this._makeRelease());
  }
}

function abortError() {
  return Object.assign(new Error('The wait for the encoder slot was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

module.exports = { EncoderSlot };
