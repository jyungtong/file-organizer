import Anthropic from '@anthropic-ai/sdk';
import type {
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { CategorizationResult, UserRule } from './types';

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY ?? '',
  ...(process.env.CLAUDE_PROXY_URL
    ? { baseURL: process.env.CLAUDE_PROXY_URL }
    : {}),
});

// claude-haiku-3-5 supports vision; use it for all categorization
const MODEL = 'claude-haiku-4-5';

function stripMarkdownCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m, '$1').trim();
}

// ─── File categorization ──────────────────────────────────────────────────────

/**
 * Ask Claude to suggest a Google Drive folder path for a file.
 *
 * @param imageBase64 - Base64-encoded image data (for image/* files). When
 *   provided Claude will visually analyse the image to infer the subject and
 *   suggest a path like "Images/Cat" or "Images/Sunset".
 * @param imageMimeType - The MIME type of the image (e.g. "image/jpeg").
 *   Required when imageBase64 is provided.
 * @param extractedText - Plain text extracted from the file (e.g. from a PDF).
 *   When provided Claude will use the content to infer context such as
 *   "Finance/Invoices/2026" for an invoice PDF.
 */
export async function categorizeFile(
  fileName: string,
  mimeType: string,
  existingRules: UserRule[],
  options?: {
    imageBase64?: string;
    imageMimeType?: string;
    extractedText?: string;
  },
): Promise<CategorizationResult> {
  const rulesContext =
    existingRules.length > 0
      ? `\nThe user has these custom organization rules:\n${existingRules
          .map(
            (r, i) => `${i + 1}. "${r.description}" → folder: ${r.targetPath}`,
          )
          .join('\n')}\nApply a matching rule if one fits.`
      : '';

  const isImage = options?.imageBase64 && options?.imageMimeType;
  const hasPdfText = !!options?.extractedText;

  const imageHint = isImage
    ? '\nAn image of the file is attached. Use what you see in the image to determine the best folder. For photos, use "Images/<Subject>" (e.g. "Images/Cat", "Images/Sunset", "Images/Food").'
    : '';

  const pdfTextHint = hasPdfText
    ? `\nExtracted text from the file (first 2000 chars):\n"""\n${options!.extractedText}\n"""\nUse this content to infer context (e.g. invoice, receipt, contract).`
    : '';

  const prompt = `You are a file organization assistant. Suggest the best Google Drive folder path to store a file.

File name: ${fileName}
MIME type: ${mimeType}
${rulesContext}${imageHint}${pdfTextHint}

Respond with ONLY valid JSON in this exact shape (no markdown, no explanation):
{
  "suggestedPath": "Category/Subcategory/OptionalYear",
  "reasoning": "One sentence explaining why",
  "confidence": "high" | "medium" | "low"
}

Rules for suggestedPath:
- Use forward slashes for folder hierarchy
- Capitalize each folder name
- Max 3 levels deep
- Use present-year subfolder only for dated documents like invoices, receipts, statements
- For photos/images use "Images/<Subject>" as the top-level pattern (e.g. "Images/Cat", "Images/Dog", "Images/Food", "Images/Landscape")
- Examples: "Work/Invoices/2026", "Images/Cat", "Finance/Tax Documents/2026", "Media/Videos", "Code/Projects"`;

  // Build the message content — text only, or text + image for vision requests
  const userContent: Array<TextBlockParam | ImageBlockParam> = isImage
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: options!.imageMimeType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: options!.imageBase64!,
          },
        } satisfies ImageBlockParam,
        { type: 'text', text: prompt } satisfies TextBlockParam,
      ]
    : [{ type: 'text', text: prompt } satisfies TextBlockParam];

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = stripMarkdownCodeFence(
    message.content[0]?.type === 'text' ? message.content[0].text.trim() : '',
  );

  try {
    const parsed = JSON.parse(text) as CategorizationResult;
    // Sanitize the path: strip leading/trailing slashes
    parsed.suggestedPath = parsed.suggestedPath.replace(/^\/+|\/+$/g, '');
    return parsed;
  } catch {
    // Fallback if Claude returns unexpected output
    console.error('Failed to parse Claude categorization response:', text);
    return {
      suggestedPath: 'Unsorted',
      reasoning: 'Could not determine category automatically.',
      confidence: 'low',
    };
  }
}

// ─── Rule parsing ─────────────────────────────────────────────────────────────

export interface ParsedRule {
  pattern: string; // keyword/glob pattern to match file names
  mimePrefix?: string; // optional MIME type prefix filter
  targetPath: string; // destination folder path
}

/**
 * Ask Claude to parse a free-text rule description into a structured rule.
 * e.g. "always put PDFs with 'invoice' in Work/Invoices"
 */
export async function parseRuleFromText(
  description: string,
): Promise<ParsedRule | null> {
  const prompt = `Parse this file organization rule into structured JSON.

User rule: "${description}"

Respond with ONLY valid JSON (no markdown):
{
  "pattern": "keyword or glob that matches the filename, lowercase",
  "mimePrefix": "optional MIME type prefix like 'application/pdf', omit if not specified",
  "targetPath": "Folder/Path/To/Use"
}

If the rule cannot be understood, respond with: null`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = stripMarkdownCodeFence(
    message.content[0]?.type === 'text' ? message.content[0].text.trim() : '',
  );

  if (text === 'null') return null;

  try {
    const parsed = JSON.parse(text) as ParsedRule;
    parsed.targetPath = parsed.targetPath.replace(/^\/+|\/+$/g, '');
    return parsed;
  } catch {
    console.error('Failed to parse Claude rule response:', text);
    return null;
  }
}
