import { GoogleGenAI } from "@google/genai";

// Construct the client lazily so merely importing this package does not require
// the Gemini integration to be provisioned. Anthropic-only deployments and
// local dev can boot without these vars; the error is raised only if/when the
// integration client is actually used.
let _ai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (_ai) return _ai;

  if (!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_BASE_URL must be set. Did you forget to provision the Gemini AI integration?",
    );
  }
  if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
    );
  }

  _ai = new GoogleGenAI({
    apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
    httpOptions: {
      apiVersion: "",
      baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
    },
  });
  return _ai;
}

// Proxy that defers construction (and the required-env check) until first use,
// while preserving the `ai.models.generateContent(...)` access shape callers use.
export const ai: GoogleGenAI = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    const client = getClient() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
});
