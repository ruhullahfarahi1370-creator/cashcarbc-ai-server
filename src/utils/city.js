// src/utils/city.js

import { KNOWN_CITIES, CITY_ALIASES } from "../config/constants.js";
import { cleanText, similarityScore } from "./text.js";

export function normalizeCity(spoken) {
  const raw = String(spoken || "").trim();
  const cleaned = cleanText(raw);

  if (cleaned && CITY_ALIASES[cleaned]) {
    return { raw, normalized: CITY_ALIASES[cleaned], score: 1.0, method: "alias" };
  }

  let best = "";
  let bestScore = 0;

  for (const city of KNOWN_CITIES) {
    const s = similarityScore(cleaned, city);
    if (s > bestScore) {
      bestScore = s;
      best = city;
    }
  }

  const normalized = bestScore >= 0.62 ? best : raw || best;
  return { raw, normalized, score: Number(bestScore.toFixed(3)), method: "fuzzy" };
}
