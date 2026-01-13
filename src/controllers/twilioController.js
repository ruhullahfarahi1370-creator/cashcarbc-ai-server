// src/controllers/twilioController.js
import twilio from "twilio";

import { YARD_POSTAL, KNOWN_CITIES } from "../config/constants.js";
import { getDrivingDistanceKm } from "../services/distanceMatrix.js";
import { normalizeCity } from "../utils/city.js";
import { writeLeadToSheet } from "../services/googleSheets.js";
import { extractPostalCodeFromSpeech } from "../utils/postal.js";

import { getOrCreateState, deleteState } from "../state/callState.js";
import { pickUserInput, sayAndGather, endCallAndCleanup } from "../twilio/twimlHelpers.js";

import {
  isOldNonDrivableEligible,
  getInitialOffer,
  evaluateCounterOffer,
  parseDesiredPrice,
} from "../../offerRules.js";

// Special early flow: non-drivable + 2001 or older + Toyota/Honda
function isEarlyToyotaHondaOldNonDrive({ drives, year, make }) {
  const y = parseInt(year, 10);
  if (drives !== false) return false;
  if (Number.isNaN(y) || y > 2001) return false;

  const m = String(make || "").toLowerCase();
  return /\btoyota\b/.test(m) || /\bhonda\b/.test(m);
}

// ----- PRICING LOGIC (keep same for now) -----
function calculatePriceRange({ drives, year, location, distanceKm }) {
  let min = drives ? 300 : 120;
  let max = drives ? 700 : 350;

  const y = parseInt(year, 10);
  if (!isNaN(y)) {
    if (y >= 2015) {
      min += 100;
      max += 100;
    } else if (y >= 2008 && y <= 2014) {
      min += 50;
      max += 50;
    }
  }

  if (typeof distanceKm === "number" && !isNaN(distanceKm)) {
    if (distanceKm <= 15) {
      min += 25;
      max += 25;
    } else if (distanceKm <= 40) {
      // no change
    } else if (distanceKm <= 80) {
      min -= 50;
      max -= 50;
    } else {
      min -= 100;
      max -= 150;
    }
  }

  const loc = (location || "").toLowerCase();
  if (/vancouver|richmond|north vancouver|coquitlam|burnaby|new westminster|delta/.test(loc)) {
    min -= 10;
    max -= 10;
  }

  min = Math.max(min, 50);
  max = Math.max(max, min + 50);

  return { min: Math.round(min), max: Math.round(max) };
}

// ----- Controller: /twilio/voice -----
export async function twilioVoice(req, res) {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid || `no-callsid-${Date.now()}`;

  getOrCreateState(callSid, req);

  twiml.say(
    { voice: "Polly-Matthew-Neural", language: "en-CA" },
    "Hi, thanks for calling Cash Car B C. I will ask a few quick questions to estimate your offer."
  );

  sayAndGather({
    twiml,
    prompt: "Does the car drive? Press 1 for yes. Press 2 for no.",
    actionUrl: "/twilio/collect",
    mode: "dtmf",
  });

  res.type("text/xml");
  return res.send(twiml.toString());
}

