import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

// ----- CONFIG -----
const PORT = process.env.PORT || 3000;

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

// ----- EXPRESS APP -----
const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends x-www-form-urlencoded
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
// NOTE: This resets if Render restarts or you redeploy.
// Good enough for Step 1 testing.
const callState = new Map();
/*
state = {
  step: "drives" | "year" | "make" | "model" | "location" | "condition" | "done",
  from: "",
  to: "",
  timestamp: "",
  drives: true/false,
  year: "",
  make: "",
  model: "",
  location: "",
  condition: ""
}
*/

// Helpers
function getOrCreateState(callSid, req) {
  if (!callState.has(callSid)) {
    callState.set(callSid, {
      step: "drives",
      from: req.body.From || "",
      to: req.body.To || "",
      timestamp: new Date().toISOString(),
      drives: null,
      year: "",
      make: "",
      model: "",
      location: "",
      condition: "",
    });
  }
  return callState.get(callSid);
}

function pickUserInput(req) {
  // If speech was used, Twilio provides SpeechResult
  const speech = (req.body.SpeechResult || "").trim();
  // If keypad was used, Twilio provides Digits
  const digits = (req.body.Digits || "").trim();

  return { speech, digits };
}

function sayAndGather({ twiml, prompt, actionUrl, mode }) {
  // mode: "dtmf" or "speech" or "both"
  const input =
    mode === "dtmf" ? "dtmf" : mode === "speech" ? "speech" : "dtmf speech";

  const gather = twiml.gather({
    input,
    action: actionUrl,
    method: "POST",
    timeout: 6,
    speechTimeout: "auto",
    language: "en-CA",
    hints: "Vancouver, Surrey, Richmond, Langley, Abbotsford, Coquitlam, Burnaby",
  });

  gather.say({ voice: "Polly-Matthew-Neural", language: "en-CA" }, prompt);

  // If no input, Twilio continues here:
  twiml.say(
    { voice: "Polly-Matthew-Neural", language: "en-CA" },
    "Sorry, I did not get that."
  );
  // redirect back to collect to repeat the same step
  twiml.redirect({ method: "POST" }, actionUrl);
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

  // Ask first question
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
    // Step handler
    if (state.step === "drives") {
      if (digits === "1") state.drives = true;
      else if (digits === "2") state.drives = false;
      else {
        sayAndGather({
          twiml,
          prompt: "Please press 1 if the car drives, or press 2 if it does not.",
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

    if (state.step === "year") {
      const y = digits;
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

      state.year = y;
      state.step = "make";

      sayAndGather({
        twiml,
        prompt: "Now say the car make. For example, Toyota, Honda, or Ford.",
        actionUrl: "/twilio/collect",
        mode: "speech",
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

    if (state.step === "model") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the model. Please say the model again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.model = speech;
      state.step = "location";

      sayAndGather({
        twiml,
        prompt: "Please say your pickup city. For example, Surrey, Vancouver, or Langley.",
        actionUrl: "/twilio/collect",
        mode: "speech",
      });

      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (state.step === "location") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt: "Sorry, I did not catch the city. Please say the pickup city again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.location = speech;
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

    if (state.step === "condition") {
      if (!speech) {
        sayAndGather({
          twiml,
          prompt:
            "Sorry, I did not catch the condition. Please briefly describe the condition again.",
          actionUrl: "/twilio/collect",
          mode: "speech",
        });
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      state.condition = speech;
      state.step = "done";

      // ---- Calculate price ----
      const { min, max } = calculatePriceRange({
        drives: Boolean(state.drives),
        year: state.year,
        location: state.location,
        condition: state.condition,
      });

      const priceText = `$${min} to $${max}`;

      // ---- Append to Google Sheet ----
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
                state.timestamp,          // Timestamp
                "",                       // Caller Name
                state.from,               // Phone Number (caller)
                state.year,               // Year
                state.make,               // Make
                state.model,              // Model
                state.drives ? "Yes" : "No", // Drives
                priceText,                // AI Price Given
                state.location,           // Location
                state.condition,          // Condition / Notes
                `CallSid=${callSid} To=${state.to}`, // Extra notes
              ],
            ],
          },
        });

        console.log(`[DONE] ✅ Sheet updated. CallSid=${callSid} price=${priceText}`);
      } catch (sheetErr) {
        console.error(`[DONE] ❌ Sheet append failed CallSid=${callSid}`, sheetErr);
      }

      // ---- Speak result to caller ----
      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        `Thanks. Based on your ${state.year} ${state.make} ${state.model} in ${state.location}, our rough estimate is ${priceText}.`
      );
      twiml.say(
        { voice: "Polly-Matthew-Neural", language: "en-CA" },
        "A human will confirm the final offer shortly. Goodbye."
      );
      twiml.hangup();

      // Cleanup memory
      callState.delete(callSid);

      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // Fallback if state is weird
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

// ----- KEEP YOUR API QUOTE ENDPOINT (OPTIONAL) -----
app.post("/api/quote", async (req, res) => {
  const {
    callerName,
    phoneNumber,
    year,
    make,
    model,
    drives,
    location,
    condition,
  } = req.body || {};

  const { min, max } = calculatePriceRange({
    drives: String(drives).toLowerCase() === "true" || drives === true,
    year,
    location,
    condition,
  });

  const priceText = `$${min} - $${max}`;
  const timestamp = new Date().toISOString();

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
            timestamp,
            callerName || "",
            phoneNumber || "",
            year || "",
            make || "",
            model || "",
            drives ? "Yes" : "No",
            priceText,
            location || "",
            condition || "",
          ],
        ],
      },
    });

    return res.json({ success: true, priceRange: { min, max }, priceText });
  } catch (err) {
    console.error("Error writing to Google Sheet:", err);
    return res.status(500).json({ success: false, error: "Sheet write failed" });
  }
});

// ----- START SERVER -----
app.listen(PORT, () => {
  console.log(`CashCarBC server listening on port ${PORT}`);
});
