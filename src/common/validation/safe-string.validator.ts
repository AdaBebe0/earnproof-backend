import { registerDecorator, ValidationOptions, ValidationArguments } from "class-validator";

function hasDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Validates that a string doesn't contain dangerous content like script tags,
 * event handlers, or other XSS payloads.
 * 
 * This is a defensive validation for free-form text fields that might be
 * rendered in HTML contexts.
 */
export function IsSafeString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isSafeString",
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === null || value === undefined) {
            return true; // Use @IsOptional for required fields
          }

          if (typeof value !== "string") {
            return false;
          }

          const str = value.trim();
          
          // Check for dangerous patterns
          const dangerousPatterns = [
            // Script tags and HTML fragments
            /<script\b[^>]*>/i,
            /<\/script>/i,
            /<iframe\b[^>]*>/i,
            /<\/iframe>/i,
            /<object\b[^>]*>/i,
            /<\/object>/i,
            /<embed\b[^>]*>/i,
            /<\/embed>/i,
            /<link\b[^>]*>/i,
            /<meta\b[^>]*>/i,
            /<style\b[^>]*>/i,
            /<\/style>/i,
            
            // Event handlers
            /on\w+\s*=/i,
            
            // JavaScript protocol
            /javascript:/i,
            /vbscript:/i,
            /data:/i,
            /file:/i,
            
            // Expression and eval
            /expression\s*\(/i,
            /eval\s*\(/i,
            
            // Dangerous attributes
            /href\s*=\s*["']?\s*javascript:/i,
            /src\s*=\s*["']?\s*javascript:/i,
            
            // SVG XSS vectors
            /<svg\b[^>]*>/i,
            /<animate\b[^>]*>/i,
            /<set\b[^>]*>/i,
            
            // Unicode directional override characters
            /[\u202A-\u202E\u2066-\u2069]/,
          ];

          if (hasDisallowedControlCharacter(str)) {
            return false;
          }

          for (const pattern of dangerousPatterns) {
            if (pattern.test(str)) {
              return false;
            }
          }

          // Check for encoded versions
          const encoded = str.toLowerCase();
          const encodedPatterns = [
            /%3cscript/i,
            /%3c%2fscript/i,
            /%22onload%22/i,
            /&#x3c;script/i,
            /&#60;script/i,
          ];

          for (const pattern of encodedPatterns) {
            if (pattern.test(encoded)) {
              return false;
            }
          }

          // Maximum length check (defense against DoS via huge strings)
          if (str.length > 10000) {
            return false;
          }

          return true;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} contains potentially dangerous content`;
        },
      },
    });
  };
}

/**
 * Validates that a string is safe for use in display names and doesn't
 * contain control characters or excessive whitespace.
 */
export function IsSafeDisplayName(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isSafeDisplayName",
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === null || value === undefined) {
            return true; // Use @IsOptional for required fields
          }

          if (typeof value !== "string") {
            return false;
          }

          const str = value.trim();
          
          // Empty strings are invalid for display names
          if (str.length === 0) {
            return false;
          }

          if (hasDisallowedControlCharacter(str)) {
            return false;
          }

          // Check for excessive whitespace (more than 2 consecutive spaces)
          if (/\s{3,}/.test(str)) {
            return false;
          }

          // Check for dangerous patterns (simpler than IsSafeString)
          const dangerousPatterns = [
            /<script/i,
            /javascript:/i,
            /on\w+\s*=/i,
          ];

          for (const pattern of dangerousPatterns) {
            if (pattern.test(str)) {
              return false;
            }
          }

          // Reasonable length limit
          if (str.length > 500) {
            return false;
          }

          return true;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a safe display name without control characters or dangerous content`;
        },
      },
    });
  };
}
