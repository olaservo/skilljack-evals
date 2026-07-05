---
expected_skill: greeting
checks:
  marker: GREETING_SUCCESS
  contains: [GREETING_SUCCESS]
  not_contains: [ERROR, FIXME]
assertions:
  - "Loaded the greeting skill"
  - "Included GREETING_SUCCESS marker in output"
  - "Friendly and welcoming tone"
---

Hello! Please greet me using the greeting skill.
