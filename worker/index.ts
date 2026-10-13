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

const log = getLogger({ component: "worker" })

assertRuntimeEnvironment()

const worker = createMeetSumWorker()
// M7: separate `meetsum-bot` queue worker; undefined when MEETSUM_BOT_ENABLED is off.
const botWorker = startBotWorker()
// M8: separate `meetsum-integrations` queue worker; undefined until Package A lands.
const integrationsWorker = startIntegrationWorker()
const scheduledTimers: NodeJS.Timeout[] = []

worker.on("completed", (job) => {
  log.info(`MeetSum job completed: ${job.name} ${job.id}`)
})

worker.on("failed", (job, error) => {
  log.error({ err: error }, `MeetSum job failed: ${job?.name} ${job?.id}`)
})

process.on("SIGTERM", async () => {
  scheduledTimers.forEach((timer) => clearInterval(timer))
  await Promise.all([worker.close(), botWorker?.close(), integrationsWorker?.close()])
  process.exit(0)
})

process.on("SIGINT", async () => {
  scheduledTimers.forEach((timer) => clearInterval(timer))
  await Promise.all([worker.close(), botWorker?.close(), integrationsWorker?.close()])
  process.exit(0)
})

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
