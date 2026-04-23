import { DEMO_MEETINGS } from "@/lib/meetings/demo-data"
import { createInMemoryMeetingRepository } from "@/lib/meetings/repository"

export const meetingRepository = createInMemoryMeetingRepository(DEMO_MEETINGS)
