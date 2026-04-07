# Chrome Assistant

A family of Chrome extensions sharing a common side panel framework. Each site is built as an independent extension. Currently supports Gmail.

## Gmail Assistant

A side panel extension for Gmail that provides quick label-based filtering and navigation.

**Features:**
- Browse all your Gmail labels in a multi-column layout
- Click a label to filter the Gmail page by that label
- Include sub-labels: selecting a parent label shows messages from all its children too (configurable)
- System labels (Inbox, Sent, Starred, Important) shown alongside user labels
- Filter by time scope
- Dynamic label filtering — only shows labels that appear on matching messages, powered by a progressive message metadata cache
- Auto-hide side panel when leaving Gmail
- Zoom controls with per-context persistence
- Configurable keyboard shortcut to toggle the side panel

**Requires:** Google account authorization (Gmail read-only access via OAuth2).

## Development

```bash
npm install
npm run dev        # watch mode (Gmail)
npm run build      # production build (Gmail)
npm run test       # run tests
npm run lint       # type check
npm run package    # build + create Chrome Web Store ZIP
```

### Per-site builds

```bash
npm run build:gmail   # build Gmail extension
npm run dev:gmail     # watch mode for Gmail
```

## Installation

Load as an unpacked extension in Chrome:

1. `npm run build`
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select `packages/site-gmail/`
