/*
 * Shorts Dislike Button
 *
 * Adds a dislike control to the YouTube Shorts action bar.
 *
 * Two strategies, in order of preference:
 *   1. If YouTube actually shipped a dislike control for this Short but hid it,
 *      un-hide it and let YouTube handle the click. Always the best outcome:
 *      real state, real optimistic UI, no API guessing.
 *   2. Otherwise inject our own button and send the dislike through YouTube's
 *      own InnerTube endpoint, via the page-context bridge in page.js.
 */
(() => {
  'use strict';

  if (window.__ysdLoaded) return;
  window.__ysdLoaded = true;

  const TAG = '[shorts-dislike]';
  // Toggle at runtime from the console — no code edit, no reload of the
  // extension: localStorage.setItem('ysd-debug', '1')
  let DEBUG = false;
  try {
    DEBUG = localStorage.getItem('ysd-debug') === '1';
  } catch (err) {
    /* storage blocked */
  }

  // sync() runs on a 1s safety-net interval, so repeat messages are dropped to
  // keep the console readable.
  let lastLogged = '';
  function log(...args) {
    if (!DEBUG) return;
    const key = args.join(' ');
    if (key === lastLogged) return;
    lastLogged = key;
    console.log(TAG, ...args);
  }

  const runtime = (globalThis.browser || globalThis.chrome).runtime;

  /* ------------------------------------------------------------------ *
   * Selectors
   *
   * Tag-name selectors come first everywhere: they are language- and
   * theme-independent, unlike aria-label matching which only works on
   * English UIs.
   * ------------------------------------------------------------------ */

  const REEL_SELECTOR = [
    'ytd-reel-video-renderer',
    'ytd-shorts-video-renderer',
    '.ytShortsVideoRendererHost',
  ].join(',');

  const ACTION_BAR_SELECTOR = [
    '#actions',
    '.ytReelActionBarViewModelHost',
    'ytd-reel-player-overlay-renderer #actions',
  ].join(',');

  const LIKE_SELECTOR = [
    'like-button-view-model',
    '#like-button',
    'ytd-toggle-button-renderer#like-button',
    'ytd-like-button-renderer',
  ].join(',');

  const DISLIKE_SELECTOR = [
    'dislike-button-view-model',
    '#dislike-button',
    'ytd-toggle-button-renderer#dislike-button',
    'ytd-dislike-button-renderer',
  ].join(',');

  /**
   * videoId -> true when the account has disliked it.
   *
   * Seeded from YouTube on first sight of a Short (so a reload shows the real
   * state) and updated optimistically on click. This map is the single source
   * of truth for the button: the sync loop repaints from it every second, so
   * anything not recorded here gets clobbered.
   */
  const disliked = new Map();

  /** videoIds we have already asked YouTube about, to keep sync() from looping. */
  const statusAsked = new Set();

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */

  function currentVideoId() {
    const m = location.pathname.match(/^\/shorts\/([\w-]+)/);
    return m ? m[1] : null;
  }

  function isCentered(el) {
    const r = el.getBoundingClientRect();
    if (!r.height) return false;
    const mid = window.innerHeight / 2;
    return r.top <= mid && r.bottom >= mid;
  }

  /**
   * The Shorts feed keeps several reels in the DOM at once; only one is on
   * screen. YouTube marks it with `is-active`, but that attribute has moved
   * around between rollouts, so fall back to whichever reel covers the middle
   * of the viewport.
   */
  function activeReel() {
    const reels = Array.from(document.querySelectorAll(REEL_SELECTOR));
    if (!reels.length) return null;
    return reels.find((r) => r.hasAttribute('is-active'))
      || reels.find(isCentered)
      || null;
  }

  /**
   * The like button is the anchor for everything else — it is the one control
   * that is always present and visible in a Shorts action bar. Prefer the one
   * inside the active reel, but fall back to the whole document so a reel
   * selector that has gone stale cannot take the extension down with it.
   */
  function findLike() {
    const reel = activeReel();
    const scopes = reel ? [reel, document] : [document];
    for (const scope of scopes) {
      const found = Array.from(scope.querySelectorAll(LIKE_SELECTOR));
      const onScreen = found.find((el) => el.getClientRects().length);
      if (onScreen) return onScreen;
      if (found.length) return found[0];
    }
    return null;
  }

  /**
   * Climb from the like button to the element that holds the whole column of
   * action buttons. Used when none of the known action-bar selectors match:
   * the bar is the nearest ancestor with more than one child.
   */
  function inferActionBar(likeEl) {
    let node = likeEl.parentElement;
    for (let i = 0; node && i < 5; i++) {
      if (node.childElementCount >= 2) return node;
      node = node.parentElement;
    }
    return likeEl.parentElement;
  }

  function findActionBar(likeEl) {
    return likeEl.closest(ACTION_BAR_SELECTOR) || inferActionBar(likeEl);
  }

  function isHidden(el) {
    if (el.hasAttribute('hidden')) return true;
    if (!el.getClientRects().length) return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0';
  }

  /** Walk up from `el` to the direct child of `bar` that contains it. */
  function topLevelIn(bar, el) {
    let node = el;
    while (node && node.parentElement && node.parentElement !== bar) {
      node = node.parentElement;
    }
    return node && node.parentElement === bar ? node : null;
  }

  /**
   * Un-hide `el` and any hidden ancestor up to `stopAt`. Revealing the control
   * alone is not enough when YouTube hid a wrapper around it instead.
   */
  function forceVisible(el, stopAt) {
    let node = el;
    for (let i = 0; node && node !== stopAt && i < 6; i++) {
      node.removeAttribute('hidden');
      if (isHidden(node)) node.classList.add('ysd-force-visible');
      node = node.parentElement;
    }
  }

  /** Read toggle state off a native dislike control. */
  function nativePressed(native) {
    const btn = native.querySelector('button') || native;
    return btn.getAttribute('aria-pressed') === 'true';
  }

  /* ------------------------------------------------------------------ *
   * Page-context bridge (see src/page.js)
   * ------------------------------------------------------------------ */

  const pending = new Map();
  let injected = false;
  let sequence = 0;

  function injectBridge() {
    if (injected) return;
    injected = true;

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.source !== 'ysd-response') return;

      const resolve = pending.get(msg.id);
      if (!resolve) return;
      pending.delete(msg.id);
      resolve({ ok: !!msg.ok, reason: msg.reason, likeStatus: msg.likeStatus });
    });

    // Injecting a web-accessible resource as a page script is exempt from the
    // page's CSP in both Chrome and Firefox, unlike an inline script.
    const el = document.createElement('script');
    el.src = runtime.getURL('src/page.js');
    el.onload = () => el.remove();
    (document.head || document.documentElement).appendChild(el);
  }

  /**
   * @param {string} videoId
   * @param {'dislike'|'removelike'|'status'} action
   * @returns {Promise<{ok: boolean, reason?: string, likeStatus?: string}>}
   */
  function sendAction(videoId, action) {
    injectBridge();
    const id = ++sequence;

    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) {
          resolve({ ok: false, reason: 'YouTube did not respond. Try reloading.' });
        }
      }, 10000);
      window.postMessage(
        { source: 'ysd-request', id, action, videoId },
        location.origin,
      );
    });
  }

  /* ------------------------------------------------------------------ *
   * Injected button
   * ------------------------------------------------------------------ */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Material "thumb up". The dislike glyph is this rotated 180deg — the same
  // relationship YouTube's own icon pair has.
  //
  // We deliberately do NOT clone YouTube's like icon to build this. Cloning
  // matched the page's styling perfectly when it worked, but the source SVG
  // depends on which reel is active and how far it has rendered, so scrolling
  // to a new Short could clone a half-built or entirely different icon and
  // paint a blob. A fixed path is one glyph, always.
  const THUMB_PATH = 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z';

  function buildIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ysd-icon');

    // Rotate in the SVG rather than in CSS: a page stylesheet cannot override
    // it, and it cannot be lost if our class is stripped.
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('transform', 'rotate(180 12 12)');

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', THUMB_PATH);
    // Outline when idle, solid when disliked — YouTube's own like/dislike
    // glyphs do the same. Both states stroke the one silhouette, so the icon
    // keeps its size and only its fill changes. The switch lives in the
    // stylesheet, keyed off aria-pressed.
    path.setAttribute('stroke-linejoin', 'round');

    group.appendChild(path);
    svg.appendChild(group);
    return svg;
  }

  function buildButton() {
    const wrap = document.createElement('div');
    wrap.className = 'ysd-wrap';
    wrap.dataset.ysd = '1';

    const btn = document.createElement('button');
    btn.className = 'ysd-btn';
    btn.type = 'button';
    btn.title = 'Dislike';
    btn.setAttribute('aria-label', 'Dislike');
    btn.setAttribute('aria-pressed', 'false');
    btn.appendChild(buildIcon());

    const label = document.createElement('span');
    label.className = 'ysd-label';
    label.textContent = 'Dislike';

    wrap.append(btn, label);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onDislikeClick(wrap, btn);
    });

    return wrap;
  }

  function paint(wrap, pressed) {
    const btn = wrap.querySelector('.ysd-btn');
    if (btn) btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }

  async function onDislikeClick(wrap, btn) {
    const videoId = wrap.dataset.videoId;
    if (!videoId || btn.disabled) return;

    // If YouTube shipped a dislike control and we simply could not make it
    // visible, click it: a hidden button is still clickable, and this way
    // YouTube owns the state and the request. We are only a visible proxy.
    const bar = wrap.closest(ACTION_BAR_SELECTOR) || wrap.parentElement;
    const native = bar && bar.querySelector(DISLIKE_SELECTOR);
    if (native) {
      (native.querySelector('button') || native).click();
      log('proxied click to native dislike control');
      setTimeout(() => paint(wrap, nativePressed(native)), 0);
      return;
    }

    const was = disliked.get(videoId) === true;
    const next = !was;

    // Optimistic: record it before painting, or the next sync() tick repaints
    // from the map and undoes the flip while the request is still in flight.
    disliked.set(videoId, next);
    paint(wrap, next);
    btn.disabled = true;

    const { ok, reason } = await sendAction(videoId, next ? 'dislike' : 'removelike');
    btn.disabled = false;

    if (!ok) {
      disliked.set(videoId, was);
      paint(wrap, was);
      toast(reason || 'Could not dislike this Short.');
    }
  }

  /**
   * Ask YouTube whether this account already disliked the Short, so a reload
   * shows the real state instead of an empty button. Fires once per videoId.
   */
  async function seedStatus(videoId, wrap) {
    if (statusAsked.has(videoId)) return;
    statusAsked.add(videoId);

    const { ok, likeStatus } = await sendAction(videoId, 'status');
    if (!ok || !likeStatus) return;

    // A click that landed while the lookup was in flight wins — it is newer.
    if (disliked.has(videoId)) return;

    disliked.set(videoId, likeStatus === 'DISLIKE');
    log('seeded like status for', videoId, '=', likeStatus);
    if (wrap.isConnected && wrap.dataset.videoId === videoId) {
      paint(wrap, likeStatus === 'DISLIKE');
    }
  }

  function ensureInjected(bar, likeEl, videoId, native) {
    let wrap = bar.querySelector('[data-ysd]');
    if (!wrap) {
      wrap = buildButton();
      const anchor = likeEl ? topLevelIn(bar, likeEl) : null;
      if (anchor) anchor.after(wrap);
      else bar.prepend(wrap);
      log('injected dislike button into', bar.tagName.toLowerCase() + (bar.id ? '#' + bar.id : ''));
    }
    wrap.dataset.videoId = videoId;

    // When proxying a hidden native control, mirror its state rather than our
    // own bookkeeping — YouTube's is authoritative and already correct on load.
    if (native) {
      paint(wrap, nativePressed(native));
      return wrap;
    }

    seedStatus(videoId, wrap);
    paint(wrap, disliked.get(videoId) === true);
    return wrap;
  }

  function removeInjected(except) {
    for (const wrap of document.querySelectorAll('[data-ysd]')) {
      if (wrap !== except) wrap.remove();
    }
  }

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */

  let toastTimer = null;

  function toast(message) {
    let el = document.querySelector('.ysd-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ysd-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4000);
  }

  /* ------------------------------------------------------------------ *
   * Sync loop
   * ------------------------------------------------------------------ */

  function sync() {
    const videoId = currentVideoId();
    if (!videoId) {
      removeInjected();
      return;
    }

    const likeEl = findLike();
    if (!likeEl) {
      log('no like button found — action bar selectors may be stale');
      return;
    }

    const bar = findActionBar(likeEl);
    if (!bar) {
      log('found a like button but could not identify its action bar');
      return;
    }

    // Strategy 1: YouTube already has a dislike control here — reveal it and
    // stay out of the way.
    const native = bar.querySelector(DISLIKE_SELECTOR);
    if (native) {
      forceVisible(native, bar);
      if (!isHidden(native)) {
        log('native dislike control is visible; nothing to do');
        removeInjected();
        return;
      }
      // Could not un-hide it (a wrapper we do not control, a stacking issue,
      // zero-sized layout). Fall through and put our own button in front of it,
      // proxying clicks to the real one.
      log('native dislike control present but stays hidden; proxying it');
    }

    // Strategy 2: our own button.
    removeInjected(ensureInjected(bar, likeEl, videoId, native));
  }

  let queued = false;

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try {
        sync();
      } catch (err) {
        console.warn(TAG, 'sync failed', err);
      }
    });
  }

  function start() {
    injectBridge();
    schedule();

    // YouTube is an SPA: no reloads, so watch for its own navigation event...
    window.addEventListener('yt-navigate-finish', schedule, true);
    window.addEventListener('popstate', schedule);

    // ...plus the DOM churn from scrolling between reels...
    const root = document.querySelector('ytd-app') || document.documentElement;
    new MutationObserver(schedule).observe(root, {
      childList: true,
      subtree: true,
      attributeFilter: ['is-active', 'hidden', 'video-id'],
    });

    // ...plus a cheap safety net for rollouts that do neither. sync() bails in
    // a few reads when there is nothing to do.
    setInterval(schedule, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
