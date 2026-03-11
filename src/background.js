import { STORAGE_KEYS, getFromStorage } from "./lib/storage.js";

const API_BASE = "https://referest.ru/api/v1/auth";
const ACCOUNT_BASE = "https://referest.ru/api/v1/account";
const INTERACTIONS_BASE = "https://referest.ru/api/v1/interactions";
const CONTENT_BASE = "https://referest.ru/api/v1/ugc";
const ALARM_NAME = "referest-token-refresh";

// ==========================================================
// Per-tab image registry  (chrome.storage.session — survives SW restarts)
// ==========================================================

// Короткий префикс ключа чтобы не засорять storage namespace
const TAB_IMG_PREFIX = "ti_";

async function getTabImagesObj(tabId) {
  const key = `${TAB_IMG_PREFIX}${tabId}`;
  const result = await chrome.storage.session.get(key);
  return result[key] ?? {};
}

async function addTabImage(tabId, image) {
  const key = `${TAB_IMG_PREFIX}${tabId}`;
  const current = await getTabImagesObj(tabId);
  if (current[image.src]) return; // already known — skip badge update
  current[image.src] = image;
  await chrome.storage.session.set({ [key]: current });
  const count = Object.keys(current).length;
  chrome.action.setBadgeText({ text: String(count), tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#2462ea", tabId }).catch(() => {});
}

async function clearTabImages(tabId) {
  await chrome.storage.session.remove(`${TAB_IMG_PREFIX}${tabId}`);
  chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
}

// tabId → { dataUrl, pageUrl, pageTitle } — pending area capture
const pendingCaptures = new Map();

// Сбрасываем при навигации и закрытии вкладки
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearTabImages(tabId);
    pendingCaptures.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabImages(tabId);
  pendingCaptures.delete(tabId);
});

// ==========================================================
// Lifecycle
// ==========================================================

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  chrome.contextMenus.create({
    id: "referest-save-image",
    title: "Сохранить в Referest",
    contexts: ["image"],
  });
});

chrome.runtime.onStartup.addListener(setupAlarm);

function isOwnSite(url) {
  try {
    const { hostname } = new URL(url || "");
    return hostname === "referest.ru" || hostname.endsWith(".referest.ru");
  } catch (_) {
    return false;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "referest-save-image") return;

  if (isOwnSite(info.pageUrl)) {
    notify("Сохранение с Referest в Referest недоступно");
    return;
  }

  let pageDescription = "";
  if (tab?.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (
          document.querySelector('meta[property="og:description"]')?.content ||
          document.querySelector('meta[name="description"]')?.content ||
          ""
        ).trim(),
      });
      pageDescription = result || "";
    } catch (_) {}
  }

  try {
    const result = await handleSaveImage({
      imageUrl: info.srcUrl,
      pageUrl: info.pageUrl,
      pageTitle: tab?.title || "",
      imageAlt: "",
      pageDescription,
    });
    if (result?.queued) {
      notify("Нет сети — изображение добавлено в очередь");
    } else {
      notifySuccess("Изображение сохранено в Referest", result.references);
    }
  } catch (e) {
    const msg = String(e);
    if (msg.includes("authenticated")) {
      notify("Войдите в аккаунт Referest, чтобы сохранять изображения");
    } else if (msg.includes("403")) {
      notify("Сайт ограничил доступ к этому изображению");
    } else if (msg.includes("лимит") || msg.includes("429")) {
      notify("Превышен лимит: не более 30 изображений в час");
    } else {
      notify("Не удалось сохранить изображение");
    }
  }
});

function notify(message) {
  chrome.notifications.create("referest-info", {
    type: "basic",
    iconUrl: "src/img/icons/icon-48x48.png",
    title: "Referest",
    message,
  });
}

// notifUrls: notifId → url — for "Открыть" button in success notifications
const notifUrls = new Map();

function notifySuccess(message, references) {
  const slug = Array.isArray(references) && references[0]?.slug;
  const url = slug ? `https://referest.ru/reference/${slug}` : null;
  const notifId = "referest-saved";

  if (url) notifUrls.set(notifId, url);
  else notifUrls.delete(notifId);

  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "src/img/icons/icon-48x48.png",
    title: "Referest",
    message,
    ...(url ? { buttons: [{ title: "Открыть" }] } : {}),
  });
}

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (btnIdx === 0 && notifUrls.has(notifId)) {
    chrome.tabs.create({ url: notifUrls.get(notifId) });
    chrome.notifications.clear(notifId);
    notifUrls.delete(notifId);
  }
});

