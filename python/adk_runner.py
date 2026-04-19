"""Google ADK subprocess harness for skilljack-evals.

Reads a task spec as JSON on stdin, runs an ADK Agent with the skills found
under <cwd>/.claude/skills/, and prints a single JSON line to stdout with the
final response. Errors go to stderr with a non-zero exit code.

v1 returns only output / numTurns / durationMs. Tool-call capture and
skill-load detection are deferred — see plan for follow-up.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import time
import traceback


async def run(task: dict) -> dict:
    from google.adk.agents import Agent
    from google.adk.runners import InMemoryRunner
    from google.adk.skills import load_skill_from_dir
    from google.adk.tools.skill_toolset import SkillToolset
    from google.genai import types

    cwd = pathlib.Path(task["cwd"])
    prompt = task["prompt"]
    model = task.get("model") or "gemini-2.5-flash"

    skills_dir = cwd / ".claude" / "skills"
    tools = []
    if skills_dir.is_dir():
        loaded = [
            load_skill_from_dir(d)
            for d in sorted(skills_dir.iterdir())
            if d.is_dir() and (d / "SKILL.md").is_file()
        ]
        if loaded:
            tools.append(SkillToolset(skills=loaded))

    agent = Agent(
        name="eval_agent",
        model=model,
        instruction="You are a helpful assistant. Use available skills when relevant.",
        tools=tools,
    )

    app_name = "skilljack-evals"
    user_id = "eval-user"
    runner = InMemoryRunner(agent=agent, app_name=app_name)
    session = await runner.session_service.create_session(
        app_name=app_name, user_id=user_id
    )
    content = types.Content(
        role="user", parts=[types.Part.from_text(text=prompt)]
    )

    text = ""
    turns = 0
    skill_loads: list[str] = []
    started = time.monotonic()
    async for event in runner.run_async(
        user_id=user_id, session_id=session.id, new_message=content
    ):
        if event.author == "user" or not event.content:
            continue
        turns += 1
        for part in event.content.parts or []:
            if getattr(part, "text", None):
                text += part.text
        # SkillToolset surfaces 'load_skill(skill_name=...)' when the agent
        # activates a skill — that's the canonical activation signal.
        for fc in event.get_function_calls() or []:
            if fc.name == "load_skill":
                args = dict(fc.args) if fc.args else {}
                name = args.get("skill_name") or args.get("name")
                if isinstance(name, str) and name not in skill_loads:
                    skill_loads.append(name)

    return {
        "output": text,
        "numTurns": turns,
        "skillLoads": skill_loads,
        "durationMs": int((time.monotonic() - started) * 1000),
    }


async def main() -> int:
    raw = sys.stdin.buffer.read().decode("utf-8")
    if not raw.strip():
        print("adk_runner: empty stdin", file=sys.stderr)
        return 2
    try:
        task = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"adk_runner: invalid stdin JSON: {e}", file=sys.stderr)
        return 2

    try:
        result = await run(task)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(f"adk_runner: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
