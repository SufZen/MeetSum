import { meetingNotFound } from "@/app/api/_lib/meeting-access"
import { loadMeetingMediaAssets } from "@/app/api/meetings/[id]/media/_lib/meeting-media"
import { withAuthz } from "@/lib/auth/authz"
import { serveMeetingPeaks } from "@/lib/media/proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/meetings/:id/media/peaks — waveform peaks JSON of the playable
 * audio (ETag `"p-<assetId>-<preparedAt>"`, 304 on If-None-Match);
 * 404 `no_peaks` until the media has been prepared.
 */
export const GET = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    const assets = await loadMeetingMediaAssets(ctx, id)

    if (!assets) return meetingNotFound()

    return serveMeetingPeaks({ request, assets })
  }
)
