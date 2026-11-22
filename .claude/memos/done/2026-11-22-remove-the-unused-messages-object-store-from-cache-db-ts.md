---
created: 2026-11-20 01:34:33
---

# Remove the unused messages object store from cache-db.ts

packages/site-gmail/src/cache-db.ts still creates a "messages" IndexedDB object store, and putMessages writes to it, but putMessages has no callers anywhere (found 2026-11-20 by the docs-relevance pass of a wrap-up review). Co-label counts come from label-index intersection in the meta store, so nothing reads per-message records. Next step: confirm with a grep that nothing reads or writes the store, delete putMessages and the store creation, bump the DB version with an upgrade that drops the store, and run npm test.
