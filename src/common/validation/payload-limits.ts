import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from "class-validator";
import { findPayloadShapeViolation } from "../limits/payload-shape";

/**
 * Size and shape constraints for free-form fields.
 *
 * A field typed `Record<string, unknown>` has no natural bound: `@IsObject()`
 * accepts a megabyte of nesting as readily as `{ name: "Acme" }`. These
 * decorators give such a field the bound its type does not.
 *
 * They complement rather than replace the transport limits in
 * `src/common/limits/`. Those bound the request; these bound one field, at a
 * value the domain can justify — which is what makes the resulting error
 * useful to the caller ("publicMetadata must not exceed 8 KB") rather than a
 * flat refusal of the whole request.
 */

/** Rejects a value whose JSON representation exceeds `limit` bytes. */
export function MaxBytes(limit: number, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "maxBytes",
      target: object.constructor,
      propertyName,
      constraints: [limit],
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          try {
            return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") <= limit;
          } catch {
            // Circular or unserialisable: not something to accept and try to
            // persist.
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must not exceed ${(args.constraints[0] as number) / 1024} KB`;
        },
      },
    });
  };
}

/**
 * Rejects a value nested deeper than `limit` levels.
 *
 * Measured with the iterative walker used by the transport-level check, so a
 * field cannot be the thing that overflows the stack while being validated for
 * being too deep.
 */
export function MaxDepth(limit: number, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "maxDepth",
      target: object.constructor,
      propertyName,
      constraints: [limit],
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return (
            findPayloadShapeViolation(value, {
              maxDepth: limit,
              maxArrayItems: Number.MAX_SAFE_INTEGER,
              maxStringLength: Number.MAX_SAFE_INTEGER,
              maxNodes: Number.MAX_SAFE_INTEGER,
            })?.limit !== "depth"
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must not be nested deeper than ${args.constraints[0] as number} levels`;
        },
      },
    });
  };
}
