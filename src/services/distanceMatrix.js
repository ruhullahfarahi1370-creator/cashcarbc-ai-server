// src/services/distanceMatrix.js

import { GOOGLE_MAPS_API_KEY } from "../config/constants.js";

export async function getDrivingDistanceKm(originPostal, destPostal) {
  if (!GOOGLE_MAPS_API_KEY) {
    return { ok: false, km: null, error: "Missing GOOGLE_MAPS_API_KEY" };
  }

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
    return {
      ok: false,
      km: null,
      error: `DistanceMatrix status=${element?.status || "unknown"}`,
    };
  }

  const meters = element.distance?.value;
  if (typeof meters !== "number") {
    return { ok: false, km: null, error: "No distance value" };
  }

  return { ok: true, km: Math.round((meters / 1000) * 10) / 10, error: "" };
}
