// Issue and verify JSON Web Tokens for session auth.
export function signToken(payload, secret, ttlSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = { ...payload, exp };
  return encode(header) + "." + encode(body) + "." + hmac(header, body, secret);
}

export function verifyToken(token, secret) {
  const [h, b, sig] = token.split(".");
  if (hmac(JSON.parse(decode(h)), JSON.parse(decode(b)), secret) !== sig) throw new Error("bad signature");
  const body = JSON.parse(decode(b));
  if (body.exp < Math.floor(Date.now() / 1000)) throw new Error("token expired");
  return body;
}