// Гарантируем наличие alarm при любом пробуждении SW
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) setupAlarm();
});

async function setupAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 12 });
}

const OFFLINE_ALARM = "referest-offline-retry";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) silentRefresh();
  if (alarm.name === OFFLINE_ALARM) processOfflineQueue();
});

// ==========================================================
// Offline queue (#10)
// ==========================================================

function isOfflineError(e) {
  return e instanceof TypeError && e.message.toLowerCase().includes("fetch");
}

async function enqueueOffline(payload) {
  const result = await chrome.storage.local.get(STORAGE_KEYS.OFFLINE_QUEUE);
  const queue = result[STORAGE_KEYS.OFFLINE_QUEUE] ?? [];
  queue.push(payload);
  await chrome.storage.local.set({ [STORAGE_KEYS.OFFLINE_QUEUE]: queue });
  // Fire retry alarm — create is idempotent if alarm already exists
  chrome.alarms.create(OFFLINE_ALARM, { periodInMinutes: 2 });
}

async function processOfflineQueue() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.OFFLINE_QUEUE);
  const queue = result[STORAGE_KEYS.OFFLINE_QUEUE] ?? [];
  if (queue.length === 0) {
    chrome.alarms.clear(OFFLINE_ALARM);
    return;
  }

  const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  if (!token) return; // not logged in yet — keep queue, retry later

  const remaining = [];
  let successCount = 0;

  for (const item of queue) {
    try {
      const imgResp = await fetch(item.imageUrl);
      if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);
      const blob = await imgResp.blob();
      await uploadBlob(blob, item);
      successCount++;
    } catch (e) {
      if (isOfflineError(e)) {
        remaining.push(item); // still offline — keep in queue
      }
      // auth / 403 / etc. — drop silently
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.OFFLINE_QUEUE]: remaining });

  if (remaining.length === 0) {
    chrome.alarms.clear(OFFLINE_ALARM);
    if (successCount > 0) {
      notify(`Офлайн-очередь: сохранено ${successCount} изображений`);
    }
  }
}

// ==========================================================
// Screenshot capture commands
// ==========================================================

chrome.commands.onCommand.addListener(async (command, tab) => {
  // Chrome передаёт активную вкладку вторым аргументом — надёжнее чем tabs.query из SW
  if (!tab?.id) return;

  const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  if (!token) {
    notify("Войдите в аккаунт Referest для сохранения скриншотов");
    return;
  }

  if (isOwnSite(tab.url)) {
    notify("Сохранение с Referest в Referest недоступно");
    return;
  }

  const sendToast = (text, state) =>
    chrome.tabs.sendMessage(tab.id, { type: "REFEREST_CAPTURE_TOAST", text, state }).catch(() => {});

  if (command === "capture-viewport") {
    sendToast("Сохранение скриншота…", "loading");
    const r = await handleCaptureViewport(tab);
    if (r.ok) {
      sendToast("Скриншот сохранён ✓", "success");
    } else {
      notifyCaptureError(r.error);
      sendToast("Не удалось сохранить", "error");
    }
  } else if (command === "capture-area") {
    const r = await handleCaptureArea(tab);
    if (!r.ok) notifyCaptureError(r.error);
    // область: toast показывает сам content.js после выбора
  }
});

