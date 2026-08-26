# Youtube Shorts Dislike Extension

Adds a working dislike button to the YouTube Shorts player.

On `youtube.com/watch?v=…` the dislike button is right there. On
`youtube.com/shorts/…` same video, it can be missing, depending on the
rollout you're in. This extension puts it back.

## How it works

The content script watches the Shorts action bar and takes one of two paths:

1. **Reveal.** If YouTube actually rendered a dislike control and merely hid it,
   the script un-hides it. YouTube then handles the click itself, so you get real
   toggle state and real optimistic UI. This is the preferred path.
2. **Inject.** If there is no dislike control at all, the script adds one styled
   to match the native Shorts buttons. Clicking it POSTs to YouTube's own
   InnerTube endpoint — `/youtubei/v1/like/dislike`, or `…/removelike` to undo —
   using the same `SAPISIDHASH` authorization scheme the page itself uses. The
   dislike is recorded on your account exactly as it would be from the watch
   page.

The injected button is a real toggle, and it starts from the truth rather than
from zero: the first time it sees a Short it asks `/youtubei/v1/next` whether
this account already disliked the video, so a reload shows the disliked state
instead of a blank button. Clicking flips it optimistically and rolls back if
the request fails. (On the reveal path none of this applies — YouTube's own
control already knows its state.)

Those requests are made by `src/page.js`, which runs in the page's own world rather
than the content script's. Two reasons: Firefox gives content-script `fetch()`
the extension's principal, which would send `Origin: moz-extension://…` and get
the request rejected, since the `SAPISIDHASH` is bound to
`https://www.youtube.com`; and `window.ytcfg` — the client version, API key and
visitor data the request needs — only exists in the page's world. The content
script talks to it over `window.postMessage`.

No background worker, no remote server, no analytics, no permissions beyond
`youtube.com` itself. Nothing leaves your browser except the request to YouTube.

## Install (development)

**Chrome, Edge, Brave, Opera, Vivaldi**

1. Go to `chrome://extensions` (`edge://extensions`, `brave://extensions`, …).
2. Turn on **Developer mode**.
3. **Load unpacked** → select this folder.

**Firefox**

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `manifest.json` in this folder.

Temporary add-ons are removed when Firefox restarts; for a permanent install the
add-on has to be signed by Mozilla (see below).

## Packaging

```sh
./build.sh
```

Produces:

- `dist/shorts-dislike-chrome.zip` — upload to the Chrome Web Store, or use for
  any Chromium browser.
- `dist/shorts-dislike-firefox.zip` — upload to
  [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing. This
  build adds Firefox's add-on ID and required data-transmission declarations.
  Firefox 140 or newer on desktop and 142 or newer on Android are required so
  the browser can show its built-in data consent prompt during installation.

## Layout

```
manifest.json      MV3 manifest, shared by both builds
src/content.js     detection, reveal/inject logic, button UI
src/page.js        page-world bridge: signs and sends the InnerTube request
src/content.css    button styling (light + dark theme)
icons/             extension icons (icon.svg is the source)
build.sh           produces the per-browser zips
```

## Verifying it works

1. Open `https://www.youtube.com/shorts/DNJvAOI6fxg` while signed in.
2. A **Dislike** button should sit directly under the like button in the right
   rail.
3. Click it — it fills in. Open the same video at
   `https://www.youtube.com/watch?v=DNJvAOI6fxg` and reload: the dislike button
   there should now be active.
4. Click ours again to undo, and re-check the watch page the same way.

Step 3 is the one that matters — it's the difference between a button that looks
right and a dislike that actually reached your account.

### If the button doesn't appear

Turn on logging — no code edit needed. In the DevTools console on a Shorts page:

```js
localStorage.setItem('ysd-debug', '1');   // then reload
```

`[shorts-dislike]` lines then report what the script decided: whether it found
the like button, which action bar it picked, and whether it revealed a native
control or injected its own. Repeat messages are suppressed.

If it logs nothing useful, paste `tools/diagnose.js` into the console on a
Shorts page. It dumps which selectors still match YouTube's current DOM, the
like button's ancestry, and what else is in the action bar — enough to repair
stale selectors without guessing.

One gotcha: the console runs in the page's world, so `window.__ysdLoaded` (set
by the content script, which lives in an isolated world) is invisible there.
`window.__ysdBridge` is the one to check — it's set by the injected page script
and proves the content script ran.

## Known limitations

- **Signed-out users can't dislike.** There is no account to record it against;
  the button reports this instead of failing silently.
- **YouTube's like button won't visually un-highlight** when the injected button
  removes a like server-side. The removal is real — YouTube's own UI just isn't
  told about it until the next page load. (Not an issue on the reveal path.)
- **Dislike counts aren't shown**, only the button. YouTube stopped serving
  public dislike counts in 2021; showing one means pulling estimates from a
  third-party service such as Return YouTube Dislike, which is a separate feature
  and a separate privacy trade-off.
- **YouTube's DOM shifts often.** Detection is anchored on tag names
  (`like-button-view-model`, `dislike-button-view-model`, `#actions`) rather than
  on `aria-label` text, so it survives non-English UIs and most re-skins — but a
  large enough Shorts rewrite will need the selectors in `src/content.js`
  updated.
- **Mobile web (`m.youtube.com`) is best-effort.** The selectors are included but
  that layout differs enough that it may need its own pass.
- **The bridge is callable from the page.** `src/page.js` listens for
  same-origin `postMessage`, so any script running on youtube.com could ask it to
  dislike a video id. It validates the id and action shape and can do nothing
  else, and the only scripts on that origin are YouTube's own — but it is a real
  widening of what page scripts can reach, worth knowing about.

## License

Licensed under the [Apache License 2.0](LICENSE). The thumb icon is derived from
Google Material Icons; see [NOTICE](NOTICE).
