"use client"

/**
 * Cross-meeting Tasks view (M5 B8; owner: Package B). Filter chips
 * (mine / open / overdue / all), room, owner and search; groups overdue →
 * today → this week → later → no date (→ done); inline edit, bulk complete,
 * and every row links to the moment it was said.
 */
import { useCallback, useEffect, useMemo, useState } from "react"

import { useOptionalI18n } from "@/components/i18n-provider"
import { bulkUpdateTasks, fetchTasks, patchActionItem } from "@/components/tasks/api"
import { Isolated, withSlot } from "@/components/tasks/slot"
import { isOverdue, TaskItemRow } from "@/components/tasks/task-item-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import type { TasksMessages } from "@/lib/i18n/m5/tasks"
import type { ActionItemPatch } from "@/lib/meetings/repository"
import { addDaysToDate, localDateIn } from "@/lib/tasks/due-date"
import type { TaskListQuery, TaskMember, TaskRow } from "@/lib/tasks/types"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"

export type TasksViewProps = {
  initialQuery?: Partial<TaskListQuery>
  locale?: string
  dictionary?: TasksMessages
  rooms?: Array<{ id: string; name: string }>
  members?: TaskMember[]
}

type Chip = "mine" | "open" | "overdue" | "all"

const CHIP_QUERY: Record<Chip, Pick<TaskListQuery, "scope" | "status">> = {
  mine: { scope: "mine", status: "open" },
  open: { scope: "all", status: "open" },
  overdue: { scope: "all", status: "overdue" },
  all: { scope: "all", status: "all" },
}

const CHIP_LABEL: Record<Chip, keyof TasksMessages> = {
  mine: "tasksMine",
  open: "tasksOpen",
  overdue: "tasksOverdue",
  all: "tasksAll",
}

type GroupKey = "overdue" | "today" | "week" | "later" | "none" | "done"

const GROUP_LABEL: Record<GroupKey, keyof TasksMessages> = {
  overdue: "tasksOverdue",
  today: "tasksGroupToday",
  week: "tasksGroupThisWeek",
  later: "tasksGroupLater",
  none: "tasksNoDueDate",
  done: "tasksGroupDone",
}

function chipFor(query: Partial<TaskListQuery> | undefined): Chip {
  if (query?.scope === "mine") return "mine"
  if (query?.status === "overdue") return "overdue"
  if (query?.status === "all") return "all"
  return "open"
}

/** Saturday of `today`'s week (weeks start on Sunday). */
function endOfWeek(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay()

  return addDaysToDate(today, 6 - dow) ?? today
}

export function groupTask(task: TaskRow, today: string, weekEnd: string): GroupKey {
  if (task.status === "done") return "done"
  if (!task.dueOn) return "none"
  if (isOverdue(task, today)) return "overdue"
  if (task.dueOn === today) return "today"
  if (task.dueOn <= weekEnd) return "week"
  return "later"
}

function meetingHref(locale: string, task: TaskRow): string {
  const params = new URLSearchParams({ meeting: task.meeting.id })

  if (task.sourceStartMs !== undefined) params.set("t", String(Math.floor(task.sourceStartMs / 1000)))
  return `/${locale}?${params.toString()}`
}

