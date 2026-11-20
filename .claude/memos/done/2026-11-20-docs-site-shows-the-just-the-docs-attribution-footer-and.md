---
created: 2026-09-08 04:01
---

# Docs site shows the just-the-docs attribution footer and builds from an unpinned theme

Docs site still shows the just-the-docs attribution footer (This site uses Just the Docs, a documentation theme for Jekyll) and builds from an unpinned remote_theme. Two fixes in docs/: pin the theme in _config.yml as remote_theme: just-the-docs/just-the-docs@<current release, v0.12.0 as of 2026-09-08, re-resolve when doing it>, and add _includes/nav_footer_custom.html containing an HTML comment. That include must be NON-EMPTY (the theme ships a 0-byte copy and falls through to the attribution whenever the include renders empty) and must contain no Liquid delimiters, not even inside the comment, because the include is parsed as Liquid before HTML and an unclosed if fails the Pages build. Leave footer_custom.html alone: it is an unrelated site.footer_content hook and shadowing it suppresses nothing. Verify on the published page rather than the source, since an unpinned theme is served from whatever Pages last cached: curl -sL <site-url> | grep -c "documentation theme for Jekyll" should be 0. Detail in the github-pages skill, section Auditing a site that already exists. Found 2026-09-08 auditing six local docs sites.
