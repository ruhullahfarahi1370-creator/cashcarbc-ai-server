// src/flows/postalFlow.js
import twilio from "twilio";
import { extractPostalCodeFromSpeech } from "../utils/postal.js";
import { extractCityFromSpeech } from "../utils/city.js"; // if you already have it; if not, remove city part.

const { VoiceResponse } = twilio.twiml;

function saidYes(text) {
  const t = String(text || "").toLowerCase();
  return /\b(yes|yeah|yep|correct|right|that'?s right|sure|ok|okay)\b/.test(t);
}

function saidNo(text) {
  const t = String(text || "").toLowerCase();
  return /\b(no|nope|nah|incorrect|wrong|not correct)\b/.test(t);
}

/**
 * Handles postal step + confirm + retries + fallback, without bloating controller.
 *
 * Inputs:
 *  - state: your call state object
 *  - speech: SpeechResult / recognized text
 *
 * Output:
 *  - twiml (VoiceResponse)
 *  - nextStep string (optional)
 *  - statePatch object (optional)
 */
export function handlePostalFlow(state, speech) {
  const vr = new VoiceResponse();
  const currentStep = state.step;

  // ---- CONFIRM FULL POSTAL ----
  if (currentStep === "confirm_postal") {
    if (saidYes(speech)) {
      vr.say("Perfect. Thanks.");
      return { twiml: vr, nextStep: "next_step_after_location" };
    }
    if (saidNo(speech)) {
      vr.say("No problem. Please say the postal code again.");
      return {
        twiml: vr,
        nextStep: "postal",
        statePatch: { pickupPostal: "", postalFSA: "", postalRetries: 0 },
      };
    }
    vr.say("Sorry, please say yes or no. Is that postal code correct?");
    return { twiml: vr, nextStep: "confirm_postal" };
  }

  // ---- CONFIRM FSA ----
  if (currentStep === "confirm_fsa") {
    if (saidYes(speech)) {
      vr.say("Great. Thanks.");
      return { twiml: vr, nextStep: "next_step_after_location" };
    }
    if (saidNo(speech)) {
      vr.say("No worries. Please say the postal code again.");
      return {
        twiml: vr,
        nextStep: "postal",
        statePatch: { postalFSA: "", postalRetries: 0 },
      };
    }
    vr.say("Sorry, please say yes or no. Is that correct?");
    return { twiml: vr, nextStep: "confirm_fsa" };
  }

  // ---- MAIN POSTAL STEP ----
  // Try to extract postal/FSA
  const r = extractPostalCodeFromSpeech(speech);

  if (r.ok && r.confidence === "high" && r.postal) {
    vr.say(`Just to confirm, I heard ${r.postal}. Is that correct?`);
    return {
      twiml: vr,
      nextStep: "confirm_postal",
      statePatch: {
        pickupPostal: r.postal,
        postalFSA: r.fsa || r.postal.replace(/[^A-Z0-9]/g, "").slice(0, 3),
        postalRetries: 0,
      },
    };
  }

  if (r.ok && r.confidence === "medium" && r.fsa) {
    vr.say(`I heard ${r.fsa}. Is that correct?`);
    return {
      twiml: vr,
      nextStep: "confirm_fsa",
      statePatch: { postalFSA: r.fsa, postalRetries: 0 },
    };
  }

  // Optional: fallback to city (only if you already collect cities and have a util)
  let city = null;
  try {
    const c = extractCityFromSpeech(speech);
    if (c?.cityNorm) city = c.cityNorm;
  } catch {
    // ignore if you don't have city util wired
  }

  if (city) {
    vr.say(`Got it. You're in ${city}, correct?`);
    return {
      twiml: vr,
      nextStep: "confirm_city",
      statePatch: { cityNorm: city, postalRetries: 0 },
    };
  }

  // Retry logic (kept here, not controller)
  const retries = Number(state.postalRetries || 0) + 1;

  if (retries <= 1) {
    vr.say("No worries. Please say the postal code again, slowly.");
    vr.say("For example: V five J one N four.");
    return {
      twiml: vr,
      nextStep: "postal",
      statePatch: { postalRetries: retries },
    };
  }

  // Final fallback
  vr.say("No problem. What city is the car located in?");
  return {
    twiml: vr,
    nextStep: "city",
    statePatch: { postalRetries: retries },
  };
}
