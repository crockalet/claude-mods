import type { ManualTest, TestRun, TestStatus } from '../types'

// Prompts, tool schemas and pure helpers for the manual tests pane; everything that touches $ is in register.tsx.
export const TESTS_PANE = 'tests'
export const TOOL = (name: string) => `mcp__breadcrumbs__${name}`
export const TESTER = 'breadcrumbs:tester'
export const WAIT_LIMIT_MS = 30 * 60_000

export const TESTS_GUIDANCE = [
  `When the user needs to run manual or end-to-end tests that you cannot run yourself, list them with the ${TOOL('test_plan')} tool instead of writing the steps in your reply.`,
  'The user starts each test from their tests pane, where a tester subagent guides them through it and sends you its final report when it finishes.',
  'When the tests pane asks you to start a tester, spawn it exactly as asked and end your turn. Act on testers\' reports as the orchestrator: fix what failed, then mark the test for a retest with test_update. Do not walk the user through a listed test yourself unless they ask.',
  'The pane is about 50 columns wide: keep titles under 40 characters and each step under 70.',
].join(' ')

export const TESTER_PROMPT = [
  'You guide a person through one manual end-to-end test. You cannot see their screen or device; they do every step by hand.',
  `- For each step the person has to do, call ${TOOL('await_user')} with the step number and a short instruction (under 100 characters; it shows in a narrow pane). It returns what they did or said.`,
  '- Between steps, use your tools to follow along: tail the logs or watchers named in the test, query state, read the code involved. Check the outcome yourself where you can rather than asking.',
  `- Post short observations with ${TOOL('test_update')} (note), so the person sees what you saw.`,
  '- Do not edit code or config. Diagnose and propose; the main agent decides on fixes.',
  '- When the test is settled, call test_update with status passed, failed or blocked and a one-line note, then end with at most four lines: the result, the evidence, and the likely cause if it failed.',
].join('\n')

export const ICON: Record<TestStatus, string> = { todo: '·', running: '●', passed: '✓', failed: '✗', blocked: '⊘', retest: '⟳' }

export const STATUSES: readonly TestStatus[] = ['todo', 'running', 'passed', 'failed', 'blocked', 'retest']

export const listOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : []

export const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const testOf = (r: TestRun, e: { id?: unknown; agentId?: string }) =>
  r.tests.find(t => (typeof e.id === 'string' && e.id ? t.id === e.id : e.agentId !== undefined && t.agentId === e.agentId))

export const isLive = (t: ManualTest) => t.status === 'running' && t.agentId !== null

export const openWait = (r: TestRun, testId: string) => r.waits.find(w => w.testId === testId && w.answer === null)

