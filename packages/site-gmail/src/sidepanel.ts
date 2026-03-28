import { renderHelp } from "@core/help.js";
import { ICON_PANEL, ICON_PANEL_1 } from "@core/icons.js";
import { loadSetting, saveSetting } from "@core/settings.js";
import type { PinMode } from "@core/types.js";

// ---------------------------------------------------------------------------
// Zoom (Ctrl+/- and Ctrl+0)
// ---------------------------------------------------------------------------

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const KEY_ZOOM = "ca_zoom_levels";
const ZOOM_DEFAULT = 1.0;

let zoomLevel = ZOOM_DEFAULT;
let zoomFadeTimeout: ReturnType<typeof setTimeout> | undefined;
let currentZoomContext = "help";

function switchZoomContext(context: string): void {
  currentZoomContext = context;
  const levels = loadSetting<Record<string, number>>(KEY_ZOOM, {});
  const stored = levels[context];
  zoomLevel = stored !== undefined && stored >= ZOOM_MIN && stored <= ZOOM_MAX ? stored : ZOOM_DEFAULT;
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.style.zoom = String(zoomLevel);
}

function applyZoom(): void {
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.style.zoom = String(zoomLevel);
  const levels = loadSetting<Record<string, number>>(KEY_ZOOM, {});
  levels[currentZoomContext] = zoomLevel;
  saveSetting(KEY_ZOOM, levels);
  const indicator = document.getElementById("zoom-indicator");
  if (indicator) {
    indicator.textContent = `${Math.round(zoomLevel * 100)}%`;
    indicator.classList.add("visible");
    clearTimeout(zoomFadeTimeout);
    zoomFadeTimeout = setTimeout(() => indicator.classList.remove("visible"), 1200);
  }
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.key === "=" || e.key === "+") {
    e.preventDefault();
    zoomLevel = Math.min(ZOOM_MAX, Math.round((zoomLevel + ZOOM_STEP) * 10) / 10);
    applyZoom();
  } else if (e.key === "-") {
    e.preventDefault();
    zoomLevel = Math.max(ZOOM_MIN, Math.round((zoomLevel - ZOOM_STEP) * 10) / 10);
    applyZoom();
  } else if (e.key === "0") {
    e.preventDefault();
    zoomLevel = 1.0;
    applyZoom();
  }
});

document.getElementById("btn-zoom-out")?.addEventListener("click", () => {
  zoomLevel = Math.max(ZOOM_MIN, Math.round((zoomLevel - ZOOM_STEP) * 10) / 10);
  applyZoom();
});
document.getElementById("btn-zoom-in")?.addEventListener("click", () => {
  zoomLevel = Math.min(ZOOM_MAX, Math.round((zoomLevel + ZOOM_STEP) * 10) / 10);
  applyZoom();
});

// ---------------------------------------------------------------------------
// Auto-hide (pin mode)
// ---------------------------------------------------------------------------

const KEY_PIN_MODE = "ca_pin_mode";
const PIN_MODE_DEFAULT: PinMode = "pinned";
let currentPinMode: PinMode = loadSetting(KEY_PIN_MODE, PIN_MODE_DEFAULT);
let pinDropdownOpen = false;

const PIN_ICONS: Record<PinMode, string> = {
  "pinned": ICON_PANEL,
  "autohide-site": ICON_PANEL_1,
};

const PIN_LABELS: Record<PinMode, string> = {
  "pinned": "Never",
  "autohide-site": "Leaving Gmail",
};

const PIN_ORDER: PinMode[] = ["pinned", "autohide-site"];

function updatePinButtonIcon(): void {
  const btn = document.getElementById("btn-pin");
  if (btn) btn.innerHTML = PIN_ICONS[currentPinMode];
}

function closePinDropdown(): void {
  const dropdown = document.getElementById("pin-dropdown");
  if (!dropdown) return;
  dropdown.style.display = "none";
  pinDropdownOpen = false;
}

