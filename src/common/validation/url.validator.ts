import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";
import { assertSafeDestinationUrl } from "../http/destination-guard";

/**
 * Validates that a URL is safe and follows security best practices.
 *
 * Requirements:
 * - Must use HTTPS protocol
 * - Must have a valid TLD
 * - Must not use dangerous protocols (javascript:, data:, vbscript:, etc.)
 * - Must not contain control characters or HTML/script payloads
 * - Must have a valid hostname
 */
export function IsSafeUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isSafeUrl",
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== "string") {
            return false;
          }

          const url = value.trim();

          // Reject empty strings
          if (!url) {
            return false;
          }

          if (hasControlCharacters(url)) {
            return false;
          }

          // Check for dangerous protocols
          const dangerousProtocols = [
            "javascript:",
            "data:",
            "vbscript:",
            "file:",
            "ftp:",
            "ws:",
            "wss:",
          ];

          const lowerUrl = url.toLowerCase();
          for (const protocol of dangerousProtocols) {
            if (lowerUrl.startsWith(protocol)) {
              return false;
            }
          }

          // Require HTTPS for web URLs
          if (!lowerUrl.startsWith("https://")) {
            return false;
          }

          try {
            assertSafeDestinationUrl(url);

            const parsed = new URL(url);

            // Validate hostname
            const hostname = parsed.hostname;
            if (!hostname || hostname.length > 253) {
              return false;
            }

            // Check for IP addresses (allow them but with additional validation)
            if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
              // Allow IP addresses but validate they're not private/local
              const parts = hostname.split(".").map(Number);
              if (
                parts.length !== 4 ||
                parts.some((part) => part < 0 || part > 255)
              ) {
                return false;
              }

              // Reject private/local IP ranges
              if (
                parts[0] === 10 ||
                (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                (parts[0] === 192 && parts[1] === 168) ||
                parts[0] === 127 ||
                parts[0] === 0
              ) {
                return false;
              }
            } else {
              // Validate domain name
              // Must have at least one dot for TLD (except localhost for development)
              if (hostname !== "localhost" && !hostname.includes(".")) {
                return false;
              }

              // Each label must be 1-63 chars, alphanumeric or hyphen (not start/end with hyphen)
              const labels = hostname.split(".");
              for (const label of labels) {
                if (label.length === 0 || label.length > 63) {
                  return false;
                }
                if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) {
                  return false;
                }
              }
            }

            // Validate port if present
            if (parsed.port) {
              const portNum = parseInt(parsed.port, 10);
              if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
                return false;
              }
              // Disallow common dangerous ports
              const dangerousPorts = [21, 22, 23, 25, 69, 110, 135, 137, 138, 139, 445];
              if (dangerousPorts.includes(portNum)) {
                return false;
              }
            }

            // Check for suspicious patterns in path/query
            const suspiciousPatterns = [
              /<script/i,
              /<\/script/i,
              /javascript:/i,
              /on\w+\s*=/i, // onclick=, onload=, etc.
              /expression\s*\(/i,
              /eval\s*\(/i,
              /vbscript:/i,
            ];

            const fullPath = parsed.pathname + parsed.search;
            const decodedPath = decodeRepeatedly(fullPath);
            if (hasControlCharacters(decodedPath)) {
              return false;
            }
            for (const pattern of suspiciousPatterns) {
              if (pattern.test(fullPath) || pattern.test(decodedPath)) {
                return false;
              }
            }

            // Maximum length check
            if (url.length > 2048) {
              return false;
            }

            return true;
          } catch {
            // URL parsing failed
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid HTTPS URL with a safe hostname and no dangerous content`;
        },
      },
    });
  };
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function decodeRepeatedly(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return decoded;
    }
  }
  return decoded;
}
