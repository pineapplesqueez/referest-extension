const MIN_IMAGE_SIZE = 120;
const Z_INDEX = "2147483647";
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";
const LOGO_URL = chrome.runtime.getURL("src/img/icons/logo.svg");

// Безопасная обёртка — если extension context стал невалидным (SW перезагрузился),
// возвращаем null вместо исключения.
function safeSendMessage(msg) {
  if (!chrome.runtime?.id) return Promise.resolve(null);
  return chrome.runtime.sendMessage(msg).catch((e) => {
    if (String(e).includes("Extension context invalidated")) return null;
    return null; // остальные ошибки тоже гасим в content script
  });
}

let currentImage = null;
let isOverButton = false;
let isOverPicker = false;

// Флаг авторизации — кнопка не показывается незалогиненным пользователям
let isAuthed = false;
safeSendMessage({ type: "REFEREST_AUTH_GET_STATUS" }).then((res) => {
  isAuthed = res?.isAuthed ?? false;
});

// URL-ы изображений, сохранённых в текущей сессии
const savedUrls = new Set();

// Cached collections (refreshed each time picker opens if stale)
let cachedCollections = null;
let collectionsLoadedAt = 0;
const COLLECTIONS_TTL = 60_000; // 1 min

// Инжектируем анимацию появления кнопки
const style = document.createElement("style");
style.textContent = `
  @keyframes referest-pop {
    from { opacity: 0; transform: translateY(-4px) scale(0.94); }
    to   { opacity: 1; transform: translateY(0)    scale(1);    }
  }
  @keyframes referest-picker-in {
    from { opacity: 0; transform: translateY(-6px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)    scale(1);    }
  }
`;
(document.head || document.documentElement).appendChild(style);

const { saveBtn, btnLabel } = createButton();
document.body.appendChild(saveBtn);

// ==========================================================
// Создание кнопки «Сохранить»
// ==========================================================

function createButton() {
  const btn = document.createElement("button");
  btn.setAttribute("data-referest", "save");
  btn.type = "button";

  Object.assign(btn.style, {
    position: "fixed",
    zIndex: Z_INDEX,
    display: "none",
    alignItems: "center",
    gap: "5px",
    padding: "5px 10px 5px 7px",
    borderRadius: "999px",
    border: "none",
    cursor: "pointer",
    fontFamily: FONT,
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "-0.01em",
    lineHeight: "1",
    whiteSpace: "nowrap",
    background: "#2462ea",
    color: "#f7f9fb",
    boxShadow: "0 2px 8px rgba(0,0,0,0.22)",
  });

  const logo = document.createElement("img");
  logo.src = LOGO_URL;
  Object.assign(logo.style, {
    width: "14px",
    height: "14px",
    display: "block",
    flexShrink: "0",
  });

  const label = document.createElement("span");
  label.textContent = "Сохранить";

  btn.appendChild(logo);
  btn.appendChild(label);

  btn.addEventListener("mouseenter", () => {
    isOverButton = true;
    openPicker();
  });
  btn.addEventListener("mouseleave", (e) => {
    isOverButton = false;
    if (!isOverPicker && e.relatedTarget !== currentImage) {
      scheduleHide();
    }
  });
  btn.addEventListener("click", (e) => {
    // Fallback direct save if picker failed to load or user clicked the btn itself
    e.stopPropagation();
    handleSave(e);
  });

  return { saveBtn: btn, btnLabel: label };
}

// ==========================================================
// Picker panel
// ==========================================================

const picker = buildPicker();
document.body.appendChild(picker.el);

