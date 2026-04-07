import type { APIGatewayProxyResultV2, Handler } from 'aws-lambda';
import { extractText } from 'unpdf';
import { categorizeFile, parseRuleFromText, resolveRuleTokens } from './claude';
import { exchangeCodeForTokens, getAuthUrl, uploadFile } from './google-drive';
import {
  addRule,
  clearUserState,
  deleteRule,
  getOAuthToken,
  getRules,
  getUserState,
  matchRule,
  saveOAuthToken,
  setUserState,
} from './rules';
import {
  answerCallbackQuery,
  confirmationKeyboard,
  downloadFile,
  editMessageText,
  sendMessage,
} from './telegram';
import type {
  PendingConfirmation,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from './types';

// ─── Lambda entry point ───────────────────────────────────────────────────────

export const handler: Handler<
  { body: string | null },
  APIGatewayProxyResultV2
> = async (event) => {
  // Handle Google OAuth redirect (GET /?code=...)
  // The Function URL will receive this when the user completes OAuth
  if ('queryStringParameters' in event) {
    const qs = (event as { queryStringParameters?: Record<string, string> })
      .queryStringParameters;
    if (qs?.code && qs?.state) {
      return handleOAuthRedirect(qs.code, qs.state);
    }
  }

  // Handle Telegram webhook (POST with JSON body)
  const body = event.body;
  if (!body) return ok();

  let update: TelegramUpdate;
  try {
    update = JSON.parse(body) as TelegramUpdate;
  } catch {
    console.error('Failed to parse Telegram update body');
    return ok();
  }

  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error('Error handling update:', err);
    // Always return 200 to Telegram so it doesn't retry
  }

  return ok();
};

// ─── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!userId) return;

  const text = msg.text?.trim();
  const state = await getUserState(userId);

  // ── Commands ──────────────────────────────────────────────────────────────

  if (text?.startsWith('/start')) {
    await handleStart(chatId, userId);
    return;
  }

  if (text?.startsWith('/rules')) {
    await handleListRules(chatId, userId);
    return;
  }

  if (text?.startsWith('/delrule')) {
    const ruleId = text.split(' ')[1]?.trim();
    await handleDeleteRule(chatId, userId, ruleId);
    return;
  }

  if (text?.startsWith('/addrule')) {
    await sendMessage(
      chatId,
      'Describe your rule in plain text.\n\nExample: _"always put PDFs with invoice in the name under Work/Invoices"_',
    );
    await setUserState(userId, { type: 'awaiting_rule_text' });
    return;
  }

  // ── State-based responses ─────────────────────────────────────────────────

  if (state.type === 'awaiting_path_edit' && text) {
    await handlePathEdit(chatId, userId, text, state.confirmation);
    return;
  }

  if (state.type === 'awaiting_rule_text' && text) {
    await handleNewRule(chatId, userId, text);
    return;
  }

  if (state.type === 'awaiting_oauth' && text) {
    // User may paste the OAuth redirect URL directly
    await sendMessage(
      chatId,
      'Please click the authorization link I sent you earlier to connect Google Drive.',
    );
    return;
  }

  // ── File received ─────────────────────────────────────────────────────────

  const file =
    msg.document ??
    msg.audio ??
    msg.video ??
    (msg.photo ? msg.photo[msg.photo.length - 1] : undefined);

  if (file) {
    await handleFileReceived(chatId, userId, msg);
    return;
  }

  // ── Fallback ──────────────────────────────────────────────────────────────

  await sendMessage(
    chatId,
    'Send me a file to organize it, or use:\n/rules — view your rules\n/addrule — add a new rule\n/start — connect Google Drive',
  );
}

// ─── /start — OAuth flow ──────────────────────────────────────────────────────

async function handleStart(chatId: number, userId: number): Promise<void> {
  const existing = await getOAuthToken(userId);
  if (existing) {
    await sendMessage(
      chatId,
      "Google Drive is already connected! Send me any file and I'll organize it for you.\n\nCommands:\n/rules — view your rules\n/addrule — add a rule\n/delrule <id> — remove a rule",
    );
    return;
  }

  const authUrl = getAuthUrl();
  // Encode userId in state param so we can save tokens to the right user on redirect
  const urlWithState = `${authUrl}&state=${userId}`;

  await sendMessage(
    chatId,
    `Welcome! To get started, connect your Google Drive:\n\n[Authorize Google Drive](${urlWithState})\n\nAfter authorizing, come back and send me a file!`,
  );
  await setUserState(userId, { type: 'awaiting_oauth' });
}

