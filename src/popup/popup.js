const unauthSection = document.getElementById("unauthSection");
const authSection = document.getElementById("authSection");
const statusMsg = document.getElementById("statusMsg");
const signupLink = document.getElementById("signupLink");

const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const loginBtn = document.getElementById("loginBtn");

const googleBtn = document.getElementById("googleBtn");
const yandexBtn = document.getElementById("yandexBtn");
const captureViewportBtn = document.getElementById("captureViewportBtn");
const captureAreaBtn = document.getElementById("captureAreaBtn");
// Показываем правильный хоткей под платформу
const isMac = navigator.platform.startsWith("Mac");
document.getElementById("captureViewportKbd").textContent = isMac ? "⌘⇧S" : "Ctrl+Shift+S";
document.getElementById("captureAreaKbd").textContent    = isMac ? "⌘⇧X" : "Ctrl+Shift+X";
const logoutBtn = document.getElementById("logoutBtn");
const avatarBtn = document.getElementById("avatarBtn");
const avatarImg = document.getElementById("avatarImg");
const avatarFallback = document.getElementById("avatarFallback");
const userNicknameLabel = document.getElementById("userNicknameLabel");

const gridLoading = document.getElementById("gridLoading");
const gridEmpty = document.getElementById("gridEmpty");
const gridToolbar = document.getElementById("gridToolbar");
const selectAllBtn = document.getElementById("selectAllBtn");
const imageGrid = document.getElementById("imageGrid");
const saveBar = document.getElementById("saveBar");
const saveSelectedBtn = document.getElementById("saveSelectedBtn");
const saveStatusMsg = document.getElementById("saveStatusMsg");
const collectionSelectBtn = document.getElementById("collectionSelectBtn");
const collectionSelectLabel = document.getElementById("collectionSelectLabel");
const collectionDropdown = document.getElementById("collectionDropdown");

// ==========================================================
// Init
// ==========================================================

refreshUI().catch((e) => showStatus(`Ошибка инициализации: ${e}`, "error"));

// ==========================================================
// UI state
// ==========================================================

async function refreshUI() {
  const response = await chrome.runtime.sendMessage({
    type: "REFEREST_AUTH_GET_STATUS"
  });

  if (response?.ok && response.isAuthed) {
    unauthSection.hidden = true;
    authSection.hidden = false;
    loadProfile();
    loadCollectionsForSelector();
    startPolling();
  } else {
    unauthSection.hidden = false;
    authSection.hidden = true;
    stopPolling();
    resetCollectionSelector();
  }
}

function showStatus(text, type = "error") {
  statusMsg.textContent = text;
  statusMsg.className = `status-msg status-${type}`;
  statusMsg.hidden = false;
}

function clearStatus() {
  statusMsg.hidden = true;
}

function showSaveStatus(text, type = "error") {
  saveStatusMsg.textContent = text;
  saveStatusMsg.className = `status-msg status-${type}`;
  saveStatusMsg.hidden = false;
}

function clearSaveStatus() {
  saveStatusMsg.hidden = true;
}

// ==========================================================
// Collection selector
// ==========================================================

let selectedCollectionId = null;
let cachedPopupCollections = null; // null = not yet loaded

function resetCollectionSelector() {
  selectedCollectionId = null;
  cachedPopupCollections = null;
  collectionSelectLabel.textContent = "Без коллекции";
  collectionSelectBtn.classList.remove("is-open");
  collectionDropdown.hidden = true;
}

async function loadCollectionsForSelector() {
  const resp = await chrome.runtime.sendMessage({ type: "REFEREST_GET_COLLECTIONS" });
  cachedPopupCollections = resp?.ok ? resp.collections : [];
}

