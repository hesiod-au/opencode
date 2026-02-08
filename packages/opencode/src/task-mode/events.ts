import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace TaskModeEvent {
  export const TaskListUpdated = BusEvent.define(
    "taskmode.task_list.updated",
    z.object({
      taskListPath: z.string(),
      taskCount: z.number(),
      pendingCount: z.number(),
      inProgressCount: z.number(),
      completedCount: z.number(),
    }),
  )

  export const TaskStarted = BusEvent.define(
    "taskmode.task.started",
    z.object({
      taskId: z.string(),
      title: z.string(),
      sessionId: z.string(),
    }),
  )

  export const TaskCompleted = BusEvent.define(
    "taskmode.task.completed",
    z.object({
      taskId: z.string(),
      title: z.string(),
      sessionId: z.string(),
      comments: z.string().optional(),
    }),
  )

  export const TaskPaused = BusEvent.define(
    "taskmode.task.paused",
    z.object({
      taskId: z.string(),
      title: z.string(),
      sessionId: z.string(),
      reason: z.string(),
      collidingTaskId: z.string().optional(),
      collidingFile: z.string().optional(),
    }),
  )

  export const TaskError = BusEvent.define(
    "taskmode.task.error",
    z.object({
      taskId: z.string(),
      title: z.string(),
      sessionId: z.string().optional(),
      error: z.string(),
    }),
  )

  export const OrchestratorStarted = BusEvent.define(
    "taskmode.orchestrator.started",
    z.object({
      taskListPath: z.string(),
    }),
  )

  export const OrchestratorStopped = BusEvent.define(
    "taskmode.orchestrator.stopped",
    z.object({
      taskListPath: z.string(),
      reason: z.enum(["completed", "error", "manual"]),
    }),
  )

  export const PlanningStarted = BusEvent.define(
    "taskmode.planning.started",
    z.object({
      sessionId: z.string(),
    }),
  )

  export const PlanningCompleted = BusEvent.define(
    "taskmode.planning.completed",
    z.object({
      sessionId: z.string(),
      taskCount: z.number(),
    }),
  )

  export const TestWritingStarted = BusEvent.define(
    "taskmode.test_writing.started",
    z.object({
      sessionId: z.string(),
      taskCount: z.number(),
    }),
  )

  export const TestWritingCompleted = BusEvent.define(
    "taskmode.test_writing.completed",
    z.object({
      sessionId: z.string(),
      tasksWithTests: z.number(),
    }),
  )
}