// ─── Google OAuth redirect ────────────────────────────────────────────────────

async function handleOAuthRedirect(
  code: string,
  state: string,
): Promise<APIGatewayProxyResultV2> {
  const userId = Number.parseInt(state, 10);
  if (Number.isNaN(userId)) {
    return { statusCode: 400, body: 'Invalid state parameter' };
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveOAuthToken(userId, tokens);
    await clearUserState(userId);
    await sendMessage(
      userId,
      'Google Drive connected! Send me a file to organize it.',
    );
  } catch (err) {
    console.error('OAuth exchange failed:', err);
    await sendMessage(userId, 'Authorization failed. Please try /start again.');
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><body><h2>Authorization successful! You can close this tab and return to Telegram.</h2></body></html>',
  };
}

// ─── File received ────────────────────────────────────────────────────────────

async function handleFileReceived(
  chatId: number,
  userId: number,
  msg: TelegramMessage,
): Promise<void> {
  // Check Google Drive is connected
  const oauthToken = await getOAuthToken(userId);
  if (!oauthToken) {
    await sendMessage(
      chatId,
      'Please connect your Google Drive first with /start',
    );
    return;
  }

  // Extract file metadata
  const doc = msg.document;
  const audio = msg.audio;
  const video = msg.video;
  const photo = msg.photo?.[msg.photo.length - 1];

  let fileId: string;
  let fileName: string;
  let mimeType: string;

  if (doc) {
    fileId = doc.file_id;
    fileName = doc.file_name;
    mimeType = doc.mime_type;
  } else if (audio) {
    fileId = audio.file_id;
    fileName = audio.file_name ?? `audio_${audio.file_id}.ogg`;
    mimeType = audio.mime_type ?? 'audio/ogg';
  } else if (video) {
    fileId = video.file_id;
    fileName = video.file_name ?? `video_${video.file_id}.mp4`;
    mimeType = video.mime_type ?? 'video/mp4';
  } else if (photo) {
    fileId = photo.file_id;
    fileName = `photo_${photo.file_id}.jpg`;
    mimeType = 'image/jpeg';
  } else {
    return;
  }

  // Check if a rule auto-matches
  const rules = await getRules(userId);
  const matchedRule = matchRule(rules, fileName, mimeType);

  if (matchedRule) {
    const hasTokens = /\{[^}]+\}/.test(matchedRule.targetPath);

    if (hasTokens) {
      // Dynamic path — extract document content so Claude can resolve tokens
      await sendMessage(chatId, '🔍 Analyzing file...');

      let contentOptions:
        | {
            imageBase64?: string;
            imageMimeType?: string;
            extractedText?: string;
          }
        | undefined;

      if (mimeType.startsWith('image/')) {
        try {
          const { buffer: imgBuffer } = await downloadFile(fileId);
          contentOptions = {
            imageBase64: imgBuffer.toString('base64'),
            imageMimeType: mimeType,
          };
        } catch (err) {
          console.warn('Failed to download image for token resolution:', err);
        }
      } else if (mimeType === 'application/pdf') {
        try {
          const { buffer: pdfBuffer } = await downloadFile(fileId);
          const { text } = await extractText(new Uint8Array(pdfBuffer), {
            mergePages: true,
          });
          const excerpt = text.slice(0, 2000).trim();
          if (excerpt) {
            contentOptions = { extractedText: excerpt };
          }
        } catch (err) {
          console.warn('Failed to extract PDF text for token resolution:', err);
        }
      }

      const resolvedPath = await resolveRuleTokens(
        matchedRule.targetPath,
        fileName,
        mimeType,
        contentOptions,
      );

      const confirmation: PendingConfirmation = {
        userId,
        fileId,
        fileName,
        mimeType,
        suggestedPath: resolvedPath,
      };

      await setUserState(userId, {
        type: 'awaiting_confirmation',
        confirmation,
      });
      await sendMessage(
        chatId,
        `Rule matched: _${matchedRule.description}_\n📁 Resolved path: \`${resolvedPath}\`\n\nOrganize *${fileName}* here?`,
        confirmationKeyboard(),
      );
      return;
    }

    // No tokens — skip confirmation, go straight to upload
    await sendMessage(
      chatId,
      `Rule matched: _${matchedRule.description}_\nUploading to \`${matchedRule.targetPath}\`...`,
    );
    await uploadAndConfirm(
      chatId,
      userId,
      fileId,
      fileName,
      mimeType,
      matchedRule.targetPath,
      oauthToken,
    );
    return;
  }

  // No rule — ask Claude, optionally with image vision or PDF text extraction
  await sendMessage(chatId, '🔍 Analyzing file...');

  let categorizationOptions:
    | { imageBase64?: string; imageMimeType?: string; extractedText?: string }
    | undefined;

  if (mimeType.startsWith('image/')) {
    // Download image bytes and encode as base64 for Claude vision
    try {
      const { buffer: imgBuffer } = await downloadFile(fileId);
      categorizationOptions = {
        imageBase64: imgBuffer.toString('base64'),
        imageMimeType: mimeType,
      };
    } catch (err) {
      console.warn(
        'Failed to download image for vision, falling back to metadata:',
        err,
      );
    }
  } else if (mimeType === 'application/pdf') {
    // Download PDF and extract text for Claude
    try {
      const { buffer: pdfBuffer } = await downloadFile(fileId);
      const { text } = await extractText(new Uint8Array(pdfBuffer), {
        mergePages: true,
      });
      const excerpt = text.slice(0, 2000).trim();
      if (excerpt) {
        categorizationOptions = { extractedText: excerpt };
      }
    } catch (err) {
      console.warn(
        'Failed to extract PDF text, falling back to metadata:',
        err,
      );
    }
  }

  const categorization = await categorizeFile(
    fileName,
    mimeType,
    rules,
    categorizationOptions,
  );

  const confirmation: PendingConfirmation = {
    userId,
    fileId,
    fileName,
    mimeType,
    suggestedPath: categorization.suggestedPath,
  };

  await setUserState(userId, { type: 'awaiting_confirmation', confirmation });

  const confidenceNote =
    categorization.confidence === 'low' ? ' _(low confidence)_' : '';
  await sendMessage(
    chatId,
    `📁 Suggested folder: \`${categorization.suggestedPath}\`${confidenceNote}\n_${categorization.reasoning}_\n\nOrganize *${fileName}* here?`,
    confirmationKeyboard(),
  );
}

