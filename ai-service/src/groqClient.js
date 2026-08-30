// /ai-service/src/groqClient.js

const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// gpt-oss-120b replaces the deprecated llama-3.3-70b-versatile (shut down Aug 16, 2026)
const MODEL = 'openai/gpt-oss-120b';

/**
 * Calls Groq asking for strict JSON matching jsonSchema.
 * Throws on failure instead of swallowing errors and returning {} —
 * callers are responsible for deciding what a failed extraction means
 * for their pipeline (previously a silent {} looked identical to a
 * legitimately empty invoice, which is what caused the all-null bug).
 */
async function callGroqStructured(systemPrompt, userPrompt, jsonSchema) {
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

  return parsed;
}

module.exports = { callGroqStructured, MODEL };