function renderCollectionDropdown() {
  collectionDropdown.innerHTML = "";

  if (cachedPopupCollections === null) {
    const loading = document.createElement("div");
    loading.className = "collection-option-loading";
    loading.textContent = "Загрузка…";
    collectionDropdown.appendChild(loading);
    return;
  }

  const makeOption = (label, id, count) => {
    const opt = document.createElement("div");
    opt.className = "collection-option" + (selectedCollectionId === id ? " is-selected" : "");

    const nameSpan = document.createElement("span");
    nameSpan.textContent = label;
    opt.appendChild(nameSpan);

    if (count != null) {
      const countSpan = document.createElement("span");
      countSpan.className = "collection-option-count";
      countSpan.textContent = count;
      opt.appendChild(countSpan);
    }

    opt.addEventListener("click", () => {
      selectedCollectionId = id;
      collectionSelectLabel.textContent = label;
      collectionSelectBtn.classList.remove("is-open");
      collectionDropdown.hidden = true;
    });
    return opt;
  };

  collectionDropdown.appendChild(makeOption("Без коллекции", null, null));
  (cachedPopupCollections || []).forEach((col) => {
    collectionDropdown.appendChild(makeOption(col.name, col.id, col.itemsCount));
  });
}

collectionSelectBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !collectionDropdown.hidden;
  if (isOpen) {
    collectionDropdown.hidden = true;
    collectionSelectBtn.classList.remove("is-open");
    return;
  }
  renderCollectionDropdown();
  collectionDropdown.hidden = false;
  collectionSelectBtn.classList.add("is-open");
});

document.addEventListener("click", () => {
  if (!collectionDropdown.hidden) {
    collectionDropdown.hidden = true;
    collectionSelectBtn.classList.remove("is-open");
  }
});

// ==========================================================
// Select all / Deselect all (#3)
// ==========================================================

selectAllBtn.addEventListener("click", () => {
  const visibleItems = [...imageGrid.querySelectorAll(".grid-item:not([hidden])")];
  const allChecked = visibleItems.length > 0 && visibleItems.every((item) =>
    selectedImages.has(item.dataset.src)
  );

  visibleItems.forEach((item) => {
    const src = item.dataset.src;
    const cb = item.querySelector(".grid-checkbox");
    if (allChecked) {
      cb.checked = false;
      selectedImages.delete(src);
      item.classList.remove("is-checked");
    } else {
      cb.checked = true;
      selectedImages.set(src, imageDataMap.get(src));
      item.classList.add("is-checked");
    }
  });

  updateSaveBar();
});

// ==========================================================
// Size filter (#8)
// ==========================================================

document.querySelectorAll(".size-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    sizeFilterMin = parseInt(btn.dataset.min) || 0;
    document.querySelectorAll(".size-filter-btn").forEach((b) =>
      b.classList.remove("is-active")
    );
    btn.classList.add("is-active");

    imageGrid.querySelectorAll(".grid-item").forEach((item) => {
      const w = parseInt(item.dataset.w) || 0;
      const h = parseInt(item.dataset.h) || 0;
      const passes = Math.max(w, h) >= sizeFilterMin;
      item.hidden = !passes;

      // Deselect hidden items
      if (!passes && selectedImages.has(item.dataset.src)) {
        selectedImages.delete(item.dataset.src);
        item.classList.remove("is-checked");
        item.querySelector(".grid-checkbox").checked = false;
      }
    });

    updateSaveBar();
  });
});

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.textContent = loading ? "Загрузка…" : label;
}

// ==========================================================
// User profile
// ==========================================================

let userNickname = null;

async function loadProfile() {
  const response = await chrome.runtime.sendMessage({ type: "REFEREST_GET_PROFILE" });
  if (!response?.ok) return;

  const { nickname, avatarUrl } = response.profile;
  userNickname = nickname;

  avatarBtn.title = `@${nickname} — открыть профиль`;
  userNicknameLabel.textContent = nickname;

  if (avatarUrl) {
    avatarImg.src = avatarUrl;
    avatarImg.hidden = false;
  } else {
    // Инициал как fallback
    avatarFallback.textContent = (nickname?.[0] || "?").toUpperCase();
    avatarFallback.hidden = false;
  }
}

avatarBtn.addEventListener("click", () => {
  if (userNickname) {
    chrome.tabs.create({ url: `https://referest.ru/${userNickname}` });
  }
});

// ==========================================================
// Image grid — incremental polling
// ==========================================================

let pollInterval = null;
let pollBusy = false;          // предотвращаем concurrent polls
let emptyTimer = null;         // таймер для показа "нет изображений"
let sizeFilterMin = 0;         // текущий фильтр по размеру
const renderedSrcs = new Set();
const selectedImages = new Map();
const savedSrcs = new Set();   // src-адреса изображений, уже сохранённых в сессии (#6)
const imageDataMap = new Map(); // src → {src, alt, width, height} для select-all (#3)