// ─── Callback query handler ───────────────────────────────────────────────────

async function handleCallbackQuery(cq: TelegramCallbackQuery): Promise<void> {
  const userId = cq.from.id;
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (!chatId || !messageId) return;

  await answerCallbackQuery(cq.id);

  const action = (cq.data ?? '').trim();
  const state = await getUserState(userId);

  if (action === 'confirm' && state.type === 'awaiting_confirmation') {
    const { confirmation } = state;

    await editMessageText(
      chatId,
      messageId,
      `Uploading to \`${confirmation.suggestedPath}\`...`,
    );

    const oauthToken = await getOAuthToken(userId);
    if (!oauthToken) {
      await sendMessage(
        chatId,
        'Google Drive connection lost. Please /start again.',
      );
      await clearUserState(userId);
      return;
    }

    await clearUserState(userId);
    await uploadAndConfirm(
      chatId,
      userId,
      confirmation.fileId,
      confirmation.fileName,
      confirmation.mimeType,
      confirmation.suggestedPath,
      oauthToken,
      messageId,
    );
  } else if (action === 'edit' && state.type === 'awaiting_confirmation') {
    const { confirmation } = state;

    await setUserState(userId, { type: 'awaiting_path_edit', confirmation });
    await editMessageText(
      chatId,
      messageId,
      `Current path: \`${confirmation.suggestedPath}\`\n\nType the folder path you want (e.g. \`Work/Invoices/2026\`):`,
    );
  } else if (action === 'cancel') {
    await clearUserState(userId);
    await editMessageText(
      chatId,
      messageId,
      '❌ Cancelled. File not organized.',
    );
  }
}

// ─── Path edit ────────────────────────────────────────────────────────────────

