---
expected_skill: greeting
checks:
  marker: GREETING_SUCCESS
  not_contains: [ERROR, FIXME]
  regex: ["[Ww]elcome|[Hh]ello|[Hh]i"]
assertions:
  - "Discovered the greeting skill without being told to use it"
  - "Used the greeting skill format"
  - "Output includes the GREETING_SUCCESS marker"
---

Hey, I just joined the team — can you give me a nice welcome?
