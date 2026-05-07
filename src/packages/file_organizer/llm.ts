import Anthropic from '@anthropic-ai/sdk';
import type {
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import type { CategorizationResult, UserRule } from './types';

const DEFAULT_OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENAI_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001:free';

type AdapterKind = 'openai-compatible' | 'anthropic';
type Confidence = 'high' | 'medium' | 'low';

interface LlmImage {
  mimeType: string;
  base64: string;
}

interface LlmInput {
  prompt: string;
  maxTokens: number;
  image?: LlmImage;
}

interface LlmAdapter {
  generateText(input: LlmInput): Promise<string>;
}

interface PromptOptions {
  imageBase64?: string;
  imageMimeType?: string;
  extractedText?: string;
}

interface CategorizationPrompt {
  prompt: string;
  image?: LlmImage;
}

function stripMarkdownCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m, '$1').trim();
}

function getAdapterKind(): AdapterKind {
  return process.env.LLM_ADAPTER === 'anthropic'
    ? 'anthropic'
    : 'openai-compatible';
}

function getImage(options?: PromptOptions): LlmImage | undefined {
  if (!options?.imageBase64 || !options?.imageMimeType) return undefined;
  return { mimeType: options.imageMimeType, base64: options.imageBase64 };
}

function buildRulesContext(existingRules: UserRule[]): string {
  if (existingRules.length === 0) return '';
  return `\nThe user has these custom organization rules:\n${existingRules
    .map((r, i) => `${i + 1}. "${r.description}" -> folder: ${r.targetPath}`)
    .join('\n')}\nApply a matching rule if one fits.`;
}

function buildCategorizeFilePrompt(
  fileName: string,
  mimeType: string,
  existingRules: UserRule[],
  options?: PromptOptions,
): CategorizationPrompt {
  const image = getImage(options);
  const hasPdfText = !!options?.extractedText;
  const rulesContext = buildRulesContext(existingRules);

  const imageHint = image
    ? '\nAn image of the file is attached. Use what you see in the image to determine the best folder. For photos, use "Images/<Subject>" (e.g. "Images/Cat", "Images/Sunset", "Images/Food").'
    : '';

  const pdfTextHint = hasPdfText
    ? `\nExtracted text from the file (first 2000 chars):\n"""\n${options?.extractedText}\n"""\nUse this content to infer context (e.g. invoice, receipt, contract).`
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

  return { prompt, image };
}

function buildResolveRuleTokensPrompt(
  pathTemplate: string,
  fileName: string,
  mimeType: string,
  options?: PromptOptions,
): CategorizationPrompt {
  const image = getImage(options);
  const hasPdfText = !!options?.extractedText;

  const imageHint = image
    ? '\nAn image of the file is attached. Use it to identify any visible dates.'
    : '';

  const pdfTextHint = hasPdfText
    ? `\nExtracted text from the file (first 2000 chars):\n"""\n${options?.extractedText}\n"""\n`
    : '';

  const prompt = `You are a file organization assistant. Resolve a folder path template by filling in tokens from the document's content.

Path template: "${pathTemplate}"
File name: ${fileName}
MIME type: ${mimeType}
${imageHint}${pdfTextHint}
Token rules:
- {year}  -> the year most relevant to this document (invoice date, receipt date, statement period, document creation year, etc.)
- {month} -> the relevant month, zero-padded numeric (e.g. "04")
- {day}   -> the relevant day, zero-padded numeric (e.g. "07")

If a token's value CANNOT be determined from the document content, remove that token and its surrounding slash to keep the path clean.
Examples:
  template "docs/{year}", invoice dated 2000       -> "docs/2000"
  template "docs/{year}", no date found in content -> "docs"
  template "Finance/{year}/{month}", March 2023 receipt -> "Finance/2023/03"

Respond with ONLY the resolved path string - no explanation, no markdown, no quotes.`;

  return { prompt, image };
}

function buildParseRulePrompt(description: string): string {
  return `Parse this file organization rule into structured JSON.

User rule: "${description}"

Respond with ONLY valid JSON (no markdown):
{
  "pattern": "keyword or glob that matches the filename, lowercase",
  "mimePrefix": "optional MIME type prefix like 'application/pdf', omit if not specified",
  "targetPath": "Folder/Path/To/Use"
}

Dynamic tokens are allowed in targetPath. If the user specifies {year}, {month}, or {day},
preserve them exactly as written - they will be resolved from the document's actual content
at upload time (e.g. invoice date, receipt date, document creation year), not the current date.
Example: "always put pdfs to docs/{year} based on the date in doc" -> targetPath: "docs/{year}"

If the rule cannot be understood, respond with: null`;
}

