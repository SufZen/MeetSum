import { Fragment, type ReactNode } from "react"

/**
 * Renders a `{placeholder}` message with each value isolated in <bdi>
 * (README §8.3: names, emails, URLs and product names inside sentences), so
 * "MeetSum Notetaker" inside a Hebrew sentence keeps its own direction.
 */
export function BdiMessage({
  template,
  values,
}: {
  template: string
  values: Record<string, ReactNode>
}) {
  const parts = template.split(/(\{\w+\})/g)

  return (
    <>
      {parts.map((part, index) => {
        const key = /^\{(\w+)\}$/.exec(part)?.[1]

        if (key && key in values) return <bdi key={index}>{values[key]}</bdi>

        return <Fragment key={index}>{part}</Fragment>
      })}
    </>
  )
}
