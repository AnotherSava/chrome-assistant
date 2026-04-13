/** Load multiple settings from chrome.storage.local in one call. Returns parsed values merged with defaults. */
export async function loadSettings<T extends Record<string, unknown>>(defaults: T): Promise<T> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return { ...defaults };
  const keys = Object.keys(defaults);
  const stored = await chrome.storage.local.get(keys);
  const result = { ...defaults } as Record<string, unknown>;
  for (const key of keys) {
    if (key in stored && stored[key] !== undefined) {
      try { result[key] = JSON.parse(stored[key] as string); } catch { /* keep default */ }
    }
  }
  return result as T;
}

/** Save a setting to chrome.storage.local. */
export function saveSetting<T>(key: string, value: T): void {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.set({ [key]: JSON.stringify(value) });
  }
}

/** Listen for setting changes from chrome.storage.local. Callback receives parsed values for changed keys. */
export function onSettingChanged(callback: (changes: Record<string, unknown>) => void): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const parsed: Record<string, unknown> = {};
    for (const [key, change] of Object.entries(changes)) {
      if (change.newValue !== undefined) {
        try { parsed[key] = JSON.parse(change.newValue as string); } catch { parsed[key] = change.newValue; }
      }
    }
    if (Object.keys(parsed).length > 0) callback(parsed);
  });
}
