---
layout: default
title: Privacy Policy
---

[Home](..) | [Gmail](gmail/) | [Privacy](privacy)

---

# Privacy Policy

**Gmail Assistant** is a browser extension that provides label-based filtering and navigation for [Gmail](https://mail.google.com). This policy explains how the extension handles your data.

## Data collection

Gmail Assistant does **not** collect, transmit, or store any personal data. There are no analytics, telemetry, or tracking of any kind. The extension does not make network requests to any servers other than `mail.google.com` and Google's OAuth/API endpoints (which your browser already connects to when using Gmail).

## How the extension works

- The extension uses Gmail API (read-only) to fetch your label list and message IDs for building a local cache of label associations.
- All processing happens locally in your browser — label indexes and co-label counts are computed on your device and never sent anywhere.
- The local cache is stored in your browser's IndexedDB and never leaves your device.
- Display preferences (such as column count, scope, and toggle states) are saved in your browser's local extension storage and never leave your device.

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

## Third-party services

Gmail Assistant does not communicate with any third-party services. All fonts and assets are bundled with the extension.

## Changes

If this policy changes, the updated version will be posted at this URL.

## Contact

For questions or concerns, please open an issue on the [GitHub repository](https://github.com/AnotherSava/chrome-assistant).