function selectPinMode(mode: PinMode): void {
  currentPinMode = mode;
  saveSetting(KEY_PIN_MODE, mode);
  updatePinButtonIcon();
  closePinDropdown();
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "setPinMode", mode }).catch(() => {});
  }
}

function buildPinDropdown(): void {
  const dropdown = document.getElementById("pin-dropdown");
  if (!dropdown) return;
  dropdown.innerHTML = "";

  const header = document.createElement("div");
  header.className = "dropdown-header";
  header.textContent = "When side panel hides:";
  dropdown.appendChild(header);

  for (const mode of PIN_ORDER) {
    const isActive = mode === currentPinMode;
    const option = document.createElement("div");
    option.className = "pin-option" + (isActive ? " active" : "");
    option.dataset.mode = mode;
    option.innerHTML = PIN_ICONS[mode] + "<span>" + PIN_LABELS[mode] + "</span>";
    dropdown.appendChild(option);

    option.addEventListener("mouseover", () => {
      dropdown.querySelectorAll(".pin-option").forEach((el) => el.classList.remove("highlight"));
      option.classList.add("highlight");
    });
    option.addEventListener("mouseout", () => { option.classList.remove("highlight"); });
    option.addEventListener("mouseup", (e: MouseEvent) => {
      e.stopPropagation();
      if (isActive) { closePinDropdown(); return; }
      selectPinMode(mode);
    });
  }

  // Divider + shortcut link
  const divider = document.createElement("div");
  divider.className = "pin-divider";
  dropdown.appendChild(divider);

  const link = document.createElement("span");
  link.className = "pin-shortcut-link";
  link.textContent = "Set hide/show shortcut";
  if (typeof chrome !== "undefined" && chrome.commands?.getAll) {
    chrome.commands.getAll((commands: chrome.commands.Command[]) => {
      const cmd = commands.find((c) => c.name === "toggle-sidepanel");
      if (cmd?.shortcut) link.textContent = `Change hide/show shortcut (${cmd.shortcut})`;
    });
  }
  link.addEventListener("mouseup", (e: MouseEvent) => {
    e.stopPropagation();
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
    closePinDropdown();
  });
  dropdown.appendChild(link);
}

function openPinDropdown(): void {
  const dropdown = document.getElementById("pin-dropdown");
  if (!dropdown) return;
  buildPinDropdown();
  dropdown.style.display = "";
  pinDropdownOpen = true;
}

const btnPin = document.getElementById("btn-pin");
if (btnPin) {
  btnPin.onmousedown = (e: MouseEvent) => {
    e.preventDefault();
    if (pinDropdownOpen) closePinDropdown();
    else openPinDropdown();
  };
  updatePinButtonIcon();
}

document.addEventListener("mouseup", (e: MouseEvent) => {
  if (!pinDropdownOpen) return;
  const dropdown = document.getElementById("pin-dropdown");
  const btn = document.getElementById("btn-pin");
  if (dropdown && !dropdown.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
    closePinDropdown();
  }
});

// Push persisted pin mode to background on startup
if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
  chrome.runtime.sendMessage({ type: "setPinMode", mode: currentPinMode }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Help page
// ---------------------------------------------------------------------------

function showHelp(): void {
  const contentEl = document.getElementById("content");
  if (!contentEl) return;
  switchZoomContext("help");
  contentEl.innerHTML = renderHelp();
}

document.getElementById("btn-help")?.addEventListener("click", () => {
  showHelp();
});

// ---------------------------------------------------------------------------
// Port connection to background
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime?.connect) {
  const connectToBackground = (): void => {
    try {
      const port = chrome.runtime.connect(undefined, { name: "sidepanel" });
      chrome.runtime.sendMessage({ type: "setPinMode", mode: currentPinMode }).catch(() => {});
      port.onDisconnect.addListener(() => {
        setTimeout(connectToBackground, 1000);
      });
    } catch {
      // Extension context invalidated
    }
  };
  connectToBackground();
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: { type: string }) => {
    if (message.type === "notAGame") {
      showHelp();
    }
    return undefined;
  });
}

// Show help on startup
showHelp();
