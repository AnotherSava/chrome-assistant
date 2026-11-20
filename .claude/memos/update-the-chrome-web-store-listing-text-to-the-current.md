---
created: 2026-11-20 01:34:33
---

# Update the Chrome Web Store listing text to the current feature set and OAuth scope

The published Web Store listing for Another Assistant for Gmail still carries text from before the Summary tab: it advertises a Location (Inbox / Sent / All Mail) filter that no longer exists, the old scope list (1w / 2w / 1mo / 3mo / 6mo / 1y / 2y / 5y / any; the code's SCOPE_OPTIONS in packages/site-gmail/src/search-tab.ts is any/1w/2w/1m/2m/6m/1y/3y/5y), and read-only claims (gmail.readonly, never calls messages.get, never reads bodies) while the manifest requests gmail.modify and the Summary tab reads Deals bodies and archives/trashes via batchModify. The gitignored local draft docs/draft/cws-listing.md was corrected on 2026-11-20 during a wrap-up review; the live listing was not. Next step: copy the corrected draft's description and permission justifications into the Web Store dashboard and submit for review, and check the OAuth consent screen's scope justification says gmail.modify. The docs-site privacy policy (pages/gmail/privacy) was already corrected and is what the listing links.
