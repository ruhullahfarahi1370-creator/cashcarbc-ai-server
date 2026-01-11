import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";
import {
  isOldNonDrivableEligible,
  getInitialOffer,
  evaluateCounterOffer,
  needsManagerReview,
  parseDesiredPrice,
} from "./offerRules.js";


const PORT = process.env.PORT || 3000;

// Yard postal code (your base)
const YARD_POSTAL = "V6V 1M7";

// Google Maps key for Distance Matrix
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Google Sheets
const sheets = google.sheets("v4");

// ----- Google Auth -----
function getGoogleAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT env var is missing");
  }
  if (!process.env.GOOGLE_SHEET_ID) {
    throw new Error("GOOGLE_SHEET_ID env var is missing");
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  // Fix escaped newlines in env vars (common on Render)
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  return new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

// ----- Deterministic sheet write (always next row based on Column A) -----
async function appendRowDeterministic(auth, rowValues) {
  const colA = await sheets.spreadsheets.values.get({
    auth,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A:A",
  });

  const values = colA.data.values || [];
  const nextRow = values.length + 1; // A1 is header

  await sheets.spreadsheets.values.update({
    auth,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!A${nextRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] },
  });
}

// ----- PRICING LOGIC (basic placeholder tiers) -----
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

  // Distance impact (simple tiers)
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

  // Light location adjustment
  const loc = (location || "").toLowerCase();
  if (/vancouver|richmond|north vancouver|coquitlam|burnaby|new westminster|delta/.test(loc)) {
    min -= 10;
    max -= 10;
  }

  min = Math.max(min, 50);
  max = Math.max(max, min + 50);

  return { min: Math.round(min), max: Math.round(max) };
}

// ----- Helpers -----
function cleanText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarityScore(a, b) {
  const aa = cleanText(a);
  const bb = cleanText(b);
  const maxLen = Math.max(aa.length, bb.length);
  if (maxLen === 0) return 0;
  return 1 - levenshtein(aa, bb) / maxLen;
}

// ----- City normalization -----
const KNOWN_CITIES = [
  "Vancouver",
  "Burnaby",
  "Richmond",
  "Surrey",
  "Langley",
  "Coquitlam",
  "Port Coquitlam",
  "Port Moody",
  "Maple Ridge",
  "Pitt Meadows",
  "Abbotsford",
  "Chilliwack",
  "Mission",
  "Delta",
  "North Vancouver",
  "West Vancouver",
  "New Westminster",
];

const CITY_ALIASES = {
  hobbits: "Abbotsford",
  hobits: "Abbotsford",
  abotsford: "Abbotsford",
  vancover: "Vancouver",
  surree: "Surrey",
};

