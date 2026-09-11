# Click-to-Load Images

A Manifest V3 browser extension for Chromium-based browsers (built and
tested against desktop Chromium/Vivaldi; sideloadable on Vivaldi Android)
that blocks images, video, and audio from loading automatically to save
cellular data, shows a lightweight placeholder in their place, and loads
an item on demand when you tap/click its placeholder.

## How it works

- A static `declarativeNetRequest` rule blocks all requests of resource
  type `image` or `media` (`rules/block-media.json`). This stops native
  `<img>`, `<video>`, `<audio>`, and CSS `background-image` loads before
  they leave the browser. DNR has only one resource type for audiovisual
  content - `media` - so blocking video necessarily blocks `<audio>`
  elements too (podcast/article-narration players, etc.); there's no way
  to separate the two at the network-request level.
- Blocked `<img>`/`<video>`/`<audio>` elements fire a normal `error` event
  — the content script (`content.js`) listens for that (via one
  delegated, capturing listener on `document`, so it catches elements
  added at any time, including by SPA route changes) and renders a
  placeholder in their place.
- Tapping a placeholder asks the background service worker
  (`background.js`) to add a **session-scoped, tab-scoped** DNR "allow"
  rule for that exact URL, then re-triggers the load (`<img src>`
  reassignment for images; `.load()` + `.play()` for video/audio, which
  re-runs resource selection against whatever's already in `src`/child
  `<source>` elements). This avoids the CORS/opaque-response problems a
  `fetch()` + blob-URL approach would hit for content without permissive
  CORS headers, since the browser loads the resource itself rather than
  JavaScript reading the response bytes.
- Video/audio always requires a tap regardless of the size-threshold
  setting (see "Controls" below) — it's typically far larger than an
  image of the same "feels small" size, so the auto-load convenience
  doesn't extend to it.
- The per-site toggle (right-click menu / popup) and the options-page
  allowlist both write to the same `siteAllowlist` setting, which the
  background worker mirrors into a **persistent** DNR allow rule for that
  domain. The global toggle just enables/disables the static block
  ruleset outright. All three "make images load" entry points (single
  click, site toggle, global toggle) ultimately drive the same
  content-script reload path.

## Controls