function buildPicker() {
  const el = document.createElement("div");
  el.setAttribute("data-referest", "picker");
  Object.assign(el.style, {
    position: "fixed",
    zIndex: Z_INDEX,
    display: "none",
    flexDirection: "column",
    background: "#fff",
    borderRadius: "12px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
    fontFamily: FONT,
    fontSize: "12px",
    color: "#010816",
    minWidth: "220px",
    maxWidth: "260px",
    overflow: "hidden",
  });

  // ── Header row ──
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 10px 8px",
    borderBottom: "1px solid #e2e8f0",
  });

  const headerLogo = document.createElement("img");
  headerLogo.src = LOGO_URL;
  Object.assign(headerLogo.style, { width: "14px", height: "14px", flexShrink: "0" });

  const headerTitle = document.createElement("span");
  headerTitle.textContent = "Новая коллекция";
  Object.assign(headerTitle.style, {
    display: "none",
    fontSize: "12px",
    fontWeight: "600",
    color: "#010816",
  });

  const quickSaveBtn = document.createElement("button");
  quickSaveBtn.type = "button";
  quickSaveBtn.textContent = "Сохранить";
  Object.assign(quickSaveBtn.style, {
    border: "none",
    borderRadius: "999px",
    background: "#2462ea",
    color: "#f7f9fb",
    fontSize: "11px",
    fontWeight: "600",
    fontFamily: FONT,
    padding: "4px 10px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: "0",
  });
  quickSaveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    doSave(null, quickSaveBtn);
  });

  header.appendChild(headerLogo);
  header.appendChild(headerTitle);
  header.appendChild(quickSaveBtn);

  // ── Collections list ──
  const list = document.createElement("div");
  Object.assign(list.style, {
    display: "flex",
    flexDirection: "column",
    maxHeight: "200px",
    overflowY: "auto",
    overflowX: "hidden",
  });

  // ── Footer ──
  const footer = document.createElement("div");
  Object.assign(footer.style, {
    borderTop: "1px solid #e2e8f0",
    display: "flex",
    flexDirection: "column",
  });

  const footerBtnStyle = {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    background: "none",
    fontFamily: FONT,
    fontSize: "12px",
    padding: "9px 12px",
    cursor: "pointer",
  };

  const createCollBtn = document.createElement("button");
  createCollBtn.type = "button";
  createCollBtn.textContent = "+ Создать коллекцию";
  Object.assign(createCollBtn.style, { ...footerBtnStyle, color: "#2462ea", fontWeight: "600" });
  createCollBtn.addEventListener("mouseenter", () => { createCollBtn.style.background = "#f1f5f9"; });
  createCollBtn.addEventListener("mouseleave", () => { createCollBtn.style.background = "none"; });
  createCollBtn.addEventListener("click", (e) => { e.stopPropagation(); showCreateForm(); });

  footer.appendChild(createCollBtn);

  // ── Inline create form (hidden until needed) ──
  const createForm = document.createElement("div");
  Object.assign(createForm.style, {
    display: "none",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 12px",
  });

  const createInput = document.createElement("input");
  createInput.type = "text";
  createInput.placeholder = "Название коллекции";
  createInput.maxLength = 80;
  Object.assign(createInput.style, {
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    padding: "6px 8px",
    fontSize: "12px",
    fontFamily: FONT,
    outline: "none",
    color: "#010816",
    width: "100%",
    boxSizing: "border-box",
  });
  createInput.addEventListener("focus", () => { createInput.style.borderColor = "#2462ea"; });
  createInput.addEventListener("blur", () => { createInput.style.borderColor = "#e2e8f0"; });

  const createActions = document.createElement("div");
  Object.assign(createActions.style, { display: "flex", gap: "6px" });

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.textContent = "Создать";
  Object.assign(confirmBtn.style, {
    flex: "1",
    border: "none",
    borderRadius: "6px",
    background: "#2462ea",
    color: "#f7f9fb",
    fontSize: "11px",
    fontWeight: "600",
    fontFamily: FONT,
    padding: "6px",
    cursor: "pointer",
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Отмена";
  Object.assign(cancelBtn.style, {
    flex: "1",
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    background: "none",
    color: "#64748b",
    fontSize: "11px",
    fontFamily: FONT,
    padding: "6px",
    cursor: "pointer",
  });

  createActions.appendChild(confirmBtn);
  createActions.appendChild(cancelBtn);
  createForm.appendChild(createInput);
  createForm.appendChild(createActions);

  function showCreateForm() {
    footer.style.display = "none";
    list.style.display = "none";
    createForm.style.display = "flex";
    // Меняем хедер: прячем лого и кнопку, центрируем заголовок
    quickSaveBtn.style.display = "none";
    headerLogo.style.display = "none";
    headerTitle.style.display = "block";
    header.style.justifyContent = "center";
    createInput.value = "";
    createInput.focus();
  }

  function hideCreateForm() {
    createForm.style.display = "none";
    list.style.display = "flex";
    footer.style.display = "flex";
    // Восстанавливаем хедер
    quickSaveBtn.style.display = "";
    headerLogo.style.display = "";
    headerTitle.style.display = "none";
    header.style.justifyContent = "space-between";
  }

  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); hideCreateForm(); });

  confirmBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const title = createInput.value.trim();
    if (!title) { createInput.focus(); return; }

    confirmBtn.disabled = true;
    confirmBtn.textContent = "…";

    const res = await safeSendMessage({ type: "REFEREST_CREATE_COLLECTION", title });
    if (res?.ok) {
      // Добавляем новую коллекцию в кэш и сразу сохраняем в неё
      const col = res.collection;
      if (cachedCollections) {
        cachedCollections = [{ id: col.id, name: col.name, itemsCount: 0 }, ...cachedCollections];
      }
      collectionsLoadedAt = 0; // инвалидируем кэш
      hideCreateForm();
      doSave(col.id, confirmBtn);
    } else {
      confirmBtn.textContent = res?.error || "Ошибка";
      setTimeout(() => {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Создать";
      }, 1500);
    }
  });

  el.appendChild(header);
  el.appendChild(list);
  el.appendChild(footer);
  el.appendChild(createForm);

  el.addEventListener("mouseenter", () => { isOverPicker = true; });
  el.addEventListener("mouseleave", (e) => {
    isOverPicker = false;
    if (!isOverButton && e.relatedTarget !== currentImage) scheduleHide();
  });

  return { el, list, quickSaveBtn };
}

