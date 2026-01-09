import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

// ----- CONFIG -----
const PORT = process.env.PORT || 3000;

// Twilio (for later – when we hook up voice)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Google Sheets
const sheets = google.sheets("v4");

function getGoogleAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT env var is missing");
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

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

// Simple health check
app.get("/", (req, res) => {
  res.status(200).send("CashCarBC AI backend is running.\n");
});

// Endpoint to be called by Twilio voice webhook later
app.post("/twilio/voice", async (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();

    // For now, just say a simple message so we can hook Twilio to it later.
    // We will upgrade this to full conversational logic in the next step.
    twiml.say(
      {
        voice: "Polly-Matthew-Neural", // a nicer male voice than default
        language: "en-CA",
      },
      "Hi, this is the Cash Car B C A I assistant. The full conversational version is under construction."
    );

    res.type("text/xml");
    return res.send(twiml.toString());
  } catch (err) {
    console.error("Error in /twilio/voice:", err);
    return res.status(500).send("Error");
  }
});

// Simple endpoint to test pricing + Google Sheet from Postman/curl
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
      valueInputOption: "USER_ENTERED",
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

    return res.json({
      success: true,
      priceRange: { min, max },
      priceText,
    });
  } catch (err) {
    console.error("Error writing to Google Sheet:", err);
    return res.status(500).json({ success: false, error: "Sheet write failed" });
  }
});

// ----- START SERVER -----
app.listen(PORT, () => {
  console.log(`CashCarBC server listening on port ${PORT}`);
});