- **Click the toolbar icon**: instantly toggles blocking **globally** (no
  popup step). Two independent indicators show state at a glance:
  - The **icon itself** dims/grays out when global blocking is off — this
    applies everywhere (it's not per-tab), so it always reflects the true
    global switch regardless of which site you're on.
  - The **badge** ("OFF" text) is per-tab: it reflects whether blocking is
    actually active for *this* tab specifically (off if either global
    blocking is off, or this site is on the allowlist), blank when it's
    on.
- **Right-click / long-press the toolbar icon**: a quick panel, plus two
  checkbox-style menu items that show a checkmark for current state as
  well as toggling it — "Block images globally" and a per-site item
  labeled with the current site's hostname (e.g. "Block images on
  example.com", checked when blocking is actually active there) — along
  with "load everything on this page" and a link to options.
- **`Alt+Shift+I`** (configurable at `chrome://extensions/shortcuts`):
  toggles blocking for the current site. Desktop only — MV3 `commands`
  aren't generally available on mobile Chromium browsers.
- **Options page**: global on/off, size-threshold auto-load for images
  (off by default) with its KB threshold — video/audio always requires a
  tap regardless of this setting — and the per-site allowlist.

## Project structure

```
manifest.json
rules/block-media.json     static DNR ruleset (image + media resource types)
background.js              service worker: DNR rule management, toggles, size checks
content.js                 placeholder detection + rendering + click handling
content.css                placeholder styling
lib/                       pure logic shared by background.js, content.js, and unit tests
options.html / options.js  settings page
popup.html / popup.js      secondary controls (global toggle, load-all, options link)
icons/
tests/unit/                Vitest — pure logic
tests/e2e/                 Playwright — real DNR/content-script/messaging behavior
```

## Development

```
npm install
npm run lint       # manifest + ruleset structural validation
npm run test:unit  # Vitest, no browser
npm run test:e2e   # Playwright, headless Chromium + the real unpacked extension
```

`npm run test:e2e` starts two tiny local HTTP servers (see
`tests/e2e/server.js`) to serve fixture pages, images, and a small real
WebM video deterministically, including one image served without CORS
headers from a second origin, to exercise the allow-rule click-to-load
path's main advantage over a `fetch()` + blob fallback.

### Loading the extension manually

Chrome/Vivaldi desktop: `chrome://extensions` (or `vivaldi://extensions`) →
enable Developer Mode → **Load unpacked** → select this directory.

## Known limitations

- **Sites that load images/video via their own `fetch()`/`XHR` call
  (rather than a plain `<img src>`/`<video src>` load) can bypass
  blocking entirely.** DNR classifies a `fetch()`/`XHR` request as
  resource type `xmlhttprequest`, not `image`/`media` — this is the same
  mechanism this extension's own click-to-load flow relies on (see "How
  it works" above), but some sites use it themselves for their *initial*
  load too (a common pattern for a smooth fade-in-once-downloaded effect
  on media-heavy/lazy-loaded pages, or for custom video players that
  stream via `fetch()`-based HLS/DASH segment fetching rather than a
  plain `<video src>`). There's no way to block only "the XHR calls that
  happen to fetch images/video" without also blocking arbitrary API/XHR
  traffic the page relies on for everything else — this is an inherent
  limit of `declarativeNetRequest` in MV3 (no equivalent of MV2's
  blocking `webRequest`, which could inspect a response and decide
  per-request), not a bug to fix here. **To check whether this is what's
  happening on a given site:** open `chrome://extensions` (or
  `vivaldi://extensions`) → this extension → "service worker" under
  *Inspect views* → Console, then reload the page. Every request our
  block rule actually matches gets logged there (`[CTLI] rule matched:
  ...`). If something that displays/plays anyway never shows up in that
  log, DNR never saw it as an `image`/`media`-type request in the first
  place — confirm by opening the page's own DevTools Network tab,
  filtering to that request, and checking its "Type" column for `fetch`/
  `xhr` instead of `img`/`media`/`document`.
- **Blocking "media" blocks `<audio>` along with `<video>`** — DNR has no
  separate resource type for the two, so there's no way to keep, say, a
  podcast/"listen to this article" player unblocked while still blocking
  autoplay video. Not a bug, just the granularity DNR offers.
- **Requires Developer Mode sideloading on Android**, since this isn't a
  Chrome Web Store listing. Some Vivaldi Android builds may not yet fully
  support Load Unpacked — verify against your installed Vivaldi version
  before relying on this.
- **Size-threshold mode adds a small per-image HEAD/Range request**, even
  for images that end up blocked. This is a deliberate, minor bandwidth
  cost in exchange for the convenience of knowing an image's size before
  deciding whether to auto-load it — not a bandwidth optimization, and not
  a bug. It never applies to video/audio (see "How it works" above).
- **CSS `background-image` blocking is best-effort**, and currently only
  detects images set via an element's *inline* `style` attribute (scanned
  on page load and via `MutationObserver` for later-added elements), not
  images set through a stylesheet rule. There's no `error` event for CSS
  background images, so detection uses a hidden probe `Image()` request
  for the same URL instead.
- Images/video/audio already in the browser's HTTP cache are still
  blocked — DNR evaluates before the cache lookup in MV3, so this is
  expected, not a bug.
- Manual testing (see below) is the only way to validate real Vivaldi
  Android behavior; CI can't run a mobile browser.

## Manual testing checklist (pre-release)

Automated tests (`npm run test:unit`, `npm run test:e2e`) cover the DNR
blocking mechanism, click-to-load for images/video/audio, the size
threshold, the allowlist, and reload-free toggling against headless
Chromium. Before a tagged release, also check by hand:

1. A static image site (news article, blog with a hero image).
2. A lazy-loaded gallery / infinite-scroll page.
3. An SPA (e.g. a React-based site) with client-side navigation.
4. A site with strict CORS on its images.
5. A page with an autoplaying background/looping video and, separately, a
   podcast/audio player.
6. Popup toggle and per-site allowlist both take effect without a reload.
7. **Sideload on Vivaldi Android** via `vivaldi://extensions` → Developer
   Mode → Load Unpacked, and confirm placeholders + click-to-load behave
   the same as on desktop. This step has no CI substitute.