// ==========================================================
// External messages (from referest.ru website)
// ==========================================================

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!sender.origin?.endsWith("referest.ru")) return;

  if (message?.type === "REFEREST_SSO_SYNC") {
    const { token, refreshToken, sessionId } = message;
    if (token && refreshToken && sessionId) {
      storeAuthData(token, refreshToken, sessionId)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async response
    }
    sendResponse({ ok: false, error: "Missing fields" });
  }

  if (message?.type === "REFEREST_SSO_LOGOUT") {
    chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_TOKEN]: "",
      [STORAGE_KEYS.REFRESH_TOKEN]: "",
      [STORAGE_KEYS.SESSION_ID]: "",
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ==========================================================
// Message router
// ==========================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    sendResponse({ ok: false, error: "Invalid message" });
    return false;
  }

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));

  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "REFEREST_AUTH_SIGN_IN":
      return signInWithEmail(message.email, message.password);

    case "REFEREST_AUTH_OAUTH_START":
      return startOAuth(message.provider);

    case "REFEREST_AUTH_GET_STATUS":
      return getAuthStatus();

    case "REFEREST_AUTH_CLEAR_TOKEN":
      return clearAuth();

    case "REFEREST_SAVE_IMAGE":
      return handleSaveImage(message.payload);

    case "REFEREST_SAVE_IMAGES_BULK":
      return handleSaveImagesBulk(message.payloads, message.collectionId ?? null);

    case "REFEREST_GET_PROFILE":
      return getProfile();

    // Изображение найдено content script — добавляем в реестр вкладки
    case "REFEREST_IMAGE_FOUND": {
      const tabId = sender.tab?.id;
      if (!tabId || !message.image?.src) return { ok: false };
      await addTabImage(tabId, message.image);
      return { ok: true };
    }

    // Popup запрашивает все изображения вкладки
    case "REFEREST_GET_TAB_IMAGES": {
      const obj = await getTabImagesObj(message.tabId);
      return { ok: true, images: Object.values(obj) };
    }

    case "REFEREST_GET_COLLECTIONS":
      return getCollections();

    case "REFEREST_CREATE_COLLECTION":
      return createCollection(message.title);

    case "REFEREST_CAPTURE_VIEWPORT": {
      const tab = message.tabId
        ? await chrome.tabs.get(message.tabId).catch(() => null)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!tab) return { ok: false, error: "Нет активной вкладки" };
      const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
      if (!token) return { ok: false, error: "Войдите в аккаунт Referest" };
      if (isOwnSite(tab.url)) return { ok: false, error: "Недоступно на Referest" };
      return handleCaptureViewport(tab);
    }

    case "REFEREST_CAPTURE_AREA": {
      const tab = message.tabId
        ? await chrome.tabs.get(message.tabId).catch(() => null)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!tab) return { ok: false, error: "Нет активной вкладки" };
      const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
      if (!token) return { ok: false, error: "Войдите в аккаунт Referest" };
      if (isOwnSite(tab.url)) return { ok: false, error: "Недоступно на Referest" };
      return handleCaptureArea(tab);
    }

    case "REFEREST_AREA_SELECTED":
      return handleAreaSelected(message.rect, message.dpr, sender.tab?.id);

    default:
      return { ok: false, error: "Unsupported message type" };
  }
}

// ==========================================================
// Auth helpers
// ==========================================================

async function broadcastAuthChange(isAuthed) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || isOwnSite(tab.url)) continue;
    chrome.tabs.sendMessage(tab.id, { type: "REFEREST_AUTH_CHANGED", isAuthed }).catch(() => {});
  }
}

async function storeAuthData(token, refreshToken, sessionId) {
  // Атомарная запись — все три ключа в одном вызове
  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTH_TOKEN]: token,
    [STORAGE_KEYS.REFRESH_TOKEN]: refreshToken,
    [STORAGE_KEYS.SESSION_ID]: sessionId,
  });
  // Сбрасываем таймер обновления от текущего момента
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 12 });
  broadcastAuthChange(true);
}

async function signInWithEmail(email, password) {
  const response = await fetch(`${API_BASE}/signin`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const data = await response.json();

  if (!response.ok) {
    return { ok: false, error: data.detail || "Ошибка входа" };
  }

  await storeAuthData(data.token, data.refreshToken, data.sessionId);
  return { ok: true };
}

async function startOAuth(provider) {
  const state = crypto.randomUUID();
  const startUrl = `${API_BASE}/${provider}/extension-start?state=${encodeURIComponent(state)}`;

  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow(
      { url: startUrl, interactive: true },
      async (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError?.message || "OAuth отменён"
          });
          return;
        }

        try {
          const url = new URL(redirectUrl);
          const token = url.searchParams.get("token");
          const refreshToken = url.searchParams.get("refreshToken");
          const sessionId = url.searchParams.get("sessionId");

          if (!token || !refreshToken || !sessionId) {
            resolve({ ok: false, error: "Неполный ответ от OAuth" });
            return;
          }

          await storeAuthData(token, refreshToken, sessionId);
          resolve({ ok: true });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      }
    );
  });
}

async function getAuthStatus() {
  const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  return { ok: true, isAuthed: Boolean(token) };
}

