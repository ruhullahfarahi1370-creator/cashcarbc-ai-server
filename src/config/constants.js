// src/config/constants.js

export const PORT = process.env.PORT || 3000;

// Yard postal code (your base)
export const YARD_POSTAL = "V6V 1M7";

// Google Maps key for Distance Matrix
export const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// ----- City normalization -----
export const KNOWN_CITIES = [
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

export const CITY_ALIASES = {
  hobbits: "Abbotsford",
  hobits: "Abbotsford",
  abotsford: "Abbotsford",
  vancover: "Vancouver",
  surree: "Surrey",
};
