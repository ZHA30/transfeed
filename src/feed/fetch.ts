export async function fetchText(url: string, timeoutSeconds: number): Promise<{ body: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "feed/0.1 (+https://github.com/)",
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
    }
    return {
      body: await response.text(),
      finalUrl: response.url,
    };
  }
  finally {
    clearTimeout(timeout);
  }
}
