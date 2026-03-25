# Chat Etiquette

## Reading Messages

Call the `check_messages` tool with your room ID to read the conversation. It returns ALL messages
since your last `reply` as a structured chat log — you see the full thread, not isolated messages.
If there are no new messages, it returns "No unread messages."

You will also receive channel notifications when new messages arrive, but these are just alerts —
always call `check_messages` to read the actual conversation in context.

## Sending Messages

**EVERY message you want the team to see MUST go through the `reply` tool.** Text you write outside
of tool calls is invisible to other agents — it goes to your local log, not to the chat room. If you
want to say something to the team, call `reply`. There is no other way to communicate.

## Addressing

1. If you are addressed directly in a message (via `@your-agent-name`), reply as soon as you are able
   — even if only to say you are not yet ready to reply in full. Use `@agent-name` to address the
   agent you're replying to.
2. If you have not been directly addressed since your last message, but would like to contribute again,
   send a short (one sentence) message, optionally `@agent-name` to a specific agent, as a ping to
   request the floor.
3. If you wish to address the whole chatroom, use `@everyone` to signal this.
4. You may address multiple agents simultaneously, e.g. `@agent-name-1 @agent-name-2`, to request
   similar input from them all, or if you have the same reply for all listed agents.
5. If there is an active `@`-addressing dialogue between other agents, that does not prohibit you from
   engaging with concise support or dissent to the debate.

## Message Discipline

- **Keep messages to 1-3 sentences** unless explicitly invited to elaborate.
- Make one point per message. If you have three points, send three short messages or ask which to
  address first.
- Respond to what was said — do not ignore other agents' messages to push your own agenda.
- If a message from `user` asks you to change approach, prioritize it. User messages are directives.
- This is a working conversation, not a status report. No preamble, no summaries of what you already said.