function startPolling() {
  resetGrid();
  pollOnce();
  pollInterval = setInterval(pollOnce, 1000);
  // Показываем "нет изображений" если через 4 секунды ничего не нашли
  emptyTimer = setTimeout(() => {
    if (renderedSrcs.size === 0) {
      gridLoading.hidden = true;
      gridEmpty.hidden = false;
    }
  }, 4000);
}

function stopPolling() {
  clearInterval(pollInterval);
  clearTimeout(emptyTimer);
  pollInterval = null;
  pollBusy = false;
}

function isOwnSite(url) {
  try {
    const { hostname } = new URL(url || "");
    return hostname === "referest.ru" || hostname.endsWith(".referest.ru");
  } catch (_) {
    return false;
  }
}

function resetGrid() {
  clearTimeout(emptyTimer);
  pollBusy = false;
  renderedSrcs.clear();
  selectedImages.clear();
  imageDataMap.clear();
  sizeFilterMin = 0;
  imageGrid.innerHTML = "";
  imageGrid.hidden = true;
  gridEmpty.textContent = "На странице нет изображений";
  gridEmpty.hidden = true;
  gridLoading.hidden = false;
  gridToolbar.hidden = true;
  document.querySelectorAll(".size-filter-btn").forEach((btn, i) => {
    btn.classList.toggle("is-active", i === 0);
  });
  saveBar.hidden = true;
  clearSaveStatus();
  selectedCollectionId = null;
  collectionSelectLabel.textContent = "Без коллекции";
  collectionSelectBtn.classList.remove("is-open");
  collectionDropdown.hidden = true;
}

function updateSaveBar() {
  const n = selectedImages.size;
  saveBar.hidden = n === 0;
  saveSelectedBtn.textContent = `Сохранить${n > 0 ? ` (${n})` : ""}`;

  // Sync select-all button label
  const visibleItems = [...imageGrid.querySelectorAll(".grid-item:not([hidden])")];
  const allChecked = visibleItems.length > 0 && visibleItems.every((item) =>
    selectedImages.has(item.dataset.src)
  );
  selectAllBtn.textContent = allChecked && n > 0 ? "Снять все" : "Выбрать все";
}

// При навигации в активном табе — сбрасываем грид немедленно
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !pollInterval) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id === tabId) resetGrid();
  });
});

window.addEventListener("unload", stopPolling);

// Выполняется в контексте страницы — возвращает SEO-метаданные.
function getPageMeta() {
  return (
    document.querySelector('meta[property="og:description"]')?.content ||
    document.querySelector('meta[name="description"]')?.content ||
    ""
  ).trim();
}

// Выполняется в контексте страницы — сканирует текущий DOM.
// Используется как fallback когда background ещё не накопил данные.
function scanPageImages(minSize) {
  const seen = new Set();
  const result = [];

  document.querySelectorAll("img").forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:") || seen.has(src)) return;
    const rect = img.getBoundingClientRect();
    const w = img.naturalWidth || img.width || rect.width;
    const h = img.naturalHeight || img.height || rect.height;
    if (w >= minSize && h >= minSize) {
      seen.add(src);
      result.push({ src, alt: img.alt || "", width: w, height: h });
    }
  });

  document.querySelectorAll("[style*='background-image']").forEach((el) => {
    const bg = el.style.backgroundImage;
    if (!bg || bg === "none") return;
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    const src = m?.[1];
    if (!src || src.startsWith("data:") || seen.has(src)) return;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w >= minSize && h >= minSize) {
      seen.add(src);
      result.push({
        src,
        alt: el.getAttribute("aria-label") || el.title || "",
        width: w,
        height: h,
      });
    }
  });

  return result;
}

