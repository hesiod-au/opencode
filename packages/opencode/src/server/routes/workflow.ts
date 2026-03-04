import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { WorkflowRegistry } from "../../workflow/registry"
import { WorkflowState } from "../../workflow/state"

const log = Log.create({ service: "workflow-routes" })

const WorkflowStatusSchema = z
  .object({
    running: z.boolean(),
    phase: z.string().optional(),
    phaseDetail: z.string().optional(),
    parentSessionId: z.string().optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    runId: z.string().optional(),
    progress: z
      .object({
        current: z.number(),
        total: z.number(),
        label: z.string().optional(),
      })
      .optional(),
    stats: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cost: z.number(),
        modifiedFiles: z.array(z.string()),
      })
      .optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ ref: "WorkflowStatus" })

const WorkflowInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    running: z.boolean(),
    runId: z.string().optional(),
    hasConfirm: z.boolean(),
    activationMode: z.enum(["start", "enable", "both"]),
    steps: z.number().optional(),
    toolInvocable: z.boolean(),
  })
  .meta({ ref: "WorkflowInfo" })

export const WorkflowRoutes = lazy(() =>
  new Hono()
    .get(
      "/list",
      describeRoute({
        summary: "List registered workflows",
        operationId: "workflow.list",
        responses: {
          200: {
            description: "List of workflows",
            content: {
              "application/json": {
                schema: resolver(WorkflowInfoSchema.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const workflows = WorkflowRegistry.list().map((w) => {
          const activeRun = WorkflowState.getActiveRun(w.id)
          return {
            id: w.id,
            name: w.name,
            running: w.isRunning(),
            runId: activeRun?.runId,
            hasConfirm: !!w.confirmPlan,
            activationMode: w.activationMode,
            steps: w.steps?.length,
            toolInvocable: !!w.toolInvocable,
          }
        })
        return c.json(workflows)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get active workflow status",
        operationId: "workflow.status",
        responses: {
          200: {
            description: "Active workflow status or null",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    workflowId: z.string().optional(),
                    status: WorkflowStatusSchema.optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const active = await WorkflowRegistry.getActive()
        if (!active) return c.json({ workflowId: undefined, status: undefined })
        const activeRun = WorkflowState.getActiveRun(active.id)
        const status = active.getStatus()
        return c.json({
          workflowId: active.id,
          status: {
            ...status,
            runId: activeRun?.runId ?? status.runId,
            progress: activeRun?.status.progress ?? status.progress,
          },
        })
      },
    )
    .get(
      "/:id/status",
      describeRoute({
        summary: "Get specific workflow status",
        operationId: "workflow.getStatus",
        responses: {
          200: {
            description: "Workflow status",
            content: {
              "application/json": {
                schema: resolver(WorkflowStatusSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const workflow = WorkflowRegistry.get(c.req.valid("param").id)
        if (!workflow) return c.json({ error: "Workflow not found" }, 404)
        const activeRun = WorkflowState.getActiveRun(workflow.id)
        const status = workflow.getStatus()
        return c.json({
          ...status,
          runId: activeRun?.runId ?? status.runId,
          progress: activeRun?.status.progress ?? status.progress,
        })
      },
    )
    .post(
      "/:id/start",
      describeRoute({
        summary: "Start a workflow",
        operationId: "workflow.start",
        responses: {
          200: {
            description: "Workflow started",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), sessionId: z.string().optional() })),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "json",
        z.object({
          parentSessionId: z.string().optional(),
          userPrompt: z.string().optional(),
        }),
      ),
      async (c) => {
        const workflow = WorkflowRegistry.get(c.req.valid("param").id)
        if (!workflow) return c.json({ error: "Workflow not found" }, 404)

        if (workflow.isRunning()) {
          return c.json({ error: "Workflow already running" }, 400)
        }

        const body = c.req.valid("json")
        log.info("starting workflow", { id: workflow.id, parentSessionId: body.parentSessionId })
        await workflow.start(body)
        const status = workflow.getStatus()
        return c.json({ ok: true, sessionId: status.parentSessionId })
      },
    )
    .post(
      "/:id/stop",
      describeRoute({
        summary: "Stop a workflow",
        operationId: "workflow.stop",
        responses: {
          200: {
            description: "Workflow stopped",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const workflow = WorkflowRegistry.get(c.req.valid("param").id)
        if (!workflow) return c.json({ error: "Workflow not found" }, 404)

        log.info("stopping workflow", { id: workflow.id })
        await workflow.stop("manual")
        return c.json({ ok: true })
      },
    )
    .post(
      "/:id/confirm",
      describeRoute({
        summary: "Confirm workflow plan",
        operationId: "workflow.confirm",
        responses: {
          200: {
            description: "Plan confirmed",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const workflow = WorkflowRegistry.get(c.req.valid("param").id)
        if (!workflow) return c.json({ error: "Workflow not found" }, 404)

        if (!workflow.confirmPlan) {
          return c.json({ error: "Workflow does not support plan confirmation" }, 400)
        }

        log.info("confirming workflow plan", { id: workflow.id })
        await workflow.confirmPlan()
        return c.json({ ok: true })
      },
    ),
)
