export const STORAGE_KEYS = {
  AUTH_TOKEN:    "referest_auth_token",
  REFRESH_TOKEN: "referest_refresh_token",
  SESSION_ID:    "referest_session_id",
  OFFLINE_QUEUE: "referest_offline_queue",
};

export async function getFromStorage(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

export async function setToStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
