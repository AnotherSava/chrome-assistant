import { escapeHtml, ICON_UNDO } from "@core/icons.js";
import { loadSettings, saveSetting } from "@core/settings.js";
import type { GmailLabel } from "@core/types.js";
import type { ErrorHint } from "@core/error-display.js";
import * as dealsView from "./summary-deals.js";
import * as remindersView from "./summary-reminders.js";
import { clearUndo, popUndo, setUndoListener } from "./undo-stack.js";

type SubTab = "deals" | "reminders";

const SUB_TABS: { id: SubTab; title: string }[] = [
  { id: "deals", title: "Deals" },
  { id: "reminders", title: "Reminders" },
];

const KEY_SUB_TAB = "ca_summary_subtab";
const SETTINGS_DEFAULTS = { [KEY_SUB_TAB]: "deals" as SubTab };

let currentSubTab: SubTab = "deals";
const counts: Partial<Record<SubTab, number | null>> = {};

dealsView.setOnCount((count) => {
  counts.deals = count;
  updateSubTabBadge("deals");
});
remindersView.setOnCount((count) => {
  counts.reminders = count;
  updateSubTabBadge("reminders");
});

export async function init(): Promise<void> {
  const s = await loadSettings(SETTINGS_DEFAULTS);
  currentSubTab = s[KEY_SUB_TAB];
}

function subTabLabel(tab: SubTab): string {
  const title = SUB_TABS.find(t => t.id === tab)?.title ?? tab;
  const c = counts[tab];
  return c !== null && c !== undefined ? `${title} (${c})` : title;
}

function updateSubTabBadge(tab: SubTab): void {
  const btn = document.querySelector<HTMLElement>(`.sub-tab[data-sub-tab="${tab}"]`);
  if (btn) btn.textContent = subTabLabel(tab);
}

export function setPort(p: chrome.runtime.Port | null): void {
  dealsView.setPort(p);
  remindersView.setPort(p);
}

export function setLabels(labels: GmailLabel[] | null): void {
  dealsView.setLabels(labels);
  remindersView.setLabels(labels);
}

export function setAccountPath(path: string): void {
  dealsView.setAccountPath(path);
  remindersView.setAccountPath(path);
}

export function setGmailHash(hash: string, isListView: boolean): void {
  dealsView.setGmailHash(hash, isListView);
  remindersView.setGmailHash(hash, isListView);
}

export function reset(): void {
  dealsView.reset();
  remindersView.reset();
}

export function deactivate(): void {
  dealsView.deactivate();
  remindersView.deactivate();
  clearUndo();
}

export function activate(): void {
  ensureShellRendered();
  showSubTab(currentSubTab);
}

function ensureShellRendered(): void {
  const contentEl = document.getElementById("content");
  if (!contentEl) return;
  if (contentEl.querySelector(".sub-tab-bar")) return;
  contentEl.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "sub-tab-bar";
  const tabButtons = SUB_TABS.map(t => `<button class="sub-tab" data-sub-tab="${t.id}">${escapeHtml(subTabLabel(t.id))}</button>`).join("");
  bar.innerHTML = `${tabButtons}<button class="summary-undo-btn" title="Undo last action" disabled>${ICON_UNDO}</button>`;
  contentEl.appendChild(bar);
  for (const t of SUB_TABS) {
    const pane = document.createElement("div");
    pane.id = `sub-${t.id}`;
    pane.className = "sub-pane";
    pane.hidden = t.id !== currentSubTab;
    contentEl.appendChild(pane);
  }
  bar.querySelectorAll<HTMLButtonElement>(".sub-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.subTab as SubTab;
      if (tab === currentSubTab) {
        // Re-click on the active sub-tab: push its filter to the Gmail page.
        if (tab === "deals") dealsView.sendGmailFilter();
        else if (tab === "reminders") remindersView.sendGmailFilter();
        return;
      }
      currentSubTab = tab;
      saveSetting(KEY_SUB_TAB, tab);
      clearUndo();
      showSubTab(tab);
    });
  });
  const undoBtn = bar.querySelector<HTMLButtonElement>(".summary-undo-btn");
  if (undoBtn) {
    undoBtn.addEventListener("click", () => { void handleUndoClick(); });
    setUndoListener((depth) => {
      const el = document.querySelector<HTMLButtonElement>(".summary-undo-btn");
      if (el) el.disabled = depth === 0;
    });
  }
}

async function handleUndoClick(): Promise<void> {
  const entry = popUndo();
  if (!entry) return;
  try {
    await entry.undo();
  } catch {
    // The view's undo callback already shows its own error.
  }
}

function showSubTab(tab: SubTab): void {
  document.querySelectorAll<HTMLElement>(".sub-tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.subTab === tab);
  });
  for (const t of SUB_TABS) {
    const pane = document.getElementById(`sub-${t.id}`);
    if (pane) pane.hidden = t.id !== tab;
  }
  if (tab === "deals") {
    void dealsView.activate();
  } else if (tab === "reminders") {
    void remindersView.activate();
  }
}

export function handleMessage(message: { type: string; requestId?: string; ids?: string[]; errorText?: string; hint?: ErrorHint | null }): boolean {
  const dealsHandled = dealsView.handleMessage(message);
  const remindersHandled = remindersView.handleMessage(message);
  return dealsHandled || remindersHandled;
}
