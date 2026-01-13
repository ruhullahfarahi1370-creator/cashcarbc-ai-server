// src/twilio/twimlHelpers.js

export function pickUserInput(req) {
  const rawSpeech = (req.body.SpeechResult || "").trim();
  const rawDigits = (req.body.Digits || "").trim();

  // IMPORTANT: Twilio may include finishOnKey chars or spaces in Digits depending on config
  // Always sanitize to digits-only for numeric fields.
  const digitsOnly = rawDigits.replace(/[^\d]/g, "");

  return {
    speech: rawSpeech,
    digits: digitsOnly,      // always digits-only
    rawDigits,               // keep for logging/debugging if needed
  };
}

export function sayAndGather({
  twiml,
  prompt,
  actionUrl,
  mode,
  hints,
  // NEW optional options:
  finishOnKey,   // e.g. "#"
  numDigits,     // e.g. 4 for year
  timeoutSec,    // default longer
}) {
  const input =
    mode === "dtmf" ? "dtmf" :
    mode === "speech" ? "speech" :
    "dtmf speech";

  const gatherOpts = {
    input,
    action: actionUrl,
    method: "POST",
    timeout: Number.isFinite(timeoutSec) ? timeoutSec : 12, // longer than 7
    speechTimeout: "auto",
    language: "en-CA",
  };

  if (hints) gatherOpts.hints = hints;
  if (finishOnKey) gatherOpts.finishOnKey = finishOnKey;
  if (Number.isFinite(numDigits)) gatherOpts.numDigits = numDigits;

  const gather = twiml.gather(gatherOpts);

  gather.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, prompt);

  // Only runs when NO input was captured
  twiml.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, "Sorry, I did not get that.");
  twiml.redirect({ method: "POST" }, actionUrl);
}

export function endCallAndCleanup({ res, twiml, callSid, deleteState }) {
  twiml.hangup();
  if (typeof deleteState === "function") deleteState(callSid);
  res.type("text/xml");
  return res.send(twiml.toString());
}
