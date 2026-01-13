// src/utils/postal.js

function applySpeechFixes(rawUpper) {
  // Word→digit fixes seen in voice transcripts
  return rawUpper
    .replace(/\bFOR\b/g, "4")
    .replace(/\bFOUR\b/g, "4")
    .replace(/\bTO\b/g, "2")
    .replace(/\bTWO\b/g, "2")
    .replace(/\bONE\b/g, "1")
    .replace(/\bZERO\b/g, "0")
    .replace(/\bOH\b/g, "0")
    // Sometimes "O" is spoken/recognized instead of zero
    .replace(/\bO\b/g, "0");
}

export function extractPostalCodeFromSpeech(speech) {
  const raw = String(speech || "").toUpperCase();
  const normalized = applySpeechFixes(raw);

  // Remove everything except letters/numbers
  const cleaned = normalized.replace(/[^A-Z0-9]/g, "");

  // 1) Try full postal: A1A1A1
  let match = cleaned.match(/([A-Z]\d[A-Z]\d[A-Z]\d)/);
  if (match) {
    const p = match[1];
    return {
      ok: true,
      raw,
      cleaned,
      postal: `${p.slice(0, 3)} ${p.slice(3)}`,
      fsa: p.slice(0, 3),
      confidence: "high",
    };
  }

  // 2) Try FSA only: A1A
  match = cleaned.match(/([A-Z]\d[A-Z])/);
  if (match) {
    const fsa = match[1];
    return {
      ok: true,
      raw,
      cleaned,
      postal: "",
      fsa,
      confidence: "medium",
    };
  }

  return {
    ok: false,
    raw,
    cleaned,
    postal: "",
    fsa: "",
    confidence: "low",
  };
}
