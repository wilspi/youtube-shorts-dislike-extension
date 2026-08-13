/*
 * Page-context bridge.
 *
 * The dislike request has to originate from the page itself, not from the
 * content script:
 *   - Firefox runs content-script fetch() with the extension's principal, so
 *     the Origin header would be moz-extension://… and Google would reject the
 *     SAPISIDHASH, which is bound to https://www.youtube.com.
 *   - window.ytcfg (client version, API key, visitor data, session index) only
 *     exists in the page's world.
 *
 * So the content script injects this file as a page script and talks to it over
 * window.postMessage.
 */
(() => {
  'use strict';

  if (window.__ysdBridge) return;
  window.__ysdBridge = true;

  const REQUEST = 'ysd-request';
  const RESPONSE = 'ysd-response';

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
    if (base && base.client) {
      return { ...base, request: { ...(base.request || {}), useSsl: true } };
    }
    return {
      client: {
        clientName: 'WEB',
        clientVersion: cfg('INNERTUBE_CLIENT_VERSION') || '2.20240701.00.00',
        hl: cfg('HL') || 'en',
        gl: cfg('GL') || 'US',
      },
      request: { useSsl: true },
      user: {},
    };
  }

  /**
   * @param {string} videoId
   * @param {'dislike'|'removelike'} action
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function send(videoId, action) {
    const auth = await authorization();
    if (!auth) return { ok: false, reason: 'Sign in to YouTube to dislike.' };

    const url = new URL(`/youtubei/v1/like/${action}`, location.origin);
    url.searchParams.set('prettyPrint', 'false');
    const apiKey = cfg('INNERTUBE_API_KEY');
    if (apiKey) url.searchParams.set('key', apiKey);

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': auth,
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': cfg('INNERTUBE_CLIENT_VERSION') || '2.20240701.00.00',
    };

    const visitorData = cfg('INNERTUBE_CONTEXT_VISITOR_DATA');
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    // Brand accounts act "on behalf of" a delegated session.
    const delegated = cfg('DELEGATED_SESSION_ID');
    if (delegated) headers['X-Goog-PageId'] = delegated;

    const idToken = cfg('ID_TOKEN');
    if (idToken) headers['X-Youtube-Identity-Token'] = idToken;

    const context = innertubeContext();
    if (delegated) context.user = { ...(context.user || {}), onBehalfOfUser: delegated };

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ context, target: { videoId } }),
      });

      if (res.ok) return { ok: true };

      return {
        ok: false,
        reason: res.status === 401 || res.status === 403
          ? 'YouTube rejected the request. Try reloading the page.'
          : `Could not dislike (HTTP ${res.status}).`,
      };
    } catch (err) {
      return { ok: false, reason: 'Network error while sending the dislike.' };
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;

    const msg = event.data;
    if (!msg || msg.source !== REQUEST) return;
    if (typeof msg.videoId !== 'string' || !/^[\w-]{1,32}$/.test(msg.videoId)) return;
    if (msg.action !== 'dislike' && msg.action !== 'removelike') return;

    const result = await send(msg.videoId, msg.action);
    window.postMessage(
      { source: RESPONSE, id: msg.id, ok: result.ok, reason: result.reason },
      location.origin,
    );
  });
})();