function normalizeCity(spoken) {
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

// ----- Postal code extraction (speech) -----
function extractPostalCodeFromSpeech(speech) {
  const raw = String(speech || "").toUpperCase();
  const cleaned = raw.replace(/[^A-Z0-9]/g, "");
  const match = cleaned.match(/([A-Z]\d[A-Z]\d[A-Z]\d)/); // A1A1A1
  if (!match) return { ok: false, raw, postal: "" };

  const p = match[1];
  return { ok: true, raw, postal: `${p.slice(0, 3)} ${p.slice(3)}` };
}

// ----- Google Distance Matrix -----
async function getDrivingDistanceKm(originPostal, destPostal) {
  if (!GOOGLE_MAPS_API_KEY) return { ok: false, km: null, error: "Missing GOOGLE_MAPS_API_KEY" };

  const origin = encodeURIComponent(`${originPostal}, BC, Canada`);
  const dest = encodeURIComponent(`${destPostal}, BC, Canada`);

  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origin}&destinations=${dest}&mode=driving&units=metric&key=${encodeURIComponent(
      GOOGLE_MAPS_API_KEY
    )}`;

  const resp = await fetch(url);
  const data = await resp.json();

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK") {
    return { ok: false, km: null, error: `DistanceMatrix status=${element?.status || "unknown"}` };
  }

  const meters = element.distance?.value;
  if (typeof meters !== "number") return { ok: false, km: null, error: "No distance value" };

  return { ok: true, km: Math.round((meters / 1000) * 10) / 10, error: "" };
}

// ----- Twilio helpers -----
function pickUserInput(req) {
  return {
    speech: (req.body.SpeechResult || "").trim(),
    digits: (req.body.Digits || "").trim(),
  };
}

function sayAndGather({ twiml, prompt, actionUrl, mode, hints }) {
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

  // If gather returns nothing, Twilio continues — redirect to same step
  twiml.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, "Sorry, I did not get that.");
  twiml.redirect({ method: "POST" }, actionUrl);
}

// ----- EXPRESS APP -----
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => res.status(200).send("CashCarBC backend is running.\n"));

// ----- Call state -----
const callState = new Map();

function getOrCreateState(callSid, req) {
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

      // pricing / rules
      ruleApplied: "N/A",

      // ===== AUTO-OFFER FLOW (old non-drivable cars) =====
      autoOfferEligible: false,   // Yes / No
      autoOfferInitial: "",       // "300"
      autoOfferFinal: "",         // "300" or "350" or counter
      autoOfferStatus: "",        // ACCEPTED_300 / ACCEPTED_COUNTER / ACCEPTED_MAX / MANAGER_REVIEW

      desiredPrice: "",           // caller’s counter after rejecting $300

      // callback handling (if final rejected)
      callbackBestNumber: "Yes",  // Yes / No
      callbackNumber: "",         // if No, store entered number
    });
  }
  return callState.get(callSid);
}


// ----- START CALL -----
app.post("/twilio/voice", async (req, res) => {
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
});

// ----- COLLECT FLOW -----
app.post("/twilio/collect", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid || `no-callsid-${Date.now()}`;
  const state = getOrCreateState(callSid, req);
  const { speech, digits } = pickUserInput(req);

  console.log(
    `[COLLECT] CallSid=${callSid} step=${state.step} digits=${digits} speech="${speech}"`
  );

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
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 2) year with validation
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

    // 3) make
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

    // 6) asking price
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

    // 7) city normalize + confirm
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

      // You requested: ALWAYS ask postal code
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

    // 8) postal code speech + confirm
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
        state.ruleApplied = "PostalDistanceUsed";
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

    // 9) condition + finalize
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

      const condition = speech;

      const { min, max } = calculatePriceRange({
        drives: Boolean(state.drives),
        year: state.year,
        location: state.cityNorm || state.cityRaw,
        distanceKm: state.distanceKm,
      });

      const priceText = `$${min} to $${max}`;

      // Write to Google Sheet (deterministic next row)
      try {
        const auth = getGoogleAuth();
        await auth.authorize();

        const notes = `CallSid=${state.callSid} | To=${state.to} | Condition=${condition}`;

        await appendRowDeterministic(auth, [
          state.timestamp, // Timestamp
          "", // Caller Name
          state.from, // Phone Number
          state.year, // Car Year
          state.make, // Car Make
          state.model, // Car Model
          state.drives ? "Yes" : "No", // Drives?
          state.mileageKm, // Mileage
          priceText, // AI price Given
          state.cityNorm || state.cityRaw, // Location (city normalized)
          notes, // Notes
          state.askingPrice, // AskingPrice
          state.distanceKm ?? "", // Distance to Yard (KM)
          state.pickupPostal || "", // PickupPostal
          state.cityRaw || "", // CityRaw
          state.cityScore || "", // CityScore
          state.ruleApplied || "", // RuleApplied
        ]);
      } catch (err) {
        console.error("Sheet append failed:", err);
      }

      // Voice response
      const distPhrase =
        typeof state.distanceKm === "number" ? ` about ${state.distanceKm} kilometers away` : "";

      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        `Thanks. For your ${state.year} ${state.make} ${state.model} in ${
          state.cityNorm || state.cityRaw
        }${distPhrase}, our rough estimate is ${priceText}.`
      );

      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        "A human will confirm the final offer shortly. Goodbye."
      );

      twiml.hangup();

      callState.delete(callSid);
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // Fallback
    twiml.say(
      { voice: "Polly-Matthew-Neural", language: "en-CA" },
      "Sorry, something went wrong. Please call again."
    );
    twiml.hangup();
    callState.delete(callSid);
    res.type("text/xml");
    return res.send(twiml.toString());
  } catch (err) {
    console.error("Error in /twilio/collect:", err);
    twiml.say(
      { voice: "Polly-Matthew-Neural", language: "en-CA" },
      "Sorry, we had a system error. Please call again later."
    );
    twiml.hangup();
    callState.delete(callSid);
    res.type("text/xml");
    return res.send(twiml.toString());
  }
});

app.listen(PORT, () => console.log(`CashCarBC server listening on port ${PORT}`));