// ── Render collections into picker list ──
function renderCollections(collections) {
  picker.list.innerHTML = "";

  if (!collections || collections.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Нет коллекций";
    Object.assign(empty.style, {
      fontSize: "11px",
      color: "#94a3b8",
      padding: "10px 12px",
      margin: "0",
    });
    picker.list.appendChild(empty);
    return;
  }

  collections.forEach((col) => {
    const row = document.createElement("button");
    row.type = "button";
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      width: "100%",
      textAlign: "left",
      border: "none",
      background: "none",
      fontFamily: FONT,
      fontSize: "12px",
      color: "#010816",
      padding: "7px 12px",
      cursor: "pointer",
    });
    row.addEventListener("mouseenter", () => { row.style.background = "#f1f5f9"; });
    row.addEventListener("mouseleave", () => { row.style.background = "none"; });

    const name = document.createElement("span");
    name.textContent = col.name;
    Object.assign(name.style, {
      flex: "1",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontWeight: "500",
    });
    row.appendChild(name);

    if (col.itemsCount > 0) {
      const count = document.createElement("span");
      count.textContent = col.itemsCount;
      Object.assign(count.style, {
        fontSize: "11px",
        color: "#94a3b8",
        flexShrink: "0",
      });
      row.appendChild(count);
    }

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      doSave(col.id, row);
    });

    picker.list.appendChild(row);
  });
}

// ── Position picker below/beside save button ──
function positionPicker() {
  const btnRect = saveBtn.getBoundingClientRect();
  let top = btnRect.bottom + 6;
  let left = btnRect.left;

  // Keep within viewport
  const pickerW = 240;
  if (left + pickerW > window.innerWidth - 8) {
    left = window.innerWidth - pickerW - 8;
  }
  if (top + 280 > window.innerHeight - 8) {
    top = btnRect.top - 280 - 6;
  }

  Object.assign(picker.el.style, {
    left: `${Math.max(8, left)}px`,
    top: `${Math.max(8, top)}px`,
  });
}

// ── Open picker ──
async function openPicker() {
  if (picker.el.style.display === "flex") return; // already open

  positionPicker();
  Object.assign(picker.el.style, {
    display: "flex",
    animation: "referest-picker-in 0.15s ease-out both",
  });

  // Show loading state
  picker.list.innerHTML = "";
  const loading = document.createElement("p");
  loading.textContent = "Загрузка…";
  Object.assign(loading.style, {
    fontSize: "11px",
    color: "#94a3b8",
    padding: "10px 12px",
    margin: "0",
  });
  picker.list.appendChild(loading);

  // Load collections (with TTL cache)
  const now = Date.now();
  if (!cachedCollections || now - collectionsLoadedAt > COLLECTIONS_TTL) {
    try {
      const res = await safeSendMessage({ type: "REFEREST_GET_COLLECTIONS" });
      if (res?.ok) {
        cachedCollections = res.collections;
        collectionsLoadedAt = now;
      } else {
        cachedCollections = [];
      }
    } catch (_) {
      cachedCollections = [];
    }
  }

  // Only render if picker is still visible (user may have moved away)
  if (picker.el.style.display !== "none") {
    renderCollections(cachedCollections);
  }
}

// ── Close picker ──
function closePicker() {
  picker.el.style.display = "none";
}

// ==========================================================
// Show / hide
// ==========================================================

