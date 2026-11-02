import { Bot, GrammyError, HttpError } from "grammy";
import { convert } from "telegram-markdown-v2";
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_ENABLED,
  TELEGRAM_NOTIFY_STARTUP,
} from "./config";
import type { SignalChange } from "./database";
import type { SignalType } from "./parser";

const MAX_MESSAGE_CHARS = 3_900;
const MAX_SEND_ATTEMPTS = 3;

const bot =
  TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN
    ? new Bot(TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 15 } })
    : null;

const SIGNAL_META: Record<SignalType, { icon: string; label: string }> = {
  STRONG_BUY: { icon: "🚀", label: "Strong Buy" },
  BUY: { icon: "🟢", label: "Buy" },
  NEUTRAL: { icon: "⚪", label: "Neutral" },
  SELL: { icon: "🔴", label: "Sell" },
  STRONG_SELL: { icon: "🛑", label: "Strong Sell" },
};

/** Split escaped text into sendable chunks. Exported for unit tests. */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_CHARS) return [text];

  const chunks: string[] = [];
  let current = "";

  const pushLine = (line: string): void => {
    // A single line longer than the limit must be hard-sliced, otherwise one
    // chunk would exceed Telegram's 4096-char limit and the send would fail.
    let rest = line;

    while (rest.length > MAX_MESSAGE_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      let cut = MAX_MESSAGE_CHARS;

      // Never split a MarkdownV2 escape sequence: a chunk ending in a lone
      // backslash would unescape the next chunk's first character and fail
      // the whole send with a parse error.
      const trailing = rest.slice(0, cut).match(/\\+$/)?.[0].length ?? 0;

      if (trailing % 2 === 1) cut -= 1;

      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }

    const candidate = current ? `${current}\n${rest}` : rest;

    if (candidate.length > MAX_MESSAGE_CHARS && current) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  };

  for (const line of text.split("\n")) {
    pushLine(line);
  }

  if (current) chunks.push(current);

  return chunks;
}

function retryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof GrammyError) {
    const retryAfter = error.parameters.retry_after;

    if (typeof retryAfter === "number" && retryAfter > 0) {
      return Math.min(retryAfter * 1_000, 30_000);
    }
  }

  return Math.min(1_500 * (attempt + 1), 10_000);
}

async function sendChunk(chunk: string): Promise<void> {
  if (!bot || !TELEGRAM_CHAT_ID) return;

  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    try {
      await bot.api.sendMessage(TELEGRAM_CHAT_ID, chunk, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });

      return;
    } catch (error) {
      const canRetry =
        error instanceof GrammyError || error instanceof HttpError;

      if (!canRetry || attempt === MAX_SEND_ATTEMPTS - 1) {
        throw error;
      }

      await Bun.sleep(retryDelayMs(error, attempt));
    }
  }
}

/**
 * Sends a Markdown message to the configured Telegram chat. The Markdown is
 * converted to Telegram MarkdownV2 by `telegram-markdown-v2`; failures are
 * logged and never thrown so notification problems cannot stop the receiver.
 */
export async function telegram(markdown: string): Promise<boolean> {
  if (!bot || !TELEGRAM_CHAT_ID) return false;

  const formatted = convert(markdown, "escape");

  try {
    for (const chunk of splitMessage(formatted)) {
      await sendChunk(chunk);
    }

    return true;
  } catch (error) {
    console.error(
      `[TELEGRAM] Send failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return false;
  }
}

export async function testTelegram(): Promise<string | null> {
  if (!bot) return null;

  const me = await bot.api.getMe();

  return me.username ? `@${me.username}` : me.first_name;
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function formatSignalRow(change: SignalChange): string {
  const current = SIGNAL_META[change.currentSignal];
  const title = `**${current.icon} ${change.symbol}**`;

  if (!change.previousSignal) {
    return `${title} · 🆕 new\n\`${current.label.toUpperCase()}\``;
  }

  const previous = SIGNAL_META[change.previousSignal];

  return (
    `${title}\n` +
    `\`${previous.label.toUpperCase()}\` ➜ \`${current.label.toUpperCase()}\``
  );
}

export function formatSignalChanges(
  timeframe: string,
  changes: SignalChange[],
): string {
  const detectedAt = new Date();
  const rows = changes.map(formatSignalRow).join("\n\n");

  return (
    `# 📡 Daily Signals Update\n\n` +
    `**Timeframe** · \`${timeframe}\`\n` +
    `**Detected** · \`${formatTimestamp(detectedAt)} UTC\`\n` +
    `**Changes** · \`${changes.length}\`\n\n` +
    `────────────\n\n` +
    `${rows}\n\n` +
    `────────────\n` +
    `_Automated by Daily Signals_`
  );
}

/**
 * Groups changes by timeframe and sends one compact message per timeframe.
 * This keeps each message readable and avoids mixing unrelated timeframes.
 */
export async function notifySignalChanges(
  changes: SignalChange[],
): Promise<boolean> {
  if (changes.length === 0 || !bot) return false;

  const groups = new Map<string, SignalChange[]>();

  for (const change of changes) {
    const group = groups.get(change.timeframe) ?? [];

    group.push(change);
    groups.set(change.timeframe, group);
  }

  let sent = false;

  for (const [timeframe, group] of groups) {
    const success = await telegram(formatSignalChanges(timeframe, group));

    sent = success || sent;
  }

  return sent;
}

export interface StartupNotification {
  signalPollSeconds: number;
  pricePollSeconds: number;
  timeframes: number;
  databasePath: string;
}

export function formatStartup(info: StartupNotification): string {
  return (
    `# 🚀 Daily Signals Receiver Online\n\n` +
    `🕒 **Started** · \`${formatTimestamp(new Date())} UTC\`\n` +
    `📡 **Signal poll** · \`every ${info.signalPollSeconds}s\`\n` +
    `⏱️ **Timeframes** · \`${info.timeframes}\`\n` +
    `💹 **Price poll** · \`every ${info.pricePollSeconds}s\`\n` +
    `🗄️ **Storage** · \`${info.databasePath}\`\n\n` +
    `_Listening for signal changes._`
  );
}

export async function notifyStartup(
  info: StartupNotification,
): Promise<boolean> {
  if (!TELEGRAM_NOTIFY_STARTUP) return false;

  return telegram(formatStartup(info));
}
