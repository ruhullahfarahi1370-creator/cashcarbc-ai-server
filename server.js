import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

// ----- CONFIG -----
const PORT = process.env.PORT || 3000;

// Optional: set in Render env vars like +17788898748
const HUMAN_TRANSFER_NUMBER = process.env.HUMAN_TRANSFER_NUMBER || "";

// Google Sheets
const sheets = google.sheets("v4");

function getGoogleAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT env var is missing");
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  // Fix escaped newlines in Render env var
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

// ----- PRICING LOGIC V1 -----
function calculatePriceRange({ drives, year, location, condition }) {
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

  const loc = (location || "").toLowerCase();
  if (/vancouver|richmond|north vancouver|coquitlam/.test(loc)) {
    min -= 30;
    max -= 30;
  } else if (/langley|abbotsford|chilliwack|maple ridge/.test(loc)) {
    min -= 50;
    max -= 50;
  }

  const cond = (condition || "").toLowerCase();
  if (/fire|flood|frame|major accident|heavy damage/.test(cond)) {
    min -= 50;
    max -= 150;
  }

  min = Math.max(min, 50);
  max = Math.max(max, min + 50);

  return { min: Math.round(min), max: Math.round(max) };
}

// ----- TEXT HELPERS -----
function cleanText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function similarityScore(a, b) {
  const aa = cleanText(a);
  const bb = cleanText(b);
  const maxLen = Math.max(aa.length, bb.length);
  if (maxLen === 0) return 0;
  const dist = levenshtein(aa, bb);
  return 1 - dist / maxLen; // 0..1
}

// ----- LOCATION NORMALIZATION (Step 1.5) -----
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
  abbot: "Abbotsford",
  abbots: "Abbotsford",
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

  let bestCity = "";
  let bestScore = 0;

  for (const city of KNOWN_CITIES) {
    const s = similarityScore(cleaned, city);
    if (s > bestScore) {
      bestScore = s;
      bestCity = city;
    }
  }

  const normalized = bestScore >= 0.62 ? bestCity : raw || bestCity;
  return { raw, normalized, score: Number(bestScore.toFixed(3)), method: "fuzzy" };
}

// ----- MAKE NORMALIZATION (Step 1.6) -----
const KNOWN_MAKES = [
  "Toyota",
  "Honda",
  "Hyundai",
  "Kia",
  "Nissan",
  "Mazda",
  "Subaru",
  "Ford",
  "Chevrolet",
  "GMC",
  "Dodge",
  "Jeep",
  "Chrysler",
  "Volkswagen",
  "Audi",
  "BMW",
  "Mercedes-Benz",
  "Lexus",
  "Acura",
  "Infiniti",
  "Mitsubishi",
  "Volvo",
  "Tesla",
  "Mini",
  "Buick",
  "Cadillac",
  "Lincoln",
  "Porsche",
];

const MAKE_ALIASES = {
  chev: "Chevrolet",
  chevy: "Chevrolet",
  volkswagon: "Volkswagen",
  merc: "Mercedes-Benz",
  mercedes: "Mercedes-Benz",
  b m w: "BMW",
  beemer: "BMW",
  hundai: "Hyundai",
  toyoda: "Toyota",
};

function normalizeMake(spoken) {
  const raw = String(spoken || "").trim();
  const cleaned = cleanText(raw);

  if (cleaned && MAKE_ALIASES[cleaned]) {
    return { raw, normalized: MAKE_ALIASES[cleaned], score: 1.0, method: "alias" };
  }

  let bestMake = "";
  let bestScore = 0;

  for (const make of KNOWN_MAKES) {
    const s = similarityScore(cleaned, make);
    if (s > bestScore) {
      bestScore = s;
      bestMake = make;
    }
  }

  const normalized = bestScore >= 0.62 ? bestMake : raw || bestMake;
  return { raw, normalized, score: Number(bestScore.toFixed(3)), method: "fuzzy" };
}

