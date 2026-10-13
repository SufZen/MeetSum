"use client"

/**
 * M5 Step 0 stub (owner: Package D): typed props, renders nothing yet.
 */
export type TemplatePickerProps = {
  meetingId: string
  /** Current `meetings.template_key`; null/undefined = workspace default. */
  value?: string | null
  onChange?: (templateKey: string | null) => void
}

export function TemplatePicker(props: TemplatePickerProps) {
  void props
  return null
}
