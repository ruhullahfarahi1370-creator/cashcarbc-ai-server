// src/twilio/twimlHelpers.js

export function pickUserInput(req) {
  return {
    speech: (req.body.SpeechResult || "").trim(),
    digits: (req.body.Digits || "").trim(),
  };
}

/**
 * sayAndGather
 * - mode: "dtmf" | "speech" | "both"
 * - numDigits: number (optional) -> for fixed-length DTMF (e.g., year=4)
 * - finishOnKey: string (optional) -> for variable-length DTMF (e.g., price/mileage; caller presses #)
 */
export function sayAndGather({
  twiml,
  prompt,
  actionUrl,
  mode = "dtmf",
  hints,
  numDigits,
  finishOnKey,
  timeout = 7,
}) {
  const input =
    mode === "dtmf" ? "dtmf" : mode === "speech" ? "speech" : "dtmf speech";

  const gatherOptions = {
    input,
    action: actionUrl,
    method: "POST",
    timeout,
    speechTimeout: "auto",
    language: "en-CA",
  };

  // Only include hints when using speech (Twilio ignores for pure DTMF anyway)
  if (mode !== "dtmf" && hints) gatherOptions.hints = hints;

  // For fixed-length numeric inputs (e.g., year=4, drives=1 digit)
  if (typeof numDigits === "number" && Number.isFinite(numDigits) && numDigits > 0) {
    gatherOptions.numDigits = numDigits;
  }

  // For variable-length numeric inputs (e.g., price/mileage/phone)
  // Caller presses # to submit.
  if (typeof finishOnKey === "string" && finishOnKey.length > 0) {
    gatherOptions.finishOnKey = finishOnKey;
  }

  const gather = twiml.gather(gatherOptions);

  gather.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, prompt);

  // If gather times out, Twilio continues and will run these:
  twiml.say(
    { voice: "Polly-Matthew-Neural", language: "en-CA" },
    "Sorry, I did not get that."
  );
  twiml.redirect({ method: "POST" }, actionUrl);
}

export function endCallAndCleanup({ res, twiml, callSid, deleteState }) {
  twiml.hangup();
  if (typeof deleteState === "function") deleteState(callSid);
  res.type("text/xml");
  return res.send(twiml.toString());
}
