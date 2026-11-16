# r3 (WfParent at 9a8d0f66, deployed check DS-2). Exec this after gen-cases.py's helpers (g, a, p, ...).
# It replaces p() with one that takes `latestart` (AllowLateStart; default False = the r2 behaviour) and defines
# R3_PARENT, new case tuples in the CASES format:
#   (id, module, mode, spec, constants, invariants, properties, expected, note)

def p(kind="send", flag="omitted", crashes=1, ext=False, pcancel=True, pend=False, fifo=False, evict=False, fault="none",
      back=False, turnfails=1, head="efe44835", wait=False, zombie=False, notifiers=1, statusrace=True, ntzombie=False,
      recover=False, maxrec=0, recafter=False, latestart=False):
    return dict(MKind=f'"{kind}"', StartFlag=f'"{flag}"', MaxCrashes=crashes, AllowExternalEnd=ext, AllowParentCancel=pcancel,
                AllowParentEnd=pend, AllowFifoFull=fifo, AllowEvict=evict, AllowClockBack=back, MaxTurnFails=turnfails,
                Fault=f'"{fault}"', AllowWaitTimeout=wait, AllowZombie=zombie, NumNotifiers=notifiers,
                AllowStatusRace=statusrace, AllowNtZombie=ntzombie, AllowRecover=recover, MaxRecovers=maxrec,
                RecoverAfterRelease=recafter, AllowLateStart=latestart, Code=f'"{head}"')

DS2 = "9a8d0f66"          # fc6d7a65's notice path + DS-2 (b3c58aa9, in the squash d7c3ca68): a NotFound parent keeps a note
NOTETX = "proposedNoteTx"  # the r3 fix: the note and its skip in one transaction
E3B_R3 = "fc6d7a65"        # the code before DS-2

# Every parent safety rule that holds at 9a8d0f66 (not Inv_NotifiedAccepted: WFO-3's status race; not Inv_ToldOnce: the r3 finding).
P_INV_R3 = ["TypeOK", "Inv_EndedIsLast", "Inv_GivenOnce", "Inv_SkipMeansNotGiven", "Inv_NotifiedXorSkipped",
            "Inv_NoDecisionAfterExpiry", "Inv_NotedMeansKept", "Inv_NoNoteAfterGone", "Inv_NoteGivenConsumed", "Inv_NoteIsLast"]
P_LIVE_R3 = ["Prop_ParentToldEnd", "Prop_NoteGivenAtTurn", "Prop_ParentLearnsEnd"]

