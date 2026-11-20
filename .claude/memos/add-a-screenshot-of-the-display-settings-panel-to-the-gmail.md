---
created: 2026-11-20 01:39:56
---

# Add a screenshot of the display settings panel to the Gmail docs page

docs/pages/gmail/index.md tells the reader to change toggles in display settings (the eye button) in two sections, Include sub-labels and the system-labels feature bullet, without showing the panel. A wrap-up on 2026-11-20 tried to capture it through the claude-in-chrome tools and could not: they refuse chrome-extension:// pages, and the side panel only renders properly inside Chrome with a signed-in Gmail session. Next step: open the side panel on Gmail, click the eye button, capture the panel with Win+Shift+S (lands in ~/CropStage), then frame it with ~/.claude/skills/screenshot/scripts/hairline.py --require keeping the unframed copy at docs/screenshots/raw/<name>, add an entry to docs/screenshots/screenshots.json (policy confirm), and embed it in the Include sub-labels section.
