---
name: workflow-schedules
description: "Load before you schedule several fire times in one Workflow: offsets from Start (+1h, +1h30m, +24h), clock times (09:00 and 17:00, weekly, monthly, time zones), an interval with a stop, bounds, and when cron fits."
---

# Schedules in one Workflow

Call `load_skill` with name `workflow-authoring` first. One Workflow holds
the whole schedule: it waits without model turns, survives restarts and
ends by itself. Do not start one Workflow per fire time, and do not use
`cron` for a fixed schedule.

| Schedule | Pattern |
|---|---|
| Times measured from Start (+1h, +1h30m, +24h) | A carried list of offsets and a wait whose `seconds` is a binding |
| Clock times (09:00; 09:00 and 17:00; Mondays; the 1st) | A `wait` with `at:`, one wait per time |
| Every N minutes until something is true | Wait, check, repeat: call `load_skill` with name `workflow-polling` |
| Each fire needs this session's own judgment | `cron` or `cron_at` (last section) |

## Offsets from Start

Keep the offsets still to fire (seconds after Start, rising) and the last
offset fired in the loop's data. `next` takes the first offset, the wait
waits the difference, the step runs, and the run ends when no offset is
left. The wait's `seconds` binding is checked when the wait is entered:
1 to 2,592,000 (30 days) per wait. Each wait counts from its own entry,
so the steps' run time adds a few seconds per fire; use `at:` for exact
clock times.

A step's output replaces the value that arrives at the next state, so the
step carries the list (`carry`; see `workflow-carry`), and `next` reads
`context.input.carry` after its first visit. Replace `remind` with your
step: a script, an agent or a send.

```yaml
# example: follow-ups
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: follow-ups, version: "1.0.0" }
description: Sends the parent a reminder 1 hour, 90 minutes and 24 hours after Start.
contracts:
  Reminder@1:
    schema: { type: object, required: [afterSeconds], properties: { afterSeconds: { type: integer } } }
initial: next
initialInput: { at: 0, offsets: [3600, 5400, 86400] }
limits: { maxNodeExecutions: 40 }
states:
  next:
    type: script
    outcomes: [pause, finished]
    source: |
      // First visit: initialInput. Later visits: the carry of remind.
      const { at, offsets } = context.input.carry ?? context.input;
      if (offsets.length === 0) await setResult("finished", { lastOffset: at });
      else if (!(offsets[0] > at)) throw new Error("offsets must rise");
      else await setResult("pause", { seconds: offsets[0] - at, at: offsets[0], offsets: offsets.slice(1) });
    transition: { next: { pause: pause, finished: done, failure: failed } }
  pause:
    type: wait
    seconds: "${input.seconds}"
    input: { at: "${input.at}", offsets: "${input.offsets}" }
    transition: { next: { elapsed: remind, failure: failed } }
  remind:
    type: messaging
    mode: send
    contract: Reminder@1
    recipient: { parent: true }
    carry: { at: "${input.at}", offsets: "${input.offsets}" }
    input: { afterSeconds: "${input.at}" }
    transition: { next: { sent: next, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "${input}" }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

To take the offsets at Start, declare `inputs` and set
`initialInput: { at: 0, offsets: "${inputs.offsets}" }`.

## Clock times

`at: { minute, hour?, day_of_week? (0-6, Sunday 0) or day_of_month? (1-31), tz }`
waits for the next such time strictly after the wait is entered, in the
IANA zone `tz` (required). Its fields are literal: no bindings.

| Fires | `at` |
|---|---|
| Every hour at :15 | `{ minute: 15, tz: UTC }` |
| Daily at 09:00 | `{ minute: 0, hour: 9, tz: Europe/London }` |
| Mondays at 08:30 | `{ minute: 30, hour: 8, day_of_week: 1, tz: America/New_York }` |
| The 1st of each month at 06:00 | `{ minute: 0, hour: 6, day_of_month: 1, tz: UTC }` |

- Several times a day: one wait per time; the step routes to the wait for
  the next time (example below).
- A wait entered after today's time waits until tomorrow's, so the example
  starts with a script that picks the next slot.
- Daylight saving follows `tz`. A time that a spring change skips does not
  fire that day; a time that an autumn change repeats fires once. A
  `day_of_month` that a month lacks (such as 31) skips that month.

```yaml
# example: twice-daily
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: twice-daily, version: "1.0.0" }
description: Posts a status report at 09:00 and 17:00 London time, 60 times.
initial: first
initialInput: { reports: 0 }
limits: { maxNodeExecutions: 300 }
states:
  first:
    type: script
    outcomes: [morning, evening]
    source: |
      const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" }).format(new Date()));
      await setResult(hour >= 9 && hour < 17 ? "evening" : "morning", context.input);
    transition: { next: { morning: at_0900, evening: at_1700, failure: failed } }
  at_0900:
    type: wait
    at: { minute: 0, hour: 9, tz: Europe/London }
    input: { reports: "${input.reports}", then: evening }
    transition: { next: { elapsed: report, failure: failed } }
  at_1700:
    type: wait
    at: { minute: 0, hour: 17, tz: Europe/London }
    input: { reports: "${input.reports}", then: morning }
    transition: { next: { elapsed: report, failure: failed } }
  report:
    type: script
    outcomes: [morning, evening, finished]
    source: |
      await callTool("post_status_report", {});
      const reports = context.input.reports + 1;
      await setResult(reports >= 60 ? "finished" : context.input.then, { reports });
    transition: { next: { morning: at_0900, evening: at_1700, finished: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "${input}" }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

Replace `post_status_report` with your tool, or the script with an agent
or a send.

## An interval with a stop

Wait `seconds`, check, and loop back until the check is done, a count in
the loop's data runs out, or a date passes. `seconds` can read a variable,
such as `"${kv.everySeconds ?? 600}"`: a person who changes it changes the
interval from the next wait on. Call `load_skill` with name `workflow-polling` for its
visit budget and a complete example.

## Bounds

- One wait is at most 2,592,000 seconds (30 days). Chain waits for a
  longer gap.
- Every visit, waits included, counts toward `limits.maxNodeExecutions`
  (default 1,000, at most 10,000). Count the visits per fire (3 in
  follow-ups, 2 in twice-daily), multiply by the fires, and leave room for
  the exit.
- `limits.timeoutSeconds` (at most 30 days) fails the whole run when it
  passes. Leave it out for a longer schedule and stop on a count or a date.
- A running Workflow keeps its revision. To change a schedule, cancel the
  run and start a new revision.

## When cron or cron_at still fits

Use `cron` or `cron_at` when each fire needs this session's own judgment
and conversation, such as summarizing what changed for the user. `cron`
keeps one interval and `cron_at` one clock pattern, and every fire costs a
model turn. A Workflow can also hand a fire to the session: a send to
`{ parent: true }` wakes it only when its judgment is needed.
