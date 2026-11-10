# r3-graph.py: exec'd after gen-cases.py's helpers (G_INV, g, ...). WfGraph r3 (S7-DX3, 9a8d0f66).
# (a) g() gains Elsewhere (default "command" = 1ef53967, the meaning of every existing WfGraph case) and OtherEnds
#     (default {} = no new writer or fault). Every existing WfGraph .cfg gets these two lines and keeps its meaning.
# (b) R3_GRAPH: the new cases, in the CASES format.

def g(plan, limit, k=1, conc=1, ff=False, cancel=True, stop=True, pause=True, deadline=True, delete=True, fault="none",
      cmd="queue", lose=False, elsewhere="command", others=()):
    assert elsewhere in ("command", "any") and set(others) <= {"chat", "delete_after", "retry"}
    return dict(Plan=f'"{plan}"', Limit=limit, K=k, Conc=conc, FailFast=ff, AllowCancel=cancel, AllowStop=stop,
                AllowPause=pause, AllowDeadline=deadline, AllowDelete=delete, Cmd=f'"{cmd}"', AllowLoseHint=lose, Fault=f'"{fault}"',
                Elsewhere=f'"{elsewhere}"', OtherEnds="{" + ", ".join(f'"{o}"' for o in others) + "}")

R3_ALL = ("chat", "retry", "delete_after")
R3_LIVEENDS = ("chat", "retry")
R3_INV = G_INV + ["Inv_NoAdmitAfterAccept", "Inv_NoCollectAfterEnd", "Inv_NoRouteWhilePaused", "Inv_NoFailWhilePaused",
                  "Inv_ReportOnlyEnded", "Inv_ReportAfterChildren", "Inv_DeletedNotReported", "Inv_NoticeFollowsWinner"]
R3_LIVE = ["Prop_ControllerEnds", "Prop_RunEnds", "Prop_CommandEnds", "Prop_CommandTold", "Prop_EndedElsewhereReported",
           "Prop_EndReported", "Prop_ChildrenEnded", "Prop_DeletedChildrenEnded"]
# a quiet environment: no command, stop, pause, run deadline or deletion unless a case enables it
R3_QUIET = dict(cancel=False, stop=False, pause=False, deadline=False, delete=False)

def r3q(**over):
    kw = dict(R3_QUIET, fault="srt1")
    kw.update(over)
    return kw

