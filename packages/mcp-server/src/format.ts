/** Format a timestamp as a human-readable "X ago" string. */
export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Truncate a commit SHA to 8 chars. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** SymbolRole bitmask to readable label. */
export function roleLabel(role: number): string {
  if (role & 1) return "DEFINITION";
  if (role & 4) return "WRITE";
  if (role & 8) return "READ";
  if (role & 2) return "IMPORT";
  return `role=${role}`;
}
