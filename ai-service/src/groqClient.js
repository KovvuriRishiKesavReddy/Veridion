require('dotenv').config();

const GROQ_MODEL = 'llama-3.3-70b-versatile';

// callGroqStructured: sends a system+user prompt to Groq, requesting strict JSON back.
// If GROQ_API_KEY isn't set, returns { __stub: true } instead of throwing — every agent
// that calls this checks for __stub and falls back to a deterministic, honest template
// response instead of LLM-generated prose. This means the entire pipeline (matching
// scores, compliance checks, the Context Gate's math, decisions) is fully functional
// and testable with zero API key; only the natural-language reasoning quality improves
// once a real key is added to .env.
async function callGroqStructured(systemPrompt, userPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { __stub: true };
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned no content');

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Groq returned non-JSON content: ${content}`);
  }
}

module.exports = { callGroqStructured };
