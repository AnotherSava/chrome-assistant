export type PinMode = "pinned" | "autohide-site";

export interface GmailLabel { id: string; name: string; type: string }

/** IndexedDB cache record */
export interface CacheMessage { id: string; labelIds: string[] }
