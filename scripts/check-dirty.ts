/**
 * scripts/check-dirty.ts
 *
 * Regression test for the "fresh tab prompts on close" bug.
 *
 * The bug:
 *   When a user opened a file (OPEN_FILE) and immediately closed the tab
 *   without typing, the IDE showed an "unsaved changes" modal — incorrect
 *   behavior. The CLOSE_TAB reducer gates on `tab.dirty === true`, and
 *   the user decision was: `OPEN_FILE`, `OPEN_UNTITLED`, and `SET_CONTENT`
 *   must leave `dirty: false`. Only the editor's on-change handler
 *   (CodeMirrorEditor.handleChange → dispatch MARK_DIRTY true) should
 *   ever flip a tab dirty.
 *
 * This test:
 *   1. Builds a fresh IdeState with one file in the tree.
 *   2. Dispatches OPEN_FILE and asserts the new tab is `dirty === false`.
 *   3. Dispatches CLOSE_TAB and asserts no modal is opened
 *      (`state.modal === null`).
 *   4. Also verifies SET_CONTENT leaves dirty untouched (so the seed-
 *      from-disk path the editor takes when mounting a fresh tab can't
 *      accidentally mark the tab dirty).
 *
 * Run with: pnpm exec tsx scripts/check-dirty.ts
 */

import {
  reduce,
  makeInitialState,
  type IdeState,
  type IdeAction,
  type FileNode,
} from "../src/ide/store"

let failures = 0

function expect(got: unknown, expected: unknown, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`FAIL  ${label}`)

    console.error(`  expected: ${JSON.stringify(expected)}`)

    console.error(`  got:      ${JSON.stringify(got)}`)

    failures++
  } else {
    console.log(`PASS  ${label}`)
  }
}

function dispatch(state: IdeState, action: IdeAction): IdeState {
  return reduce(state, action)
}

const fileId = "src/foo.py"

const initialFile: FileNode = {
  id: fileId,

  name: "foo.py",

  kind: "file",

  parentId: "src",

  fileType: "python",
}

let state = makeInitialState()

state = { ...state, fileTree: [initialFile] }

// Step 1: dispatch OPEN_FILE and assert the new tab is dirty: false.

state = dispatch(state, { type: "OPEN_FILE", fileId })

const openedTab = state.tabs.find((t) => t.fileId === fileId)

expect(state.tabs.length, 1, "OPEN_FILE creates exactly one tab")

expect(openedTab?.dirty, false, "OPEN_FILE leaves the new tab clean")

// Step 2: dispatch CLOSE_TAB on it and assert no modal is opened.

const tabId = openedTab?.id

state = dispatch(state, { type: "CLOSE_TAB", tabId })

expect(state.modal, null, "CLOSE_TAB on a clean tab does not open the modal")

expect(state.tabs.length, 0, "CLOSE_TAB on a clean tab actually closes it")

// Step 3: re-open the file, then dispatch SET_CONTENT (the editor's

// seed-from-disk path does this when mounting), and assert dirty stays

// false. This is the load-bearing case: before the fix, the SET_CONTENT

// reducer flipped dirty: true for every caller, including this one,

// which is exactly what caused the original bug.

state = dispatch(state, { type: "OPEN_FILE", fileId })

const freshTab = state.tabs.find((t) => t.fileId === fileId)

expect(freshTab?.dirty, false, "OPEN_FILE on a re-opened tab leaves it clean")

state = dispatch(state, {
  type: "SET_CONTENT",

  fileId,

  content: "print('hello')\n",
})

const tabAfterSeed = state.tabs.find((t) => t.fileId === fileId)

expect(
  tabAfterSeed?.dirty,

  false,

  "SET_CONTENT (editor seed-from-disk path) leaves dirty untouched",
)

// Step 4: close the still-clean tab and assert no modal opens.

state = dispatch(state, { type: "CLOSE_TAB", tabId: tabAfterSeed?.id })

expect(
  state.modal,

  null,

  "CLOSE_TAB after SET_CONTENT does not open the modal",
)

expect(
  state.tabs.length,
  0,
  "CLOSE_TAB after SET_CONTENT actually closes the tab",
)

// Step 5: OPEN_UNTITLED must also start clean.

state = dispatch(state, { type: "OPEN_UNTITLED" })

const untitledTab = state.tabs[state.tabs.length - 1]

expect(untitledTab?.dirty, false, "OPEN_UNTITLED leaves the new tab clean")

// Step 6: simulate the editor's on-change flow. MARK_DIRTY(true) is what

// the editor's handleChange dispatches synchronously when the user types.

// After that, SET_CONTENT (debounced flush) must NOT clobber dirty back

// to false or otherwise alter it.

state = dispatch(state, {
  type: "MARK_DIRTY",
  tabId: untitledTab?.id,
  dirty: true,
})

const dirtyTab = state.tabs.find((t) => t.id === untitledTab?.id)

expect(dirtyTab?.dirty, true, "MARK_DIRTY(true) flips the tab dirty")

state = dispatch(state, {
  type: "SET_CONTENT",

  fileId: untitledTab?.fileId ?? "",

  content: "x = 1\n",
})

const dirtyTabAfterFlush = state.tabs.find((t) => t.id === untitledTab?.id)

expect(
  dirtyTabAfterFlush?.dirty,

  true,

  "SET_CONTENT leaves an already-dirty tab dirty",
)

// Step 7: closing a dirty tab (without force) DOES open the modal — make

// sure the modal gate still works for the legitimate case.

state = dispatch(state, { type: "CLOSE_TAB", tabId: untitledTab?.id })

expect(
  state.modal?.kind,

  "closeDirty",

  "CLOSE_TAB on a dirty tab opens the closeDirty modal",
)

expect(state.tabs.length, 1, "CLOSE_TAB on a dirty tab keeps the tab in place")

// Step 8: closing a dirty tab WITH force=true skips the modal.

state = dispatch(state, {
  type: "CLOSE_TAB",
  tabId: untitledTab?.id,
  force: true,
})

expect(state.modal, null, "CLOSE_TAB with force=true skips the modal")

expect(
  state.tabs.length,
  0,
  "CLOSE_TAB with force=true actually closes the dirty tab",
)

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)

  process.exit(1)
} else {
  console.log("\nAll tests passed")

  process.exit(0)
}