export function TasksView({
  initialQuery,
  locale = "he",
  dictionary,
  rooms = [],
  members = [],
}: TasksViewProps) {
  // Without a prop, the route's I18nProvider carries the task keys (M10 C).
  const providerMessages = useOptionalI18n()?.messages
  const strings = dictionary ?? ((providerMessages ?? {}) as unknown as TasksMessages)
  // Viewers (no meeting:write) see read-only rows.
  const canEditTasks = useWorkspace().can("meeting:write")
  const [chip, setChip] = useState<Chip>(chipFor(initialQuery))
  const [roomId, setRoomId] = useState(initialQuery?.roomId ?? "")
  const [ownerUserId, setOwnerUserId] = useState(initialQuery?.ownerUserId ?? "")
  const [search, setSearch] = useState(initialQuery?.q ?? "")
  const [q, setQ] = useState(initialQuery?.q ?? "")
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [cursor, setCursor] = useState<string>()
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saveError, setSaveError] = useState<string>()
  const [today] = useState(() => localDateIn(new Date()))
  const weekEnd = useMemo(() => endOfWeek(today), [today])

  // Debounce the search box.
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300)

    return () => clearTimeout(timer)
  }, [search])

  const query = useMemo<Partial<TaskListQuery>>(
    () => ({
      ...CHIP_QUERY[chip],
      roomId: roomId || undefined,
      ownerUserId: ownerUserId || undefined,
      q: q || undefined,
    }),
    [chip, roomId, ownerUserId, q]
  )

  const load = useCallback(
    async (append?: string) => {
      setState("loading")
      try {
        const page = await fetchTasks({ ...query, cursor: append })

        setTasks((current) => (append ? [...current, ...page.tasks] : page.tasks))
        setCursor(page.nextCursor)
        setState("ready")
      } catch {
        setState("error")
      }
    },
    [query]
  )

  useEffect(() => {
    let cancelled = false

    fetchTasks(query).then(
      (page) => {
        if (cancelled) return
        setTasks(page.tasks)
        setCursor(page.nextCursor)
        setSelected(new Set())
        setState("ready")
      },
      () => {
        if (!cancelled) setState("error")
      }
    )
    return () => {
      cancelled = true
    }
  }, [query])

  async function patchTask(task: TaskRow, patch: ActionItemPatch) {
    setSaveError(undefined)
    try {
      const saved = await patchActionItem(task.meeting.id, task.id, patch)

      setTasks((current) =>
        current.map((entry) => (entry.id === saved.id ? { ...entry, ...saved, meeting: entry.meeting } : entry))
      )
    } catch {
      setSaveError(strings.tasksSaveError)
    }
  }

  async function completeSelected() {
    const ids = [...selected]

    if (!ids.length) return
    setSaveError(undefined)
    try {
      await bulkUpdateTasks(ids, { status: "done" })
      setSelected(new Set())
      await load()
    } catch {
      setSaveError(strings.tasksSaveError)
    }
  }

  const groups = useMemo(() => {
    const order: GroupKey[] = ["overdue", "today", "week", "later", "none", "done"]
    const buckets = new Map<GroupKey, TaskRow[]>(order.map((key) => [key, []]))

    for (const task of tasks) buckets.get(groupTask(task, today, weekEnd))!.push(task)

    return order.map((key) => [key, buckets.get(key)!] as const).filter(([, list]) => list.length)
  }, [tasks, today, weekEnd])

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold text-fg">{strings.tasksTitle}</h1>
        <p className="text-sm text-fg-3">{strings.tasksSubtitle}</p>
      </header>

      <div className="grid gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={strings.tasksTitle}>
          {(Object.keys(CHIP_QUERY) as Chip[]).map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant="secondary"
              aria-pressed={chip === key}
              className="aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand-text"
              onClick={() => setChip(key)}
            >
              {strings[CHIP_LABEL[key]]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            dir="auto"
            value={search}
            aria-label={strings.tasksSearch}
            placeholder={strings.tasksSearch}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 max-w-xs flex-1"
          />
          {rooms.length ? (
            <NativeSelect
              size="sm"
              aria-label={strings.tasksAllRooms}
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
            >
              <NativeSelectOption value="">{strings.tasksAllRooms}</NativeSelectOption>
              {rooms.map((room) => (
                <NativeSelectOption key={room.id} value={room.id}>
                  {room.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {members.length ? (
            <NativeSelect
              size="sm"
              aria-label={strings.tasksAnyOwner}
              value={ownerUserId}
              onChange={(event) => setOwnerUserId(event.target.value)}
            >
              <NativeSelectOption value="">{strings.tasksAnyOwner}</NativeSelectOption>
              {members.map((member) => (
                <NativeSelectOption key={member.userId} value={member.userId}>
                  {member.name || member.email}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
        </div>
      </div>

      {selected.size ? (
        <div className="sticky top-2 z-10 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 shadow-sm">
          <span className="text-sm text-fg-2">
            {withSlot(strings.tasksSelected, "count", <Isolated>{selected.size}</Isolated>)}
          </span>
          <Button type="button" size="sm" onClick={() => void completeSelected()}>
            {strings.tasksCompleteSelected}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {strings.tasksClearSelection}
          </Button>
        </div>
      ) : null}

      {saveError ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">
          {saveError}
        </p>
      ) : null}

      {state === "error" ? (
        <div role="alert" className="grid justify-items-start gap-2 rounded-md border border-line bg-surface p-4">
          <p className="text-sm text-fg-2">{strings.tasksLoadError}</p>
          <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
            {strings.tasksRetry}
          </Button>
        </div>
      ) : state === "loading" && !tasks.length ? (
        <div role="status" className="grid gap-2" aria-busy="true" aria-label={strings.tasksLoading}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : !tasks.length ? (
        <p className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-fg-3">
          {strings.tasksEmpty}
        </p>
      ) : (
        <div className="grid gap-5">
          {groups.map(([key, list]) => (
            <section key={key} className="grid gap-2" aria-labelledby={`tasks-group-${key}`}>
              <h2
                id={`tasks-group-${key}`}
                className={cn(
                  "flex items-center gap-2 text-sm font-semibold text-fg-2",
                  key === "overdue" && "text-warn-text"
                )}
              >
                {strings[GROUP_LABEL[key]]}
                <span className="font-normal text-fg-3">
                  <Isolated>{list.length}</Isolated>
                </span>
              </h2>
              <ul className="grid gap-2">
                {list.map((task) => (
                  <TaskItemRow
                    key={task.id}
                    item={task}
                    meetingId={task.meeting.id}
                    meetingStartedAt={task.meeting.startedAt}
                    strings={strings}
                    members={members}
                    today={today}
                    canEdit={canEditTasks}
                    onPatch={(patch) => patchTask(task, patch)}
                    selection={{
                      selected: selected.has(task.id),
                      onChange: (value) =>
                        setSelected((current) => {
                          const next = new Set(current)

                          if (value) next.add(task.id)
                          else next.delete(task.id)
                          return next
                        }),
                    }}
                    meetingLink={{ href: meetingHref(locale, task), title: task.meeting.title }}
                    showSource={false}
                    showComments={false}
                  />
                ))}
              </ul>
            </section>
          ))}
          {cursor ? (
            <Button
              type="button"
              variant="secondary"
              className="justify-self-center"
              disabled={state === "loading"}
              onClick={() => void load(cursor)}
            >
              {strings.tasksLoadMore}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
