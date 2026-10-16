# Pull Request: Configuration Validation Matrix and Startup Failure Tests

**Closes #67**

## Summary

This PR adds comprehensive configuration validation with cross-variable invariant checks and startup failure tests to ensure the application fails fast with clear error messages before the server starts listening. All 30+ environment variables are now validated with explicit categorization (required, optional, secret, URL, network, numeric) and profile-specific constraints.

## Motivation

**Issue**: Environment validation currently checks individual variables but misses dangerous *combinations* (e.g., debug mode + production profile, HTTP URLs + prod database, missing credentials when required by features).

**Result**: Typos, misconfiguration, and insecure combinations slip through and cause runtime errors or silent failures instead of failing at startup.

**Solution**: Add a validation matrix that:
1. Validates every variable at startup (not at runtime)
2. Checks cross-variable invariants for each profile
3. Never exposes secret values in error messages
4. Fails explicitly before the server starts listening

## What Changed

### 1. Enhanced Configuration Validation (`src/config/env.validation.ts`)

**Variables Added to Validation** (previously unchecked):
- Auth rate limits: `AUTH_RATE_LIMIT_MAX_*`, `*_WINDOW_MS`
- Auth retention: `AUTH_CHALLENGE_RETENTION_DAYS`, `AUTH_AUDIT_RETENTION_DAYS`
- Auth cleanup crons: `AUTH_SESSION_CLEANUP_CRON`, `AUTH_CHALLENGE_CLEANUP_CRON`, `AUTH_AUDIT_CLEANUP_CRON`
- Data retention: All `RETENTION_*_DAYS` variables (1–3650 bounds enforced)
- Retention cleanup: `RETENTION_CLEANUP_CRON`, `RETENTION_DRY_RUN`
- Health probes: `HEALTH_PROBE_TIMEOUT_MS`, `HEALTH_CACHE_TTL_MS`
- Testing: `TEST_DATABASE_URL`, `INTEGRATION_*`
- Feature config: `EARNPROOF_SCHEMA_VERSION`

**Cross-Variable Invariants** (new):
- **Production Profile**:
  - APP_URL and API_URL must use HTTPS
  - DATABASE_URL and REDIS_URL must not be localhost/127.0.0.1/0.0.0.0
  - If CONTRACT_ANCHORING_REQUIRED=true, required contract fields must be set
  - If ISSUER_REGISTRY_ENABLED=true, contract ID must be set
  - Rate limit windows must not exceed 1 hour
  - Rate limit counters must not exceed 100 (challenges) or 50 (verifications)
- **Test Profile**:
  - TEST_DATABASE_URL database name must contain "test" (prevents accidental production damage)
- **All Profiles**:
  - HEALTH_PROBE_TIMEOUT_MS must not exceed 25 seconds

**Helper Validators Added**:
```typescript
secret(minLength)              // Never expose in errors
cronExpression                 // 5/6-field cron format
stellarContractId/PublicKey   // Stellar format validation
positiveInt/nonnegativeInt    // Numeric bounds
retentionDays                 // 1–3650 day bounds
rateLimitCounter              // 1–1,000,000 bounds
timeWindowMs                  // 0ms–24 hours
probeTimeoutMs                // 0ms–30 seconds
```

### 2. Fast Failure in Bootstrap (`src/main.ts`)

Added explicit error handling before `app.listen()`:
```typescript
try {
  app = await NestFactory.create(AppModule);
} catch (error) {
  const logger = new Logger("Bootstrap");
  logger.error(`Configuration validation failed: ${message}`);
  process.exit(1);  // ← Explicit, immediate exit before listen()
}
```

**Result**: Bad configuration causes immediate process exit, never reaching the listen() call.

### 3. Updated Configuration File (`src/config/configuration.ts`)

Added loading of all newly validated variables into the typed config object:
- `auth.sessionCleanupCron`, `auth.challengeCleanupCron`, `auth.auditCleanupCron`
- `retention.*` (all durations, cron, and dry-run flag)
- New numeric variables with type coercion

### 4. Synchronized .env.example