async function handlePathEdit(
  chatId: number,
  userId: number,
  newPath: string,
  confirmation: PendingConfirmation,
): Promise<void> {
  const sanitized = newPath.replace(/^\/+|\/+$/g, '').trim();
  if (!sanitized) {
    await sendMessage(
      chatId,
      'Please enter a valid path like `Work/Invoices/2026`',
    );
    return;
  }

  const updated: PendingConfirmation = {
    ...confirmation,
    suggestedPath: sanitized,
  };
  await setUserState(userId, {
    type: 'awaiting_confirmation',
    confirmation: updated,
  });

  await sendMessage(
    chatId,
    `Updated path: \`${sanitized}\`\n\nOrganize *${confirmation.fileName}* here?`,
    confirmationKeyboard(),
  );
}

// ─── /rules ───────────────────────────────────────────────────────────────────

async function handleListRules(chatId: number, userId: number): Promise<void> {
  const rules = await getRules(userId);

  if (rules.length === 0) {
    await sendMessage(
      chatId,
      'You have no custom rules yet.\n\nUse /addrule to add one, e.g.:\n_"always put PDFs with invoice in the name under Work/Invoices"_',
    );
    return;
  }

  const list = rules
    .map(
      (r, i) =>
        `${i + 1}. \`${r.ruleId.slice(0, 8)}\` — ${r.description}\n   → \`${r.targetPath}\``,
    )
    .join('\n\n');

  await sendMessage(
    chatId,
    `Your rules:\n\n${list}\n\nUse /delrule <id> to remove a rule.`,
  );
}

// ─── /delrule ─────────────────────────────────────────────────────────────────

async function handleDeleteRule(
  chatId: number,
  userId: number,
  ruleId?: string,
): Promise<void> {
  if (!ruleId) {
    await sendMessage(
      chatId,
      'Usage: /delrule <rule-id>\n\nUse /rules to see your rule IDs.',
    );
    return;
  }

  // Find rule by prefix match (user only needs first 8 chars)
  const rules = await getRules(userId);
  const match = rules.find((r) => r.ruleId.startsWith(ruleId));

  if (!match) {
    await sendMessage(
      chatId,
      `Rule \`${ruleId}\` not found. Use /rules to see your rules.`,
    );
    return;
  }

  await deleteRule(userId, match.ruleId);
  await sendMessage(chatId, `Rule deleted: _${match.description}_`);
}

// ─── /addrule ─────────────────────────────────────────────────────────────────

async function handleNewRule(
  chatId: number,
  userId: number,
  text: string,
): Promise<void> {
  await sendMessage(chatId, '🔍 Parsing rule...');

  const parsed = await parseRuleFromText(text);
  if (!parsed) {
    await sendMessage(
      chatId,
      'Sorry, I couldn\'t understand that rule. Try something like:\n_"always put PDFs with invoice in the name under Work/Invoices"_',
    );
    await clearUserState(userId);
    return;
  }

  const rule = await addRule(userId, {
    description: text,
    pattern: parsed.pattern,
    mimePrefix: parsed.mimePrefix,
    targetPath: parsed.targetPath,
  });

  await clearUserState(userId);
  await sendMessage(
    chatId,
    `Rule saved!\n\nPattern: \`${rule.pattern}\`${rule.mimePrefix ? `\nMIME: \`${rule.mimePrefix}\`` : ''}\nFolder: \`${rule.targetPath}\`\n\nFiles matching this rule will be organized automatically.`,
  );
}

// ─── Upload helper ────────────────────────────────────────────────────────────

async function uploadAndConfirm(
  chatId: number,
  _userId: number,
  fileId: string,
  fileName: string,
  mimeType: string,
  folderPath: string,
  oauthToken: { accessToken: string; refreshToken: string; expiryDate: number },
  editMessageId?: number,
): Promise<void> {
  try {
    const { buffer } = await downloadFile(fileId);

    const result = await uploadFile({
      ...oauthToken,
      buffer,
      fileName,
      mimeType,
      folderPath,
    });

    const successMsg = `✅ *${result.fileName}* organized!\n\nFolder: \`${result.folderPath}\`\n[Open in Drive](${result.webViewLink})`;

    if (editMessageId) {
      await editMessageText(chatId, editMessageId, successMsg);
    } else {
      await sendMessage(chatId, successMsg);
    }
  } catch (err) {
    console.error('Upload failed:', err);
    const errMsg = `❌ Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
    if (editMessageId) {
      await editMessageText(chatId, editMessageId, errMsg);
    } else {
      await sendMessage(chatId, errMsg);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(): APIGatewayProxyResultV2 {
  return { statusCode: 200, body: 'OK' };
}
