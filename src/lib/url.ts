export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = "***";
    }
    if (url.password) {
      url.password = "***";
    }
    for (const key of url.searchParams.keys()) {
      url.searchParams.set(key, "***");
    }
    return url.toString();
  }
  catch {
    return value.replace(/([?&][^=&#]+)=([^&#]*)/g, "$1=***");
  }
}
