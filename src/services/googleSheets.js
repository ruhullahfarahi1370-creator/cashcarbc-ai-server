// src/services/googleSheets.js

import { google } from "googleapis";

const sheets = google.sheets("v4");

function getGoogleAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT env var is missing");
  }
  if (!process.env.GOOGLE_SHEET_ID) {
    throw new Error("GOOGLE_SHEET_ID env var is missing");
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

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

async function appendRowDeterministic(rowValues) {
  const auth = getGoogleAuth();
  await auth.authorize();

  const colA = await sheets.spreadsheets.values.get({
    auth,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A:A",
  });

  const values = colA.data.values || [];
  const nextRow = values.length + 1;

  await sheets.spreadsheets.values.update({
    auth,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!A${nextRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] },
  });
}

export async function writeLeadToSheet(state) {
  const notesParts = [
    `CallSid=${state.callSid}`,
    `To=${state.to}`,
    state.condition ? `Condition=${state.condition}` : "",
  ].filter(Boolean);

  const notes = notesParts.join(" | ");

  const priceGiven = state.autoOfferFinal ? `$${state.autoOfferFinal}` : state.priceText || "";

  const rowValues = [
    state.timestamp,                 // Timestamp
    "",                              // Caller Name
    state.from,                      // Phone Number
    state.year,                      // Car Year
    state.make,                      // Car Make
    state.model,                     // Car Model
    state.drives ? "Yes" : "No",     // Drives?
    state.mileageKm,                 // Mileage
    priceGiven,                      // AI price given
    state.cityNorm || state.cityRaw, // City
    notes,                           // Notes
    state.askingPrice,               // AskingPrice
    state.distanceKm ?? "",          // Distance KM
    state.pickupPostal || "",        // PickupPostal
    state.cityRaw || "",             // CityRaw
    state.cityScore || "",           // CityScore
    state.ruleApplied || "",         // RuleApplied
    state.autoOfferEligible ? "Yes" : "No",
    state.autoOfferInitial || "",
    state.autoOfferFinal || "",
    state.autoOfferStatus || "",
    state.callbackBestNumber || "",
    state.callbackNumber || "",
    state.desiredPrice || "",
  ];

  await appendRowDeterministic(rowValues);
}
