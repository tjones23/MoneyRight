/** "Safari on iOS", "Chrome on Windows" — a browser named the way people would. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Mac OS X/.test(userAgent)
      ? "Mac"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  return os ? `${browser} on ${os}` : browser;
}
