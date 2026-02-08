import z from "zod"
import { Log } from "../util/log"
import { TaskList } from "./task-list"
import { Lock } from "../util/lock"

export namespace Collision {
  const log = Log.create({ service: "collision" })

  export const FileReservation = z.object({
    taskId: z.string(),
    filePath: z.string(),
    reservedAt: z.number(),
  })
  export type FileReservation = z.infer<typeof FileReservation>

  export const CollisionResult = z.object({
    hasCollision: z.boolean(),
    collidingTaskId: z.string().optional(),
    collidingFile: z.string().optional(),
  })
  export type CollisionResult = z.infer<typeof CollisionResult>

  export const TaskContext = z.object({
    taskId: z.string(),
    taskTitle: z.string(),
    paths: z.object({
      taskListPath: z.string(),
      tasksDir: z.string(),
      lockPath: z.string(),
    }),
  })
  export type TaskContext = z.infer<typeof TaskContext>

  // In-memory file reservations by task
  const reservations = new Map<string, Set<string>>()

  // In-memory task context by sessionID - tracks which sessions are task agents
  const sessionTaskContext = new Map<string, TaskContext>()

  // Lock for thread-safe reservation operations
  const RESERVATION_LOCK = "collision:reservations"

  export function check(taskId: string, editFiles: string[], allTasks: TaskList.TaskEntry[]): CollisionResult {
    const inProgressTasks = allTasks.filter((t) => t.status === "in-progress" && t.id !== taskId)

    for (const file of editFiles) {
      // Check against reserved files from other in-progress tasks
      for (const [otherTaskId, files] of reservations.entries()) {
        if (otherTaskId === taskId) continue
        if (files.has(file)) {
          log.warn("file collision detected", {
            taskId,
            collidingTaskId: otherTaskId,
            file,
          })
          return {
            hasCollision: true,
            collidingTaskId: otherTaskId,
            collidingFile: file,
          }
        }
      }
    }

    return { hasCollision: false }
  }

  export async function reserveFile(
    taskId: string,
    filePath: string,
    allTasks: TaskList.TaskEntry[],
  ): Promise<CollisionResult> {
    using _ = await Lock.write(RESERVATION_LOCK)

    // Check for collision first
    const collision = check(taskId, [filePath], allTasks)
    if (collision.hasCollision) {
      return collision
    }

    // Reserve the file
    if (!reservations.has(taskId)) {
      reservations.set(taskId, new Set())
    }
    reservations.get(taskId)!.add(filePath)

    log.info("file reserved", { taskId, filePath })
    return { hasCollision: false }
  }

  export async function releaseFile(taskId: string, filePath: string): Promise<void> {
    using _ = await Lock.write(RESERVATION_LOCK)

    const taskReservations = reservations.get(taskId)
    if (taskReservations) {
      taskReservations.delete(filePath)
      if (taskReservations.size === 0) {
        reservations.delete(taskId)
      }
    }

    log.info("file released", { taskId, filePath })
  }

  export async function releaseAllForTask(taskId: string): Promise<void> {
    using _ = await Lock.write(RESERVATION_LOCK)

    const count = reservations.get(taskId)?.size ?? 0
    reservations.delete(taskId)

    log.info("all files released for task", { taskId, count })
  }

  export function getReservationsForTask(taskId: string): string[] {
    return Array.from(reservations.get(taskId) ?? [])
  }

  export function getAllReservations(): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (const [taskId, files] of reservations.entries()) {
      result.set(taskId, Array.from(files))
    }
    return result
  }

  export function clearAll(): void {
    reservations.clear()
    log.info("all reservations cleared")
  }

  // Task context management for Edit tool integration
  export function registerTaskSession(sessionId: string, context: TaskContext): void {
    sessionTaskContext.set(sessionId, context)
    log.info("task session registered", { sessionId, taskId: context.taskId })
  }

  export function unregisterTaskSession(sessionId: string): void {
    sessionTaskContext.delete(sessionId)
    log.info("task session unregistered", { sessionId })
  }

  export function getTaskContextForSession(sessionId: string): TaskContext | undefined {
    return sessionTaskContext.get(sessionId)
  }

  export function isTaskSession(sessionId: string): boolean {
    return sessionTaskContext.has(sessionId)
  }
}