// ----- MODEL CLEANUP (Step 1.6) -----
const MODEL_ALIASES = {
  "f one fifty": "F-150",
  "f one 50": "F-150",
  "f150": "F-150",
  "f 150": "F-150",
  "rav four": "RAV4",
  "rav4": "RAV4",
  "cr v": "CR-V",
  "crv": "CR-V",
  "c class": "C-Class",
  "e class": "E-Class",
};

function normalizeModel(spoken) {
  const raw = String(spoken || "").trim();
  const cleaned = cleanText(raw);

  // Alias mapping for a few common ones
  if (cleaned && MODEL_ALIASES[cleaned]) {
    return { raw, normalized: MODEL_ALIASES[cleaned], method: "alias" };
  }

  // Light cleanup: title-ish formatting (keep it simple)
  // If caller said "civic", "corolla", etc. we store as-is but trimmed.
  const normalized = raw.replace(/\s+/g, " ").trim();
  return { raw, normalized, method: "clean" };
}

// ----- EXPRESS APP -----
const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-urlencoded
app.use(bodyParser.json());

// Simple request logger
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => {
  res.status(200).send("CashCarBC AI backend is running.\n");
});

// ----- CALL STATE (IN MEMORY) -----
const callState = new Map();
/*
state.step:
  drives -> year -> make -> make_confirm -> model -> model_confirm
  -> mileage -> mileage_confirm -> location -> location_confirm -> condition -> done
*/
function getOrCreateState(callSid, req) {
  if (!callState.has(callSid)) {
    callState.set(callSid, {
      step: "drives",
      from: req.body.From || "",
      to: req.body.To || "",
      timestamp: new Date().toISOString(),

      drives: null,
      year: "",

      makeRaw: "",
      makeNorm: "",
      makeScore: 0,

      modelRaw: "",
      modelNorm: "",

      mileageKm: "",

      locationRaw: "",
      locationNorm: "",
      locationScore: 0,

      condition: "",
      humanRequested: "No",
    });
  }
  return callState.get(callSid);
}

function pickUserInput(req) {
  const speech = (req.body.SpeechResult || "").trim();
  const digits = (req.body.Digits || "").trim();
  return { speech, digits };
}

function sayAndGather({ twiml, prompt, actionUrl, mode, hints }) {
  const input =
    mode === "dtmf" ? "dtmf" : mode === "speech" ? "speech" : "dtmf speech";

  const gather = twiml.gather({
    input,
    action: actionUrl,
    method: "POST",
    timeout: 6,
    speechTimeout: "auto",
    language: "en-CA",
    hints: hints || "",
  });

  gather.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, prompt);

  twiml.say(
    { voice: "Polly-Matthew-Neural", language: "en-CA" },
    "Sorry, I did not get that."
  );
  twiml.redirect({ method: "POST" }, actionUrl);
}

function handleHumanTransfer(twiml, state) {
  state.humanRequested = "Yes";

  if (HUMAN_TRANSFER_NUMBER) {
    twiml.say(
      { voice: "Polly-Matthew-Neural", language: "en-CA" },
      "Okay. Please hold while I connect you."
    );
    twiml.dial({}, HUMAN_TRANSFER_NUMBER);
  } else {
    twiml.say(
      { voice: "Polly-Matthew-Neural", language: "en-CA" },
      "Okay. A human will call you back shortly."
    );
    twiml.hangup();
  }
}

