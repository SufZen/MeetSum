"use client"

/**
 * M5 Step 0 stub (owner: Package B): typed props, renders nothing yet.
 */
import type { TaskListQuery } from "@/lib/tasks/types"

export type TasksViewProps = {
  initialQuery?: Partial<TaskListQuery>
}

export function TasksView(props: TasksViewProps) {
  void props
  return null
}
