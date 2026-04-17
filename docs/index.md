---
layout: default
title: Chrome Assistant
---

[Home](.) | [Gmail](pages/gmail) | [Development](pages/development)

---

*A family of Chrome extensions sharing a common side panel framework. Each site is built as an independent extension.* <br>Currently supports Gmail. [BGA Assistant](https://github.com/AnotherSava/bga-assistant) (for [Board Game Arena](https://boardgamearena.com)) is a separate project for now, pending integration into this monorepo.

<!-- [Install from Chrome Web Store](https://chromewebstore.google.com/detail/gmail-assistant/TODO) -->

## [Gmail](pages/gmail)

A side panel extension for Gmail that provides quick label-based filtering and navigation. Browse your labels in a multi-column layout, narrow by location and time scope, and jump to filtered views with one click. Dynamic label filtering (only shows labels that appear on matching messages) is powered by a progressive background cache.

![Gmail Assistant](screenshots/main.png)

## Usage

1. Navigate to [Gmail](https://mail.google.com) in a tab
2. Click the Gmail Assistant icon in the toolbar to open the side panel
3. Filter your Gmail view:
   - **Labels** — click to filter, click again to deselect
   - **Location** — narrow to Inbox, Sent, or All Mail
   - **Scope from** — limit results to a time range
4. Click the "?" icon in the side panel for a built-in help page

**Requires:** Google account authorization (Gmail read-only access via OAuth2).
