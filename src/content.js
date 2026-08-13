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
  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.log(TAG, ...args); };

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

  /** videoId -> true when we believe our own button has disliked it. */
  const dislikedByUs = new Map();

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

  function findActionBar(reel, likeEl) {
    if (likeEl) {
      const anchored = likeEl.closest(ACTION_BAR_SELECTOR);
      if (anchored) return anchored;
    }
    return reel.querySelector(ACTION_BAR_SELECTOR);
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
      resolve({ ok: !!msg.ok, reason: msg.reason });
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
   * @param {'dislike'|'removelike'} action
   * @returns {Promise<{ok: boolean, reason?: string}>}
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

  // Material "thumb up", used only when we cannot clone YouTube's own icon.
  // Rendered rotated 180deg, which is exactly how the dislike glyph is drawn.
  const FALLBACK_PATH = 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z';

  function buildIcon(likeEl) {
    const source = likeEl && likeEl.querySelector('svg');
    if (source && source.querySelector('path')) {
      const clone = source.cloneNode(true);
      clone.removeAttribute('id');
      clone.removeAttribute('class');
      clone.setAttribute('aria-hidden', 'true');
      clone.classList.add('ysd-icon', 'ysd-icon--flip');
      return clone;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ysd-icon', 'ysd-icon--flip');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', FALLBACK_PATH);
    svg.appendChild(path);
    return svg;
  }

  function buildButton(likeEl) {
    const wrap = document.createElement('div');
    wrap.className = 'ysd-wrap';
    wrap.dataset.ysd = '1';

    const btn = document.createElement('button');
    btn.className = 'ysd-btn';
    btn.type = 'button';
    btn.title = 'Dislike';
    btn.setAttribute('aria-label', 'Dislike');
    btn.setAttribute('aria-pressed', 'false');
    btn.appendChild(buildIcon(likeEl));

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

    const was = dislikedByUs.get(videoId) === true;
    const next = !was;

    // Optimistic: flip immediately, roll back if the request fails.
    paint(wrap, next);
    btn.disabled = true;

    const { ok, reason } = await sendAction(videoId, next ? 'dislike' : 'removelike');
    btn.disabled = false;

    if (ok) {
      dislikedByUs.set(videoId, next);
    } else {
      paint(wrap, was);
      toast(reason || 'Could not dislike this Short.');
    }
  }

  function ensureInjected(bar, likeEl, videoId) {
    let wrap = bar.querySelector('[data-ysd]');
    if (!wrap) {
      wrap = buildButton(likeEl);
      const anchor = likeEl ? topLevelIn(bar, likeEl) : null;
      if (anchor) anchor.after(wrap);
      else bar.prepend(wrap);
      log('injected dislike button');
    }
    wrap.dataset.videoId = videoId;
    paint(wrap, dislikedByUs.get(videoId) === true);
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

    const reel = activeReel();
    if (!reel) return;

    const likeEl = reel.querySelector(LIKE_SELECTOR);
    const bar = findActionBar(reel, likeEl);
    if (!bar) return;

    // Strategy 1: YouTube already has a dislike control here — reveal it and
    // stay out of the way.
    const native = bar.querySelector(DISLIKE_SELECTOR);
    if (native) {
      if (isHidden(native)) {
        native.removeAttribute('hidden');
        native.classList.add('ysd-force-visible');
        log('revealed native dislike control');
      }
      removeInjected();
      return;
    }

    // Strategy 2: no native control, inject ours.
    removeInjected(ensureInjected(bar, likeEl, videoId));
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