R3_PARENT = [
 # ---- r3: 9a8d0f66 (DS-2) ----
 ("parent.r3-safety-send", "WfParent", "reviewed", "Spec",
  p(ext=True, pend=True, zombie=True, notifiers=2, ntzombie=True, latestart=True, head=DS2), P_INV_R3, [], "PASS",
  "9a8d0f66: a parent that starts late (or is deleted first, or deleted with its orchestration), a send, other ends, a delivery zombie, a second notifier, a timed-out lock holder, a crash: the note path keeps every safety rule but told-once."),
 ("parent.r3-safety-request", "WfParent", "reviewed", "Spec",
  p("request", ext=True, pend=True, back=True, zombie=True, notifiers=2, ntzombie=True, latestart=True, head=DS2), P_INV_R3, [], "PASS",
  "9a8d0f66: the same with a request, its deadline and clock steps (parent.safety-e3b with a parent that starts late)."),
 ("parent.r3-live-send", "WfParent", "reviewed", "LiveSpec",
  p(ext=True, pend=True, latestart=True, head=DS2), [], P_LIVE_R3, "PASS",
  "9a8d0f66: a parent that starts after the run ended is given the end through its note at a turn; a started parent through the notice."),
 ("parent.r3-live-request", "WfParent", "reviewed", "LiveSpec",
  p("request", ext=True, pend=True, wait=True, zombie=True, notifiers=2, ntzombie=True, latestart=True, head=DS2), [], P_LIVE_R3, "PASS",
  "9a8d0f66: the same with a request, the wait's bound, a delivery zombie, a second notifier and a timed-out lock holder."),
 ("parent.r3-live-off", "WfParent", "reviewed", "LiveSpec",
  p(flag="false", ext=True, pend=True, latestart=True, head=DS2), [], ["Prop_ParentToldEnd"], "PASS",
  "9a8d0f66 with notifications off: the skip is recorded, no note is kept."),
 ("parent.r3-told-once-nocrash", "WfParent", "reviewed", "Spec",
  p("request", ext=True, pend=True, crashes=0, notifiers=2, ntzombie=True, latestart=True, head=DS2), ["TypeOK", "Inv_ToldOnce"], [], "PASS",
  "9a8d0f66 without a crash: the end is given once (the notice or the note), also with a second notifier and a timed-out holder."),
 ("parent.r3-note-is-last", "WfParent", "reviewed", "Spec",
  p(ext=True, pend=True, wait=True, zombie=True, notifiers=2, latestart=True, head=DS2), ["TypeOK", "Inv_NoteIsLast"], [], "PASS",
  "9a8d0f66: the note never comes before the run's message, even past the wait's bound (a NotFound parent was never sent the message)."),
 ("parent.r3-told-twice", "WfParent", "reviewed", "Spec",
  p(pcancel=False, latestart=True, head=DS2), ["Inv_ToldOnce"], [], "safety",
  "FINDING R3-P1 at 9a8d0f66: keepNote, then a crash before the skip is recorded; the parent starts and reads the note; the retry finds it running and queues the notice: the end twice."),
 ("parent.r3-wit-note-given", "WfParent", "witness", "Spec",
  p(pcancel=False, latestart=True, head=DS2), ["Wit_NoteGiven"], [], "safety",
  "9a8d0f66: a parent that started after the run ended reads the end in its note; the skip says kept as a note."),
 ("parent.r3-wit-note-for-gone", "WfParent", "witness", "Spec",
  p(pcancel=False, pend=True, latestart=True, head=DS2), ["Wit_NoteForGone"], [], "safety",
  "9a8d0f66: a parent deleted after the authority read (unstarted, or with its orchestration) gets a note it never reads, recorded as kept as a note."),
 # ---- r3 comparisons ----
 ("cmp.parent-r3-late-start-e3b", "WfParent", "comparison", "LiveSpec",
  p(pcancel=False, latestart=True, head=E3B_R3), [], ["Prop_ParentToldEnd"], "liveness",
  "fc6d7a65: a parent not started when the run ends is recorded as gone (skip), then starts and is never told."),
 ("cmp.parent-r3-learns-e3b", "WfParent", "comparison", "LiveSpec",
  p(pcancel=False, latestart=True, head=E3B_R3), [], ["Prop_ParentLearnsEnd"], "PASS",
  "fc6d7a65: the r2 progress rule counts that skip as an answer, so it does not see the late start (why r3 adds Prop_ParentToldEnd)."),
 ("cmp.parent-r3-told-once-e3b", "WfParent", "comparison", "Spec",
  p(pcancel=False, latestart=True, head=E3B_R3), ["TypeOK", "Inv_ToldOnce"], [], "PASS",
  "fc6d7a65 has no note: the duplicate of parent.r3-told-twice is new with DS-2."),
 ("cmp.parent-r3-fix-told-once", "WfParent", "comparison", "Spec",
  p(pcancel=False, latestart=True, head=NOTETX), P_INV_R3 + ["Inv_ToldOnce"], [], "PASS",
  "The R3-P1 fix: the note and its skip in one transaction; the end is given once."),
 ("cmp.parent-r3-fix-safety", "WfParent", "comparison", "Spec",
  p("request", ext=True, pend=True, zombie=True, notifiers=2, ntzombie=True, latestart=True, head=NOTETX), P_INV_R3 + ["Inv_ToldOnce"], [], "PASS",
  "The R3-P1 fix with a request, other ends, the parent's end, zombies and a second notifier."),
 ("cmp.parent-r3-fix-live", "WfParent", "comparison", "LiveSpec",
  p(ext=True, pend=True, latestart=True, head=NOTETX), [], P_LIVE_R3, "PASS",
  "The R3-P1 fix keeps the progress rules."),
 # Smaller settings for the two liveness cases that did not finish in 300 s (r3 run): one notifier, or no delivery zombie.
 ("parent.live-e3b-n1", "WfParent", "reviewed", "LiveSpec", p("request", ext=True, pend=True, wait=True, zombie=True, notifiers=1, ntzombie=True, head=E3B), [], ["Prop_ParentLearnsEnd"], "PASS",
  "fc6d7a65 as parent.live-e3b with one notifier: the parent learns the end."),
 ("parent.live-e3b-nozombie", "WfParent", "reviewed", "LiveSpec", p("request", ext=True, pend=True, wait=True, zombie=False, notifiers=2, ntzombie=True, head=E3B), [], ["Prop_ParentLearnsEnd"], "PASS",
  "fc6d7a65 as parent.live-e3b without a delivery zombie: the parent learns the end with two notifiers."),
 ("parent.r3-live-request-n1", "WfParent", "reviewed", "LiveSpec",
  p("request", ext=True, pend=True, wait=True, zombie=True, notifiers=1, ntzombie=True, latestart=True, head=DS2), [], P_LIVE_R3, "PASS",
  "9a8d0f66 as parent.r3-live-request with one notifier."),
 ("parent.r3-live-request-nozombie", "WfParent", "reviewed", "LiveSpec",
  p("request", ext=True, pend=True, wait=True, zombie=False, notifiers=2, ntzombie=True, latestart=True, head=DS2), [], P_LIVE_R3, "PASS",
  "9a8d0f66 as parent.r3-live-request without a delivery zombie, with two notifiers."),
]
