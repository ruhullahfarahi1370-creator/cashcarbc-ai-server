import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

// ----- CONFIG -----
const PORT = process.env.PORT || 3000;

// Twilio (optional here, but kept for later use)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID || "",
  process.env.TWILIO_AUTH_TOKEN || ""
);

// Google Sheets
const sheets = google.sheets("v4");

function getGoogleAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT env var is missing");
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  // 🔥 Very common fix when JSON is stored in environment variables
  // (private_key comes with escaped newlines \\n)
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
  // 1. Base price
  let min = drives ? 300 : 120;
  let max = drives ? 700 : 350;

  const y = parseInt(year, 10);

  // 2. Year adjustment
  if (!isNaN(y)) {
    if (y >= 2015) {
      min += 100;
      max += 100;
    } else if (y >= 2008 && y <= 2014) {
      min += 50;
      max += 50;
    }
  }

  // 3. Location adjustment (very rough for now)
  const loc = (location || "").toLowerCase();
  if (/vancouver|richmond|north vancouver|coquitlam/.test(loc)) {
    min -= 30;
    max -= 30;
  } else if (/langley|abbotsford|chilliwack|maple ridge/.test(loc)) {
    min -= 50;
    max -= 50;
  }

  // 4. Condition adjustment
  const cond = (condition || "").toLowerCase();
  if (/fire|flood|frame|major accident|heavy damage/.test(cond)) {
    min -= 50;
    max -= 150;
  }

  // Never go below 50
  min = Math.max(min, 50);
  max = Math.max(max, min + 50);

  return {
    min: Math.round(min),
    max: Math.round(max),
  };
}

// ----- EXPRESS APP -----
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ✅ Optional: log every request path (helps confirm Twilio is hitting your app)
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// Simple health check
app.get("/", (req, res) => {
  res.status(200).send("CashCarBC AI backend is running.\n");
});

// Endpoint to be called by Twilio voice webhook
app.post("/twilio/voice", async (req, res) => {
  const requestId = `twilio-${Date.now()}`;

  try {
    const twiml = new twilio.twiml.VoiceResponse();

    // Twilio request body debug (don’t print everything)
    const fromNumber = req.body.From || "";
    const toNumber = req.body.To || "";
    const callSid = req.body.CallSid || "";
    const timestamp = new Date().toISOString();

    console.log(`[${requestId}] Incoming Twilio call`, {
      From: fromNumber,
      To: toNumber,
      CallSid: callSid,
    });

    // ---- GOOGLE SHEET APPEND (WITH LOGS) ----
    try {
      console.log(`[${requestId}] Sheet env check`, {
        hasServiceAccount: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT),
        sheetId: process.env.GOOGLE_SHEET_ID ? "✅ set" : "❌ missing",
      });

      console.log(`[${requestId}] About to authorize Google JWT...`);
      const auth = getGoogleAuth();
      await auth.authorize();
      console.log(`[${requestId}] ✅ Google auth OK`);

      console.log(
        `[${requestId}] About to append row to sheet...`,
        process.env.GOOGLE_SHEET_ID
      );

      await sheets.spreadsheets.values.append({
        auth,
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "Sheet1!A:Z",
        valueInputOption: "RAW",
        requestBody: {
          values: [
            [
              timestamp, // Timestamp
              "", // Caller Name (unknown for now)
              fromNumber, // Phone Number
              "", // Car Year
              "", // Car Make
              "", // Car Model
              "", // Drives?
              "Phone call - no quote yet", // AI Price Given (placeholder)
              "", // Location
              `Incoming call to ${toNumber} | CallSid=${callSid}`, // Notes
            ],
          ],
        },
      });

      console.log(`[${requestId}] ✅ Sheet append OK`);
    } catch (sheetErr) {
      console.error(`[${requestId}] ❌ Error logging call to Google Sheet:`, sheetErr);
      // Do NOT fail the call if sheet write fails
    }

    // Voice message to caller
    twiml.say(
      {
        voice: "Polly-Matthew-Neural",
        language: "en-CA",
      },
      "Hi, thanks for calling Cash Car B C. Our A I assistant is in testing right now. A human will review your call details shortly."
    );

    res.type("text/xml");
    return res.send(twiml.toString());
  } catch (err) {
    console.error(`[${requestId}] ❌ Error in /twilio/voice:`, err);
    return res.status(500).send("Error");
  }
});

// Simple endpoint to test pricing + Google Sheet from Postman/curl
app.post("/api/quote", async (req, res) => {
  const requestId = `quote-${Date.now()}`;

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
    console.log(`[${requestId}] About to authorize Google JWT...`);
    const auth = getGoogleAuth();
    await auth.authorize();
    console.log(`[${requestId}] ✅ Google auth OK`);

    console.log(`[${requestId}] About to append quote row...`);
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

    console.log(`[${requestId}] ✅ Quote sheet append OK`);

    return res.json({
      success: true,
      priceRange: { min, max },
      priceText,
    });
  } catch (err) {
    console.error(`[${requestId}] ❌ Error writing quote to Google Sheet:`, err);
    return res.status(500).json({ success: false, error: "Sheet write failed" });
  }
});

// ----- START SERVER -----
app.listen(PORT, () => {
  console.log(`CashCarBC server listening on port ${PORT}`);
});
