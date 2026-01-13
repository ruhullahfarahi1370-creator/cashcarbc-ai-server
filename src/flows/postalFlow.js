// src/flows/postalFlow.js
import { extractPostalCodeFromSpeech } from "../utils/postal.js";

/**
 * Postal flow module (DTMF confirm) that matches twilioController.js.
 *
 * Steps handled:
 *  - "postal"         (speech)  -> parse postal -> prompt DTMF confirm
 *  - "postal_confirm" (dtmf)    -> 1 confirm, 2 retry
 *
 * It does NOT call distance APIs. On confirm, it returns { confirmed: true }
 * so the controller can continue with distance + condition.
 *
 * Expected inputs (passed from controller):
 *  - state
 *  - speech
 *  - digits
 *  - twiml (VoiceResponse instance created in controller)
 *  - sayAndGather (helper)
 */
export function handlePostalFlow({ state, speech, digits, twiml, sayAndGather }) {
  // --- Step: postal (speech) ---
  if (state.step === "postal") {
    const parsed = extractPostalCodeFromSpeech(speech);

    // If we can't parse, retry (you can add retry counters later if you want)
    if (!parsed?.ok) {
      sayAndGather({
        twiml,
        prompt:
          "Sorry, I could not understand the postal code. Please say it again, for example, V six V one M seven.",
        actionUrl: "/twilio/collect",
        mode: "speech",
        timeoutSec: 12,
      });
      return { handled: true };
    }

    // Save (full postal if available; otherwise you could store FSA only)
    if (parsed.postal) state.pickupPostal = parsed.postal;
    if (parsed.fsa) state.postalFSA = parsed.fsa;

    state.step = "postal_confirm";

    // Confirm via DTMF (same behavior as your old controller)
    sayAndGather({
      twiml,
      prompt: `I heard ${state.pickupPostal || state.postalFSA}. Press 1 to confirm. Press 2 to say it again.`,
      actionUrl: "/twilio/collect",
      mode: "dtmf",
      timeoutSec: 12,
    });

    return { handled: true };
  }

  // --- Step: postal_confirm (DTMF) ---
  if (state.step === "postal_confirm") {
    if (digits === "2") {
      // retry
      state.pickupPostal = "";
      state.postalFSA = "";
      state.step = "postal";

      sayAndGather({
        twiml,
        prompt: "Okay. Please say your postal code again.",
        actionUrl: "/twilio/collect",
        mode: "speech",
        timeoutSec: 12,
      });

      return { handled: true };
    }

    if (digits !== "1") {
      // invalid input, ask again
      sayAndGather({
        twiml,
        prompt: "Press 1 to confirm the postal code, or press 2 to say it again.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
        timeoutSec: 12,
      });

      return { handled: true };
    }

    // Confirmed
    return { confirmed: true };
  }

  // Not handled by this module
  return { handled: false };
}