let hideTimer = null;

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!isOverButton && !isOverPicker) hideNow();
  }, 80);
}

function show(image) {
  const rect = image.getBoundingClientRect();
  if (rect.width < MIN_IMAGE_SIZE || rect.height < MIN_IMAGE_SIZE) return;

  const alreadySaved = savedUrls.has(image.currentSrc || image.src);
  setButtonState(alreadySaved ? "saved" : "default");

  Object.assign(saveBtn.style, {
    left: `${Math.max(8, rect.left + 8)}px`,
    top: `${Math.max(8, rect.top + 8)}px`,
    display: "inline-flex",
    animation: "none",
  });

  // Перезапускаем анимацию
  saveBtn.offsetHeight; // force reflow
  saveBtn.style.animation = "referest-pop 0.15s ease-out both";
}

// Мгновенное скрытие — без задержки, без transition
function hideNow() {
  clearTimeout(hideTimer);
  saveBtn.style.display = "none";
  saveBtn.style.animation = "none";
  closePicker();
  currentImage = null;
  isOverButton = false;
  isOverPicker = false;
}

// ==========================================================
// Mouse events
// ==========================================================

document.addEventListener("mouseover", (e) => {
  if (!isAuthed) return;
  const target = e.target;
  if (!(target instanceof HTMLImageElement)) return;
  if (target.hasAttribute("data-referest")) return;
  if (target.naturalWidth < MIN_IMAGE_SIZE || target.naturalHeight < MIN_IMAGE_SIZE) return;

  currentImage = target;
  show(target);
});

document.addEventListener("mouseout", (e) => {
  if (e.target !== currentImage) return;
  const to = e.relatedTarget;
  if (to === saveBtn || saveBtn.contains(to) || isOverButton) return;
  if (to === picker.el || picker.el.contains(to) || isOverPicker) return;
  hideNow();
});

// Скрываем мгновенно при скролле и ресайзе
window.addEventListener("scroll", hideNow, { passive: true });
window.addEventListener("resize", hideNow, { passive: true });

// ==========================================================
// Image tracker → pushes to background registry
// ==========================================================

const trackedImgs = new WeakSet();
const trackedBgUrls = new WeakMap(); // el → last pushed src URL

function trackImage(img) {
  if (trackedImgs.has(img)) return;
  trackedImgs.add(img);
  // Постоянный слушатель — срабатывает при каждой смене src
  img.addEventListener("load", () => pushImage(img));
  pushImage(img);
}

function pushImage(img) {
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith("data:")) return;
  if (img.naturalWidth < MIN_IMAGE_SIZE || img.naturalHeight < MIN_IMAGE_SIZE) return;
  safeSendMessage({
    type: "REFEREST_IMAGE_FOUND",
    image: { src, alt: img.alt || "", width: img.naturalWidth, height: img.naturalHeight },
  });
}

// ── background-image (inline style) ──

function parseBgUrl(el) {
  const bg = el.style?.backgroundImage;
  if (!bg || bg === "none") return null;
  const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
  return m?.[1] ?? null;
}

function pushBgElement(el) {
  const src = parseBgUrl(el);
  if (!src || src.startsWith("data:")) return;
  // Skip if same URL already pushed for this element (style mutations can fire repeatedly)
  if (trackedBgUrls.get(el) === src) return;
  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w < MIN_IMAGE_SIZE || h < MIN_IMAGE_SIZE) return;
  trackedBgUrls.set(el, src);
  safeSendMessage({
    type: "REFEREST_IMAGE_FOUND",
    image: {
      src,
      alt: el.getAttribute("aria-label") || el.title || "",
      width: w,
      height: h,
    },
  });
}

// Сканируем всё что есть в DOM при старте
document.querySelectorAll("img").forEach(trackImage);
document.querySelectorAll("[style*='background-image']").forEach(pushBgElement);

// Следим за новыми img и сменой src (lazy loaders, infinite scroll, виртуализация)
new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === "childList") {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLImageElement) {
          trackImage(node);
        } else if (node instanceof Element) {
          node.querySelectorAll("img").forEach(trackImage);
          if (parseBgUrl(node)) pushBgElement(node);
          node.querySelectorAll("[style*='background-image']").forEach(pushBgElement);
        }
      }
    } else if (m.type === "attributes") {
      if (m.target instanceof HTMLImageElement) {
        // src/srcset сменился (custom lazy loader) — переотслеживаем
        trackedImgs.delete(m.target);
        trackImage(m.target);
      } else if (m.attributeName === "style" && m.target instanceof Element) {
        // inline style сменился — проверяем background-image
        pushBgElement(m.target);
      }
    }
  }
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "style"],
});

