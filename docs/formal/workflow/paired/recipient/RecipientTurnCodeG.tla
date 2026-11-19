------------------------- MODULE RecipientTurnCodeG -------------------------
(***************************************************************************)
(* Independent code comparison against the amended intent proposal        *)
(* RecipientTurnSpecG. The code model RecipientTurnCode (5df032f1; the    *)
(* orchestration files are byte-identical at 009109e2) is EXTENDED, not    *)
(* changed: same variables, same Next, same Spec. Only a second mapping is *)
(* added. The gate variables map one to one; the code's witness values map *)
(* to the design's three: sent -> "yes"; unsent, notrun -> "no"; threw,    *)
(* none -> "unknown" (no explicit mapping needed: refinement is checked on *)
(* state pairs). The code's WorkspaceCommand maps to GateWaitEnds.         *)
(* GateRule "code" is compared with GateResume "revalidated"; the         *)
(* hypothetical "design" rule with "timer_only" (positive control).       *)
(*                                                                         *)
(* Boundary assumption A-WITNESS (not checked here): the worker's witness  *)
(* says "sent: true" only if the model request including the items may    *)
(* have been issued, and "sent: false" only if it was not; an adopted      *)
(* result keeps its own witness or none. At 5df032f1/22be2ba4 this did not *)
(* hold (W2-WIT1, W2-WIT2); 009109e2 changes the worker side for it, see  *)
(* W2-GATE-AMENDMENT.md.                                                   *)
(***************************************************************************)
EXTENDS RecipientTurnCode

G == INSTANCE RecipientTurnSpecG WITH
        inv <- sinv, nTurns <- nTurns, cur <- scur, held <- sheld,
        firstSent <- firstSent, interposed <- interposed, badRide <- badRide,
        badOwn <- badOwn, badLatched <- badLatched,
        gateOpen <- gateOpen, gateWait <- gateWait, flips <- flips, passed <- passed,
        MaxTurns <- MaxTurns, MaxRetries <- MaxRetries, MaxGateFlips <- MaxGateFlips,
        GateResume <- IF GateRule = "code" THEN "revalidated" ELSE "timer_only"

RefinesG == G!SpecG

=============================================================================
