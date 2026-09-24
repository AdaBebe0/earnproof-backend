import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

/**
 * Shared table-driven DTO validation contract harness (earnproof-backend#62).
 *
 * Exercises a request DTO exactly the way the app's global `ValidationPipe`
 * does in `src/main.ts` (`whitelist: true`, `forbidNonWhitelisted: true`,
 * `transform: true`) — see that file for the pipe config this mirrors.
 *
 * Usage:
 *   const violations = await validateDto(CreateChallengeDto, {
 *     walletAddress: "G".repeat(56),
 *   });
 *   expect(violations).toHaveLength(0);
 */
export async function validateDto<T extends object>(
  dtoClass: new () => T,
  plain: Record<string, unknown>,
): Promise<{ property: string; constraints: string[] }[]> {
  const instance = plainToInstance(dtoClass, plain, {
    excludeExtraneousValues: false,
  });
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => ({
    property: e.property,
    constraints: Object.values(e.constraints ?? {}),
  }));
}

/** True if validating `plain` against `dtoClass` produces zero violations. */
export async function isValidDto<T extends object>(
  dtoClass: new () => T,
  plain: Record<string, unknown>,
): Promise<boolean> {
  return (await validateDto(dtoClass, plain)).length === 0;
}

/**
 * Reusable boundary/malformed-value fixtures for building table-driven cases
 * without repeating the same "what could possibly go wrong" list at every
 * call site. Each list is intentionally small and generic — combine with a
 * DTO's own domain-specific values (e.g. a too-short wallet address).
 */
export const COMMON_INVALID_STRING_VALUES: unknown[] = [
  null,
  undefined,
  123,
  true,
  {},
  [],
];

export const COMMON_UNKNOWN_FIELD = { __unexpectedField__: "surprise" };
