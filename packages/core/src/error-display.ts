import { escapeHtml } from "./icons.js";

export interface ErrorHint {
  text: string;
  linkText?: string;
  linkUrl?: string;
}

export function buildErrorHtml(errorText: string, hint: ErrorHint | null | undefined): string {
  let html = `<div class="status error">${escapeHtml(errorText)}`;
  if (hint) {
    html += `<span class="hint">${escapeHtml(hint.text)}`;
    if (hint.linkUrl && hint.linkText) {
      html += ` <a href="${escapeHtml(hint.linkUrl)}" target="_blank" rel="noopener">${escapeHtml(hint.linkText)}</a>`;
    }
    html += `</span>`;
  }
  html += `</div>`;
  return html;
}