R3_GRAPH = [
 # ---- 9a8d0f66 (Elsewhere = "any"): every source of another end, direct commands, S-RT1 ----
 ("graph.r3-linear", "WfGraph", "reviewed", "Spec",
  g("linear", 4, fault="srt1", cmd="direct", lose=True, elsewhere="any", others=R3_ALL), R3_INV, ["Prop_FirstEndWins"], "PASS",
  "S7-DX3 at 9a8d0f66: with direct commands, the owning chat's end, deletions (also after the end) and end retries, the parent is told at most once, only of an ended run, after its children, never of a deleted run, never by a losing command."),
 ("graph.r3-loop", "WfGraph", "reviewed", "Spec",
  g("loop", 4, fault="srt1", cmd="direct", lose=True, elsewhere="any", others=R3_ALL), R3_INV, ["Prop_FirstEndWins"], "PASS",
  "S7-DX3 at 9a8d0f66 on a loop that reaches its node limit (finishRun's elsewhere answer): the same rules."),
 ("graph.r3-par", "WfGraph", "reviewed", "Spec",
  g("par", 7, 2, 2, True, fault="srt1", cmd="direct", lose=True, elsewhere="any", others=R3_ALL), R3_INV, ["Prop_FirstEndWins"], "PASS",
  "S7-DX3 at 9a8d0f66 on a parallel state, two branches at once, failFast: the same rules."),
 ("graph.r3-live-linear", "WfGraph", "reviewed", "LiveSpec",
  g("linear", 4, fault="srt1", cmd="direct", lose=True, elsewhere="any", others=R3_LIVEENDS), [], R3_LIVE, "PASS",
  "S7-DX3 at 9a8d0f66: every end by another writer but a deletion is reported once after its children are ended; a deletion ends the children only; the controller ends. No deletion after an end (graph.r3-delete-after-cmd)."),
 ("graph.r3-live-loop", "WfGraph", "reviewed", "LiveSpec",
  g("loop", 4, fault="srt1", cmd="direct", lose=True, elsewhere="any", others=R3_LIVEENDS), [], R3_LIVE, "PASS",
  "S7-DX3 at 9a8d0f66 on a loop: the same progress rules."),
 ("graph.r3-live-par", "WfGraph", "reviewed", "LiveSpec",
  g("par", 7, 2, 1, True, fault="srt1", cmd="direct", lose=True, elsewhere="any", others=R3_LIVEENDS), [], R3_LIVE, "PASS",
  "S7-DX3 at 9a8d0f66 on a parallel state, one branch at a time, failFast: the same progress rules."),
 # ---- what changed: minimal pairs, 9a8d0f66 (PASS) and 1ef53967 (comparison) ----
 ("graph.r3-chat-reported", "WfGraph", "reviewed", "LiveSpec",
  g("linear", 4, cmd="direct", elsewhere="any", others=("chat",), **r3q()), [], ["Prop_EndedElsewhereReported"], "PASS",
  "S7-DX3 N-1: a run its owning chat's end cancelled (no command, no deletion) is reported by its controller (endedElsewhere -> reportEnded)."),
 ("cmp.graph-r3-chat-unreported-1ef", "WfGraph", "comparison", "LiveSpec",
  g("linear", 4, cmd="direct", elsewhere="command", others=("chat",), **r3q()), [], ["Prop_EndedElsewhereReported"], "liveness",
  "1ef53967's endedElsewhere told the parent only after an accepted command's end (commandEndOf): the chat's end, found by the collection, ends the children only."),
 ("graph.r3-finish-deleted", "WfGraph", "reviewed", "Spec",
  g("linear", 4, cmd="direct", elsewhere="any", **r3q(delete=True)), ["TypeOK", "Inv_DeletedNotReported", "Inv_OneReport", "Inv_ReportOnlyEnded"], [], "PASS",
  "S7-DX3 N-1: a terminal's finish that finds the run deleted answers elsewhere; endedElsewhere ends the children and tells no one."),
 ("cmp.graph-r3-finish-deleted-1ef", "WfGraph", "comparison", "Spec",
  g("linear", 4, cmd="direct", elsewhere="command", **r3q(delete=True)), ["TypeOK", "Inv_DeletedNotReported"], [], "safety",
  "1ef53967 (Q1): a terminal's finish that found the run ended reported it (reportEnded), a deleted run's too: the parent was told of a deletion."),
 ("graph.r3-queue-loser", "WfGraph", "reviewed", "Spec",
  g("linear", 4, cmd="queue", elsewhere="any", others=("chat",), **r3q(cancel=True, delete=True)),
  ["TypeOK", "Inv_NoticeFollowsWinner", "Inv_DeletedNotReported", "Inv_OneReport", "Inv_ReportOnlyEnded", "Inv_NoCollectAfterEnd"], [], "PASS",
  "S7-DX3 N-2: an older build's queued cancel read after the chat's end or a deletion won: applyCommand's cancel answers elsewhere and the stored end decides the notice."),
 ("cmp.graph-r3-queue-loser-1ef", "WfGraph", "comparison", "Spec",
  g("linear", 4, cmd="queue", elsewhere="command", others=("chat",), **r3q(cancel=True, delete=True)),
  ["TypeOK", "Inv_NoticeFollowsWinner"], [], "safety",
  "1ef53967 (N-2): applyCommand told the parent with the requester of a queued command that lost to another end (and of a deleted run)."),
 # ---- finding R3-G1 at 9a8d0f66: a deletion after another end drops that end's notice ----
 ("graph.r3-delete-after-cmd", "WfGraph", "reviewed", "LiveSpec",
  g("linear", 4, cmd="direct", lose=True, elsewhere="any", others=("delete_after",), **r3q(cancel=True, delete=True)), [], ["Prop_EndReported"], "liveness",
  "Finding R3-G1 at 9a8d0f66: a cancel accepted (the run ends cancelled), then the workflow deleted before its controller's observeEnd: deleted is read from the session, so the cancel's end is never told."),
 ("cmp.graph-r3-delete-after-cmd-1ef", "WfGraph", "comparison", "LiveSpec",
  g("linear", 4, cmd="direct", lose=True, elsewhere="command", others=("delete_after",), **r3q(cancel=True, delete=True)), [], ["Prop_EndReported"], "PASS",
  "1ef53967: endedElsewhere decided by the stored end (commandEndOf), so a cancel's end deleted later was still told."),
 ("graph.r3-delete-after-retry", "WfGraph", "reviewed", "LiveSpec",
  g("linear", 4, elsewhere="any", others=("retry", "delete_after"), **r3q(delete=True)), [], ["Prop_EndReported"], "liveness",
  "Finding R3-G1, own end: the terminal's finish commits completed, the worker crashes, the workflow is deleted, the retry answers elsewhere: the completion is never told."),
 # ---- reachability of the new paths ----
 ("wit.graph-r3-chat-reported", "WfGraph", "witness", "Spec",
  g("linear", 4, cmd="direct", elsewhere="any", others=("chat",), **r3q()), ["TypeOK", "Wit_ChatEndReported"], [], "safety",
  "S7-DX3: the chat's end is found and reported by the controller (reachable)."),
 ("wit.graph-r3-retry-observed", "WfGraph", "witness", "Spec",
  g("linear", 4, elsewhere="any", others=("retry",), **r3q()), ["TypeOK", "Wit_RetryObserved"], [], "safety",
  "S7-DX3: a retried finish of the controller's own end reaches endedElsewhere (reachable)."),
]
