// /ai-service/src/groqClient.js

const Groq = require('groq-sdk');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  // Retry rate-limit (429) and temporary server errors up to 6 times with growing waits
  // (about 20s in total) instead of the library default of 2, which gave up in ~1-2s.
  // Found during the Flow 7 evaluation: one invoice hit a tokens-per-minute 429, was not retried
  // long enough, and fell back to vendor-submitted data. Override with GROQ_MAX_RETRIES.
  maxRetries: Number(process.env.GROQ_MAX_RETRIES || 6),
});

// gpt-oss-120b replaces the deprecated llama-3.3-70b-versatile (shut down Aug 16, 2026)
const MODEL = 'openai/gpt-oss-120b';

/**
 * Calls Groq asking for strict JSON matching jsonSchema.
 * Throws on failure instead of swallowing errors and returning {} —
 * callers are responsible for deciding what a failed extraction means
 * for their pipeline (previously a silent {} looked identical to a
 * legitimately empty invoice, which is what caused the all-null bug).
 */
// Veridion deals only in Indian Rupees, but the model is given bare numbers with no currency,
// so left alone it guesses a symbol (we saw "¥9,900" in a ranking explanation). For callers
// that WRITE prose for people (ranking reasoning, decision reasoning, dispute drafts) we both
// tell the model to use ₹ and rewrite any other currency marker in front of a number.
const RUPEE_NOTE = ' All monetary amounts are in Indian Rupees (INR). Always write them with the rupee symbol, e.g. ₹9,900 — never use ¥, $, €, £, "Rs", "USD", "JPY" or any other currency symbol or code.';
const CURRENCY_BEFORE_NUMBER = /(?:[¥￥$€£]|\b(?:Rs\.?|INR|JPY|USD|EUR|GBP|CNY))\s?(?=\d)/g;
function normalizeCurrency(value) {
  if (typeof value === 'string') return value.replace(CURRENCY_BEFORE_NUMBER, '₹');
  if (Array.isArray(value)) return value.map(normalizeCurrency);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeCurrency(v)]));
  }
  return value;
}

async function callGroqStructured(systemPrompt, userPrompt, jsonSchema, options = {}) {
  if (options.rupees) systemPrompt = systemPrompt + RUPEE_NOTE;
  const response = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const raw = response?.choices?.[0]?.message?.content;

  if (!raw || raw.trim().length === 0) {
    throw new Error('Groq returned an empty response body');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Model sometimes wraps JSON in ```json fences despite json_object mode
    const cleaned = raw.replace(/```json|```/g, '').trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch (err2) {
      throw new Error(`Groq response was not valid JSON. Raw output: ${raw.slice(0, 300)}`);
    }
  }

  return options.rupees ? normalizeCurrency(parsed) : parsed;
}

module.exports = { callGroqStructured, normalizeCurrency, MODEL };