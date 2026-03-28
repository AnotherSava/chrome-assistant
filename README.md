# Chrome Assistant

A family of Chrome extensions sharing a common side panel framework. Each site is built as an independent extension. Currently supports Gmail.

## Development

```bash
npm install
npm run dev       # watch mode
npm run build     # production build
npm run test      # run tests
npm run lint      # type check
```

## Installation

Load as an unpacked extension in Chrome:

1. `npm run build`
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select `packages/site-gmail/`