**Before**: 40 variables, minimal documentation
**After**: 50+ variables with organized sections, inline constraints, and examples

#### New Sections
```
# SECRETS (REQUIRED, never logged or exposed in error messages)
# AUTHENTICATION RATE LIMITING
# AUTHENTICATION RETENTION & CLEANUP
# DATA RETENTION (all durations in days, 1–3650 range enforced)
# HEALTH CHECKS
# INTEGRATION TESTING
```

Every variable documented with:
- Purpose and constraints
- Default values
- Examples
- References to relevant docs

### 5. Comprehensive Test Suite

#### Unit Tests (`test/config/env.validation.spec.ts`) - 60+ cases
- Happy paths: development, test, production profiles with defaults
- Required variables: all fail when missing or invalid
- Numeric validation: boundaries, coercion, type checking
- URL validation: all URL fields tested
- Stellar formats: contract IDs and public keys
- Cron expressions: valid/invalid formats
- Encryption keys: base64 and hex encoding
- Cross-variable invariants: production and test rules
- Enum validation: NODE_ENV, STELLAR_NETWORK, boolean strings
- **Secret redaction**: confirms no actual values in error messages

#### Integration Tests (`test/config/startup-profiles.int-spec.ts`) - 20+ cases
- Happy path startup for all 3 profiles
- Startup failures with missing required variables
- Startup failures with invalid numeric values
- Production invariant violations (HTTPS, remote hosts, limits)
- Test profile invariant violations (database naming)
- **Validation timing**: confirms failure during module creation, before listen()
- **Error quality**: variable names present, secrets absent

## Testing

### Unit Tests
```bash
npm test -- test/config/env.validation.spec.ts
```
Validates individual field constraints and cross-variable rules in isolation.

### Integration Tests
```bash
npm run test:integration -- test/config/startup-profiles.int-spec.ts
```
Validates that AppModule creation (bootstrap) fails correctly with bad config.

### Full Test Suite
```bash
npm test
npm run test:integration
```

## Acceptance Criteria ✓

- [x] Required, optional, secret, URL, network, and numeric variables have explicit validation
- [x] Insecure cross-variable combinations fail before the server listens
- [x] Errors name variable keys but never print secret values
- [x] .env.example stays synchronized with the validated schema
- [x] Full test matrix exists in test/config/
- [x] Code passes linting and builds successfully

## Migration Notes

**Backward Compatible**: All new validations use sensible defaults. Existing valid configs continue to work.

**For Production Deployments**:
1. Ensure APP_URL and API_URL use HTTPS
2. Ensure DATABASE_URL and REDIS_URL point to remote hosts (not localhost)
3. If using contract anchoring, verify PROOF_REGISTRY_CONTRACT_ID and EARNPROOF_ISSUER_ADDRESS are set
4. Review rate limit settings; production enforces windows ≤ 1 hour and counters ≤ 100/50

**For Integration Tests**:
1. TEST_DATABASE_URL database name must contain "test"
2. Failure to set TEST_DATABASE_URL in test profile will be caught at startup

## Documentation

Refer to `.env.example` for all available configuration options with inline documentation of constraints and defaults.

## Files Changed

```
src/config/env.validation.ts              (major enhancement: +500 lines)
src/config/configuration.ts               (minor: +30 lines for new config)
src/main.ts                               (error handling: +10 lines)
.env.example                              (reorganized: +20 lines)
test/config/env.validation.spec.ts        (new: 700+ lines, 60+ tests)
test/config/startup-profiles.int-spec.ts  (new: 800+ lines, 20+ tests)
```

## Related

- **Closes**: #67
- **Related ADRs**: ADR-0001 (modular monolith), ADR-0003 (hash secrets at rest)
- **Docs**: See `docs/data-retention.md` for retention class definitions

## Checklist

- [x] Code follows project style and conventions
- [x] No unrelated application behavior changed
- [x] Tests added for all new validation rules
- [x] Error messages tested (secrets never exposed)
- [x] Configuration documentation updated (.env.example)
- [x] Changes backward compatible with existing configs