// ==========================================================
// Save
// ==========================================================

async function doSave(collectionId, triggerEl) {
  if (!currentImage) return;

  // Показываем loading сразу на главной кнопке
  setButtonState("loading");

  const payload = {
    imageUrl: currentImage.currentSrc || currentImage.src,
    pageUrl: window.location.href,
    pageTitle: document.title,
    pageDescription: (
      document.querySelector('meta[property="og:description"]')?.content ||
      document.querySelector('meta[name="description"]')?.content ||
      ""
    ).trim(),
    imageAlt: currentImage.alt || "",
    collectionId: collectionId ?? null,
  };

  const origText = triggerEl?.textContent;
  if (triggerEl) {
    triggerEl.disabled = true;
    triggerEl.textContent = "…";
  }

  const response = await safeSendMessage({
    type: "REFEREST_SAVE_IMAGE",
    payload,
  });

  if (triggerEl) {
    triggerEl.textContent = response?.ok ? "Сохранено ✓" : errorLabel(response?.error);
    setTimeout(() => {
      triggerEl.disabled = false;
      triggerEl.textContent = origText;
    }, 1500);
  }

  if (response?.ok) {
    savedUrls.add(payload.imageUrl);
    // Сохранение в коллекцию меняет itemsCount — сбрасываем кэш
    if (collectionId != null) collectionsLoadedAt = 0;
    setButtonState("saved");
    setTimeout(() => {
      setButtonState("default");
      hideNow();
    }, 1200);
  } else if (response?.error?.includes("authenticated")) {
    setButtonState("auth");
    setTimeout(() => setButtonState("default"), 1500);
    hideNow();
  } else {
    setButtonState("error");
    setTimeout(() => setButtonState("default"), 1500);
  }
}

function errorLabel(error) {
  if (!error) return "Ошибка";
  if (error.includes("403")) return "Нет доступа";
  if (error.includes("429") || error.includes("лимит")) return "Лимит!";
  if (error.includes("загрузить") || error.includes("404")) return "Недоступно";
  return "Ошибка";
}

async function handleSave(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!currentImage) return;
  await doSave(null, null);
}

function setButtonState(state) {
  const states = {
    default: { text: "Сохранить", bg: "#2462ea" },
    loading: { text: "...",        bg: "#64748b" },
    saved:   { text: "Сохранено",  bg: "#16a34a" },
    auth:    { text: "Войдите",    bg: "#ee4444" },
    error:   { text: "Ошибка",     bg: "#ee4444" },
  };

  const s = states[state] || states.default;
  btnLabel.textContent = s.text;
  saveBtn.style.background = s.bg;
  saveBtn.disabled = state === "loading";
}

// ==========================================================
// Capture toast — page-level upload feedback
// ==========================================================

let captureToastEl = null;
let captureToastTimer = null;

function showCaptureToast(text, state = "loading") {
  clearTimeout(captureToastTimer);

  if (!captureToastEl) {
    captureToastEl = document.createElement("div");
    captureToastEl.setAttribute("data-referest", "toast");

    const logoImg = document.createElement("img");
    logoImg.src = LOGO_URL;
    Object.assign(logoImg.style, { width: "14px", height: "14px", flexShrink: "0", display: "block" });

    const textEl = document.createElement("span");
    textEl.setAttribute("data-referest-toast-text", "");

    captureToastEl.appendChild(logoImg);
    captureToastEl.appendChild(textEl);

    Object.assign(captureToastEl.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: Z_INDEX,
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "10px 16px",
      borderRadius: "10px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.28)",
      fontFamily: FONT,
      fontSize: "13px",
      fontWeight: "500",
      color: "#f8fafc",
      letterSpacing: "-0.01em",
      pointerEvents: "none",
      transition: "background 0.2s",
    });

    document.body.appendChild(captureToastEl);
  }

  captureToastEl.querySelector("[data-referest-toast-text]").textContent = text;
  captureToastEl.style.background =
    state === "success" ? "#16a34a" :
    state === "error"   ? "#ee4444" :
                          "#1e293b";
  captureToastEl.style.display = "flex";

  if (state !== "loading") {
    captureToastTimer = setTimeout(hideCaptureToast, 2500);
  }
}

function hideCaptureToast() {
  clearTimeout(captureToastTimer);
  captureToastEl?.remove();
  captureToastEl = null;
}

