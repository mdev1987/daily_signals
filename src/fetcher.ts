import { BASE_URL } from "./config";

/**
 * Fetches the signals page for a given timestamp
 * @param time - The timestamp parameter for the API request
 * @returns A promise that resolves to the HTML content of the signals page
 */
export async function fetchSignalsPage(time: number): Promise<string> {
  const url = `${BASE_URL}?time=${time}`;

  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 SignalReceiver/1.0",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — ${url}`);
  }

  return response.text();
}
