export namespace PlanningPrompts {
  export function buildAnalysisPrompt(context?: string, conversationContext?: string, userPrompt?: string): string {
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

    return `You are a senior software architect. Your job is to deeply analyze a project and produce a thorough discussion of how to implement the requested changes.

${userRequestSection}${conversationSection}${context ? `## Additional Context\n${context}\n\n` : ""}## Instructions

Produce a **long-form analysis** covering every aspect of the work. Structure your response with the following sections:

### 1. Summary of the Goal
What the user is asking for and why it matters. Restate the objective in your own words to confirm understanding.

### 2. Approach & Architecture
- The overall strategy you recommend
- Alternative approaches you considered and why you rejected them
- Key design decisions and their trade-offs

### 3. Files to Create or Modify
For each file, explain:
- What changes are needed and why
- How it fits into the broader architecture
- Any patterns or conventions to follow from the existing codebase

### 4. End-to-End Walkthrough
Describe how the final solution works from start to finish. Walk through the data flow, control flow, or user journey so the reader can mentally trace the implementation.

### 5. Risks, Edge Cases & Integration Points
- What could go wrong
- Edge cases that need handling
- How this change interacts with other parts of the system
- Migration or backwards-compatibility concerns

### 6. Ordering & Dependencies
Discuss which parts of the work depend on others and the ideal order of implementation.

**IMPORTANT:** Do NOT produce a task table. Do NOT output a markdown table of tasks. Your job is only to produce the analysis above. The task table will be generated in a later step by a separate agent that reads your analysis.

Now, analyze the project and produce the detailed analysis.
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

  export function buildAssessmentPrompt(planA: string, planB: string, sourceA: string, sourceB: string): string {
    return (
      `You are a planning assessment agent. You have been given two independently generated analyses of the same work request. Your job is to evaluate both analyses, synthesize the best approach, and produce a final task table.

## Analysis A (generated by ${sourceA})

${planA}

## Analysis B (generated by ${sourceB})

${planB}

## Instructions

1. **Evaluate both analyses** on these criteria:
   - Completeness: Does it cover all necessary work?
   - Technical depth: Does it identify the right files, patterns, and approach?
   - Risk awareness: Does it call out edge cases and integration concerns?
   - Practicality: Is the proposed approach realistic and well-ordered?

2. **Synthesize the best approach** by:
   - Choosing the stronger overall strategy
   - Incorporating any insights, risks, or considerations from the weaker analysis that the stronger one missed
   - Resolving any contradictions between the two

3. **Generate the final task table** from the synthesized approach. Break the work into discrete tasks, each with a single coherent purpose. Output the table in this exact format:

\`\`\`markdown
# Task List

Brief description of the overall goal.

| ID | Title | Status | Assignee | Deps | File |
|----|-------|--------|----------|------|------|
| 001 | First task title | ⬜ todo | - | - | 001.md |
| 002 | Second task title | ⬜ todo | - | - | 002.md |
| 003 | Third task title | ⬜ todo | - | - | 003.md |
\`\`\`

## Task Table Guidelines

- Break up the work into tasks with discrete purposes - each task should be a single, coherent unit of work
- Create as many tasks as are actually needed to complete the job properly
- Each task should be completable independently (once dependencies are met)
- Tasks should be small enough for a single agent to complete in one session
- Use descriptive titles that clearly indicate what needs to be done
- Number tasks sequentially starting from 001
- A task's File should match its ID (e.g., task 001 has file 001.md)
- Do NOT create tasks for writing tests - test creation is handled separately by the test-writer agent when TDD is enabled

### Dependencies

- **Dependencies are optional.** The default is ` -
      ` in the Deps column.
- Only add a dependency when there is a concrete reason:
  - Two tasks modify the **same files** and must be ordered to avoid conflicts
  - A task relies on **output, research, or code changes** produced by another task
- Do not add dependencies by position; only add when tasks share files or rely on outputs, research, or changes from another task
- Dependencies must not form cycles

**IMPORTANT:** Your output MUST include the task table. Renumber tasks sequentially starting from 001. Ensure dependencies reference the correct renumbered IDs.
`
    )
  }
}
