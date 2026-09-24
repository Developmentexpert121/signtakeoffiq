/**
 * Gemini Vision client — direct REST API call to generativelanguage.googleapis.com.
 *
 * Uses gemini-2.5-pro for image+text vision tasks.
 * Requires GEMINI_API_KEY set in the environment.
 * Get a key at https://aistudio.google.com/app/apikey
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_MODEL = "gemini-2.5-pro";

// Gemini 1.5 Pro pricing (prompts ≤128K tokens)
// https://ai.google.dev/pricing
const INPUT_PRICE_PER_1M = 1.25;  // USD per 1M input tokens
const OUTPUT_PRICE_PER_1M = 5.00;  // USD per 1M output tokens

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export interface GeminiVisionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

async function callGeminiApi(
  imagePngBase64: string,
  prompt: string,
): Promise<GeminiVisionResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const url = `${GEMINI_API_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "image/png", data: imagePngBase64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      response_mime_type: "application/json",
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `Gemini API error ${resp.status}: ${errText.slice(0, 300)}`,
    );
  }

  const data = (await resp.json()) as GeminiApiResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  const cost =
    (inputTokens / 1_000_000) * INPUT_PRICE_PER_1M +
    (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_1M;

  return { text, inputTokens, outputTokens, cost };
}

/**
 * Send a PNG image + text prompt to Gemini 1.5 Flash and return the raw text
 * from the model response (typically JSON when generationConfig.response_mime_type
 * is set to "application/json").
 *
 * Requires GEMINI_API_KEY in the environment.
 * Throws an Error including the HTTP status code if the API returns non-2xx.
 */
export async function geminiVisionScan(
  imagePngBase64: string,
  prompt: string,
): Promise<string> {
  const { text } = await callGeminiApi(imagePngBase64, prompt);
  return text;
}

/**
 * Same as geminiVisionScan but also returns token usage and cost.
 * Used by the pipeline's callClaudeVision wrapper to maintain cost-tracking
 * parity with Claude calls.
 */
export async function geminiVisionScanWithUsage(
  imagePngBase64: string,
  prompt: string,
): Promise<GeminiVisionResult> {
  return callGeminiApi(imagePngBase64, prompt);
}
