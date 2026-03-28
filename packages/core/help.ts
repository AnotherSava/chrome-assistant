import { ICON_ZOOM_OUT, ICON_ZOOM_IN, ICON_PANEL, ICON_PANEL_1 } from "./icons.js";

export function renderHelp(): string {
  return `
<div class="help">
  <div class="help-hero">
    <div class="help-hero-title">Gmail Assistant</div>
    <div class="help-hero-sub">A Chrome extension for <a href="https://mail.google.com" target="_blank">Gmail</a>, part of <a href="https://github.com/AnotherSava/chrome-assistant" target="_blank">Another Chrome Assistant</a> project</div>
  </div>

  <p>A side panel assistant that helps you work with Gmail more efficiently.</p>

  <div class="help-section">
    <div class="help-section-title">How to use</div>
    <ol class="help-steps">
      <li>Open <a href="https://mail.google.com" target="_blank">Gmail</a> in a tab.</li>
      <li>Click the extension icon in the toolbar to open the side panel.</li>
      <li>The side panel updates automatically as you navigate Gmail.</li>
    </ol>
  </div>

  <div class="help-section">
    <div class="help-section-title">Top bar</div>
    <div class="help-sections-grid">
      <div class="help-grid-item"><span class="help-grid-label"><span class="help-btn">${ICON_ZOOM_OUT}</span> <span class="help-btn">${ICON_ZOOM_IN}</span></span><span> Zoom out / in (also <b>Ctrl</b>+<b>\u2212</b> / <b>Ctrl</b>+<b>=</b>)<br>Zoom level is saved independently</span></div>
      <div class="help-grid-item"><span class="help-grid-label"><span class="help-btn">${ICON_PANEL}</span><span style="color:#888;margin:0 1px">/</span><span class="help-btn">${ICON_PANEL_1}</span></span><span> Auto-hide side panel: never / when leaving Gmail</span></div>
      <div class="help-grid-item"><span class="help-grid-label"><span class="help-btn help-btn-text">?</span></span><span> This help page</span></div>
    </div>
  </div>
</div>`;
}
