import { env } from "../config.js";
import jwt, { SignOptions } from "jsonwebtoken";

export interface TokenPayload {
  sub: string;
  email: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
  aud: string;
  iss: string;
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.JWT_SECRET, {
    audience: "cryptotrace-web",
    issuer: "cryptotrace"
  }) as TokenPayload;
}

export function generateToken(payload: Omit<TokenPayload, "iat" | "exp" | "aud" | "iss">): string {
  const options: SignOptions = {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
    audience: "cryptotrace-web",
    issuer: "cryptotrace"
  };
  return jwt.sign(payload, env.JWT_SECRET, options);
}