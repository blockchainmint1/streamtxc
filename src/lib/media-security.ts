/** User files may be viewed, never executed with the application's authority. */
export function mediaResponseHeaders(contentType: string | null): Headers {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const safe = /^(video|audio)\/[a-z0-9.+-]+$/.test(type) ||
    ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/svg+xml", "image/x-icon", "text/vtt", "application/json", "application/vnd.apple.mpegurl", "application/x-mpegurl"].includes(type);
  const headers = new Headers({
    "content-type": safe ? type : "application/octet-stream",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  });
  if (!safe) headers.set("content-disposition", "attachment");
  return headers;
}