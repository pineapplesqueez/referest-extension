# Referest Extension

Browser extension skeleton (Manifest V3) for saving website images to Referest.

## What is included

- `manifest.json` with background worker, content script, and popup
- `src/content.js` hover `Save` button for images
- `src/background.js` message router + local mock save storage
- `src/popup/*` auth stub UI (temporary token input)

## Run locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `/Users/reveinz/Documents/GitHub/referest-extension`.

## Next implementation steps

- Replace token input with OAuth (`chrome.identity.launchWebAuthFlow`).
- Replace local mock save with Referest API calls.
- Add collection picker in popup or image save modal.
