# Implementation Plan: Revocable Auth Sessions

## Overview

The core session infrastructure (SessionService, AuthGuard, AuthService, schema, tests) is already implemented. This plan closes the remaining gaps: CleanupJob creation and wiring, the `POST /auth/rotate` controller route, AuthTokenService deprecation annotation, the structural non-usage test, and a final lint/build verification pass.

## Tasks

- [ ] 1. Create `CleanupJob` and wire it into the module graph
  - [ ] 1.1 Create `src/auth/cleanup.job.ts`
    - Implement `CleanupJob` as an `@Injectable()` class
    - Inject `SessionService` via constructor
    - Add `@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)` on `handleCron()`
    - `handleCron()` calls `this.sessionService.deleteExpired()` and logs the deleted count via `Logger`
    - _Requirements: 9.3, 9.4, 9.5_

  - [ ] 1.2 Update `AuthModule` to register `CleanupJob` and import `ScheduleModule`
    - Add `ScheduleModule.forFeature()` to `AuthModule.imports`
    - Add `CleanupJob` to `AuthModule.providers`
    - _Requirements: 9.4_

  - [ ] 1.3 Update `AppModule` to import `ScheduleModule.forRoot()`
    - Add `ScheduleModule.forRoot()` to `AppModule.imports` so `@Cron` decorators are activated globally
    - _Requirements: 9.4_

- [ ] 2. Add `POST /auth/rotate` endpoint
  - [ ] 2.1 Inject `SessionService` into `AuthController` and add the rotate route
    - Add `SessionService` as a second constructor argument in `AuthController`
    - Add `@ApiBearerAuth() @UseGuards(AuthGuard) @Post('rotate') @HttpCode(HttpStatus.OK)` handler
    - Extract `sessionId` and the user identity from `@CurrentUser() session: AuthenticatedSession`
    - Delegate to `this.sessionService.rotate(session.sessionId, session)` and return `{ token, tokenType: 'Bearer', sessionId, expiresAt }`
    - _Requirements: 5.7_

- [ ] 3. Checkpoint — Ensure all tests pass and the application compiles
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Deprecate `AuthTokenService` and add structural non-usage test
  - [ ] 4.1 Annotate `AuthTokenService` with `@deprecated` JSDoc
    - Add a JSDoc comment block above the class declaration with `@deprecated` tag
    - State that `SessionService` is the replacement
    - _Requirements: 7.1_

  - [ ]* 4.2 Add structural non-usage test to `auth-token.service.spec.ts`
    - Add a `describe` block: "AuthTokenService is not used in production code paths"
    - Import source text of `auth.guard.ts` and `auth.service.ts` using `fs.readFileSync`
    - Assert that neither file's source contains the string `AuthTokenService`
    - Assert that neither file imports from `./auth-token.service` or `../auth/auth-token.service`
    - _Requirements: 7.5_

- [ ] 5. Verify lint, tests, and build all pass
  - [ ] 5.1 Run `npm run lint` and fix any reported errors
    - Address any ESLint or Prettier violations introduced by the new files
    - _Requirements: 10.6_

  - [ ] 5.2 Run `npm run test -- --runInBand` and confirm exit code 0
    - All existing and new tests must pass
    - _Requirements: 10.6_

  - [ ] 5.3 Run `npm run build` and confirm exit code 0
    - TypeScript compilation must succeed with no errors
    - _Requirements: 10.6_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The `@nestjs/schedule` package must be available — check `package.json` before running; add it with `npm install @nestjs/schedule` if missing
- `ScheduleModule.forFeature()` is only needed if using module-scoped schedulers; `ScheduleModule.forRoot()` in `AppModule` is the minimum required
- The rotate endpoint reuses the already-injected `SessionService` — no new service methods are needed
- All correctness properties (1–11) are already validated by the existing test suite; no new property test tasks are required

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "4.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["5.1", "5.2"] },
    { "id": 4, "tasks": ["5.3"] }
  ]
}
```
