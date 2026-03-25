# Design Teams Not Inter-Communicating

## Main Issue: No Feedback Loop Established

Summarized transcript of team discussion:

```
user

13 minutes ago
Brief: `Notes/docker-claude/briefs/guest-behaviour-docs.md` -- read this file from your workspace to begin.

critic-1

9 minutes ago
I've read the brief and completed a deep review of the implementation. Here's my initial critic's assessment of the key design questions before we start drafting.

/* ... detailed criticisms ...*/

Ready to engage with proposals from the team. My main concern will be ensuring the document doesn't over-describe what might be (speculative architecture) at the expense of what *is* (grounded in the code paths above).

domain-1

9 minutes ago
I'm domain-1, joining as domain expert. I've done a deep read of the guest behaviour system — the brief, the original design draft (`resort-guest-behaviour-tree.md`), and the full implementation source. Here's what I can contribute:

/* ... domain summary... */

Ready to contribute to drafting the document. What's the team's working approach?

architect-1

8 minutes ago
I've completed my initial codebase analysis. Here's an architectural summary to ground our discussion and frame the document structure.

/* ... architect summary */

I'll wait for feedback before drafting. Particularly interested in whether the team agrees with collapsing the outcome taxonomy to just `FModifyAffectOutcome`, and whether the document should say anything about what a future "field became unavailable" response looks like beyond what the prerequisite validation plan already covers.

chairman-1

8 minutes ago
## Guest Behaviour Vision Document — Kickoff

Team, we're writing `Notes/guest-behaviour/resort-guest-behaviour-vision.md` — a successor to the original `resort-guest-behaviour-tree.md` that describes the system **as it actually exists today**.

/* ... various comments... */

### Questions for the team

**Architect:** Please propose the document structure. How should we organize the vision doc to cover: system overview, stack lifecycle, evaluation pipeline, outcome system, field tag management, and the prescribed removals?

**Critic:** Looking at the four outcome types — three of which emit `NAME_None` and have no resolution logic — what's the real risk profile here? Are these dead code, or do they have structural effects I'm missing? Also: is the "silent skip" approach for prerequisite validation (from the plan doc) the right failure mode, or should the vision doc prescribe something else?

**Domain:** Please verify my reading of `ResolveOutcomes` (lines 451-516 of `WorldBehaviourContext.cpp`). It only resolves `FModifyAffectOutcome` into `FResolvedAffectWrite`. The other three outcome types are silently skipped because they return `NAME_None` or aren't `FModifyAffectOutcome`. Is there any other code path where `FCancelBehaviourOutcome` or `FRemoveAllFieldTagsOutcome` actually takes effect?
```

After which all the containers shut down and sent no further messages. I checked the docker logs and the containers were
indeed shutdown:

```
$  docker logs claude-chairman-1-claude-worker-1 --tail 30
Branch: docker/chairman-1
Type:   design-chairman
Turns:  200

Cloning from local bare repo...
Cloning into '/workspace'...
done.
Your branch is up to date with 'origin/docker/chairman-1'.
HEAD is now at 7b1aff24 moves debrief archive into debriefs. Adds Notes/briefs folder to team design work.
Build hooks disabled (design agent mode)
Symlinked /plugins-ro/Voxel -> /workspace/Plugins/Voxel
Symlinked /plugins-ro/UE5Coro -> /workspace/Plugins/UE5Coro
Registered with coordination server (token: 5342c783...)
Skipping instruction (chat-only mode): 00-build-loop.md
Skipping instruction (chat-only mode): 01-debrief.md
Loading instruction: 02-chat.md
Skipping instruction (chat-only mode): 03-messages.md
Skipping instruction (chat-only mode): 04-task-worker.md
Chat-only mode: room=guest-behaviour-docs, role=chairman
Prompt assembled (1600 bytes)

Starting Claude Code...

Now I'll wait for the team's responses before proceeding.

=== Claude Code exited with code 0 ===
Everything up-to-date
Final state pushed to bare repo

=== Shutting down agent chairman-1 ===
```

I have two leading hypotheses:

1) The messages sent into the chat room as a group do not result in "pings" for the agents via the MCP server. They
   aren't seen as "addressed to the agent", so the agent receives no notification that there is communication for it.
2) The mode in which the agents are launched doesn't have any "keep alive" loop. They're launched as "one-shots", and
   after reading the initial brief they see no pending communications and consider the work done, so they shut down.

Can we verify/refute either of these theories, and/or propose your own?

## Secondary Issue: Wall-of-text Introductions

The agents read the brief, did isolated research cycles, and then each produced a similar but scope-oriented
wall-of-text as their _first_ message to the chat. There was no handshake, hello, or ceremony. The design team concept
will derive its values (if it can escape the prototyping stage) from _transparent dialectic_. The agents must be given
instructions to begin the meeting with each performing a short hello/handshake, to establish that the whole room is
present. They should then continue the discussion by way of _short_, _focused_, _mediated_ talking points. The chairman
needs to _chair the meeting_. They need a protocol that instructs them to communicate with reciprocity and etiquette,
alongside pushing their own point of view. They need to keep messages to only 1-3 sentences, _unless they're invited by
the chairman to "talk" at greater length_.