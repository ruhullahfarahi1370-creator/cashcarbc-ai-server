// src/utils/postal.js

export function extractPostalCodeFromSpeech(speech) {
  const raw = String(speech || "").toUpperCase();
  const cleaned = raw.replace(/[^A-Z0-9]/g, "");
  const match = cleaned.match(/([A-Z]\d[A-Z]\d[A-Z]\d)/); // A1A1A1
  if (!match) return { ok: false, raw, postal: "" };

  const p = match[1];
  return { ok: true, raw, postal: `${p.slice(0, 3)} ${p.slice(3)}` };
}
