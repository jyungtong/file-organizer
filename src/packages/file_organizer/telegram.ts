import type {
  InlineKeyboardMarkup,
  TelegramFile,
  TelegramMessage,
} from './types';

const BASE_URL = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ─── Core API call ────────────────────────────────────────────────────────────

async function call<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram API ${method} failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as {
    ok: boolean;
    result: T;
    description?: string;
  };
  if (!json.ok) {
    throw new Error(`Telegram API ${method} error: ${json.description}`);
  }

  return json.result;
}

// ─── Messaging ────────────────────────────────────────────────────────────────

export async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<TelegramMessage> {
  return call<TelegramMessage>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  await call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await call('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

// ─── Files ────────────────────────────────────────────────────────────────────

interface TelegramFilePath {
  file_id: string;
  file_path: string;
}

/** Resolve a file_id to a download URL */
export async function getFileDownloadUrl(fileId: string): Promise<string> {
  const file = await call<TelegramFilePath>('getFile', { file_id: fileId });
  return `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}

/** Download a file from Telegram and return it as a Buffer */
export async function downloadFile(
  fileId: string,
): Promise<{ buffer: Buffer; fileName: string }> {
  const file = await call<TelegramFilePath & TelegramFile>('getFile', {
    file_id: fileId,
  });
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Extract filename from the path (e.g. "documents/file_42.pdf" → "file_42.pdf")
  const pathParts = file.file_path.split('/');
  const fileName = pathParts[pathParts.length - 1] ?? fileId;

  return { buffer, fileName };
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

export async function setWebhook(url: string): Promise<void> {
  await call('setWebhook', {
    url,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log(`Webhook set to: ${url}`);
}

export async function deleteWebhook(): Promise<void> {
  await call('deleteWebhook', {});
}

// ─── Inline keyboard helpers ──────────────────────────────────────────────────

export function confirmationKeyboard(fileId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, organize it', callback_data: `confirm:${fileId}` },
        { text: '✏️ Edit path', callback_data: `edit:${fileId}` },
      ],
      [{ text: '❌ Cancel', callback_data: `cancel:${fileId}` }],
    ],
  };
}
