# Tabletop exercise

A runbook is only as good as its last rehearsal. This checklist is the rehearsal:
one hour, no production access, one scenario at a time.

Run it quarterly, and again whenever a runbook changes materially. Record the
date and the findings in the same place as incident records, so the gap between
"we wrote it down" and "we can do it" stays visible.

## How to run it

1. Pick a scenario below. Do not tell the participants which one in advance.
2. Assign roles from [the response roles](README.md#roles) — incident lead,
   responder, evidence keeper, communications — to different people. One person
   holding two roles is the normal case in production; the exercise is where
   that is tested rather than discovered.
3. The facilitator reveals the scenario, then answers questions with only what a
   real responder could actually see: an alert, a report, a log line.
4. Participants work the runbook aloud. **No commands are executed.** The
   responder says which command they would run and against which environment;
   the facilitator answers with the plausible output.
5. Stop at 60 minutes whether or not the scenario is resolved. An unresolved
   scenario is a finding, not a failure.

## Checklist per scenario

Tick each item only if the participants reached it *from the runbook*, not from
memory or from the facilitator's prompting. An item reached only by prompting is
a documentation gap, which is the point of the exercise.

- [ ] **Severity** assigned within five minutes, with a stated reason.
- [ ] **Incident lead** named, and not the same person running commands.
- [ ] **Evidence** identified before the first containment action, and the
      containment clock recorded.
- [ ] **Containment** chosen from the runbook's order, with the trade stated out
      loud ("this signs out every user").
- [ ] **Environment confirmed** before every command, aloud.
- [ ] **Destructive commands** identified as destructive, with two-maintainer
      confirmation named where the runbook requires it.
- [ ] **Privacy held**: nothing that belongs in the database was spoken as
      something to paste into a ticket.
- [ ] **Reconciliation** planned, not just containment — what data has to be
      checked afterwards, and how.
- [ ] **Communication** drafted: who is told, what they are told, what is
      withheld because it is not yet established.
- [ ] **Exit criteria** read out, and the group agrees which are unmet.
- [ ] **Handoff** written, as if the shift ended now.

## Scenarios

Each maps to one runbook. The injects are what the facilitator adds partway
through, to force a re-classification.

### 1. Leaked API key

A customer emails: an API key of theirs appeared in a public repository. They do
not know for how long.

*Inject at 20 minutes:* the audit trail shows `api_key.authenticated` rows for
that prefix from a period the customer says they were not running integrations.

Runbook: [compromised-credentials.md](compromised-credentials.md).

### 2. Verification flooding

`verifications_total` is ten times baseline, almost all `UNKNOWN`. API latency
alerts are firing.

*Inject at 20 minutes:* a small number of the requests are returning `VALID` —
someone has real proof identifiers.

Runbook: [abusive-client.md](abusive-client.md), then
[data-exposure.md](data-exposure.md) after the inject.

### 3. Cross-tenant response

A customer reports seeing a payment that is not theirs in a list response. One
report, no alert.

*Inject at 15 minutes:* the deploy that introduced it shipped nine days ago.

Runbook: [data-exposure.md](data-exposure.md).

### 4. Anchors we did not write

The reconciler logs `error` for six proofs: locally `ACTIVE`, on chain neither
valid nor revoked.

*Inject at 20 minutes:* the registry account has transactions with no matching
`AnchoringIntent.transactionHash`.

Runbook: [anchoring-failure.md](anchoring-failure.md), escalating to
[compromised-credentials.md](compromised-credentials.md).

### 5. Horizon returning the wrong thing

Sync is running, lag is normal, and a user reports payments they never received.

*Inject at 15 minutes:* an independent Horizon instance does not show those
operations.

Runbook: [dependency-outage.md](dependency-outage.md).

## After the exercise

- Record which checklist items were missed, and which document should have
  carried them.
- Open an issue per documentation gap. A gap noted only in the exercise write-up
  is a gap that survives to the next exercise.
- Fix the runbook before the next incident, not after it.
