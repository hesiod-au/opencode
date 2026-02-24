import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace TestConfigEvent {
  export const AnalysisComplete = BusEvent.define(
    "test-config.analysis.complete",
    z.object({
      language: z.string().optional(),
      framework: z.string().optional(),
    }),
  )

  export const ConfigWritten = BusEvent.define(
    "test-config.config.written",
    z.object({
      path: z.string(),
    }),
  )
}
