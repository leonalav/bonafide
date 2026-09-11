/**
 * scripts/check-ruff.ts
 *
 * Verifies ruffLocationToLineCol helper in src/ide/ruff-linter.ts.
 * Run with: pnpm exec tsx scripts/check-ruff.ts
 */

import { ruffLocationToLineCol } from "../src/ide/ruff-linter"

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

// Test 1: maps ruff 1-based row / 0-based col to 1-based line / col
expect(
  ruffLocationToLineCol({ row: 12, column: 4 }),
  { line: 12, col: 5 },
  "maps ruff 1-based row / 0-based col to 1-based line / col",
)

// Test 2: clamps missing location to 0
expect(
  ruffLocationToLineCol(undefined as unknown as null),
  { line: 0, col: 0 },
  "clamps missing location to 0 (undefined)",
)

expect(
  ruffLocationToLineCol(null),
  { line: 0, col: 0 },
  "clamps missing location to 0 (null)",
)

// Test 3: column 0 stays 1
expect(
  ruffLocationToLineCol({ row: 1, column: 0 }),
  { line: 1, col: 1 },
  "column 0 maps to col 1",
)

// Test 4: column 9 maps to col 10
expect(
  ruffLocationToLineCol({ row: 5, column: 9 }),
  { line: 5, col: 10 },
  "column 9 maps to col 10",
)

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
} else {
  console.log("\nAll tests passed")
  process.exit(0)
}
