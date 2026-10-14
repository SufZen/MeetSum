import { getAsrBootWarnings } from "@/lib/ai/asr/router"
import { startBotWorker } from "@/lib/bot/worker"
import { startIntegrationWorker } from "@/lib/integrations/core/worker"
import { isTeamsSubscriptionConfigured } from "@/lib/capture/teams-subscriptions"
import { createMeetSumWorker } from "@/lib/jobs/processor"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import {
  getCaptureScheduleConfig,
  getGoogleSyncScheduleConfig,
  getRetentionScheduleConfig,
} from "@/lib/jobs/scheduler-config"
import {
  enqueueWorkspaceGooglePolls,
  enqueueWorkspaceRetention,
} from "@/lib/jobs/workspace-schedules"
import { assertRuntimeEnvironment } from "@/lib/ops/environment"
import { warmSearchCapabilities } from "@/lib/search/capabilities"
import { enqueueIndexSweeps, indexSweepEveryMs } from "@/lib/search/index-sweep"
import { getLogger } from "@/lib/log"
import { createLagMonitor, startWorkerHealthServer } from "@/lib/worker-health/server"

const log = getLogger({ component: "worker" })

assertRuntimeEnvironment()

// v0.7.1: the worker runs transcription, so it repeats the app's ASR boot
// warnings (deprecated MEETSUM_TRANSCRIPTION_PROVIDER, single-provider chain).
for (const warning of getAsrBootWarnings()) log.warn(`[asr] ${warning}`)

// M10 B2: optional Sentry/GlitchTip; without SENTRY_DSN the module (and
// @sentry/node) is never imported.
const sentry = process.env.SENTRY_DSN?.trim()
  ? import("@/lib/observability/sentry").then(async (module) => {
      await module.initSentry("worker")
      return module
    })
  : undefined

const worker = createMeetSumWorker()
// M7: separate `meetsum-bot` queue worker; undefined when MEETSUM_BOT_ENABLED is off.
const botWorker = startBotWorker()
// M8: separate `meetsum-integrations` queue worker; undefined until Package A lands.
const integrationsWorker = startIntegrationWorker()
const scheduledTimers: NodeJS.Timeout[] = []

worker.on("completed", (job) => {
  log.info({ jobId: job.id, jobName: job.name, queue: "meetsum" }, "MeetSum job completed")
})

worker.on("failed", (job, error) => {
  log.error({ err: error, jobId: job?.id, jobName: job?.name, queue: "meetsum" }, "MeetSum job failed")
  void sentry?.then((module) => module.captureError(error, { queue: "meetsum", jobName: job?.name ?? "unknown" }))
})

// M10 B3: /live and /ready on MEETSUM_WORKER_HEALTH_PORT (never published).
const lagMonitor = createLagMonitor()
const healthServer = startWorkerHealthServer({
  workers: () => [worker, botWorker, integrationsWorker],
  pingRedis: async () => (await worker.client).ping(),
  eventLoopLagMs: () => lagMonitor.lagMs(),
})

let shuttingDown = false

/** SIGTERM/SIGINT: stop schedules, drain the workers, close the health server. */
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, "MeetSum worker draining")
  scheduledTimers.forEach((timer) => clearInterval(timer))
  lagMonitor.stop()
  await Promise.all([worker.close(), botWorker?.close(), integrationsWorker?.close()])
  const server = await healthServer

  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await sentry?.then((module) => module.flushSentry(2_000)).catch(() => undefined)
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

/**
 * Google polls run per workspace: each tick enqueues one job for every live
 * workspace with a Google subject (workspaces.google_subject), carrying that
 * workspace's id and subject. Workspaces without one are simply skipped.
 */
function scheduleGoogleSync() {
  const config = getGoogleSyncScheduleConfig()

  if (!config.enabled) return

  const schedules = [
    { name: "google.calendar.poll", job: config.calendar, label: "Calendar sync" },
    { name: "google.drive.poll", job: config.drive, label: "Drive sync" },
    { name: "google.meet.poll", job: config.meet, label: "Meet artifact sync" },
  ] as const

  for (const schedule of schedules) {
    if (!schedule.job.enabled) continue

    scheduledTimers.push(
      setInterval(() => {
        void enqueueWorkspaceGooglePolls(schedule.name, schedule.job.payload).catch(
          (error) => log.error({ err: error }, `Scheduled ${schedule.label} failed`)
        )
      }, schedule.job.minutes * 60 * 1000)
    )
  }
}

function scheduleTeamsSubscriptionRenewal() {
  if (!isTeamsSubscriptionConfigured()) return

  const { minutes } = getCaptureScheduleConfig().teamsSubscriptionRenew
  const enqueueRenewal = () =>
    void enqueueMeetSumJob("teams.subscription.renew", { scheduled: true }).catch(
      (error) => log.error({ err: error }, "Scheduled Teams subscription renewal failed")
    )

  enqueueRenewal()
  scheduledTimers.push(setInterval(enqueueRenewal, minutes * 60 * 1000))
}

/** Daily audioRetentionDays enforcement, opt-in (MEETSUM_RETENTION_ENFORCE). */
function scheduleMediaRetention() {
  const config = getRetentionScheduleConfig()

  if (!config.enabled) return

  scheduledTimers.push(
    setInterval(() => {
      void enqueueWorkspaceRetention().catch((error) =>
        log.error({ err: error }, "Scheduled media retention failed")
      )
    }, config.hours * 60 * 60 * 1000)
  )
}

/**
 * M6 search index sweeper: every MEETSUM_INDEX_SWEEP_EVERY_MS, one
 * search.index.sweep job per live workspace re-enqueues stale, failed or
 * re-keyed meetings. Postgres only (other storage keeps no index).
 */
function scheduleSearchIndexSweep() {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  void warmSearchCapabilities()
  const enqueueSweeps = () =>
    void enqueueIndexSweeps().catch((error) => log.error({ err: error }, "Scheduled search index sweep failed"))

  enqueueSweeps()
  scheduledTimers.push(setInterval(enqueueSweeps, indexSweepEveryMs()))
}

scheduleGoogleSync()
scheduleTeamsSubscriptionRenewal()
scheduleMediaRetention()
scheduleSearchIndexSweep()
log.info("MeetSum worker started")
