// src/state/callState.js

// In-memory call session store (per Render instance)
const callState = new Map();

export function getOrCreateState(callSid, req) {
  if (!callState.has(callSid)) {
    callState.set(callSid, {
      // flow control
      step: "drives",

      // call metadata
      from: req.body.From || "",
      to: req.body.To || "",
      callSid,
      timestamp: new Date().toISOString(),

      // vehicle basics
      drives: null,
      year: "",
      make: "",
      model: "",
      mileageKm: "",
      askingPrice: "",

      // location
      cityRaw: "",
      cityNorm: "",
      cityScore: 0,
      pickupPostal: "",
      distanceKm: null,

      // condition
      condition: "",

      // pricing / rules
      ruleApplied: "N/A",

      // ===== AUTO-OFFER FLOW (old non-drivable cars) =====
      autoOfferEligible: false,
      autoOfferInitial: "", // e.g. "300"
      autoOfferFinal: "",   // e.g. "300" or "350"
      autoOfferStatus: "",  // ACCEPTED_300 / ACCEPTED_COUNTER / MANAGER_REVIEW / DECLINED

      desiredPrice: "",

      // callback handling
      callbackBestNumber: "Yes",
      callbackNumber: "",
    });
  }
  return callState.get(callSid);
}

export function deleteState(callSid) {
  callState.delete(callSid);
}

// Optional: good for debugging in dev
export function hasState(callSid) {
  return callState.has(callSid);
}
