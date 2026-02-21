import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace PRReviewEvent {
  export const CycleStarted = BusEvent.define(
    "pr-review.cycle.started",
    z.object({
      cycleNumber: z.number(),
      commentCount: z.number(),
    }),
  )

  export const CycleCompleted = BusEvent.define(
    "pr-review.cycle.completed",
    z.object({
      cycleNumber: z.number(),
      commitSha: z.string(),
    }),
  )

  export const NoNewComments = BusEvent.define("pr-review.no_new_comments", z.object({}))
}
