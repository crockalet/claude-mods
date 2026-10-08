import type { ManualTest, TestRun, TestStatus } from '../types'

// Prompts, tool schemas and pure helpers for the manual tests pane; everything that touches $ is in register.tsx.
export const TESTS_PANE = 'tests'
export const TOOL = (name: string) => `mcp__breadcrumbs__${name}`
export const TESTER = 'breadcrumbs:tester'
export const WAIT_LIMIT_MS = 30 * 60_000

export const TESTS_GUIDANCE = [
  `When the user needs to run manual or end-to-end tests that you cannot run yourself, list them with the ${TOOL('test_plan')} tool instead of writing the steps in your reply.`,
  'The user starts each test from their tests pane, where a tester subagent guides them through it and sends you its final report when it finishes.',
  'You are the planner. Give test_plan a brief that every tester reads first and trusts without re-checking: what the change does, the environment (devices, builds, servers and how to reach them), how to observe results (log tags, commands, signals known to mislead) and what is already verified.',
  'Before listing, make sure every step can actually happen, checked against the code and the setup; testers do not re-check. Do the preconditions you can check yourself (builds, deploys, registrations) instead of making them a test.',
  'For each test, trigger names the code that produces the expected signal and what decides whether it fires ("ride_ended is sent by completeRide() in rides.ts, from the driver app only"), so a step never takes a path that skips it; assumes lists what you could not check in the code (one ride per driver at a time, how another agent will behave); needs lists ids of tests that must pass first. Testers run on a fast default model; set model "opus" on a test only when the tester will have to diagnose something subtle.',
  'Group by physical setup: one setup such as a single ride can verify several behaviours, so prefer fewer, longer tests. Steps are only what the person does by hand; checks you or the tester run go in expect or watch, and each expect names a signal that tells a pass from a fail.',
  'After each tester report, revise the tests still to run with test_update: new steps or expect, status blocked with the reason when one can no longer be done or failed when an earlier result already decides it, and new facts added to the brief.',
  'A tester may hand back a question instead of a report ("[tester asks · manual test …] …"). It is paused with its setup still running, so fix what it needs if you can (rebuild, restart a server, sync data), then answer with test_update: its id and reply, plus new steps or expect if they change, and send the message it gives you to the tester with SendMessage, which resumes it. Reply "end the test" when it should stop.',
  'When the tests pane asks you to start a tester, spawn it exactly as asked and end your turn. Act on testers\' reports as the orchestrator: fix what failed, then mark the test for a retest with test_update. Do not walk the user through a listed test yourself unless they ask.',
  'The pane can be narrow: keep titles under 40 characters and each step under 70.',
].join(' ')

export const TESTER_PROMPT = [
  'You guide a person through one manual end-to-end test. You cannot see their screen or device; they do every step by hand.',
  '- The planner wrote the brief and the test and already checked the steps can be done. Trust the brief: do not re-verify the environment, tooling or facts it states; start the test straight away and read code only to explain a result.',
  `- When a step turns out to be impossible, the setup breaks (a watcher or server dies, data or config is missing) or a result fails in a way the planner could fix, call ${TOOL('ask_planner')} with what you saw and what you need, then end your turn as it says. The planner fixes things or revises the steps, and its reply resumes you in the same run with the same setup.`,
  '- Do not swap in a different path to the same end on your own. End the test as blocked or failed only when the planner says to or does not answer.',
  '- Before the first step, start one background capture of the logs or watchers named in the test and note its PID. Check it at checkpoints and analyse it in full at the end.',
  `- Hand the person steps with ${TOOL('await_user')}. Put a run of steps they can do without stopping in one call (steps, step = the first one's number), and stop only at a checkpoint: where the result decides whether the remaining steps still make sense, or where only the person can see the result (screen, notification tray).`,
  '- When you ask the person something, put the question in instruction and give 2 to 4 short answer options ("Gone", "Still there", "Not sure"). Leave options out for plain actions; they then get Done and Can\'t.',
  `- Post short observations with ${TOOL('test_update')} (note), so the person sees what you saw.`,
  '- When an expected signal does not show, check the test\'s trigger first: say whether the steps reached that code path, and if an assumption turned out wrong, say which.',
  '- Do not edit code or config. Diagnose and propose; the main agent decides on fixes.',
  '- Before your final report, kill every background process you started; keep them while you wait on ask_planner.',
  '- When the test is settled, call test_update with status passed, failed or blocked and a one-line note, then end with at most five lines: the result, the evidence, the likely cause if it failed, and anything you learned that affects the tests still to run.',
].join('\n')

export const ICON: Record<TestStatus, string> = { todo: '·', running: '●', passed: '✓', failed: '✗', blocked: '⊘', retest: '⟳' }

export const STATUSES: readonly TestStatus[] = ['todo', 'running', 'passed', 'failed', 'blocked', 'retest']

export const listOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : []

export const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const testOf = (r: TestRun, e: { id?: unknown; agentId?: string }) =>
  r.tests.find(t => (typeof e.id === 'string' && e.id ? t.id === e.id : e.agentId !== undefined && t.agentId === e.agentId))

// Ids this test needs that have not passed yet.
export const unmet = (r: TestRun, t: ManualTest): string[] =>
  (t.needs ?? []).filter(id => r.tests.find(x => x.id === id)?.status !== 'passed')

// A test whose prerequisite failed or was blocked cannot run either.
export const settleNeeds = (r: TestRun, at: number): TestRun => ({
  ...r,
  tests: r.tests.map(t => {
    if (t.status !== 'todo' && t.status !== 'retest') return t
    const dead = r.tests.find(x => (t.needs ?? []).includes(x.id) && (x.status === 'failed' || x.status === 'blocked'))
    if (!dead) return t
    const text = `${ICON.blocked} needs test ${dead.id}, which ${dead.status === 'failed' ? 'failed' : 'is blocked'}`
    return { ...t, status: 'blocked', log: [...t.log, { from: 'claude', text, at }].slice(-30) }
  }),
})

export const isLive = (t: ManualTest) => t.status === 'running' && t.agentId !== null

export const openWait = (r: TestRun, testId: string) => r.waits.find(w => w.testId === testId && w.answer === null)

