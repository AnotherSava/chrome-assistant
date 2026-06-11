---
name: project-summary-tab-plan
description: Gmail Summary tab — shipped scope, label conventions, and the architectural choice to keep sub-views as parallel near-duplicates
metadata:
  node_type: memory
  type: project
---

The Gmail Summary tab is feature-complete for the current direction. The original four-step plan was bypassed when the user moved to label-driven filtering instead of structured extraction.

**Shipped (as of 2026-05-21):**
- Sub-tab shell with persisted active sub-tab (`summary-tab.ts`).
- **Deals** sub-view: intersects `ads/deal` AND `pending` labels. Body fetched via `fetchMessagesFull`, regex extractors for expiry (`expiry.ts`) and max discount (`discount.ts`) run once at fetch time; results persisted per-message in `SUMMARY_DEALS_STORE` so subsequent renders skip the Gmail API.
- **Reminders** sub-view: filters by the single `remind` user label. Metadata-only fetch (`fetchMessagesMetadata`), cleaned subjects persisted in `SUMMARY_REMINDERS_STORE`, grouped by cleaned subject with `(+N)` count.
- Per-row hover-revealed archive (remove the filter label that gates the view) + delete (move to Trash via `addLabelIds: ["TRASH"]`) buttons. Optimistic local cache patching with rollback on API failure.
- Shared LIFO undo stack (`undo-stack.ts`) cleared on sub-tab switch / Summary deactivate. Undo button at the right of the sub-tab bar.
- OAuth scope upgraded to `gmail.modify` (manifest 1.2.0) plus `scripting` permission.
- Gmail page integration: re-clicking the active sub-tab navigates Gmail to the filter URL (no-op if already there); archive/delete/undo refresh Gmail's current view in place via injected click on Gmail's own Refresh button — see [[feedback-actions-refresh-not-navigate]] and [[chrome-extension]].

**Why the plan changed:** The original step 3 (structured JSON-LD `Offer` blocks for Deals, ICS `text/calendar` parts for Reminders) was bypassed when the user switched Reminders to filter by a single `remind` user label rather than intersecting `notifications/calendar` AND `pending`. Label-driven filtering is now the convention for both sub-views, and the deferred work (JSON-LD/ICS extraction) is no longer relevant in the current direction.

**Architectural state:** `summary-deals.ts` and `summary-reminders.ts` remain intentionally near-duplicates — same shape (cache → fetch missing → render → action handlers with optimistic rollback → undo push) but each owns its label set, query builder, and per-tab IndexedDB store. See [[feedback-no-premature-abstraction]]: only build the shared interface when a third concrete view emerges. The two files diverge mainly in: filter labels, query construction (intersection vs single label), and the per-row data shape (Deals stores `fromName`/`expiry`/`discount`; Reminders stores raw subject for grouping).

**How to apply:** When extending Summary, follow the same per-sub-view shape rather than reaching for a shared `SummaryView<T>` interface. Each new sub-view should own its label set, its IndexedDB store, and its action handlers.
