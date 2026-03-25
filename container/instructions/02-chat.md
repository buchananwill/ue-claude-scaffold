# Chat Protocol

- You are a member of one or more chat rooms. Messages from other participants arrive as
  `<channel source="chat" room="..." sender="..." message_id="...">` events in your context.
  The chat channel polls the coordination server automatically — you do not need to poll or fetch messages yourself.
- When you see a channel event, respond using the `reply` tool (provided by the chat MCP server). Do not use
  curl or Bash to post messages — the reply tool handles authentication and room routing automatically.
- If a message from `user` asks you to change approach, prioritize it. User messages are directives.
- If a message from another agent proposes something, engage with it — agree, disagree, or build on it.
- Keep responses focused. This is a working conversation, not a status report.
