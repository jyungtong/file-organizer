// ─── Telegram ────────────────────────────────────────────────────────────────

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramDocument extends TelegramFile {
  file_name: string;
  mime_type: string;
}

export interface TelegramAudio extends TelegramFile {
  duration: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramVideo extends TelegramFile {
  duration: number;
  width: number;
  height: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramPhotoSize extends TelegramFile {
  width: number;
  height: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  document?: TelegramDocument;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  photo?: TelegramPhotoSize[];
  caption?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

// ─── Application ─────────────────────────────────────────────────────────────

/** A user-defined organization rule stored in DynamoDB */
export interface UserRule {
  userId: number;
  ruleId: string;
  description: string; // raw text the user typed
  pattern: string; // glob/keyword pattern to match filename
  mimePrefix?: string; // e.g. "application/pdf"
  targetPath: string; // e.g. "Work/Invoices"
  createdAt: string; // ISO 8601
}

/** A pending confirmation waiting for the user to confirm/edit/cancel */
export interface PendingConfirmation {
  userId: number;
  fileId: string;
  fileName: string;
  mimeType: string;
  suggestedPath: string;
  ruleMatched?: string; // ruleId if a rule matched
}

/** State stored in DynamoDB per user */
export type UserStateType =
  | { type: 'idle' }
  | { type: 'awaiting_confirmation'; confirmation: PendingConfirmation }
  | { type: 'awaiting_path_edit'; confirmation: PendingConfirmation }
  | { type: 'awaiting_rule_text' }
  | { type: 'awaiting_oauth' };

/** DynamoDB item shapes */
export interface DynamoUserState {
  pk: string; // USER#<userId>
  sk: string; // STATE
  state: UserStateType;
  ttl?: number;
}

export interface DynamoUserRule {
  pk: string; // USER#<userId>
  sk: string; // RULE#<ruleId>
  rule: UserRule;
}

export interface DynamoOAuthToken {
  pk: string; // USER#<userId>
  sk: string; // OAUTH
  refreshToken: string;
  accessToken: string;
  expiryDate: number;
}

/** Result of uploading a file to Google Drive */
export interface DriveUploadResult {
  fileId: string;
  fileName: string;
  webViewLink: string;
  folderPath: string;
}

/** Claude's categorization response */
export interface CategorizationResult {
  suggestedPath: string; // e.g. "Work/Invoices/2026"
  reasoning: string;
  confidence: 'high' | 'medium' | 'low';
}
