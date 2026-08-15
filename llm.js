// CalTrack LLM layer — direct browser calls to the Anthropic API.
// Structured outputs (output_config.format json_schema) guarantee valid JSON;
// thinking is disabled: these are extraction tasks, not reasoning tasks.
"use strict";

const LLM = (() => {
  const MODEL = "claude-sonnet-5";
  const API_URL = "https://api.anthropic.com/v1/messages";

  const NULL_STR = { anyOf: [{ type: "string" }, { type: "null" }] };
  const NULL_NUM = { anyOf: [{ type: "number" }, { type: "null" }] };
  const NUM = { type: "number" };

  async function call({ system, content, schema, maxTokens = 2500 }) {
    const key = localStorage.getItem("caltrack_api_key");
    if (!key) throw new Error("No API key — add it in Settings first.");
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        thinking: { type: "disabled" },
        system,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : res.statusText);
    if (data.stop_reason === "refusal") throw new Error("The model declined this request.");
    if (data.stop_reason === "max_tokens") throw new Error("Response was truncated — try again.");
    const block = data.content.find((b) => b.type === "text");
    return JSON.parse(block.text);
  }

  // ---------- photo scan ----------
  const PHOTO_ITEM = {
    type: "object", additionalProperties: false,
    required: ["name", "portion_g", "kcal", "kcal_low", "kcal_high", "protein_g", "carbs_g", "fat_g", "hidden_factor"],
    properties: {
      name: { type: "string" }, portion_g: NUM,
      kcal: NUM, kcal_low: NUM, kcal_high: NUM,
      protein_g: NUM, carbs_g: NUM, fat_g: NUM,
      hidden_factor: NULL_STR,
    },
  };
  const PHOTO_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["items", "question", "notes"],
    properties: { items: { type: "array", items: PHOTO_ITEM }, question: NULL_STR, notes: { type: "string" } },
  };

  const PHOTO_SYSTEM = `You are a nutrition analysis engine. You receive one photo of food.

Rules:
- Identify each distinct food item visible in the photo.
- Estimate portions in grams using visual cues (a dinner plate is ~26 cm across, a fork ~19 cm, a glass ~250-350 ml).
- kcal is your MEDIAN estimate — not high, not low. Do not skew in either direction.
- kcal_low and kcal_high are an honest 80% interval for that item (the true value should fall inside 8 times out of 10). Wide intervals for genuinely uncertain items are correct, not a failure.
- NEVER invent items or detail you cannot see. If something plausible might be present but is invisible (dressing, cooking oil, a filling, sauce mixed in), do NOT add it as an item and do NOT fold it into the numbers — raise it in "question" instead.
- hidden_factor: for each item, the single most calorie-relevant variable you cannot see (e.g. "cooked in oil vs dry", "sugar in the sauce"), or null if the item is fully determined.
- question: ONE short question about the highest-impact hidden variable across the whole plate (piece count, dressing amount, oil), or null if nothing material is hidden. Never more than one.
- Macros must be consistent with standard nutrition data for the food and portion.
- If the photo contains no food, return an empty items array and say so in notes.
- notes: one short sentence about assumptions, or an empty string.`;

  function analyzePhoto(base64, mediaType = "image/jpeg") {
    return call({
      system: PHOTO_SYSTEM,
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "Analyze this meal." },
      ],
      schema: PHOTO_SCHEMA,
    });
  }

  // ---------- nutrition label ----------
  const LABEL_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["name", "per_100g", "unit_g", "notes"],
    properties: {
      name: { type: "string" },
      per_100g: {
        type: "object", additionalProperties: false,
        required: ["kcal", "protein_g", "carbs_g", "fat_g"],
        properties: { kcal: NUM, protein_g: NUM, carbs_g: NUM, fat_g: NUM },
      },
      unit_g: NULL_NUM,
      notes: { type: "string" },
    },
  };

  const LABEL_SYSTEM = `You are reading a photo of a food product's nutrition label.
Extract the product name and the EXACT per-100g (or per-100ml) values as printed. Do not estimate, round differently, or adjust anything.
If the label only gives per-serving values, convert to per-100g using the printed serving size and say so in notes.
unit_g: the package or serving size in grams/ml if printed, else null.
If the photo is not a nutrition label, put an explanation in notes and zeros elsewhere.`;

  function analyzeLabel(base64, mediaType = "image/jpeg") {
    return call({
      system: LABEL_SYSTEM,
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "Extract this nutrition label." },
      ],
      schema: LABEL_SCHEMA,
    });
  }

  // ---------- loose-text entry ----------
  const TEXT_ITEM = {
    type: "object", additionalProperties: false,
    required: ["kind", "food_id", "grams", "date", "item_name", "name", "kcal", "kcal_low", "kcal_high", "protein_g", "carbs_g", "fat_g"],
    properties: {
      kind: { type: "string", enum: ["food", "log_ref", "estimate"] },
      food_id: NULL_STR, grams: NULL_NUM,
      date: NULL_STR, item_name: NULL_STR,
      name: NULL_STR, kcal: NULL_NUM, kcal_low: NULL_NUM, kcal_high: NULL_NUM,
      protein_g: NULL_NUM, carbs_g: NULL_NUM, fat_g: NULL_NUM,
    },
  };
  const TEXT_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["items", "question"],
    properties: { items: { type: "array", items: TEXT_ITEM }, question: NULL_STR },
  };

  const TEXT_SYSTEM = `You turn a short free-text food description into log items, resolving against the user's own food database and recent log. Three resolution kinds, in strict order of preference:

1. kind="food": the text plausibly refers to an entry in FOODS (match names AND aliases, loosely — "cott" matches cottage cheese, "krapow" matches Fit2Go Krapow Chicken). Return food_id and grams. Leave every macro field null — the app fills macros from its local database. Never restate numbers for known foods.
   - grams: use the quantity in the text if given; otherwise the food's default_g; for "half a", scale accordingly.
2. kind="log_ref": the text refers to a recently logged dish that is NOT in FOODS ("same as yesterday's lunch", "that pasta from Tuesday"). Return date and item_name copied EXACTLY from RECENT. Leave macros null — the app copies them verbatim from the log.
3. kind="estimate": genuinely unknown item. Return name, grams, median kcal with an honest 80% kcal_low/kcal_high interval, and macros.

Rules:
- Only log what the text mentions. Never add side items, drinks, or condiments the user didn't name.
- Multiple foods in one sentence become multiple items.
- question: ONE short question if a needed quantity is missing or a reference is ambiguous, else null. Still return your best-guess items alongside the question.`;

  function parseText(text, foodsDigest, recentDigest) {
    const content = [
      { type: "text", text: `FOODS (id | name | aliases | kcal per 100g | default_g):\n${foodsDigest}\n\nRECENT (date: item (kcal)):\n${recentDigest}\n\nUSER TEXT: ${text}` },
    ];
    return call({ system: TEXT_SYSTEM, content, schema: TEXT_SCHEMA, maxTokens: 1500 });
  }

  return { analyzePhoto, analyzeLabel, parseText, MODEL };
})();
