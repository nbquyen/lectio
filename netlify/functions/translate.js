// Netlify serverless function: POST /.netlify/functions/translate
//
// MULTIPLE GEMINI KEYS (load balance + fallback):
//   GEMINI_API_KEY_1 = AIza...   ← key từ acc 1
//   GEMINI_API_KEY_2 = AIza...   ← key từ acc 2
//   GEMINI_API_KEY_3 = AIza...   ← key từ acc 3 (thêm bao nhiêu cũng được)
//   GEMINI_API_KEY   = AIza...   ← key duy nhất (nếu chỉ có 1 acc, dùng cái này)
//
// Logic:
//   1. Thu thập tất cả key có trong env (GEMINI_API_KEY, GEMINI_API_KEY_1, _2, _3...)
//   2. Xáo ngẫu nhiên → thử từng key cho đến khi thành công
//   3. Nếu tất cả Gemini key fail → fallback sang Google Translate (miễn phí, không cần key)
//   4. Response luôn trả về cùng 1 JSON shape dù dùng Gemini hay Google Translate

// ── Collect all Gemini keys from env ──────────────────────────
function getGeminiKeys() {
  const keys = [];
  // Single key
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  // Numbered keys: GEMINI_API_KEY_1 ... GEMINI_API_KEY_10
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  // Deduplicate
  return [...new Set(keys)];
}

// ── Shuffle array (Fisher-Yates) ──────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Try one Gemini key ─────────────────────────────────────────
async function tryGemini(apiKey, prompt) {
  const model = "gemini-2.5-flash";
  const res = await fetch(
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
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${msg.slice(0, 120)}`);
  }
  const data = await res.json();
  const textOut = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  const cleaned = textOut.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned); // throws if not valid JSON
}

// ── Google Translate fallback (free, no key needed) ───────────
// Uses the unofficial endpoint — no auth, but rate-limited per IP.
// Returns a simplified result (no part_of_speech, no pronunciation).
async function googleTranslateFallback(text, sourceLang) {
  const sl = sourceLang === "de" ? "de" : "en";
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=vi&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Translate ${res.status}`);
  const data = await res.json();

  // data[0] = array of [translated, original] pairs
  const meaning_vi = (data[0] || []).map(x => x?.[0] || "").join("").trim();

  // data[1] = dict entries (may be null for phrases)
  let part_of_speech = "";
  let pronunciation = "";
  if (Array.isArray(data[1])) {
    part_of_speech = data[1]?.[0]?.[0] || "";
  }

  return {
    original: text,
    meaning_vi: meaning_vi || "—",
    part_of_speech,
    pronunciation,
    example_vi: "",
    via: "google_translate", // flag so frontend knows this was a fallback
  };
}

// ── Main handler ───────────────────────────────────────────────
export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
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
  "part_of_speech": "noun/verb/adjective/phrase/idiom/etc, or empty string",
  "pronunciation": "IPA if single word/short phrase, else empty string",
  "example_vi": "bản dịch tiếng Việt của câu ví dụ nếu có context, else empty string"
}`;

  // Step 1: Try all Gemini keys in random order
  const keys = shuffle(getGeminiKeys());
  const errors = [];

  for (const key of keys) {
    try {
      const result = await tryGemini(key, prompt);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...result, via: "gemini" }),
      };
    } catch (e) {
      console.warn(`Gemini key ...${key.slice(-6)} failed:`, e.message);
      errors.push(e.message);
      // Continue to next key
    }
  }

  // Step 2: All Gemini keys failed — fallback to Google Translate
  console.log(`All ${keys.length} Gemini key(s) failed. Falling back to Google Translate.`);
  try {
    const result = await googleTranslateFallback(text, sourceLang);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (e) {
    console.error("Google Translate fallback also failed:", e.message);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: "Không thể dịch lúc này — cả Gemini và Google Translate đều không phản hồi.",
        gemini_errors: errors,
      }),
    };
  }
};
