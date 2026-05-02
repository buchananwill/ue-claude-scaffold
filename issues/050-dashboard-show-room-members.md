---
title: "Dashboard should display the current member list of every chat room"
priority: medium
reported-by: interactive-session
date: 2026-04-29
status: open
---

# Dashboard should display the current member list of every chat room

## Required behaviour

Every chat room visible in the dashboard must show its current set of members. The list must reflect actual `room_members` rows for the room — i.e. the agents who can post to and read from that room — not the team definition's intended roster, which can diverge from reality.

The display must be visible without drilling into a room: a count or compact member list on the room overview is sufficient, with the full list available on the room detail view.

## Why this is needed

On 2026-04-29 the resort-vehicle-configurator team launch produced six containers that registered, started their MCP servers, attached to the chat room, and then silently failed every `reply` and `check_messages` call with `not_a_member` / HTTP 403. The room existed; the agents existed; the agents simply weren't in `room_members`. The cause was a regression in `team-launcher.ts` (Phase 9 decomp split `createWithRoom` into separate calls and dropped the member-population step). The dashboard showed the room and the team as healthy throughout, because neither view surfaces the room's actual member list.

A members-on-room display would have shown an empty member list at launch time and made the disconnect between "room exists" and "agents can talk in it" immediately obvious.
