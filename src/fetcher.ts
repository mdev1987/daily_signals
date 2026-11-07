import { BASE_URL, TOR_ENABLED } from "./config";
import { TorClient } from "tor-js";

const REQUEST_TIMEOUT = 15_000;

const HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 SignalReceiver/1.0",
  "Cache-Control": "no-cache",
};

const torClient = TOR_ENABLED ? new TorClient({}) : null;

/**
 * Fetches the signals page for a given timestamp.
 *
 * @param time - The timestamp parameter for the API request.
 * @returns HTML content of the signals page.
 * @throws Error when the request fails or returns a non-OK status.
 */
export async function fetchSignalsPage(time: number): Promise<string> {
  const url = `${BASE_URL}?time=${time}`;

  const request = {
    headers: HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  };

  const response = torClient
    ? await torClient.fetch(url, request)
    : await fetch(url, request);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — ${url}`);
  }

  return response.text();
}
