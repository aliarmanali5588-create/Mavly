/**
 * The single place a Vercel API URL is built.
 *
 * ⚠️ THE ORIGIN IS CONSTANT. Callers pass a fixed API path; the only variable
 * scope is the server-configured team id. Personal-account mode passes `null`
 * and therefore never appends a `teamId` parameter to any request.
 */

export const VERCEL_API_ORIGIN = "https://api.vercel.com";

export function vercelRequestUrl(path: string, teamId: string | null): URL {
  const url = new URL(path, VERCEL_API_ORIGIN);
  if (teamId) url.searchParams.set("teamId", teamId);
  return url;
}