async function pollOnce() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    if (isOwnSite(tab.url)) {
      stopPolling();
      gridLoading.hidden = true;
      gridEmpty.textContent = "Расширение недоступно на Referest";
      gridEmpty.hidden = false;
      return;
    }

    // Основной источник: background хранит историю всех виденных изображений,
    // включая те что уже удалены из DOM виртуализацией
    const bgResponse = await chrome.runtime.sendMessage({
      type: "REFEREST_GET_TAB_IMAGES",
      tabId: tab.id,
    });

    // Fallback: текущий DOM через executeScript (для первого открытия
    // и случаев когда service worker был перезапущен)
    let liveImages = [];
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scanPageImages,
        args: [120],
      });
      liveImages = result || [];
    } catch (_) {}

    // Объединяем: background (история) + live DOM (текущий экран)
    const merged = new Map();
    (bgResponse?.images || []).forEach((img) => merged.set(img.src, img));
    liveImages.forEach((img) => merged.set(img.src, img));

    if (merged.size === 0) return;

    gridLoading.hidden = true;

    const fresh = [...merged.values()].filter((img) => !renderedSrcs.has(img.src));

    if (fresh.length === 0) {
      if (renderedSrcs.size === 0) gridEmpty.hidden = false;
      return;
    }

    gridEmpty.hidden = true;
    imageGrid.hidden = false;
    appendImages(fresh);
  } catch (_) {
    // chrome://, pdf и прочие несканируемые страницы
  } finally {
    pollBusy = false;
  }
}

function appendImages(images) {
  images.forEach((img) => {
    renderedSrcs.add(img.src);
    imageDataMap.set(img.src, img);

    const item = document.createElement("div");
    item.className = "grid-item";
    item.dataset.src = img.src;
    item.dataset.w = img.width || 0;
    item.dataset.h = img.height || 0;

    // Apply current size filter
    const maxDim = Math.max(img.width || 0, img.height || 0);
    if (sizeFilterMin > 0 && maxDim < sizeFilterMin) {
      item.hidden = true;
    }

    // Saved indicator badge (#6)
    const savedBadge = document.createElement("span");
    savedBadge.className = "saved-badge";
    savedBadge.textContent = "✓";
    item.appendChild(savedBadge);

    if (savedSrcs.has(img.src)) {
      item.classList.add("is-saved");
    }

    const thumb = document.createElement("img");
    thumb.src = img.src;
    thumb.alt = img.alt;
    thumb.className = "grid-thumb";
    thumb.loading = "lazy";

    const wrap = document.createElement("label");
    wrap.className = "grid-checkbox-wrap";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "grid-checkbox";

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedImages.set(img.src, img);
        item.classList.add("is-checked");
      } else {
        selectedImages.delete(img.src);
        item.classList.remove("is-checked");
      }
      updateSaveBar();
    });

    // Клик по карточке тоже переключает чекбокс
    item.addEventListener("click", (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });

    wrap.appendChild(checkbox);
    item.appendChild(thumb);
    item.appendChild(wrap);
    imageGrid.appendChild(item);
  });

  gridToolbar.hidden = false;
}

saveSelectedBtn.addEventListener("click", async () => {
  if (selectedImages.size === 0) return;

  clearSaveStatus();
  saveSelectedBtn.disabled = true;
  collectionSelectBtn.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let pageDescription = "";
  if (tab?.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getPageMeta,
      });
      pageDescription = result || "";
    } catch (_) {}
  }

  const images = [...selectedImages.values()];
  const total = images.length;
  let done = 0, saved = 0, failed = 0;
  const newlySaved = [];

  for (const img of images) {
    saveSelectedBtn.textContent = `Сохранение ${done + 1}/${total}…`;

    const result = await chrome.runtime.sendMessage({
      type: "REFEREST_SAVE_IMAGE",
      payload: {
        imageUrl: img.src,
        pageUrl: tab?.url || "",
        pageTitle: tab?.title || "",
        pageDescription,
        imageAlt: img.alt || "",
        collectionId: selectedCollectionId ?? null,
      },
    }).catch(() => ({ ok: false }));

    done++;
    if (result?.ok || result?.queued) {
      saved++;
      newlySaved.push(img.src);
    } else {
      failed++;
    }
  }

  // Mark saved images with dedup indicator (#6)
  newlySaved.forEach((src) => savedSrcs.add(src));
  imageGrid.querySelectorAll(".grid-item").forEach((item) => {
    if (savedSrcs.has(item.dataset.src)) {
      item.classList.add("is-saved");
    }
  });

  // Деселектируем все
  selectedImages.clear();
  imageGrid.querySelectorAll(".grid-checkbox").forEach((cb) => {
    cb.checked = false;
    cb.closest(".grid-item")?.classList.remove("is-checked");
  });

  saveSelectedBtn.disabled = false;
  collectionSelectBtn.disabled = false;
  updateSaveBar();

  if (failed > 0) {
    showSaveStatus(
      saved > 0
        ? `Сохранено ${saved}, не удалось: ${failed}`
        : "Не удалось сохранить изображения",
      "error"
    );
    setTimeout(clearSaveStatus, 4000);
  } else if (saved > 0) {
    showSaveStatus(`Сохранено ${saved}`, "success");
    setTimeout(clearSaveStatus, 3000);
  }
});

