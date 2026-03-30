/**
 * Convert a local file path to a stream:// URL for video playback.
 * Uses our custom Tauri protocol handler that serves local files.
 */
export function videoUrl(filePath: string): string {
  const encoded = encodeURIComponent(filePath);
  return `stream://localhost/${encoded}`;
}
