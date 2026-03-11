# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome extension (Manifest V3) that lets authenticated users save images from any webpage to their Referest account (Russian Pinterest analog). Auth is fully working (email/password + Google/Yandex OAuth). Saving is currently mocked to `chrome.storage.local` — the real `POST /api/pins` endpoint is not yet integrated.

## Loading the extension locally

No build step — runs directly from source.

1. `chrome://extensions` → Enable **Developer mode** → **Load unpacked** → select repo root.
2. After any code change, click the refresh icon on the extension card.

## Architecture

Three entry points communicate via `chrome.runtime.sendMessage`. All messaging goes through `background.js` as a single router.

### `src/background.js` — service worker

Owns all storage, API calls, and the per-tab image registry.

**Message types:**

| Type | Description |
|------|-------------|
| `REFEREST_AUTH_SIGN_IN` | Email/password login → `PUT /api/v1/auth/signin` |
| `REFEREST_AUTH_OAUTH_START` | Launches `chrome.identity.launchWebAuthFlow` for Google or Yandex |
| `REFEREST_AUTH_GET_STATUS` | Returns `{ isAuthed: boolean }` |
| `REFEREST_AUTH_CLEAR_TOKEN` | Clears stored tokens + fires logout to backend |
| `REFEREST_SAVE_IMAGE` | Saves image (currently mocked to local storage) |
| `REFEREST_GET_PROFILE` | `GET /api/v1/account/profile` → `{ nickname, avatarUrl, username }` |
| `REFEREST_GET_COLLECTIONS` | `GET /api/v1/interactions/collections/my` → `[{ id, name, itemsCount }]` |
| `REFEREST_IMAGE_FOUND` | Content script pushes a discovered image into the per-tab registry |
| `REFEREST_GET_TAB_IMAGES` | Popup retrieves all images seen for a given tab |

**Per-tab image registry** — `tabImages: Map<tabId, Map<src, entry>>`. Content scripts push images here so they survive virtual DOM removal (infinite scroll, virtualised lists). Cleared on tab navigation (`onUpdated`) and close (`onRemoved`).

**Token refresh** — `chrome.alarms` fires every 12 min (access token TTL is 15 min). `silentRefresh()` calls `POST /api/v1/auth/refresh`. On 401 the stored tokens are wiped. Alarm is reset to full 12 min on every new login/refresh so the timer always runs from the latest token issue time.

**API base URLs:**
```
API_BASE          = https://referest.ru/api/v1/auth
ACCOUNT_BASE      = https://referest.ru/api/v1/account
INTERACTIONS_BASE = https://referest.ru/api/v1/interactions
```

### `src/content.js` — injected into every page

**Hover save button** — a `position: fixed` pill button (`data-referest="save"`) appended to `document.body`. Appears when the cursor enters an `<img>` ≥ 120 px in either dimension. Disappears immediately on scroll/resize.

**Collection picker panel** — `position: fixed` card (`data-referest="picker"`) that appears below the save button on `mouseenter`. Shows the user's collections fetched via `REFEREST_GET_COLLECTIONS` (cached for 1 min). Each row saves to that collection. "Сохранить" in the header and "Без коллекции" in the footer both save without a collection. `isOverButton` / `isOverPicker` flags + an 80 ms `scheduleHide` debounce prevent accidental closure when the mouse moves between the button and picker.

**Image tracker** — pushes every discovered `<img>` to the background registry via `REFEREST_IMAGE_FOUND`. Uses a `WeakSet` for dedup. `MutationObserver` watches `childList + attributes[src, srcset]` so lazy loaders and infinite scroll are covered.

**`safeSendMessage(msg)`** — wraps all `chrome.runtime.sendMessage` calls. Guards with `chrome.runtime?.id` and silently returns `null` on `"Extension context invalidated"` (happens when the extension reloads while a tab is open).

### `src/popup/popup.html` + `popup.js` + `popup.css`

**Unauthenticated section** — email/password form + Google/Yandex OAuth icon buttons + signup link.

**Authenticated section:**
- Header: brand logo | avatar (initials fallback) + nickname (click → opens `referest.ru/<nickname>`) | logout icon button.
- Masonry image grid (3 columns, `columns: 3` CSS) with a `max-height: 460px` scroll wrapper (`overflow-x: hidden` on the wrapper prevents horizontal overflow caused by CSS columns). Images have checkbox overlays that appear on hover and stay visible when checked (`.is-checked`).
- Save bar — appears when ≥ 1 image is selected; shows count; `Promise.all` for bulk save.

**Polling** — `setInterval(pollOnce, 1000)`. `pollBusy` boolean guards against concurrent async polls. Each poll merges background registry images + a live `executeScript` DOM scan (fallback for when the SW was restarted). New images are appended incrementally. An `emptyTimer` (4 s) shows "no images" if nothing has arrived.

### `src/lib/storage.js`

Thin wrappers over `chrome.storage.local`. Storage keys: `AUTH_TOKEN`, `REFRESH_TOKEN`, `SESSION_ID`, `SAVED_ITEMS`.

## Backend API reference (interaction-service)

Collections picker endpoint: `GET /api/v1/interactions/collections/my`
Response: `list[CollectionPickerItemModel]` → array of `{ id: int, slug, title: str, itemsCount: int, updatedAt }`.
The normaliser in `background.js` maps `title` → `name` for the frontend. There is **no** `coverUrl` in this model.

## Branding

Font: **Inter** (Google Fonts, popup only).

| Token | Hex |
|-------|-----|
| `--color-accent` | `#2462EA` |
| `--color-bg` | `#FFFFFF` |
| `--color-text` | `#010816` |
| `--color-on-accent` | `#F7F9FB` |
| `--color-surface` | `#F1F5F9` |
| `--color-muted` | `#64748B` |
| `--color-danger` | `#EE4444` |
| `--color-border` | `#E2E8F0` |

Logo: `src/img/icons/logo.svg`. Extension icons (all sizes): `src/img/icons/`.

## Save image flow

`handleSaveImage` in `background.js` calls `POST /api/v1/ugc/upload` (multipart/form-data):

1. Fetches the image binary via `fetch(imageUrl)` — CORS is bypassed by `host_permissions: <all_urls>`.
2. Builds `FormData`: `files` (blob), `title` (imageAlt || pageTitle), `own_url` (pageUrl), `collection_id` (optional), `status: published`.
3. Sends to `CONTENT_BASE/upload` with Bearer token.
4. On 401 — calls `silentRefresh()` and retries once (refresh-and-retry pattern).
5. Backend adds the item to the collection internally via its own call to interaction-service.
6. Returns `{ ok, references: [{ id, slug, media_url }], collectionAdded }`.

**`CONTENT_BASE`** = `https://referest.ru/api/v1/ugc`

## What is NOT yet done

- **`chrome.storage.session` for tabImages** — the in-memory `tabImages` Map is lost when the service worker is killed (idle >30 s). The `executeScript` fallback in `pollOnce` mitigates this, but a full fix would persist to `chrome.storage.session`.
- **CSS `background-image` / `<picture>`** — content script only tracks `<img>` elements.
