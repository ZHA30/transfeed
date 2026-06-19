const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

export async function fetchText(url: string, timeoutSeconds: number): Promise<{ body: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const requestUrl = new URL(url);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: requestUrl.origin,
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
