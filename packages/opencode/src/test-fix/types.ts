export namespace TestFix {
  export type TestType = "unit" | "endpoint" | "e2e"

  export type TestFileStatus = "passing" | "failing" | "erroring" | "invalid" | "pending" | "fixing"

  export interface TestMethodConfig {
    command: string
    test_file_command?: string | null
    required?: boolean
  }

  export interface TestConfig {
    version?: number
    language?: string
    framework?: string
    project_type?: string
    test_methods?: Partial<Record<TestType, TestMethodConfig>>
    commands?: {
      test?: string
      testFile?: string
      lint?: string
      typecheck?: string
    }
    paths?: {
      tests?: string[]
      source?: string[]
    }
    validation?: Partial<
      Record<
        TestType,
        {
          status: "pass" | "fail" | "unknown"
          note?: string
        }
      >
    >
    warnings?: string[]
  }

  export interface TestFileResult {
    file: string
    status: TestFileStatus
    retries: number
    sessionId?: string
    error?: string
    reason?: string
  }

  export interface GroupResult {
    type: TestType
    sessionId?: string
    files: TestFileResult[]
    regressionCycles: number
    suitePassedAfterFixes: boolean
    error?: string
  }

  export interface Stats {
    inputTokens: number
    outputTokens: number
    cost: number
    duration: number
    modifiedFiles: string[]
  }

  export interface Report {
    groups: GroupResult[]
    stats: Stats
    invalidTests: TestFileResult[]
    allPassing: boolean
  }
}
