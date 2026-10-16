import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { AuthTokenPayload } from "./auth.types";
import { safeEqual } from "../common/crypto/timing-safe";

/**
 * @deprecated Self-contained tokens cannot be revoked server-side. Use
 * `SessionService` for all production authentication flows.
 */
@Injectable()
export class AuthTokenService {
  private readonly secret: string;

  constructor(configService: ConfigService) {
    this.secret = configService.getOrThrow<string>("sessionSecret");
  }

  sign(payload: Omit<AuthTokenPayload, "exp">, ttlSeconds = 60 * 60 * 12) {
    const tokenPayload: AuthTokenPayload = {
      ...payload,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    const encodedPayload = this.base64Url(JSON.stringify(tokenPayload));
    const signature = this.signPayload(encodedPayload);

    return `${encodedPayload}.${signature}`;
  }

  verify(token: string): AuthTokenPayload {
    const [encodedPayload, signature] = token.split(".");

    if (!encodedPayload || !signature) {
      throw new UnauthorizedException("Malformed auth token");
    }

    const expectedSignature = this.signPayload(encodedPayload);
    if (!safeEqual(signature, expectedSignature)) {
      throw new UnauthorizedException("Invalid auth token");
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as AuthTokenPayload;

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException("Expired auth token");
    }

    return payload;
  }

  /**
   * Best-effort verification for legacy callers that still need this
   * deprecated token format. New production code should prefer persisted
   * sessions through `SessionService`.
   */
  tryVerify(token: string): AuthTokenPayload | undefined {
    try {
      return this.verify(token);
    } catch {
      return undefined;
    }
  }

  private signPayload(encodedPayload: string) {
    return createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");
  }

  private base64Url(value: string) {
    return Buffer.from(value).toString("base64url");
  }
}
