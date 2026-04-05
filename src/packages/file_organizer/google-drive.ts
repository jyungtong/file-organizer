import { google } from 'googleapis';
import type { DriveUploadResult } from './types';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// ─── OAuth client factory ─────────────────────────────────────────────────────

export function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/** Generate a Google OAuth consent URL for the user to authorize */
export function getAuthUrl(): string {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

/** Exchange an authorization code for tokens */
export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
}> {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token returned. Ensure prompt=consent was set.',
    );
  }

  return {
    accessToken: tokens.access_token ?? '',
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date ?? Date.now() + 3600 * 1000,
  };
}

// ─── Drive client factory ─────────────────────────────────────────────────────

function createDriveClient(
  accessToken: string,
  refreshToken: string,
  expiryDate: number,
) {
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
  });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ─── Folder management ────────────────────────────────────────────────────────

/**
 * Resolve or create a nested folder path in Google Drive.
 * e.g. "Work/Invoices/2026" → creates folders recursively, returns the leaf folder ID.
 */
async function resolveOrCreateFolder(
  drive: ReturnType<typeof google.drive>,
  folderPath: string,
  rootFolderId = 'root',
): Promise<string> {
  const parts = folderPath.split('/').filter(Boolean);
  let parentId = rootFolderId;

  for (const part of parts) {
    // Search for existing folder with this name under the current parent
    const res = await drive.files.list({
      q: `name='${part.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    const existing = res.data.files?.[0];
    if (existing?.id) {
      parentId = existing.id;
    } else {
      // Create the folder
      const created = await drive.files.create({
        requestBody: {
          name: part,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        },
        fields: 'id',
      });

      if (!created.data.id) {
        throw new Error(`Failed to create folder: ${part}`);
      }

      parentId = created.data.id;
    }
  }

  return parentId;
}

// ─── File upload ──────────────────────────────────────────────────────────────

/**
 * Upload a file buffer to Google Drive at the given folder path.
 * Creates intermediate folders as needed.
 */
export async function uploadFile(params: {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  folderPath: string;
}): Promise<DriveUploadResult> {
  const {
    accessToken,
    refreshToken,
    expiryDate,
    buffer,
    fileName,
    mimeType,
    folderPath,
  } = params;
  const drive = createDriveClient(accessToken, refreshToken, expiryDate);

  // Resolve or create the folder hierarchy
  const folderId = await resolveOrCreateFolder(drive, folderPath);

  // Upload the file into that folder
  const { Readable } = await import('node:stream');
  const stream = Readable.from(buffer);

  const uploaded = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: 'id, name, webViewLink',
  });

  if (!uploaded.data.id || !uploaded.data.webViewLink) {
    throw new Error(
      'Upload succeeded but missing file ID or web link in response',
    );
  }

  return {
    fileId: uploaded.data.id,
    fileName: uploaded.data.name ?? fileName,
    webViewLink: uploaded.data.webViewLink,
    folderPath,
  };
}
