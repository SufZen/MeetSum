import { Badge } from "@/components/ui/badge"
import type { MeetingTag } from "@/lib/intelligence"

export function TagList({ tags = [] }: { tags?: MeetingTag[] }) {
  if (tags.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="h-6 rounded-sm">
          {tag}
        </Badge>
      ))}
    </div>
  )
}