// ----- Controller: /twilio/collect -----
export async function twilioCollect(req, res) {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid || `no-callsid-${Date.now()}`;
  const state = getOrCreateState(callSid, req);
  const { speech, digits } = pickUserInput(req);

  console.log(`[COLLECT] CallSid=${callSid} step=${state.step} digits=${digits} speech="${speech}"`);

  try {
    // 1) drives
    if (state.step === "drives") {
      if (digits === "1") state.drives = true;
      else if (digits === "2") state.drives = false;
      else {
        sayAndGather({
          twiml,
          prompt: "Press 1 if it drives, press 2 if it does not.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.step = "year";
      sayAndGather({
        twiml,
        prompt: "Enter the car year using 4 digits. For example, 2012.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
        numDigits: 4,
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 2) year
    if (state.step === "year") {
      const y = digits;
      const currentYear = new Date().getFullYear();

      if (!/^\d{4}$/.test(y)) {
        sayAndGather({
          twiml,
          prompt: "Please enter a 4 digit year. For example, 2015.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const yNum = parseInt(y, 10);
      if (isNaN(yNum) || yNum < 1900 || yNum > currentYear) {
        sayAndGather({
          twiml,
          prompt: `That year is not valid. Please enter a year between 1900 and ${currentYear}.`,
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.year = y;
      state.step = "make";
      sayAndGather({
        twiml,
        prompt: "Now say the car make. For example, Toyota, Honda, Ford, or BMW.",
        actionUrl: "/twilio/collect",
        mode: "speech",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 3) make (with early special flow)
    if (state.step === "make") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the make. Please say it again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.make = speech;

      // EARLY SPECIAL FLOW:
      // doesn't drive + 2001 or older + Toyota/Honda
      if (isEarlyToyotaHondaOldNonDrive({ drives: state.drives, year: state.year, make: state.make })) {
        state.ruleApplied = "EarlyToyotaHondaOldNonDrive";
        state.step = "early_ask_price";

        // IMPORTANT: allow DTMF or speech
        sayAndGather({
          twiml,
          prompt:
            "How much would you like to sell it for? You can enter digits like 500, or say the amount.",
          actionUrl: "/twilio/collect",
          mode: "both",
          finishOnKey: "#",
        });

        res.type("text/xml");
        return res.send(twiml.toString());
      }

      // normal flow
      state.step = "model";
      sayAndGather({
        twiml,
        prompt: "Please say the car model. For example, Civic, Corolla, or F one fifty.",
        actionUrl: "/twilio/collect",
        mode: "speech",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 3b) early_ask_price:
    // If below 300 => accept
    // Otherwise => offer 350, then if reject => manager callback flow
    if (state.step === "early_ask_price") {
      // Parse from digits first, else speech (fixes your “dialed 500” issue)
      const rawInput = (digits && digits.trim()) ? digits.trim() : (speech || "").trim();
      const parsed = parseDesiredPrice(rawInput);

      if (!parsed?.ok) {
        sayAndGather({
          twiml,
          prompt:
            "Sorry, I could not read that amount. Please enter digits like 250 or 500.",
          actionUrl: "/twilio/collect",
          mode: "both",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const desired = parsed.value;
      state.desiredPrice = String(desired);

      if (desired < 300) {
        state.autoOfferEligible = true;
        state.autoOfferFinal = String(desired);
        state.autoOfferStatus = "ACCEPTED_BELOW_300";
        state.ruleApplied = "EarlyAcceptedBelow300";

        try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

        twiml.say(
          { voice: "Polly-Matthew-Neural", language: "en-CA" },
          `Okay. We can do $${state.autoOfferFinal}. A human will confirm pickup details shortly. Goodbye.`
        );
        return endCallAndCleanup({ res, twiml, callSid, deleteState });
      }

      state.autoOfferEligible = true;
      state.autoOfferFinal = "350";
      state.autoOfferStatus = "OFFERED_350";
      state.ruleApplied = "EarlyOffer350";
      state.step = "early_offer_350_confirm";

      sayAndGather({
        twiml,
        prompt: "The best we can do is 350 dollars. Press 1 to accept. Press 2 to reject.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 3c) early_offer_350_confirm
    if (state.step === "early_offer_350_confirm") {
      if (digits === "1") {
        state.autoOfferStatus = "ACCEPTED_350";
        state.ruleApplied = "EarlyAccepted350";

        try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

        twiml.say(
          { voice: "Polly-Matthew-Neural", language: "en-CA" },
          "Perfect. We have accepted 350 dollars. A human will confirm pickup details shortly. Goodbye."
        );
        return endCallAndCleanup({ res, twiml, callSid, deleteState });
      }

      if (digits === "2") {
        state.autoOfferStatus = "MANAGER_REVIEW";
        state.ruleApplied = "EarlyRejected350";

        state.step = "callback_best_number";
        sayAndGather({
          twiml,
          prompt:
            "No problem. We'll have a manager review this and call you back soon. Is this the best number to call you back on? Press 1 for yes. Press 2 to enter a different number.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Press 1 to accept, or press 2 to reject.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 4) model
    if (state.step === "model") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the model. Please say it again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.model = speech;

      state.step = "mileage";
      sayAndGather({
        twiml,
        prompt: "Enter the mileage in kilometers, numbers only. For example, enter 150000.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 5) mileage
    if (state.step === "mileage") {
      const km = digits;

      if (!/^\d{1,6}$/.test(km)) {
        sayAndGather({
          twiml,
          prompt: "Please enter mileage using numbers only. Example: 150000.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const kmNum = parseInt(km, 10);
      if (isNaN(kmNum) || kmNum < 0 || kmNum > 800000) {
        sayAndGather({
          twiml,
          prompt: "That mileage seems unusual. Please enter it again. Example: 150000.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.mileageKm = String(kmNum);

      state.step = "asking_price";
      sayAndGather({
        twiml,
        prompt:
          "How much are you trying to sell the car for? Enter the amount in dollars, numbers only. For example, enter 1200.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 6) asking_price
    if (state.step === "asking_price") {
      const ap = digits;

      if (!/^\d{2,7}$/.test(ap)) {
        sayAndGather({
          twiml,
          prompt: "Please enter the amount in dollars using numbers only. Example: 1200.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.askingPrice = ap;

      state.step = "city";
      sayAndGather({
        twiml,
        prompt:
          "Please say your pickup city. For example, Surrey, Vancouver, Abbotsford, or Langley.",
        actionUrl: "/twilio/collect",
        mode: "speech",
        hints: KNOWN_CITIES.join(", "),
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 7) city
    if (state.step === "city") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the city. Please say it again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
          hints: KNOWN_CITIES.join(", "),
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const norm = normalizeCity(speech);
      state.cityRaw = norm.raw;
      state.cityNorm = norm.normalized;
      state.cityScore = norm.score;

      state.step = "city_confirm";
      sayAndGather({
        twiml,
        prompt: `I heard ${state.cityNorm}. Press 1 to confirm. Press 2 to say it again.`,
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "city_confirm") {
      if (digits === "2") {
        state.cityRaw = "";
        state.cityNorm = "";
        state.cityScore = 0;
        state.step = "city";
        sayAndGather({
          twiml,
          prompt: "Okay. Please say your pickup city again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
          hints: KNOWN_CITIES.join(", "),
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      if (digits !== "1") {
        sayAndGather({
          twiml,
          prompt: "Press 1 to confirm the city, or press 2 to say it again.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.step = "postal";
      sayAndGather({
        twiml,
        prompt:
          "To estimate distance, please say your postal code. For example, V six V one M seven.",
        actionUrl: "/twilio/collect",
        mode: "speech",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 8) postal
    if (state.step === "postal") {
      const parsed = extractPostalCodeFromSpeech(speech);

      if (!parsed.ok) {
        sayAndGather({
          twiml,
          prompt:
            "Sorry, I could not understand the postal code. Please say it again, for example, V six V one M seven.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.pickupPostal = parsed.postal;
      state.step = "postal_confirm";
      sayAndGather({
        twiml,
        prompt: `I heard ${state.pickupPostal}. Press 1 to confirm. Press 2 to say it again.`,
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "postal_confirm") {
      if (digits === "2") {
        state.pickupPostal = "";
        state.step = "postal";
        sayAndGather({
          twiml,
          prompt: "Okay. Please say your postal code again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      if (digits !== "1") {
        sayAndGather({
          twiml,
          prompt: "Press 1 to confirm the postal code, or press 2 to say it again.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const dist = await getDrivingDistanceKm(YARD_POSTAL, state.pickupPostal);
      if (dist.ok) {
        state.distanceKm = dist.km;
        state.ruleApplied = state.ruleApplied || "PostalDistanceUsed";
      } else {
        console.error(`[DIST] Failed: ${dist.error}`);
        state.distanceKm = null;
        state.ruleApplied = `DistanceFailed:${dist.error}`;
      }

      state.step = "condition";
      sayAndGather({
        twiml,
        prompt:
          "Briefly describe the condition. For example, accident damage, engine issue, fire damage, or normal wear.",
        actionUrl: "/twilio/collect",
        mode: "speech",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 9) condition -> auto-offer OR normal range
    if (state.step === "condition") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the condition. Please describe it again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.condition = speech;

      state.autoOfferEligible = isOldNonDrivableEligible({
        drives: state.drives,
        year: state.year,
        condition: state.condition,
        make: state.make,
        model: state.model,
        mileageKm: state.mileageKm,
        city: state.cityNorm || state.cityRaw,
        distanceKm: state.distanceKm,
      });

      if (state.autoOfferEligible) {
        const initial = String(getInitialOffer({ year: state.year }) ?? "300");
        state.autoOfferInitial = initial;
        state.autoOfferFinal = "";
        state.autoOfferStatus = "";

        state.step = "auto_offer_present";
        sayAndGather({
          twiml,
          prompt: `Based on the details, we can offer $${initial}. Press 1 to accept. Press 2 to make a counter offer.`,
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const { min, max } = calculatePriceRange({
        drives: Boolean(state.drives),
        year: state.year,
        location: state.cityNorm || state.cityRaw,
        distanceKm: state.distanceKm,
      });

      state.priceText = `$${min} to $${max}`;

      try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

      const distPhrase =
        typeof state.distanceKm === "number" ? ` about ${state.distanceKm} kilometers away` : "";

      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        `Thanks. For your ${state.year} ${state.make} ${state.model} in ${state.cityNorm || state.cityRaw}${distPhrase}, our rough estimate is ${state.priceText}.`
      );

      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        "A human will confirm the final offer shortly. Goodbye."
      );

      return endCallAndCleanup({ res, twiml, callSid, deleteState });
    }

    // 10) auto_offer_present
    if (state.step === "auto_offer_present") {
      if (digits === "1") {
        state.autoOfferFinal = state.autoOfferInitial;
        state.autoOfferStatus = "ACCEPTED_300";
        state.ruleApplied = "AutoOfferAccepted";

        try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

        twiml.say(
          { voice: "Polly-Matthew-Neural", language: "en-CA" },
          `Perfect. We have accepted $${state.autoOfferFinal}. A human will confirm pickup details shortly. Goodbye.`
        );
        return endCallAndCleanup({ res, twiml, callSid, deleteState });
      }

      if (digits === "2") {
        state.step = "auto_offer_counter";
        sayAndGather({
          twiml,
          prompt:
            "Okay. What price would you accept? Enter the amount in dollars, numbers only. For example, 350.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Press 1 to accept the offer, or press 2 to make a counter offer.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 11) auto_offer_counter
    if (state.step === "auto_offer_counter") {
      const parsed = parseDesiredPrice(digits);

      if (!parsed?.ok) {
        sayAndGather({
          twiml,
          prompt:
            "Sorry, I could not read that amount. Please enter the amount in dollars. For example, 350.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const desiredValue = parsed.value;
      state.desiredPrice = String(desiredValue);

      const decision = evaluateCounterOffer({
        make: state.make,
        desiredPrice: desiredValue,
      });

      if (!decision?.ok) {
        sayAndGather({
          twiml,
          prompt:
            "Sorry, I could not process that offer. Please enter your price again, for example 350.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const proposedFinal = Number(decision.finalOffer);

      if (decision.decision === "CAP_AT_MAX") {
        state.autoOfferFinal = String(proposedFinal);
        state.autoOfferStatus = "COUNTERED_AT_MAX";
        state.ruleApplied = "AutoOfferCappedToMax";

        state.step = "auto_offer_cap_confirm";
        sayAndGather({
          twiml,
          prompt: `The best we can do is $${state.autoOfferFinal}. Press 1 to accept. Press 2 to reject.`,
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.autoOfferFinal = String(proposedFinal);
      state.autoOfferStatus = "ACCEPTED_COUNTER";
      state.ruleApplied = "AutoOfferCounterAccepted";

      try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        `Okay. We can do $${state.autoOfferFinal}. A human will confirm pickup details shortly. Goodbye.`
      );
      return endCallAndCleanup({ res, twiml, callSid, deleteState });
    }

    // 11b) auto_offer_cap_confirm
    if (state.step === "auto_offer_cap_confirm") {
      if (digits === "1") {
        state.autoOfferStatus = "ACCEPTED_MAX";
        state.ruleApplied = "AutoOfferMaxAccepted";

        try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

        twiml.say(
          { voice: "Polly-Matthew-Neural", language: "en-CA" },
          `Perfect. We have accepted $${state.autoOfferFinal}. A human will confirm pickup details shortly. Goodbye.`
        );
        return endCallAndCleanup({ res, twiml, callSid, deleteState });
      }

      if (digits === "2") {
        state.autoOfferStatus = "MANAGER_REVIEW";
        state.ruleApplied = "AutoOfferRejectedFinal";

        state.step = "callback_best_number";
        sayAndGather({
          twiml,
          prompt:
            "No problem. We'll have a manager review this and call you back soon. Is this the best number to call you back on? Press 1 for yes. Press 2 to enter a different number.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Press 1 to accept, or press 2 to reject.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 12) callback_best_number
    if (state.step === "callback_best_number") {
      if (digits === "1") {
        state.callbackBestNumber = "Yes";
        state.callbackNumber = "";

        try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

        twiml.say(
          { voice: "Polly-Matthew-Neural", language: "en-CA" },
          "Great. We'll call you back shortly. Goodbye."
        );
        return endCallAndCleanup({ res, twiml, callSid, deleteState });
      }

      if (digits === "2") {
        state.callbackBestNumber = "No";
        state.step = "callback_number";
        sayAndGather({
          twiml,
          prompt: "Please enter the best callback number now, including area code. Numbers only.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Press 1 for yes, or press 2 to enter a different callback number.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 13) callback_number
    if (state.step === "callback_number") {
      const n = String(digits || "").replace(/\D/g, "");
      if (n.length < 10 || n.length > 15) {
        sayAndGather({
          twiml,
          prompt: "That number seems invalid. Please enter the callback number again, numbers only.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.callbackNumber = n;

      try { await writeLeadToSheet(state); } catch (err) { console.error("Sheet append failed:", err); }

      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        "Thanks. We'll call you back shortly. Goodbye."
      );
      return endCallAndCleanup({ res, twiml, callSid, deleteState });
    }

    // Fallback
    twiml.say(
      { voice: "Polly-Matthew-Neural", language: "en-CA" },
      "Sorry, something went wrong. Please call again."
    );
    return endCallAndCleanup({ res, twiml, callSid, deleteState });
  } catch (err) {
    console.error("Error in /twilio/collect:", err);
    twiml.say(
      { voice: "Polly-Matthew-Neural", language: "en-CA" },
      "Sorry, we had a system error. Please call again later."
    );
    return endCallAndCleanup({ res, twiml, callSid, deleteState });
  }
}
