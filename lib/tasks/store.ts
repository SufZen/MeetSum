/**
 * Cross-meeting task list over visible meetings (owner: Package B). Step 0
 * stub that throws "not implemented (M5)".
 */
import type { RepoScope } from "@/lib/meetings/repository"
import { notImplementedM5 } from "@/lib/meetings/repository"
import type { TaskListPage, TaskListQuery } from "@/lib/tasks/types"

export async function listTasks(scope: RepoScope, query: TaskListQuery): Promise<TaskListPage> {
  void scope
  void query
  return notImplementedM5("listTasks")
}
