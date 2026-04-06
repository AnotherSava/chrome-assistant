export type PinMode = "pinned" | "autohide-site";

export interface GmailLabel { id: string; name: string; type: string }

export interface MessageMeta { id: string; labelIds: string[]; internalDate: number }

/** IndexedDB cache record */
export interface CacheMessage { id: string; internalDate: number | null; labelIds: string[]; status?: "pending" | "fetched" | "inaccessible" }
