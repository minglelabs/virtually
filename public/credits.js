// Credit math shared by the server (lib/billing) and the pages (animate.js,
// billing.js): one formula in one file, so the price a page shows is the price
// the server charges. 1 credit buys 1 / creditsPerUsd US dollars of a job's
// estimated model cost. Credits are sold at 1 KRW each, and the default of 2000
// credits per dollar prices a $0.30 job at 600 credits.
// Loaded in the browser as window.VirtuallyCredits, required by Node as a module.
(function (root) {
  const DEFAULT_CREDITS_PER_USD = 2000;

  /**
   * Credits a job costs for its USD estimate. Null when the price is unknown
   * (no estimate), 0 for a free estimate, otherwise at least 1, rounded up.
   * The 1e-6 slack absorbs float noise: 1.1 * 100 is 110.00000000000001,
   * which must cost 110 credits, not 111.
   */
  function creditsFor(estimateUsd, creditsPerUsd = DEFAULT_CREDITS_PER_USD) {
    if (typeof estimateUsd !== 'number' || !Number.isFinite(estimateUsd)) return null;
    const rate = Number.isInteger(creditsPerUsd) && creditsPerUsd >= 1 ? creditsPerUsd : DEFAULT_CREDITS_PER_USD;
    if (estimateUsd <= 0) return 0;
    return Math.max(1, Math.ceil(estimateUsd * rate - 1e-6));
  }

  const api = Object.freeze({ DEFAULT_CREDITS_PER_USD, creditsFor });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VirtuallyCredits = api;
})(typeof window !== 'undefined' ? window : null);
