# tf1 (2026-11-10): an agent state's child whose turn fails terminally (its retries spent: the session goes idle with
# an error and never completes the state). Today nothing tells the store and the state waits for its deadline. The
# fix (owner decision 2026-11-10): the child's session orchestration reports the failure and one store transaction
# decides the open state execution_failed (winner controller, only while pending) and wakes the controller.
# exec() this after gen-cases.py's helpers. It defines TF_AGENT (CASES format) and TF_HEAD.
#   Report = "none": the code before the fix (Code a10c2e07, the latest WfAgent binding); "fix": the design;
#   DeadlineFair = FALSE: the deadline is not forced, so a liveness pass cannot rest on it.

TF_HEAD = "design"
_TF = dict(head=A10, turnfail=True)
TF_INV = A_INV + ["Inv_DecidedOnce", "Inv_FailOnlyWhenPending"]

TF_AGENT = [
 ("tf.agent-fail-waits", "WfAgent", "reviewed", "LiveSpec", a(dfair=False, **_TF), [], ["Prop_FailedDecided"], "liveness",
  "Finding (the code before the fix): a child whose turn failed terminally is never reported; without the deadline its state stays pending."),
 ("tf.agent-fail-decided", "WfAgent", "comparison", "LiveSpec", a(dfair=False, report="fix", **_TF), [],
  ["Prop_FailedDecided", "Prop_FailedChildReleased"], "PASS",
  "The fix: the failure report decides the state execution_failed and the child is ended, without the deadline."),
 ("tf.agent-fail-safety", "WfAgent", "comparison", "Spec", a(exhaust=True, endfail=True, report="fix", **_TF), TF_INV, [], "PASS",
  "The fix: every agent-state rule, a decision never replaced, execution_failed only after a terminal failure; crashes, refusals, exhausted spawns, failed ends, a report delivered twice."),
 ("tf.agent-fail-live", "WfAgent", "comparison", "LiveSpec", a(report="fix", **_TF), [],
  ["Prop_StateDecided", "Prop_ChildReleased", "Prop_FailedDecided"], "PASS",
  "The fix with the deadline: the state is decided and its child ended."),
 ("fault.agent-fail-unfenced", "WfAgent", "deliberate", "Spec", a(report="unfenced", **_TF), ["Inv_DecidedOnce"], [], "safety",
  "The report decides a state that was already decided (no pending check)."),
 ("wit.agent-fail-decided", "WfAgent", "witness", "Spec", a(report="fix", **_TF), ["Wit_FailedDecided"], [], "safety",
  "The failure report decides the state."),
]
