---
layout: default
title: Gmail — Privacy Policy
---

[Home](../..) | [Gmail](.) | [Privacy](privacy) | [Development](../development)

---

# Privacy Policy

**Another Gmail Assistant** is a browser extension that provides label-based filtering and navigation for [Gmail](https://mail.google.com). This policy explains how the extension handles your data.

## Data collection

Another Gmail Assistant does **not** collect or transmit any personal data. There are no analytics, telemetry, or tracking of any kind, and no data leaves your browser. The extension's only outbound network traffic is to Google's OAuth and Gmail API endpoints — using a read-only OAuth scope, so it cannot send emails, create drafts, or modify any content in your account (see [OAuth2 scope](#oauth2-scope) below).

## Local data storage

To function, the extension stores data locally on your device. This data never leaves your browser — it is not sent to any server, including ours.

- **Message and label index** (IndexedDB): message IDs and the labels attached to each message, fetched from the Gmail API. Used to compute co-label counts and answer queries instantly without re-fetching. Scoped per Gmail account.
- **Display preferences** (`chrome.storage.local`): column count, scope selection, include-children toggle, show-counts toggle, show Starred / Important toggles, zoom level, pin mode.

You can clear all stored data at any time by clicking the refresh (↻) button in the side panel toolbar to reset the cache, or by removing the extension from Chrome.

## How the extension works

- The extension uses the Gmail API (read-only) to fetch your label list and message IDs for building the local cache.
- All processing happens locally in your browser — label indexes and co-label counts are computed on your device and never sent anywhere.

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Detect the current Gmail tab to synchronize side panel navigation |
| `alarms` | Schedule periodic cache refresh and keep the service worker alive during background fetching |
| `identity` | Obtain an OAuth2 token for Gmail API access (read-only) |
| `sidePanel` | Display the label browser in a Chrome side panel |
| `storage` | Persist extension state across service worker restarts |
| `tabs` | Detect navigation between Gmail tabs and update side panel content |
| `host_permissions` (mail.google.com) | Navigate the Gmail tab to filtered views when a label is selected |

## OAuth2 scope

The extension requests `gmail.readonly` — read-only access to your Gmail account. It cannot send, delete, or modify emails or settings.

In practice, the extension only reads message IDs and label IDs from the Gmail API `messages.list` and `labels.list` endpoints. It never calls `messages.get`, so it never reads message bodies, subjects, headers, snippets, or attachments. The local cache stores only `{ messageId → [labelIds] }` mappings.

The narrower `gmail.metadata` scope was evaluated but does not support the search operators (`after:`, `before:`, `has:nouserlabels`) required for time-scope filtering and the "no user labels" feature.

## Third-party services

Another Gmail Assistant does not communicate with any third-party services. All fonts and assets are bundled with the extension.

## Changes

If this policy changes, the updated version will be posted at this URL.

## Contact

For questions or concerns, please open an issue on the [GitHub repository](https://github.com/AnotherSava/chrome-assistant).