// ==========================================================
// Email / password login
// ==========================================================

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  setLoading(loginBtn, true, "Войти");

  const response = await chrome.runtime.sendMessage({
    type: "REFEREST_AUTH_SIGN_IN",
    email,
    password
  });

  setLoading(loginBtn, false, "Войти");

  if (response?.ok) {
    await refreshUI();
  } else {
    showStatus(response?.error || "Ошибка входа");
  }
});

// ==========================================================
// OAuth
// ==========================================================

googleBtn.addEventListener("click", async () => {
  clearStatus();
  googleBtn.disabled = true;
  yandexBtn.disabled = true;

  const response = await chrome.runtime.sendMessage({
    type: "REFEREST_AUTH_OAUTH_START",
    provider: "google"
  });

  googleBtn.disabled = false;
  yandexBtn.disabled = false;

  if (response?.ok) {
    await refreshUI();
  } else {
    showStatus(response?.error || "Ошибка Google OAuth");
  }
});

yandexBtn.addEventListener("click", async () => {
  clearStatus();
  googleBtn.disabled = true;
  yandexBtn.disabled = true;

  const response = await chrome.runtime.sendMessage({
    type: "REFEREST_AUTH_OAUTH_START",
    provider: "yandex"
  });

  googleBtn.disabled = false;
  yandexBtn.disabled = false;

  if (response?.ok) {
    await refreshUI();
  } else {
    showStatus(response?.error || "Ошибка Яндекс OAuth");
  }
});

// ==========================================================
// Signup link
// ==========================================================

signupLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://referest.ru/auth/signup" });
});

document.getElementById("policyLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://referest.ru/policy" });
});

// ==========================================================
// Screenshot capture buttons
// ==========================================================

captureViewportBtn.addEventListener("click", async () => {
  // Получаем tabId здесь — пока попап ещё открыт и является частью текущего окна
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showSaveStatus("Не удалось определить вкладку", "error");
    setTimeout(clearSaveStatus, 3000);
    return;
  }

  captureViewportBtn.disabled = true;
  captureAreaBtn.disabled = true;
  showSaveStatus("Захват страницы…", "loading");

  const result = await chrome.runtime.sendMessage({ type: "REFEREST_CAPTURE_VIEWPORT", tabId: tab.id })
    .catch(() => ({ ok: false }));

  if (result?.ok) {
    showSaveStatus("Скриншот сохранён ✓", "success");
    setTimeout(() => window.close(), 900);
  } else {
    captureViewportBtn.disabled = false;
    captureAreaBtn.disabled = false;
    showSaveStatus(result?.error || "Не удалось сделать скриншот", "error");
    setTimeout(clearSaveStatus, 3000);
  }
});

captureAreaBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showSaveStatus("Не удалось определить вкладку", "error");
    setTimeout(clearSaveStatus, 3000);
    return;
  }

  captureViewportBtn.disabled = true;
  captureAreaBtn.disabled = true;
  showSaveStatus("Подготовка захвата…", "loading");

  const result = await chrome.runtime.sendMessage({ type: "REFEREST_CAPTURE_AREA", tabId: tab.id })
    .catch(() => ({ ok: false }));

  if (result?.ok) {
    window.close(); // оверлей уже появился на странице
  } else {
    captureViewportBtn.disabled = false;
    captureAreaBtn.disabled = false;
    showSaveStatus(result?.error || "Не удалось начать захват", "error");
    setTimeout(clearSaveStatus, 3000);
  }
});

// ==========================================================
// Logout
// ==========================================================

logoutBtn.addEventListener("click", async () => {
  stopPolling();
  const response = await chrome.runtime.sendMessage({
    type: "REFEREST_AUTH_CLEAR_TOKEN"
  });

  if (response?.ok) {
    await refreshUI();
  } else {
    showStatus(response?.error || "Ошибка выхода");
  }
});
