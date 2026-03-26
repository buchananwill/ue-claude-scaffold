# Buttons Should Be Links

## Main Button Problems

1. On the web dashboard, none of the buttons that behave links produce a standard "link" context menu when
   right-clicked.
   There should be "open in new tab" etc.
2. The different task statuses use opaque React state to store whether they are active. More useful would be URL search
   params, so that specific filter sets could be "bookmarked"
3. Sorting should also be searchParam-driven
4. There is no global state, so navigating `Overview -> Chat -> Overview` causes any filter/sorting settings to be lost.
   Poor UX.

## Other Overview Problems

1. No data available on how long an agent has been working on a task. This could be easily tracked/retrieved via the
   database.
2. `In Progress` and `Failed` don't seem to be used at all by the task status system.

## Messages Problems

1. No way to filter messages via agent sender.
2. Build start/end and test start/end have never been used by an agent. Is the protocol missing something, or should
   they simply be deprecated/removed?
3. Text search should support "show all matching" as well as click to go to a specific result.
4. OnBlur does not close the search. OnBlur should close search without deleting the entered value, so you can click
   away and then pick up again if you were in the middle of searching for something.