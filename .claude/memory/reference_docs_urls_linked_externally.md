---
name: reference-docs-urls-linked-externally
description: The Chrome Web Store listing links docs/pages/gmail/privacy and docs/pages/gmail by URL, so those docs pages must not move
metadata:
  type: reference
---

The Chrome Web Store listing for the Gmail extension (draft text in the gitignored `docs/draft/cws-listing.md`) links two docs-site pages by absolute URL: the privacy policy at `/chrome-assistant/pages/gmail/privacy` and the feature walkthrough at `/chrome-assistant/pages/gmail`. Google's OAuth consent screen review also reads the privacy URL.

**How to apply:** when restructuring the docs site, keep both files where they are (`docs/pages/gmail/privacy.md`, `docs/pages/gmail/index.md`) and change only their front matter. Sidebar placement comes from `parent:`, not from the folder, so a page can sit under a different parent without moving. The 2026-11-20 move to just-the-docs did exactly that, putting the Gmail data-flow and storage-layout pages under Development while leaving them in `docs/pages/gmail/`. Moving either linked page breaks the store listing until a new listing is submitted and reviewed. Related: [[project-published-gmail]].