// ----- TWILIO VOICE: START -----
app.post("/twilio/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid || `no-callsid-${Date.now()}`;
  const state = getOrCreateState(callSid, req);

  console.log(`[CALL START] CallSid=${callSid} From=${state.from} To=${state.to}`);

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

// ----- TWILIO VOICE: COLLECT STEPS -----
app.post("/twilio/collect", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid || `no-callsid-${Date.now()}`;
  const state = getOrCreateState(callSid, req);

  const { speech, digits } = pickUserInput(req);
  console.log(`[COLLECT] CallSid=${callSid} step=${state.step} digits=${digits} speech="${speech}"`);

  try {
    // Universal: allow 0 for human on DTMF steps
    const dtmfSteps = new Set([
      "drives",
      "year",
      "make_confirm",
      "model_confirm",
      "mileage",
      "mileage_confirm",
      "location_confirm",
    ]);
    if (dtmfSteps.has(state.step) && digits === "0") {
      console.log(`[HUMAN] Requested transfer. CallSid=${callSid}`);
      handleHumanTransfer(twiml, state);
      // Note: if we dial out, Twilio continues; still return TwiML
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "drives") {
      if (digits === "1") state.drives = true;
      else if (digits === "2") state.drives = false;
      else {
        sayAndGather({
          twiml,
          prompt: "Please press 1 if the car drives, or press 2 if it does not. Press 0 to speak to a human.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.step = "year";
      sayAndGather({
        twiml,
        prompt: "Enter the car year using 4 digits. For example, 2012. Press 0 to speak to a human.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "year") {
      const y = digits;
      if (!/^\d{4}$/.test(y)) {
        sayAndGather({
          twiml,
          prompt: "Please enter a 4 digit year. For example, 2015. Press 0 to speak to a human.",
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
        hints: KNOWN_MAKES.join(", "),
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "make") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the make. Please say the car make again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
          hints: KNOWN_MAKES.join(", "),
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const nm = normalizeMake(speech);
      state.makeRaw = nm.raw;
      state.makeNorm = nm.normalized;
      state.makeScore = nm.score;

      console.log(`[MAKE] raw="${state.makeRaw}" normalized="${state.makeNorm}" score=${state.makeScore}`);

      state.step = "make_confirm";
      sayAndGather({
        twiml,
        prompt: `I heard ${state.makeNorm}. Press 1 to confirm. Press 2 to say it again. Or press 0 to speak to a human.`,
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "make_confirm") {
      if (digits === "1") {
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

      if (digits === "2") {
        state.makeRaw = "";
        state.makeNorm = "";
        state.makeScore = 0;
        state.step = "make";
        sayAndGather({
          twiml,
          prompt: "Okay. Please say the car make again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
          hints: KNOWN_MAKES.join(", "),
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Please press 1 to confirm the make, or press 2 to say it again. Press 0 to speak to a human.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "model") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the model. Please say the car model again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const nm = normalizeModel(speech);
      state.modelRaw = nm.raw;
      state.modelNorm = nm.normalized;

      console.log(`[MODEL] raw="${state.modelRaw}" normalized="${state.modelNorm}"`);

      state.step = "model_confirm";
      sayAndGather({
        twiml,
        prompt: `I heard ${state.modelNorm}. Press 1 to confirm. Press 2 to say it again. Or press 0 to speak to a human.`,
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "model_confirm") {
      if (digits === "1") {
        state.step = "mileage";
        sayAndGather({
          twiml,
          prompt:
            "Enter the mileage in kilometers, numbers only. For example, enter 150000. Press 0 to speak to a human.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      if (digits === "2") {
        state.modelRaw = "";
        state.modelNorm = "";
        state.step = "model";
        sayAndGather({
          twiml,
          prompt: "Okay. Please say the car model again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Please press 1 to confirm the model, or press 2 to say it again. Press 0 to speak to a human.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "mileage") {
      const km = digits;
      // Basic validation: digits only, reasonable range
      if (!/^\d{1,6}$/.test(km)) {
        sayAndGather({
          twiml,
          prompt:
            "Please enter mileage in kilometers using numbers only. Example: 150000. Press 0 to speak to a human.",
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
          prompt:
            "That mileage seems unusual. Please enter mileage in kilometers again. Example: 150000. Press 0 to speak to a human.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.mileageKm = String(kmNum);
      state.step = "mileage_confirm";

      sayAndGather({
        twiml,
        prompt: `You entered ${state.mileageKm} kilometers. Press 1 to confirm. Press 2 to re-enter. Or press 0 to speak to a human.`,
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "mileage_confirm") {
      if (digits === "1") {
        state.step = "location";
        sayAndGather({
          twiml,
          prompt: "Please say your pickup city. For example, Surrey, Vancouver, Abbotsford, or Langley.",
          actionUrl: "/twilio/collect",
          mode: "speech",
          hints: KNOWN_CITIES.join(", "),
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      if (digits === "2") {
        state.mileageKm = "";
        state.step = "mileage";
        sayAndGather({
          twiml,
          prompt:
            "Okay. Enter the mileage in kilometers, numbers only. Example: 150000. Press 0 to speak to a human.",
          actionUrl: "/twilio/collect",
          mode: "dtmf",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Please press 1 to confirm mileage, or press 2 to re-enter. Press 0 to speak to a human.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // Location + confirmation (Step 1.5)
    if (state.step === "location") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the city. Please say the pickup city again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
          hints: KNOWN_CITIES.join(", "),
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const norm = normalizeCity(speech);
      state.locationRaw = norm.raw;
      state.locationNorm = norm.normalized;
      state.locationScore = norm.score;

      console.log(`[LOCATION] raw="${state.locationRaw}" normalized="${state.locationNorm}" score=${state.locationScore}`);

      state.step = "location_confirm";
      sayAndGather({
        twiml,
        prompt: `I heard ${state.locationNorm}. Press 1 to confirm. Press 2 to say it again. Or press 0 to speak to a human.`,
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "location_confirm") {
      if (digits === "1") {
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

      if (digits === "2") {
        state.locationRaw = "";
        state.locationNorm = "";
        state.locationScore = 0;
        state.step = "location";
        sayAndGather({
          twiml,
          prompt:
            "Okay. Please say the pickup city again. For example, Surrey, Vancouver, Abbotsford, or Langley.",
          actionUrl: "/twilio/collect",
          mode: "speech",
          hints: KNOWN_CITIES.join(", "),
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      sayAndGather({
        twiml,
        prompt: "Please press 1 to confirm the city, or press 2 to say it again. Press 0 to speak to a human.",
        actionUrl: "/twilio/collect",
        mode: "dtmf",
      });
      res.type("text/xml");
      return res.send(twiml.toString());
    }

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
      state.step = "done";

      const locationForPricing = state.locationNorm || state.locationRaw;
      const { min, max } = calculatePriceRange({
        drives: Boolean(state.drives),
        year: state.year,
        location: locationForPricing,
        condition: state.condition,
      });

      const priceText = `$${min} to $${max}`;

      // Append to Google Sheet
      try {
        const auth = getGoogleAuth();
        await auth.authorize();

        await sheets.spreadsheets.values.append({
          auth,
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: "Sheet1!A:Z",
          valueInputOption: "RAW",
          requestBody: {
            values: [
              [
                state.timestamp,                       // Timestamp
                "",                                    // Caller Name
                state.from,                            // Phone Number
                state.year,                            // Year
                state.makeNorm || "",                  // Make (Normalized)
                state.modelNorm || "",                 // Model (Normalized/Clean)
                state.drives ? "Yes" : "No",            // Drives
                state.mileageKm || "",                 // Mileage (km)
                priceText,                             // Price estimate
                state.locationNorm || "",               // Location (Normalized)
                state.condition || "",                 // Condition
                state.makeRaw || "",                    // Make (Raw)
                `MakeScore=${state.makeScore}`,         // Make score
                state.modelRaw || "",                   // Model (Raw)
                state.locationRaw || "",                // Location (Raw)
                `CityScore=${state.locationScore}`,     // City score
                `HumanRequested=${state.humanRequested}`, // Human flag
                `CallSid=${callSid} To=${state.to}`,    // Notes
              ],
            ],
          },
        });

        console.log(`[DONE] ✅ Sheet updated. CallSid=${callSid} price=${priceText}`);
      } catch (sheetErr) {
        console.error(`[DONE] ❌ Sheet append failed CallSid=${callSid}`, sheetErr);
      }

      // Speak result
      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        `Thanks. Based on your ${state.year} ${state.makeNorm} ${state.modelNorm} in ${locationForPricing}, our rough estimate is ${priceText}.`
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
    console.error(`[ERROR] CallSid=${callSid}`, err);
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

// ----- START SERVER -----
app.listen(PORT, () => {
  console.log(`CashCarBC server listening on port ${PORT}`);
});
