// Netlify serverless function: POST /.netlify/functions/translate
// (App.jsx calls this via /api/translate — netlify.toml rewrites the path)
//
// Required environment variable (set in Netlify dashboard, NOT in code):
//   GEMINI_API_KEY = AIza...

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server is missing GEMINI_API_KEY." }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const { text, contextSentence, sourceLang = "en" } = body;
  if (!text || typeof text !== "string" || text.length > 500) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid 'text' field." }) };
  }

  const langLabel = sourceLang === "de" ? "German" : "English";

  const prompt = `You are a precise ${langLabel}-Vietnamese dictionary assistant for a language learner.
Translate/explain this ${langLabel} text: "${text}"
${contextSentence && contextSentence !== text ? `It appears in this sentence: "${contextSentence}"` : ""}

Respond ONLY with valid JSON, no markdown, no preamble, no code fences, in this exact shape:
{
  "original": "the exact text",
  "meaning_vi": "nghĩa tiếng Việt ngắn gọn, tự nhiên",
  "part_of_speech": "${langLabel === "German" ? "Nomen/Verb/Adjektiv/Phrase/etc" : "noun/verb/adjective/phrase/idiom/etc"}, or empty string if not applicable",
  "pronunciation": "IPA pronunciation if it's a single word or short phrase, else empty string",
  "example_vi": "bản dịch tiếng Việt của câu ví dụ nếu có context, else empty string"
}`;

  try {
    const model = "gemini-2.5-flash";
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 500,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", response.status, errText);
      return { statusCode: 502, body: JSON.stringify({ error: "Translation service error. Please try again." }) };
    }

    const data = await response.json();
    const textOut = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const cleaned = textOut.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Failed to parse model output:", cleaned);
      return { statusCode: 502, body: JSON.stringify({ error: "Could not parse translation result." }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (e) {
    console.error("Translate handler error:", e);
    return { statusCode: 500, body: JSON.stringify({ error: "Unexpected server error." }) };
  }
};
