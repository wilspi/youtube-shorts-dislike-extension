/*
 * Page-context bridge.
 *
 * The InnerTube requests have to originate from the page itself, not from the
 * content script:
 *   - Firefox runs content-script fetch() with the extension's principal, so
 *     the Origin header would be moz-extension://… and Google would reject the
 *     SAPISIDHASH, which is bound to https://www.youtube.com.
 *   - window.ytcfg (client version, API key, visitor data, session index) only
 *     exists in the page's world.
 *
 * So the content script injects this file as a page script and talks to it over
 * window.postMessage. It handles three actions: `dislike`, `removelike`, and
 * `status` (what does the account currently think of this video).
 */
(() => {
  'use strict';

  if (window.__ysdBridge) return;
  window.__ysdBridge = true;

  const REQUEST = 'ysd-request';
  const RESPONSE = 'ysd-response';
  const DEFAULT_CLIENT_VERSION = '2.20240701.00.00';

  function cfg(key) {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        return window.ytcfg.get(key);
      }
    } catch (err) {
      /* ytcfg not ready yet */
    }
    return undefined;
  }

  function cookie(name) {
    const prefix = name + '=';
    for (const part of document.cookie.split('; ')) {
      if (part.startsWith(prefix)) return part.slice(prefix.length);
    }
    return null;
  }

  async function sha1Hex(input) {
    const digest = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(input),
    );
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** `Authorization: SAPISIDHASH <ts>_<sha1("<ts> <SAPISID> <origin>")>`. */
  async function authorization() {
    const sapisid = cookie('SAPISID')
      || cookie('__Secure-3PAPISID')
      || cookie('__Secure-1PAPISID');
    if (!sapisid) return null;

    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${ts} ${sapisid} ${location.origin}`);
    return `SAPISIDHASH ${ts}_${hash}`;
  }

  function innertubeContext() {
    const base = cfg('INNERTUBE_CONTEXT');
    const context = base && base.client
      ? { ...base, request: { ...(base.request || {}), useSsl: true } }
      : {
        client: {
          clientName: 'WEB',
          clientVersion: cfg('INNERTUBE_CLIENT_VERSION') || DEFAULT_CLIENT_VERSION,
          hl: cfg('HL') || 'en',
          gl: cfg('GL') || 'US',
        },
        request: { useSsl: true },
        user: {},
      };

    // Brand accounts act "on behalf of" a delegated session.
    const delegated = cfg('DELEGATED_SESSION_ID');
    if (delegated) {
      context.user = { ...(context.user || {}), onBehalfOfUser: delegated };
    }
    return context;
  }

  /**
   * POST to an InnerTube endpoint with the same credentials the page uses.
   * @returns {Promise<Response|null>} null when signed out.
   */
  async function post(path, payload) {
    const auth = await authorization();
    if (!auth) return null;

    const url = new URL(path, location.origin);
    url.searchParams.set('prettyPrint', 'false');
    const apiKey = cfg('INNERTUBE_API_KEY');
    if (apiKey) url.searchParams.set('key', apiKey);

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': auth,
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': cfg('INNERTUBE_CLIENT_VERSION') || DEFAULT_CLIENT_VERSION,
    };

    const visitorData = cfg('INNERTUBE_CONTEXT_VISITOR_DATA');
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    const delegated = cfg('DELEGATED_SESSION_ID');
    if (delegated) headers['X-Goog-PageId'] = delegated;

    const idToken = cfg('ID_TOKEN');
    if (idToken) headers['X-Youtube-Identity-Token'] = idToken;

    return fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: innertubeContext(), ...payload }),
    });
  }

  function failure(status) {
    return status === 401 || status === 403
      ? 'YouTube rejected the request. Try reloading the page.'
      : `Could not dislike (HTTP ${status}).`;
  }

  /**
   * @param {string} videoId
   * @param {'dislike'|'removelike'} action
   */
  async function setLikeStatus(videoId, action) {
    try {
      const res = await post(`/youtubei/v1/like/${action}`, { target: { videoId } });
      if (!res) return { ok: false, reason: 'Sign in to YouTube to dislike.' };
      return res.ok ? { ok: true } : { ok: false, reason: failure(res.status) };
    } catch (err) {
      return { ok: false, reason: 'Network error while sending the dislike.' };
    }
  }

  const LIKE_STATES = ['LIKE', 'DISLIKE', 'INDIFFERENT'];

  /**
   * Modern InnerTube reports the viewer's like state as a `likeStatus` field on
   * a `likeStatusEntity`, but its exact path moves between rollouts — so scan
   * for the field rather than hard-coding a path through the response.
   */
  function scanLikeStatus(node, depth) {
    if (!node || depth > 12) return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = scanLikeStatus(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof node !== 'object') return null;

    if (typeof node.likeStatus === 'string' && LIKE_STATES.includes(node.likeStatus)) {
      return node.likeStatus;
    }

    for (const value of Object.values(node)) {
      const found = scanLikeStatus(value, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /** What does this account currently think of the video? */
  async function getLikeStatus(videoId) {
    try {
      const res = await post('/youtubei/v1/next', { videoId });
      if (!res) return { ok: false, reason: 'signed out' };
      if (!res.ok) return { ok: false, reason: failure(res.status) };

      const data = await res.json();
      // frameworkUpdates carries the entity batch, which is where the current
      // state lives; fall back to the whole payload for older shapes.
      const likeStatus = scanLikeStatus(data.frameworkUpdates, 0)
        || scanLikeStatus(data, 0);
      return { ok: true, likeStatus };
    } catch (err) {
      return { ok: false, reason: 'Could not read like status.' };
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;

    const msg = event.data;
    if (!msg || msg.source !== REQUEST) return;
    if (typeof msg.videoId !== 'string' || !/^[\w-]{1,32}$/.test(msg.videoId)) return;

    let result;
    if (msg.action === 'status') {
      result = await getLikeStatus(msg.videoId);
    } else if (msg.action === 'dislike' || msg.action === 'removelike') {
      result = await setLikeStatus(msg.videoId, msg.action);
    } else {
      return;
    }

    window.postMessage(
      {
        source: RESPONSE,
        id: msg.id,
        ok: result.ok,
        reason: result.reason,
        likeStatus: result.likeStatus,
      },
      location.origin,
    );
  });
})();
