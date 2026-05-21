exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const apiKey = process.env.ANTHROPIC_API_KEY_NUTRITION;
  if (!apiKey) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Clé API manquante" }) };

  let parsed;
  try { parsed = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Body invalide: " + e.message }) }; }

  let resp, text;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(parsed),
    });
    text = await resp.text();
  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Fetch Anthropic échoué: " + e.message }) };
  }

  // Vérifier que la réponse est bien du JSON
  try { JSON.parse(text); }
  catch(e) {
    return { statusCode: 502, headers: h, body: JSON.stringify({ error: "Réponse Anthropic non-JSON: " + text.slice(0, 200) }) };
  }

  return { statusCode: resp.status, headers: h, body: text };
};
