---
layout: default
title: Privacy policy
parent: Gmail
nav_order: 1
---

# Privacy Policy

**Another Assistant for Gmail** is a browser extension that provides label-based filtering and navigation for [Gmail](https://mail.google.com). This policy explains how the extension handles your data.

## Data collection

Another Assistant for Gmail does **not** collect or transmit any personal data. There are no analytics, telemetry, or tracking of any kind, and no data leaves your browser. The extension's only outbound network traffic is to Google's OAuth and Gmail API endpoints (see [OAuth2 scope](#oauth2-scope) below).

## Local data storage

To function, the extension stores data locally on your device. This data never leaves your browser — it is not sent to any server, including ours.

- **Message and label index** (IndexedDB): message IDs and the labels attached to each message, fetched from the Gmail API. Used to compute co-label counts and answer queries instantly without re-fetching. Scoped per Gmail account.
- **Summary records** (IndexedDB): for messages shown on the Summary tab, the message and thread IDs, subject and date; for a Deals message also the sender name and the expiry date and maximum discount extracted from its body. The body itself is read only to extract those two values and is not stored.
- **Preferences and selection** (`chrome.storage.local`): column count, scope selection, include-children toggle, show-counts toggle, show Starred / Important toggles, return-to-inbox toggle, parallel fetch count, zoom level, pin mode, active Summary sub-tab, and the label selected on the Search tab (its Gmail label ID and name), so the selection is restored when the side panel reopens.

You can clear all stored data at any time by clicking the refresh (↻) button in the side panel toolbar to reset the cache, or by removing the extension from Chrome.

## How the extension works

- The Search tab uses the Gmail API to fetch your label list and the message IDs in each label for building the local cache. It reads no message content.
- The Summary tab reads more of the messages carrying the labels it summarizes: the Subject, From and Date headers of Reminders messages, and the full content of Deals messages, whose body text is scanned for an expiry date and a maximum discount.
- The Summary tab's archive and delete buttons change labels on the messages you act on: archive removes the `pending` (Deals) or `remind` (Reminders) label, and delete moves the message to Gmail's Trash, from which Gmail recovers it for 30 days. Undo reverses either change. The extension never deletes a message permanently.
- All processing happens locally in your browser — label indexes, co-label counts and extracted Summary values are computed on your device and never sent anywhere.

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Detect the current Gmail tab to synchronize side panel navigation |
| `alarms` | Schedule periodic cache refresh and keep the service worker alive during background fetching |
| `identity` | Obtain an OAuth2 token for Gmail API access |
| `scripting` | Click Gmail's own Refresh button after an archive or delete, so the Gmail tab shows the change without a full page reload |
| `sidePanel` | Display the label browser in a Chrome side panel |
| `storage` | Persist extension state across service worker restarts |
| `tabs` | Detect navigation between Gmail tabs and update side panel content |
| `host_permissions` (mail.google.com) | Navigate the Gmail tab to filtered views when a label is selected |

## OAuth2 scope

The extension requests `gmail.modify`, which grants reading messages and changing their labels. The archive and delete actions on the Summary tab need it: a read-only scope cannot change labels or move a message to Trash. The scope does not allow permanent deletion.

In practice, the extension calls four Gmail API endpoints: `labels.list` for the label list, `messages.list` for message IDs, `messages.get` for the Summary tab's headers and Deals bodies, and `messages.batchModify` for archive, delete and their undo. The scope would also permit composing and sending mail; the extension makes no such call, and it never reads attachments.

## Third-party services

Another Assistant for Gmail does not communicate with any third-party services. All fonts and assets are bundled with the extension.

## Changes

If this policy changes, the updated version will be posted at this URL.

## Contact

For questions or concerns, please open an issue on the [GitHub repository](https://github.com/AnotherSava/chrome-assistant).
