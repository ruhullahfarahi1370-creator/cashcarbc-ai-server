// src/twilio/twimlHelpers.js

export function pickUserInput(req) {
  return {
    speech: (req.body.SpeechResult || "").trim(),
    digits: (req.body.Digits || "").trim(),
  };
}

export function sayAndGather({ twiml, prompt, actionUrl, mode, hints }) {
  const input = mode === "dtmf" ? "dtmf" : mode === "speech" ? "speech" : "dtmf speech";

  const gather = twiml.gather({
    input,
    action: actionUrl,
    method: "POST",
    timeout: 7,
    speechTimeout: "auto",
    language: "en-CA",
    hints: hints || "",
  });

  gather.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, prompt);

  // If gather times out, Twilio continues and will run these:
  twiml.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, "Sorry, I did not get that.");
  twiml.redirect({ method: "POST" }, actionUrl);
}

export function endCallAndCleanup({ res, twiml, callSid, deleteState }) {
  twiml.hangup();
  if (typeof deleteState === "function") deleteState(callSid);
  res.type("text/xml");
  return res.send(twiml.toString());
}
