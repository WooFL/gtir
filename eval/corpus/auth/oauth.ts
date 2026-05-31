// OAuth 2.0 PKCE flow helpers for browser-based apps.

export function generateCodeVerifier(length = 64): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export async function codeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  challenge: string;
  state: string;
  authEndpoint: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
  });
  return `${params.authEndpoint}?${q}`;
}
