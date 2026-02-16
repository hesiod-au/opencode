export namespace PlanningPrompts {
  export function buildPlanOnlyPrompt(context?: string, conversationContext?: string, userPrompt?: string): string {
    const userRequestSection = userPrompt
      ? `## User Request

The user has made the following request:

${userPrompt}

`
      : ""

    const conversationSection = conversationContext
      ? `## Previous Conversation

The user has been discussing the following with an assistant. Use this context to understand what needs to be done:

${conversationContext}

`
      : ""

    return `You are a task planning agent. Your job is to analyze the project and create a task breakdown for the work that needs to be done.

${userRequestSection}${conversationSection}${context ? `## Additional Context\n${context}\n\n` : ""}## Instructions

1. Analyze the project structure and requirements based on the conversation above
2. Break down the work into tasks, where each task has a discrete, single purpose
3. Create as many tasks as needed to complete the work - this could be 1 task or 10+ tasks depending on the scope
4. Identify dependencies between tasks
5. Output a task list in the following markdown table format:

\`\`\`markdown
# Task List

Brief description of the overall goal.

| ID | Title | Status | Assignee | Deps | File |
|----|-------|--------|----------|------|------|
| 001 | First task title | ⬜ todo | - | - | 001.md |
| ... | (n)th task | ⬜ todo | - | deps | nnn.md |
\`\`\`

## Guidelines

- Break up the work into tasks with discrete purposes - each task should be a single, coherent unit of work
- Create as many tasks as are actually needed to complete the job properly
- Each task should be completable independently (once dependencies are met)
- Tasks should be small enough for a single agent to complete in one session
- Dependencies should form a valid DAG (no cycles)
- Use descriptive titles that clearly indicate what needs to be done
- Number tasks sequentially starting from 001
- A task's File should match its ID (e.g., task 001 has file 001.md)
- Do NOT create tasks for writing tests - test creation is handled separately by the test-writer agent when TDD is enabled

**IMPORTANT:** Output ONLY the task table. Do NOT write detailed task descriptions. Just output the markdown table with the task breakdown.

Now, analyze the project and create the task breakdown based on what the user has requested.
`
  }

  export function buildTaskWritingPrompt(
    planTable: string,
    context?: string,
    conversationContext?: string,
    userPrompt?: string,
    taskCount?: number,
  ): string {
    const userRequestSection = userPrompt
      ? `## User Request

${userPrompt}

`
      : ""

    const conversationSection = conversationContext
      ? `## Previous Conversation

${conversationContext}

`
      : ""

    const countWarning = taskCount
      ? `You MUST write descriptions for ALL ${taskCount} tasks below. Do not stop early.\n\n`
      : ""

    return `You are a task description writer. You have been given a finalized task plan. Your job is to write comprehensive, self-contained descriptions for each task.

${countWarning}${userRequestSection}${conversationSection}${context ? `## Additional Context\n${context}\n\n` : ""}## Finalized Plan

${planTable}

## Instructions

For each task in the plan above, write a **comprehensive, self-contained description** using this format:

## Task 001: First task title

**IMPORTANT:** Each task description must contain ALL context needed for an autonomous agent to complete it without access to the original conversation or other tasks. Include:

- **Background/Context**: Why this task exists and how it fits into the larger goal
- **Specific Requirements**: Exactly what needs to be done, in detail
- **Files to Modify/Create**: List specific file paths that will be affected
- **Implementation Details**: Technical approach, patterns to follow, constraints
- **Expected Outcomes**: What success looks like, how to verify completion
- **Relevant Code Snippets**: If the conversation mentioned specific code, APIs, or patterns, include them
- **Dependencies Context**: What the dependent tasks produce that this task needs

The agent working on this task will NOT have access to the original user conversation, so the description must be complete and standalone.

## Task NNN: (n)th task title

And so on for each task...

Now write the detailed descriptions for each task. Do not stop until every task has a description.
`
  }

  export function buildContinuationPrompt(
    planTable: string,
    completedTaskIds: string[],
    missingTaskIds: string[],
  ): string {
    return `You stopped before completing all task descriptions. Write the remaining ones now.

## Plan Reference

${planTable}

## Already Completed

The following tasks already have descriptions: ${completedTaskIds.join(", ")}

## Missing Descriptions

You MUST write descriptions for these tasks: ${missingTaskIds.join(", ")}

Use the same format as before:

## Task NNN: Task title

(comprehensive, self-contained description)

Write descriptions for ALL ${missingTaskIds.length} missing tasks now. Do not stop until every one is covered.
`
  }

  export function buildCombinedPlanningPrompt(
    context?: string,
    conversationContext?: string,
    userPrompt?: string,
  ): string {
    const userRequestSection = userPrompt
      ? `## User Request

The user has made the following request:

${userPrompt}

`
      : ""

    const conversationSection = conversationContext
      ? `## Previous Conversation

The user has been discussing the following with an assistant. Use this context to understand what needs to be done:

${conversationContext}

`
      : ""

    return `You are a task planning agent. Your job is to analyze the project and create a task breakdown for the work that needs to be done.

${userRequestSection}${conversationSection}${context ? `## Additional Context\n${context}\n\n` : ""}## Instructions

1. Analyze the project structure and requirements based on the conversation above
2. Break down the work into tasks, where each task has a discrete, single purpose
3. Create as many tasks as needed to complete the work - this could be 1 task or 10+ tasks depending on the scope
4. Identify dependencies between tasks
5. Output a task list in the following markdown table format:

\`\`\`markdown
# Task List

Brief description of the overall goal.

| ID | Title | Status | Assignee | Deps | File |
|----|-------|--------|----------|------|------|
| 001 | First task title | ⬜ todo | - | - | 001.md |
| ... | (n)th task | ⬜ todo | - | deps | nnn.md |
\`\`\`

## Guidelines

- Break up the work into tasks with discrete purposes - each task should be a single, coherent unit of work
- Create as many tasks as are actually needed to complete the job properly
- Each task should be completable independently (once dependencies are met)
- Tasks should be small enough for a single agent to complete in one session
- Dependencies should form a valid DAG (no cycles)
- Use descriptive titles that clearly indicate what needs to be done
- Number tasks sequentially starting from 001
- A task's File should match its ID (e.g., task 001 has file 001.md)
- Do NOT create tasks for writing tests - test creation is handled separately by the test-writer agent when TDD is enabled

After the table, for each task provide a **comprehensive, self-contained description**:

## Task 001: First task title

**IMPORTANT:** Each task description must contain ALL context needed for an autonomous agent to complete it without access to the original conversation or other tasks. Include:

- **Background/Context**: Why this task exists and how it fits into the larger goal
- **Specific Requirements**: Exactly what needs to be done, in detail
- **Files to Modify/Create**: List specific file paths that will be affected
- **Implementation Details**: Technical approach, patterns to follow, constraints
- **Expected Outcomes**: What success looks like, how to verify completion
- **Relevant Code Snippets**: If the conversation mentioned specific code, APIs, or patterns, include them
- **Dependencies Context**: What the dependent tasks produce that this task needs

The agent working on this task will NOT have access to the original user conversation, so the description must be complete and standalone.

## Task NNN: (n)th task title

And so on for each task...

Now, analyze the project and create the task breakdown based on what the user has requested.
`
  }

  export function buildAssessmentPrompt(
    planA: string,
    planB: string,
    sourceA: string,
    sourceB: string,
  ): string {
    return `You are a planning assessment agent. You have been given two independently generated task plans for the same request. Your job is to evaluate both plans, choose the better one, and synthesize any missing insights from the rejected plan.

## Plan A (generated by ${sourceA})

${planA}

## Plan B (generated by ${sourceB})

${planB}

## Instructions

1. **Evaluate both plans** on these criteria:
   - Completeness: Does it cover all necessary work?
   - Granularity: Are tasks appropriately sized (not too large, not too small)?
   - Dependencies: Are dependencies correctly identified and forming a valid DAG?
   - Clarity: Are task titles clear and descriptive?
   - Ordering: Is the sequence logical?

2. **Choose the better plan** and explain why in 1-2 sentences.

3. **Review the rejected plan** for any insights, tasks, or considerations that the chosen plan missed.

4. **Output the final synthesized plan** as a markdown task table, incorporating any missing insights from the rejected plan into the chosen plan. Use the same table format:

\`\`\`markdown
# Task List

Brief description of the overall goal.

| ID | Title | Status | Assignee | Deps | File |
|----|-------|--------|----------|------|------|
| 001 | First task title | ⬜ todo | - | - | 001.md |
| ... | (n)th task | ⬜ todo | - | deps | nnn.md |
\`\`\`

**IMPORTANT:** Output the final synthesized plan table. Renumber tasks sequentially starting from 001. Ensure dependencies reference the correct renumbered IDs.
`
  }
}