async function getProfile() {
  const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  if (!token) return { ok: false, error: "Not authenticated" };

  const response = await fetch(`${ACCOUNT_BASE}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return { ok: false, error: "Failed to fetch profile" };

  const data = await response.json();
  return {
    ok: true,
    profile: {
      nickname: data.nickname,
      avatarUrl: data.avatarUrl || null,
      username: data.username,
    },
  };
}

async function clearAuth() {
  const refreshToken = await getFromStorage(STORAGE_KEYS.REFRESH_TOKEN, "");
  const sessionId = await getFromStorage(STORAGE_KEYS.SESSION_ID, "");

  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTH_TOKEN]: "",
    [STORAGE_KEYS.REFRESH_TOKEN]: "",
    [STORAGE_KEYS.SESSION_ID]: "",
  });
  await chrome.alarms.clear(ALARM_NAME);

  broadcastAuthChange(false);

  // Fire-and-forget backend logout
  if (refreshToken && sessionId) {
    fetch(`${API_BASE}/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, sessionId })
    }).catch(() => {});
  }

  return { ok: true };
}

async function silentRefresh() {
  const refreshToken = await getFromStorage(STORAGE_KEYS.REFRESH_TOKEN, "");
  const sessionId = await getFromStorage(STORAGE_KEYS.SESSION_ID, "");
  if (!refreshToken || !sessionId) return;

  try {
    const response = await fetch(`${API_BASE}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, sessionId })
    });

    if (response.ok) {
      const data = await response.json();
      await storeAuthData(
        data.token,
        data.refreshToken || refreshToken,
        sessionId
      );
    } else if (response.status === 401) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.AUTH_TOKEN]: "",
        [STORAGE_KEYS.REFRESH_TOKEN]: "",
        [STORAGE_KEYS.SESSION_ID]: "",
      });
    }
  } catch (_) {
    // Network errors are silent — will retry on next alarm
  }
}

async function getCollections() {
  const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  if (!token) return { ok: false, error: "Not authenticated" };

  const response = await fetch(`${INTERACTIONS_BASE}/collections/my`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return { ok: false, error: "Failed to fetch collections" };

  const data = await response.json();
  // API returns array of collection objects; normalise to what UI needs
  // API returns list[CollectionPickerItemModel]: { id, slug, title, itemsCount, updatedAt }
  const collections = (Array.isArray(data) ? data : []).map((c) => ({
    id: c.id,
    name: c.title,
    itemsCount: c.itemsCount ?? 0,
  }));
  return { ok: true, collections };
}

// ==========================================================
// Save image
// ==========================================================

function buildUploadForm(blob, payload) {
  const form = new FormData();
  form.append("files", blob, "image");

  const title = (payload.pageTitle || payload.imageAlt || "").trim().slice(0, 500);
  if (title) form.append("title", title);

  const description = (payload.pageDescription || "").trim().slice(0, 1000);
  if (description) form.append("description", description);

  const own_url = (payload.pageUrl || "").trim().slice(0, 2000);
  if (own_url) form.append("own_url", own_url);

  if (payload.collectionId != null) {
    form.append("collection_id", String(payload.collectionId));
  }

  form.append("status", "published");
  return form;
}

async function callUploadApi(token, form) {
  return fetch(`${CONTENT_BASE}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

// Общий upload blob → API (используется как handleSaveImage, так и capture)
async function uploadBlob(blob, payload) {
  let token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  if (!token) throw new Error("User is not authenticated");

  let response = await callUploadApi(token, buildUploadForm(blob, payload));

  if (response.status === 401) {
    await silentRefresh();
    token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
    if (!token) throw new Error("User is not authenticated");
    response = await callUploadApi(token, buildUploadForm(blob, payload));
  }

  if (response.status === 429) {
    throw new Error("Превышен лимит загрузок: не более 30 файлов в час");
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || `Ошибка сохранения (${response.status})`);
  }

  const data = await response.json();
  return { ok: true, references: data.references, collectionAdded: data.collection_added };
}

async function handleSaveImage(payload, _retrying = false) {
  try {
    const imgResp = await fetch(payload.imageUrl);
    if (!imgResp.ok) throw new Error(`Не удалось загрузить изображение (${imgResp.status})`);
    const blob = await imgResp.blob();
    return uploadBlob(blob, payload);
  } catch (e) {
    if (!_retrying && isOfflineError(e)) {
      await enqueueOffline(payload);
      return { ok: false, queued: true };
    }
    throw e;
  }
}

async function createCollection(title) {
  const token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  if (!token) return { ok: false, error: "Not authenticated" };

  const response = await fetch(`${INTERACTIONS_BASE}/collections/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return { ok: false, error: err.detail || "Ошибка создания коллекции" };
  }

  const data = await response.json();
  return { ok: true, collection: { id: data.id, name: data.title } };
}

// Bulk upload: скачивает все блобы параллельно, батчит по 10 (лимит бэкенда)
async function handleSaveImagesBulk(payloads, collectionId = null) {
  if (!payloads?.length) return { ok: false, saved: 0, failed: 0 };

  let token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
  if (!token) throw new Error("User is not authenticated");

  // Скачиваем все блобы параллельно — независимо отслеживаем ошибки
  const blobResults = await Promise.allSettled(
    payloads.map(async (p) => {
      const r = await fetch(p.imageUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { blob: await r.blob(), payload: p };
    })
  );

  const items = blobResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
  let failed = blobResults.filter((r) => r.status === "rejected").length;
  let saved = 0;

  if (items.length === 0) return { ok: false, saved: 0, failed: payloads.length };

  // Все картинки с одной страницы — общий pageUrl и pageTitle
  const sharedPayload = items[0].payload;

  const buildBatchForm = (batch) => {
    const form = new FormData();
    batch.forEach(({ blob }) => form.append("files", blob, "image"));
    const title = (sharedPayload.pageTitle || "").trim().slice(0, 500);
    if (title) form.append("title", title);

    const description = (sharedPayload.pageDescription || "").trim().slice(0, 1000);
    if (description) form.append("description", description);

    if (title || description) form.append("apply_meta_to_all", "true");

    const own_url = (sharedPayload.pageUrl || "").trim().slice(0, 2000);
    if (own_url) form.append("own_url", own_url);
    if (collectionId != null) form.append("collection_id", String(collectionId));
    form.append("status", "published");
    return form;
  };

  const BATCH_SIZE = 10;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    let response = await callUploadApi(token, buildBatchForm(batch));

    if (response.status === 401) {
      await silentRefresh();
      token = await getFromStorage(STORAGE_KEYS.AUTH_TOKEN, "");
      if (!token) { failed += batch.length; continue; }
      response = await callUploadApi(token, buildBatchForm(batch));
    }

    if (response.ok) {
      const data = await response.json();
      saved += data.references?.length ?? 0;
    } else {
      failed += batch.length;
    }
  }

  return { ok: saved > 0, saved, failed };
}

// ==========================================================
// Screenshot capture
// ==========================================================

function notifyCaptureError(e) {
  const msg = String(e);
  if (msg.includes("authenticated")) {
    notify("Войдите в аккаунт Referest для сохранения скриншотов");
  } else if (msg.includes("лимит") || msg.includes("429")) {
    notify("Превышен лимит: не более 30 изображений в час");
  } else {
    notify("Не удалось сохранить скриншот");
  }
}

// Обрезаем dataUrl по rect (CSS-пиксели) с учётом devicePixelRatio
async function cropScreenshot(dataUrl, rect, dpr) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.min(Math.round(rect.width * dpr),  bitmap.width  - sx);
  const sh = Math.min(Math.round(rect.height * dpr), bitmap.height - sy);

  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.convertToBlob({ type: "image/png" });
}

async function handleCaptureViewport(tab) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const result = await uploadBlob(blob, {
      pageUrl: tab.url || "",
      pageTitle: tab.title || "",
      pageDescription: "",
      imageAlt: "",
    });
    notifySuccess("Скриншот страницы сохранён в Referest", result.references);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function handleCaptureArea(tab) {
  try {
    // Снимаем до показа оверлея — без тёмной маски на скриншоте
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    pendingCaptures.set(tab.id, {
      dataUrl,
      pageUrl: tab.url || "",
      pageTitle: tab.title || "",
    });
    await chrome.tabs.sendMessage(tab.id, { type: "REFEREST_START_CAPTURE" });
    return { ok: true };
  } catch (e) {
    pendingCaptures.delete(tab.id);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function handleAreaSelected(rect, dpr, tabId) {
  const capture = pendingCaptures.get(tabId);
  if (!capture) return { ok: false };
  pendingCaptures.delete(tabId);

  try {
    const blob = await cropScreenshot(capture.dataUrl, rect, dpr);
    const result = await uploadBlob(blob, {
      pageUrl: capture.pageUrl,
      pageTitle: capture.pageTitle,
      pageDescription: "",
      imageAlt: "",
    });
    notifySuccess("Скриншот области сохранён в Referest", result.references);
    return { ok: true };
  } catch (e) {
    notifyCaptureError(e);
    return { ok: false };
  }
}