// ==========================================================
// Screenshot capture overlay
// ==========================================================

let captureOverlayEl = null;
let captureKeyListener = null;

function showCaptureOverlay() {
  if (captureOverlayEl) removeCaptureOverlay();

  hideNow(); // убираем hover-кнопку если была показана

  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Контейнер
  const container = document.createElement("div");
  container.setAttribute("data-referest", "capture-overlay");
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    zIndex: Z_INDEX,
    cursor: "crosshair",
  });

  // Canvas — тёмный оверлей с «вырезом» в области выделения
  const canvas = document.createElement("canvas");
  canvas.width = vw;
  canvas.height = vh;
  Object.assign(canvas.style, { position: "absolute", inset: "0", display: "block" });
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d");

  // Подсказка
  const hint = document.createElement("div");
  hint.textContent = "Выделите область · ESC для отмены";
  Object.assign(hint.style, {
    position: "absolute",
    top: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.72)",
    color: "#fff",
    fontSize: "13px",
    fontFamily: FONT,
    fontWeight: "500",
    padding: "7px 16px",
    borderRadius: "20px",
    pointerEvents: "none",
    whiteSpace: "nowrap",
    letterSpacing: "-0.01em",
  });
  container.appendChild(hint);

  let startX = 0, startY = 0, curX = 0, curY = 0, isSelecting = false;

  function getRect() {
    return {
      x: Math.round(Math.min(startX, curX)),
      y: Math.round(Math.min(startY, curY)),
      width:  Math.round(Math.abs(curX - startX)),
      height: Math.round(Math.abs(curY - startY)),
    };
  }

  function redraw() {
    ctx.clearRect(0, 0, vw, vh);

    // Тёмный оверлей
    ctx.fillStyle = "rgba(0,0,0,0.48)";
    ctx.fillRect(0, 0, vw, vh);

    if (!isSelecting) return;

    const { x, y, width: w, height: h } = getRect();
    if (w < 2 || h < 2) return;

    // «Вырез» — просвечивает живую страницу
    ctx.clearRect(x, y, w, h);

    // Синяя рамка
    ctx.strokeStyle = "#2462ea";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    // Размерный лейбл
    const label = `${w} × ${h}`;
    ctx.font = `500 12px ${FONT}`;
    const lw = ctx.measureText(label).width + 14;
    const lh = 22;
    const lx = Math.max(x, 0);
    const ly = y >= lh + 6 ? y - lh - 4 : y + h + 4;

    ctx.fillStyle = "#2462ea";
    ctx.beginPath();
    ctx.roundRect(lx, ly, lw, lh, 4);
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + 7, ly + lh / 2);
  }

  redraw();

  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    curX   = e.clientX; curY   = e.clientY;
    isSelecting = true;
    hint.style.display = "none";
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isSelecting) return;
    curX = e.clientX;
    curY = e.clientY;
    redraw();
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!isSelecting) return;
    isSelecting = false;
    const rect = getRect();

    if (rect.width < 10 || rect.height < 10) {
      // Слишком маленькое выделение — сбрасываем
      hint.style.display = "";
      redraw();
      return;
    }

    removeCaptureOverlay();
    showCaptureToast("Сохранение скриншота…");
    safeSendMessage({ type: "REFEREST_AREA_SELECTED", rect, dpr }).then((result) => {
      if (result?.ok) {
        showCaptureToast("Скриншот сохранён ✓", "success");
      } else {
        showCaptureToast("Не удалось сохранить", "error");
      }
    });
  });

  // ESC отменяет
  captureKeyListener = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      removeCaptureOverlay();
    }
  };
  document.addEventListener("keydown", captureKeyListener, { capture: true });

  document.body.appendChild(container);
  captureOverlayEl = container;
}

function removeCaptureOverlay() {
  if (captureKeyListener) {
    document.removeEventListener("keydown", captureKeyListener, { capture: true });
    captureKeyListener = null;
  }
  captureOverlayEl?.remove();
  captureOverlayEl = null;
}

// Входящие сообщения от background (capture-команды + смена авторизации)
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "REFEREST_START_CAPTURE") {
    showCaptureOverlay();
  }
  if (message?.type === "REFEREST_CAPTURE_TOAST") {
    showCaptureToast(message.text, message.state);
  }
  if (message?.type === "REFEREST_AUTH_CHANGED") {
    isAuthed = message.isAuthed;
    if (!isAuthed) hideNow();
  }
});
