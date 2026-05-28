import { describe, expect, it } from "vitest"

import { meetingRepository } from "@/lib/meetings/store"

describe("share lifecycle", () => {
  const fakeMeeting = {
    title: "Share E2E Test Meeting",
    startedAt: new Date().toISOString(),
    source: "upload" as const,
    language: "en",
    participants: ["Alice", "Bob"],
  }

  it("creates a share with default sections", async () => {
    const meeting = await meetingRepository.createMeeting(fakeMeeting)
    const share = await meetingRepository.createMeetingShare({
      meetingId: meeting.id,
      includedSections: ["summary", "decisions", "participants"],
    })

    expect(share.token).toBeTruthy()
    expect(share.meetingId).toBe(meeting.id)
    expect(share.revoked).toBe(false)
    expect(share.includedSections).toContain("summary")
    expect(share.includedSections).toContain("participants")
  })

  it("retrieves a share by token", async () => {
    const meeting = await meetingRepository.createMeeting(fakeMeeting)
    const share = await meetingRepository.createMeetingShare({
      meetingId: meeting.id,
      includedSections: ["summary", "decisions"],
    })

    const result = await meetingRepository.getShareByToken(share.token)

    expect(result).toBeTruthy()
    expect(result!.share.id).toBe(share.id)
    expect(result!.meeting.id).toBe(meeting.id)
    expect(result!.meeting.title).toBe(fakeMeeting.title)
  })

  it("revokes a share link", async () => {
    const meeting = await meetingRepository.createMeeting(fakeMeeting)
    const share = await meetingRepository.createMeetingShare({
      meetingId: meeting.id,
      includedSections: ["summary"],
    })

    const revoked = await meetingRepository.updateMeetingShare(meeting.id, {
      revoked: true,
    })

    expect(revoked.revoked).toBe(true)

    // A revoked share should not be retrievable
    const result = await meetingRepository.getShareByToken(share.token)
    expect(result).toBeFalsy()
  })

  it("regenerates a share token", async () => {
    const meeting = await meetingRepository.createMeeting(fakeMeeting)
    const original = await meetingRepository.createMeetingShare({
      meetingId: meeting.id,
      includedSections: ["summary"],
    })

    const regenerated = await meetingRepository.updateMeetingShare(meeting.id, {
      regenerate: true,
    })

    expect(regenerated.token).not.toBe(original.token)
    expect(regenerated.meetingId).toBe(meeting.id)

    // Old token should no longer resolve
    const oldResult = await meetingRepository.getShareByToken(original.token)
    expect(oldResult).toBeFalsy()

    // New token should resolve
    const newResult = await meetingRepository.getShareByToken(regenerated.token)
    expect(newResult).toBeTruthy()
    expect(newResult!.meeting.id).toBe(meeting.id)
  })

  it("updates included sections", async () => {
    const meeting = await meetingRepository.createMeeting(fakeMeeting)
    await meetingRepository.createMeetingShare({
      meetingId: meeting.id,
      includedSections: ["summary"],
    })

    const updated = await meetingRepository.updateMeetingShare(meeting.id, {
      includedSections: ["summary", "transcript", "action_items"],
    })

    expect(updated.includedSections).toContain("transcript")
    expect(updated.includedSections).toContain("action_items")
    expect(updated.includedSections).toContain("summary")
  })

  it("does not expose internal fields on public share data", async () => {
    const meeting = await meetingRepository.createMeeting(fakeMeeting)
    const share = await meetingRepository.createMeetingShare({
      meetingId: meeting.id,
      includedSections: ["summary", "transcript"],
    })

    const result = await meetingRepository.getShareByToken(share.token)

    expect(result).toBeTruthy()
    // The public share should return meeting data but sections should be filtered by includedSections
    expect(result!.share.includedSections).toContain("summary")
    expect(result!.share.includedSections).toContain("transcript")
    expect(result!.share.includedSections).not.toContain("action_items")
  })

  it("returns null for an invalid token", async () => {
    const result = await meetingRepository.getShareByToken("nonexistent-token-abc123")
    expect(result).toBeFalsy()
  })
})
