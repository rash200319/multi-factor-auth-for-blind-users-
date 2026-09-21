export const RP_NAME = process.env.RP_NAME ?? "MFA for Blind Users (Demo)";
export const RP_ID = process.env.RP_ID ?? "localhost";
export const ORIGIN = process.env.ORIGIN ?? "http://localhost:5190";
export const PORT = Number(process.env.PORT ?? 4000);
export const CHALLENGE_TTL_SECONDS = 300; // WCAG 2.2 SC 2.2.1 — 300s minimum, PDF Figure 6
