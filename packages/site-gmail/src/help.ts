import { ICON_ZOOM_OUT, ICON_ZOOM_IN, ICON_EYE, ICON_PANEL, ICON_PANEL_1 } from "@core/icons.js";

export function renderHelp(): string {
  return `
<div class="help">
  <div class="help-hero">
    <div class="help-hero-title">Another Gmail Assistant</div>
    <div class="help-hero-sub">A Chrome extension for <a href="https://mail.google.com" target="_blank">Gmail</a>, part of <a href="https://anothersava.github.io/chrome-assistant/" target="_blank">Another Chrome Assistant</a> project</div>
  </div>

  <p>A side panel assistant for Gmail that provides quick label-based filtering and navigation. Browse your labels, narrow by location and time scope, and jump to filtered views with one click.</p>

  <div class="help-section" style="background:#2a2418;border:1px solid #5a4a1f;border-radius:4px;padding:10px">
    <div style="color:#ffd27a"><b>Private beta.</b> Gmail sign-in is gated to allowlisted test users while the app is unverified by Google. If sign-in fails with an "access blocked" error, email <a href="mailto:oleg.savelev@gmail.com" style="color:#ffd27a">oleg.savelev@gmail.com</a> or open a <a href="https://github.com/AnotherSava/chrome-assistant/issues" target="_blank" style="color:#ffd27a">GitHub issue</a> to be added.</div>
  </div>

  <div class="help-section">
    <div class="help-section-title">How to use</div>
    <ol class="help-steps">
      <li>Open <a href="https://mail.google.com" target="_blank">Gmail</a> in a tab.</li>
      <li>Click the extension icon to open the side panel.</li>
      <li>Filter your Gmail view:
        <ul class="help-sublist">
          <li><b>Labels</b> \u2014 click to filter, click again to deselect</li>
          <li><b>Location</b> \u2014 narrow to Inbox, Sent, or All Mail</li>
          <li><b>Scope from</b> \u2014 limit results to a time range</li>
        </ul>
      </li>
    </ol>
  </div>

  <div class="help-section">
    <div class="help-section-title">Tabs</div>
    <div class="help-sections-grid">
      <div class="help-grid-item"><span class="help-grid-label">Search</span><span> Browse Gmail labels in a multi-column layout. Click a label to search the Gmail page. Combine with Location and Scope dropdowns for precise searching. Labels are dynamically filtered to show only those that appear on matching messages — a background cache builds progressively so subsequent searching is instant.</span></div>
      <div class="help-grid-item"><span class="help-grid-label">Summary</span><span> Email summary view (coming soon).</span></div>
    </div>
  </div>

  <div class="help-section">
    <div class="help-section-title">Top bar</div>
    <div class="help-sections-grid">
      <div class="help-grid-item"><span class="help-grid-label"><span class="help-btn">${ICON_ZOOM_OUT}</span> <span class="help-btn">${ICON_ZOOM_IN}</span></span><span> Zoom out / in (also <b>Ctrl</b>+<b>\u2212</b> / <b>Ctrl</b>+<b>=</b>)<br>Zoom level is saved independently</span></div>
      <div class="help-grid-item"><span class="help-grid-label"><span class="help-btn">${ICON_EYE}</span></span><span> Display settings (label column count)</span></div>
      <div class="help-grid-item"><span class="help-grid-label"><span class="help-btn">${ICON_PANEL}</span><span style="color:#888;margin:0 1px">/</span><span class="help-btn">${ICON_PANEL_1}</span></span><span> Auto-hide side panel: never / when leaving Gmail</span></div>
      <div class="help-grid-item"><span class="help-grid-label"><span class="help-btn help-btn-text">?</span></span><span> This help page</span></div>
    </div>
  </div>

  <div class="help-section">
    <div class="help-section-title">Keyboard shortcut</div>
    <p style="color:#ccc;margin:0">Set a keyboard shortcut to toggle the side panel via the auto-hide dropdown or <a href="#" class="help-shortcuts-link">Chrome's extension shortcuts page</a>.</p>
  </div>
</div>`;
}