class OpenAICompatibleAdapter implements LlmAdapter {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.CLAUDE_API_KEY;
    const baseURL =
      process.env.OPENAI_BASE_URL ??
      process.env.CLAUDE_API_ENDPOINT ??
      DEFAULT_OPENAI_BASE_URL;

    this.client = new OpenAI({ apiKey, baseURL });
    this.model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  }

  async generateText(input: LlmInput): Promise<string> {
    const content: ChatCompletionContentPart[] = input.image
      ? [
          {
            type: 'image_url',
            image_url: {
              url: `data:${input.image.mimeType};base64,${input.image.base64}`,
            },
          },
          { type: 'text', text: input.prompt },
        ]
      : [{ type: 'text', text: input.prompt }];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: input.maxTokens,
      messages: [{ role: 'user', content }],
    });

    return completion.choices[0]?.message?.content?.trim() ?? '';
  }
}

class AnthropicAdapter implements LlmAdapter {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY,
      ...(process.env.ANTHROPIC_BASE_URL ?? process.env.CLAUDE_API_ENDPOINT
        ? {
            baseURL:
              process.env.ANTHROPIC_BASE_URL ?? process.env.CLAUDE_API_ENDPOINT,
          }
        : {}),
    });

    this.model = process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  }

  async generateText(input: LlmInput): Promise<string> {
    const content: Array<TextBlockParam | ImageBlockParam> = input.image
      ? [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: input.image.mimeType as
                | 'image/jpeg'
                | 'image/png'
                | 'image/gif'
                | 'image/webp',
              data: input.image.base64,
            },
          } satisfies ImageBlockParam,
          { type: 'text', text: input.prompt } satisfies TextBlockParam,
        ]
      : [{ type: 'text', text: input.prompt } satisfies TextBlockParam];

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: input.maxTokens,
      messages: [{ role: 'user', content }],
    });

    return message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
  }
}

function getLlmAdapter(): LlmAdapter {
  return getAdapterKind() === 'anthropic'
    ? new AnthropicAdapter()
    : new OpenAICompatibleAdapter();
}

const llm = getLlmAdapter();

// --- File categorization -------------------------------------------------------

export async function categorizeFile(
  fileName: string,
  mimeType: string,
  existingRules: UserRule[],
  options?: PromptOptions,
): Promise<CategorizationResult> {
  const { prompt, image } = buildCategorizeFilePrompt(
    fileName,
    mimeType,
    existingRules,
    options,
  );

  const text = stripMarkdownCodeFence(
    await llm.generateText({ prompt, maxTokens: 1024, image }),
  );

  try {
    const parsed = JSON.parse(text) as CategorizationResult;
    parsed.suggestedPath = parsed.suggestedPath.replace(/^\/+|\/+$/g, '');
    parsed.confidence =
      parsed.confidence === 'high' ||
      parsed.confidence === 'medium' ||
      parsed.confidence === 'low'
        ? (parsed.confidence as Confidence)
        : 'low';
    return parsed;
  } catch {
    console.error('Failed to parse categorization response:', text);
    return {
      suggestedPath: 'Unsorted',
      reasoning: 'Could not determine category automatically.',
      confidence: 'low',
    };
  }
}

// --- Rule token resolution -----------------------------------------------------

export async function resolveRuleTokens(
  pathTemplate: string,
  fileName: string,
  mimeType: string,
  options?: PromptOptions,
): Promise<string> {
  const { prompt, image } = buildResolveRuleTokensPrompt(
    pathTemplate,
    fileName,
    mimeType,
    options,
  );

  const raw = (await llm.generateText({ prompt, maxTokens: 128, image })).trim();

  const resolved = raw
    .replace(/\/?\{[^}]+\}/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');

  return resolved || 'Unsorted';
}

// --- Rule parsing --------------------------------------------------------------

export interface ParsedRule {
  pattern: string;
  mimePrefix?: string;
  targetPath: string;
}

export async function parseRuleFromText(
  description: string,
): Promise<ParsedRule | null> {
  const prompt = buildParseRulePrompt(description);
  const text = stripMarkdownCodeFence(await llm.generateText({ prompt, maxTokens: 256 }));

  if (text === 'null') return null;

  try {
    const parsed = JSON.parse(text) as ParsedRule;
    parsed.targetPath = parsed.targetPath.replace(/^\/+|\/+$/g, '');
    return parsed;
  } catch {
    console.error('Failed to parse rule response:', text);
    return null;
  }
}
