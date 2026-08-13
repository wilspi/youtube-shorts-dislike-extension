/*
 * Paste this whole file into the DevTools console while a Short is open
 * (https://www.youtube.com/shorts/...) and share the output.
 *
 * It reports which of the extension's selectors still match YouTube's current
 * DOM, so stale ones can be fixed without guessing.
 *
 * Note: the console runs in the page's world, so `__ysdLoaded` (set by the
 * content script, isolated world) is NOT visible here — `__ysdBridge`, set by
 * the injected page script, is the signal that the content script ran.
 */
(() => {
  const SELECTORS = {
    reel: 'ytd-reel-video-renderer, ytd-shorts-video-renderer, .ytShortsVideoRendererHost',
    shortsRoot: 'ytd-shorts',
    actionBar: '#actions, .ytReelActionBarViewModelHost',
    like: 'like-button-view-model, #like-button, ytd-toggle-button-renderer#like-button, ytd-like-button-renderer',
    dislike: 'dislike-button-view-model, #dislike-button, ytd-toggle-button-renderer#dislike-button, ytd-dislike-button-renderer',
  };

  const describe = (el) => {
    const name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    const r = el.getBoundingClientRect();
    const visible = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    return `${name} [${visible ? 'visible' : 'HIDDEN'} ${Math.round(r.width)}x${Math.round(r.height)}]`;
  };

  const report = {
    url: location.href,
    signedIn: /(^|;\s*)SAPISID=/.test(document.cookie),
    bridgeLoaded: !!window.__ysdBridge,
    injectedButtonPresent: !!document.querySelector('[data-ysd]'),
    matches: {},
  };

  for (const [name, selector] of Object.entries(SELECTORS)) {
    const els = Array.from(document.querySelectorAll(selector));
    report.matches[name] = {
      count: els.length,
      samples: els.slice(0, 4).map(describe),
    };
  }

  const like = document.querySelector(SELECTORS.like);
  if (like) {
    const chain = [];
    for (let n = like, i = 0; n && i < 7; n = n.parentElement, i++) {
      chain.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : ''));
    }
    report.likeAncestry = chain.join('  <  ');

    const bar = like.closest(SELECTORS.actionBar) || like.parentElement;
    report.actionBarChildren = Array.from(bar.children).map(describe);
  } else {
    // Last resort: what buttons are actually in the Shorts overlay?
    report.overlayButtons = Array.from(document.querySelectorAll('button[aria-label]'))
      .filter((b) => b.getClientRects().length)
      .slice(0, 25)
      .map((b) => b.getAttribute('aria-label'));
  }

  console.log(JSON.stringify(report, null, 2));
  return report;
})();
